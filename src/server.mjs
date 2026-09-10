#!/usr/bin/env node
/**
 * pm-ai-proxy - SERVER tuong thich ANTHROPIC MESSAGES API, bac cau Claude Code CLI -> Postman gateway.
 *
 * Cach dung (APPROACH.md #2 - mao danh nha cung cap model):
 *   1) Postman Desktop dang mo + da harvest token/template (node src/harvest.mjs).
 *   2) node src/server.mjs           # mac dinh http://127.0.0.1:8788
 *   3) Tro Claude Code CLI vao proxy:
 *        set ANTHROPIC_BASE_URL=http://127.0.0.1:8788
 *        set ANTHROPIC_API_KEY=pm-proxy        (gia tri bat ky; proxy bo qua)
 *        claude
 *
 * Khac webui: O DAY chinh Claude Code CLI chay tool (Bash/Read/Write/Edit...). Proxy chi DICH
 * ten+tham so tool giua Postman native <-> Claude Code (docs/tool-mapping.md) va dich stream
 * SSE Postman <-> Anthropic. Tool KHONG chay tren server.
 *
 * Endpoint: POST /v1/messages - POST /v1/messages/count_tokens - GET /v1/models - GET /health
 */
import http from 'node:http';
import {
  GATEWAY, APP_VERSION_FALLBACK, readToken, loadTemplate, buildBody, listModels,
} from './core.mjs';
import { applySession } from './session.mjs';
import {
  mapPostmanToolToClaude, buildToolCard, claudeToolSet, excludedToolsFor, mapModel, QUERY_CAP, subagentThirdParty, toolChoiceDirective,
  conformToolName, conformInputToSchema,
} from './map.mjs';
import { AnthropicSSE, estimateTokens, genMessageId, THINKING_SIG } from './sse.mjs';
import {
  sessionKey, getSession, setSession, recordToolUse, getToolUse, addPending, takePending, contentText,
} from './sessions.mjs';
import {
  analyzeRequest, buildToolResponses, systemText, extractWorkingDir, isUtilityTurn, utilityReply,
  rebuildTranscript, priorMessages,
} from './translate.mjs';
import { cap, capFull } from './capture.mjs';
import { isMcpTool, callMcpTool, listMcpTools } from './mcp.mjs';
import { readUserRules, ensureRules, RULES_FILE } from './rules.mjs';
import { handleChatCompletions, toOpenAIModels } from './openai.mjs';
import { spawn as _spawn } from 'node:child_process';

const PORT = Number(process.env.PM_ANTHROPIC_PORT || 8788);
const HOST = process.env.PM_ANTHROPIC_HOST || '127.0.0.1';
const MAX_ROUNDS = Number(process.env.PM_MAX_ROUNDS || 16);
const DEBUG = !!process.env.DEBUG_PROXY;
const log = (...a) => console.log('[pm-proxy]', ...a);
const dbg = (...a) => { if (DEBUG) console.log('[pm-proxy:dbg]', ...a); };

// AUTO-REGISTER MCP (B2): inject configured MCP servers' tools into clientTools.thirdParty
// so the Postman gateway advertises them to the model; the proxy executes calls via
// mcp.mjs (callMcpTool) and returns results through the normal TOOL_RESPONSE loop.
const MCP_AUTOREGISTER = process.env.PM_MCP_AUTOREGISTER !== '0';
const MCP_WARM_TTL = Number(process.env.PM_MCP_WARM_TTL_MS || 300000);
let mcpThirdPartyCache = null;   // { '<server>': { serverConfig, tools:[{name,description,parameters}] } }
let mcpWarming = false, mcpWarmedAt = 0;

async function buildMcpThirdParty() {
  const { tools } = await listMcpTools();
  const byServer = {};
  for (const t of tools || []) {
    const srv = t.server || 'mcp';
    if (!byServer[srv]) byServer[srv] = { serverConfig: { command: 'pm-ai-proxy-mcp', args: [srv] }, tools: [] };
    byServer[srv].tools.push({ name: t.name, description: t.description || '', parameters: t.inputSchema || { type: 'object' } });
  }
  return byServer;
}

function ensureMcpThirdPartyWarm() {
  if (!MCP_AUTOREGISTER || mcpWarming) return;
  if (mcpThirdPartyCache !== null && (Date.now() - mcpWarmedAt) < MCP_WARM_TTL) return;
  mcpWarming = true;
  buildMcpThirdParty()
    .then((tp) => { mcpThirdPartyCache = tp; mcpWarmedAt = (Object.keys(tp).length ? Date.now() : (Date.now() - MCP_WARM_TTL + 20000)); dbg('mcp thirdParty warmed:', Object.keys(tp).join(',') || '(none)'); })
    .catch((e) => { if (mcpThirdPartyCache === null) mcpThirdPartyCache = {}; dbg('mcp warm failed:', e && e.message); })
    .finally(() => { mcpWarming = false; });
}

// (c) Ensure OpenClaw's CDP browser is running (chrome-devtools attaches to it). Best-effort.
let _browserStarting = false;
function ensureOpenclawBrowser() {
  return new Promise((resolve) => {
    if (_browserStarting) { setTimeout(resolve, 6000); return; }
    _browserStarting = true;
    let done = false;
    const fin = () => { if (done) return; done = true; _browserStarting = false; resolve(); };
    try {
      const cp = _spawn('cmd', ['/c', 'openclaw', 'browser', 'start'], { windowsHide: true });
      cp.on('exit', () => setTimeout(fin, 1500));
      cp.on('error', fin);
    } catch { fin(); }
    setTimeout(fin, 12000);
  });
}

function gatewayHeaders(token) {
  const tpl = loadTemplate();
  return {
    'x-access-token': token,
    'x-pstmn-req-service': 'agent-mode-service',
    'x-app-version': (tpl && tpl.headers && tpl.headers['x-app-version']) || APP_VERSION_FALLBACK,
    'Content-Type': 'application/json',
  };
}

/**
 * Co thinking client yeu cau. Claude Code gui nhieu type khac nhau:
 *   {type:'enabled', budget_tokens}          - khi set MAX_THINKING_TOKENS
 *   {type:'adaptive', display:'summarized'}  - mac dinh cua CLI moi
 * Chi 'disabled' moi la tat; moi type khac deu coi la BAT (neu khong gateway
 * khong phat thinkingChunk va client khong bao gio thay khoi reasoning).
 * null = client khong khai bao -> de template gateway tu quyet.
 */
function thinkingFlag(body) {
  const t = body && body.thinking && body.thinking.type;
  return t ? t !== 'disabled' : null;
}

/**
 * Xac dinh thu muc lam viec cua client - UU TIEN header do client gui.
 * Thu tu: x-pm-working-dir -> x-working-directory -> "Working directory:" trong system prompt.
 * Chuan hoa header: mang (gui trung) -> lay phan tu dau; trim; bo nhay bao ngoai;
 * chuoi rong/toan khoang trang coi nhu KHONG khai -> roi xuong nguon ke tiep
 * (tranh loi cu: `' '` truthy -> bi nhan nham thanh folder).
 * @returns {{ dir: string|null, source: 'header'|'system'|null }}
 */
function resolveWorkingDir(req, system) {
  const norm = (v) => {
    if (Array.isArray(v)) v = v[0];
    if (typeof v !== 'string') return '';
    let s = v.trim();
    if (s.length >= 2 && ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'"))) {
      s = s.slice(1, -1).trim();
    }
    return s;
  };
  const h = norm(req.headers['x-pm-working-dir']) || norm(req.headers['x-working-directory']);
  if (h) return { dir: h, source: 'header' };
  const sys = extractWorkingDir(system);
  if (sys) return { dir: sys, source: 'system' };
  return { dir: null, source: null };
}

/** Ap ngu canh/che do/tool cho MOI vong /chat (giong ctx.applyContext cua core.mjs). */
function prepBody(body, opts) {
  const { workingDir, pmModelKey, claudeTools, thinking } = opts;
  if (workingDir) applySession(body, { workingDir });
  const dm = (body.devModeOptions = body.devModeOptions || {});
  dm.autoRun = true;
  dm.isLoopApprovalEnabled = false;      // proxy khong dung checkpoint cua gateway
  dm.supportsAskUser = true;             // askUser -> AskUserQuestion native cua Claude Code (map.mjs)
  dm.supportsActionRecommendations = false;
  dm.isParallelToolCallingSupported = true;
  if (pmModelKey) dm.selectedModel = pmModelKey;
  if (thinking === true) { dm.useThinkingModeIfAvailable = true; if (!dm.thinkingLevel) dm.thinkingLevel = 'medium'; }
  else if (thinking === false) dm.useThinkingModeIfAvailable = false;
  const ct = (body.clientTools = body.clientTools || {});
  ct.excludedTools = excludedToolsFor(claudeTools, Array.isArray(ct.excludedTools) ? ct.excludedTools : []);
  // thirdParty cua template la MCP cua MAY DA HARVEST (duong dan + token cua may khac) ->
  // khong con dung o may dang chay. Dung lai tu dau: chi quang cao thu proxy nay thuc su
  // phuc vu duoc (MCP cau hinh o may nay + tool subagent ao).
  ct.thirdParty = {};
  // SUBAGENT AO: gateway khong co tool uy nhiem subagent -> proxy tu cap. Xem map.mjs.
  const subTp = subagentThirdParty(claudeTools);
  if (subTp) ct.thirdParty = { ...ct.thirdParty, ...subTp };
  // AUTO-REGISTER (B2): advertise MCP-server tools to the model via thirdParty.
  if (MCP_AUTOREGISTER) {
    try {
      ensureMcpThirdPartyWarm();
      if (mcpThirdPartyCache && Object.keys(mcpThirdPartyCache).length) ct.thirdParty = { ...ct.thirdParty, ...mcpThirdPartyCache };
    } catch {}
  }
  return body;
}

/** Doc SSE Postman cua MOT vong /chat. Tra { tools:[{id,name,groupId,args}], sawLoopApproval }. */
async function readGatewayStream(res, emitter, ctx) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', done = false, sawLoopApproval = false;
  const acc = {}; const order = [];

  const onEvent = (type, d) => {
    switch (type) {
      case 'conversation':
        if (d && d.id) { ctx.conversationId = d.id; setSession(ctx.key, { conversationId: d.id, model: ctx.model }); }
        break;
      case 'textChunk': {
        const t = (d && (d.textContent || d.text || d.delta || d.content)) || '';
        if (t) emitter.textDelta(t);
        break;
      }
      case 'planningChunk': { const t = d && (d.textContent || d.text); if (t) emitter.textDelta(t); break; }
      case 'thinkingChunk': { // chi forward khi client BAT thinking (body.thinking.type==='enabled')
        if (ctx.opts.thinking === true) { const t = d && (d.thinkingContent || d.thinking || d.text || d.textContent); if (t) emitter.thinkingDelta(t); }
        break;
      }
      case 'toolCallChunk': {
        for (const c of (d && d.toolCalls) || []) {
          if (!c || !c.id) continue;
          let a = acc[c.id];
          if (!a) { a = { id: c.id, name: (c.function && c.function.name) || c.name || 'tool', groupId: c.toolCallGroupId || (d && d.toolCallGroupId) || null, args: '' }; acc[c.id] = a; order.push(c.id); }
          if (c.function && c.function.name) a.name = c.function.name;
          if (c.function && typeof c.function.arguments === 'string') a.args += c.function.arguments;
        }
        break;
      }
      case 'toolCall': {
        const id = d && (d.toolCallId || d.id);
        if (id && !acc[id]) { acc[id] = { id, name: d.toolName || d.name || 'tool', groupId: d.toolCallGroupId || null, args: d.arguments != null ? (typeof d.arguments === 'string' ? d.arguments : JSON.stringify(d.arguments)) : '' }; order.push(id); }
        break;
      }
      case 'loopApprovalChunk': sawLoopApproval = true; break;
      case 'usage': if (d && emitter.setUsage) emitter.setUsage(d); break;
      case 'notification': break;
      case 'progressUpdate': break;
      case 'failure': { const e = new Error((d && (d.userMessage || d.message)) || 'gateway failure'); e.errorType = d && d.errorType; throw e; }
      default: dbg('event', type);
    }
  };

  for (;;) {
    const { done: rd, value } = await reader.read();
    if (rd) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') { done = true; break; }
      let evt; try { evt = JSON.parse(payload); } catch { continue; }
      onEvent(evt.eventType, evt.data);
    }
    if (done) break;
  }
  return { tools: order.map((id) => acc[id]), sawLoopApproval };
}

/** Mot vong roundtrip toi gateway; tu de quy khi can (drop-only / continue-loop). */
async function runGateway(token, body, emitter, ctx) {
  if (ctx.round > MAX_ROUNDS) { emitter.textDelta('\n[proxy] Da dat gioi han so vong tool. Dung.'); emitter.finish('end_turn'); return; }
  prepBody(body, ctx.opts);
  dbg('POST /chat round', ctx.round, 'chatType', body.input && body.input.chatType);
  const res = await fetch(`${GATEWAY}/chat`, { method: 'POST', headers: gatewayHeaders(token), body: JSON.stringify(body), signal: ctx.signal });
  if (!res.ok) { const text = await res.text().catch(() => ''); cap({ dir: 'gw_error', status: res.status, body: text.slice(0, 600) }); const e = new Error(`gateway HTTP ${res.status}: ${text.slice(0, 300)}`); e.status = res.status; throw e; }

  const { tools, sawLoopApproval } = await readGatewayStream(res, emitter, ctx);

  // Phan loai tool: client (Claude Code chay) vs drop (proxy tu tra de gateway chay tiep).
  const clientCalls = [], dropByGroup = {};
  for (const t of tools) {
    let args = {}; try { args = t.args ? JSON.parse(t.args) : {}; } catch { args = {}; }
    cap({ dir: 'gw_tool', round: ctx.round, native: t.name, groupId: t.groupId, argsRaw: (t.args || '').slice(0, 600) });
    // Tap chuyen biet cho askUser: ghi DAY DU args gateway phat (question/options) de soi format menu chon option.
    if (String(t.name).toLowerCase() === 'askuser') {
      cap({ dir: 'gw_askuser', round: ctx.round, toolUseId: t.id, groupId: t.groupId, args });
      dbg('gw_askuser ->', JSON.stringify(args).slice(0, 400));
    }
    if (isMcpTool(t.name)) {
      const gid = t.groupId || '_';
      let r; try { r = await callMcpTool(t.name, args); } catch (e) { r = { status: 'ERROR', message: e && e.message }; }
      const _emsg = (r && (r.content || r.message)) || '';
      if (r && r.status !== 'SUCCESS' && String(t.name).indexOf('chrome-devtools') >= 0 && /connect to chrome|chrome is running|not running|ECONNREFUSED/i.test(_emsg)) {
        try { await ensureOpenclawBrowser(); r = await callMcpTool(t.name, args); } catch (e2) { r = { status: 'ERROR', message: e2 && e2.message }; }
      }
      const okr = r && r.status === 'SUCCESS';
      const content = String(okr ? (r.content || '(no content)') : ('[mcp error] ' + ((r && (r.content || r.message)) || 'unknown')));
      (dropByGroup[gid] = dropByGroup[gid] || []).push({ toolCallId: t.id, content, toolResponseSummary: content.slice(0, 200), toolResponseStatus: okr ? 'SUCCESS' : 'ERROR' });
      cap({ dir: 'mcp_exec', native: t.name, status: okr ? 'SUCCESS' : 'ERROR' });
      continue;
    }
    const m = mapPostmanToolToClaude(t.name, args, ctx.opts.claudeTools);
    if (m.kind === 'client') {
      // Conform ten + khoa tham so sang dung schema client khai (file_path <-> path...).
      const claudeName = conformToolName(m.name, ctx.opts.claudeToolDefs);
      const input = conformInputToSchema(claudeName, m.input, ctx.opts.claudeToolDefs);
      clientCalls.push({ id: t.id, name: claudeName, input, groupId: t.groupId, nativeName: t.name });
      cap({ dir: 'emit', native: t.name, claude: claudeName, input });
    }
    else {
      const gid = t.groupId || '_';
      (dropByGroup[gid] = dropByGroup[gid] || []).push({ toolCallId: t.id, content: m.syntheticResult, toolResponseSummary: m.syntheticResult, toolResponseStatus: 'SUCCESS' });
      cap({ dir: 'drop', native: t.name, reason: m.reason });
      dbg('drop tool', t.name, '->', m.reason);
    }
  }

  if (clientCalls.length) {
    // Co tool cho client -> cat phan drop (neu co) de gop luot sau, phat tool_use roi DUNG (cho client).
    for (const gid of Object.keys(dropByGroup)) for (const r of dropByGroup[gid]) addPending(ctx.conversationId, gid === '_' ? null : gid, r);
    for (const c of clientCalls) {
      // Luu CA ten native Postman (postmanNative) lan ten Claude (nativeName) de chieu tra loi ve
      // nhan dien duoc askUser (postmanNative==='askUser') va xu ly rieng khi can.
      recordToolUse(c.id, { conversationId: ctx.conversationId, groupId: c.groupId, nativeName: c.name, postmanNative: c.nativeName });
      emitter.toolUse(c.id, c.name, c.input);
    }
    emitter.finish('tool_use');
    return;
  }

  const dropGroups = Object.keys(dropByGroup);
  if (dropGroups.length) {
    // Chi co tool bi drop -> proxy tu tra TOOL_RESPONSE (kem pending) roi tiep tuc vong.
    const gid = dropGroups[0];
    const merged = [...dropByGroup[gid], ...takePending(ctx.conversationId, gid === '_' ? null : gid)];
    // gop moi group con lai vao (hiem; Postman thuong 1 group/luot)
    for (const g of dropGroups.slice(1)) merged.push(...dropByGroup[g]);
    const next = buildBody('TOOL_RESPONSE', { conversationId: ctx.conversationId, toolCallGroupId: gid === '_' ? undefined : gid, toolResponses: merged });
    ctx.round += 1;
    return runGateway(token, next, emitter, ctx);
  }

  if (sawLoopApproval) {
    const next = buildBody('USER_CONTINUE_LOOP', { conversationId: ctx.conversationId });
    ctx.round += 1;
    return runGateway(token, next, emitter, ctx);
  }

  emitter.finish('end_turn');
}

// Hai loi gateway deu co nghia "ngu canh cu khong dung lai duoc nua", nhung khac nhau o
// cho co giu conversation hay khong:
//   TOOL_CALL_NOT_FOUND   - gateway bo tool-call, hoi thoai VAN CON  -> thu giu conversationId
//   CONVERSATION_NOT_FOUND - ca hoi thoai da mat                     -> BAT BUOC mo cai moi
const RECOVERABLE = new Set(['TOOL_CALL_NOT_FOUND', 'CONVERSATION_NOT_FOUND']);

/**
 * Chay gateway VA tu phuc hoi khi ngu canh tren gateway khong con dung duoc. Ta chuyen sang
 * USER_QUERY de hoi thoai CHAY TIEP, uu tien GIU conversationId (con ngu canh tren gateway); neu van
 * hong thi mo hoi thoai MOI kem transcript dung lai tu lich su client gui. Chi phuc hoi khi emitter
 * CHUA phat gi (loi failure den truoc content) de khong lam hong stream dang do.
 */
async function runGatewayResilient(token, gwBody, emitter, ctx, recov) {
  try {
    await runGateway(token, gwBody, emitter, ctx);
    return;
  } catch (e) {
    if (!RECOVERABLE.has(e.errorType) || emitter.started || !recov) throw e;
    const { turn, messages, key, model, opts } = recov;
    // Hoi thoai da mat han -> QUEN conversationId ngay, neu khong luot sau lai gui len
    // dung cai id chet do va lap vo han (da quan sat tren may that).
    const convGone = e.errorType === 'CONVERSATION_NOT_FOUND';
    if (convGone) { setSession(key, { conversationId: null }); cap({ dir: 'conversation_not_found', key }); }
    const conversationId = convGone ? null : recov.conversationId;
    const base = (turn.kind === 'tool_result')
      ? 'Ket qua tool:\n' + turn.results.map((r) => r.content).join('\n---\n')
      : (turn.text || '');
    cap({ dir: 'gateway_ctx_recover', errorType: e.errorType, keepConv: !!conversationId });
    dbg(e.errorType + ' -> phuc hoi bang USER_QUERY (giu conversationId=' + !!conversationId + ')');
    // Buoc 1: USER_QUERY tren CUNG conversation (giu ngu canh tren gateway).
    if (conversationId) {
      try {
        await runGateway(token, buildBody('USER_QUERY', { query: base.slice(0, QUERY_CAP), conversationId }), emitter, { conversationId, key, model, opts, round: 0 });
        return;
      } catch (e2) {
        if (!RECOVERABLE.has(e2.errorType) || emitter.started) throw e2;
        if (e2.errorType === 'CONVERSATION_NOT_FOUND') setSession(key, { conversationId: null });
      }
    }
    // Buoc 2: hoi thoai MOI + dung lai ngu canh tu lich su (guaranteed: conversation moi luon nhan USER_QUERY).
    const prior = CTX_REBUILD ? priorMessages(messages) : [];
    const cur = (turn.kind === 'tool_result') ? base : ('[Nguoi dung] ' + base);
    const budget = Math.max(1000, QUERY_CAP - CTX_HEADER.length - CTX_SEP.length - cur.length - 32);
    const ctxBlock = prior.length ? rebuildTranscript(prior, budget) : '';
    const q = ctxBlock ? (CTX_HEADER + ctxBlock + CTX_SEP + cur) : cur;
    cap({ dir: 'tool_call_not_found_recover_fresh', priorMsgs: prior.length, chars: ctxBlock.length });
    await runGateway(token, buildBody('USER_QUERY', { query: q.slice(0, QUERY_CAP), conversationId: null }), emitter, { conversationId: null, key, model, opts, round: 0 });
  }
}

/** Bo dem cho che do khong-stream: gom content thanh mot Messages object. */
class BufferEmitter {
  constructor({ model, messageId, inputTokens }) { this.model = model; this.messageId = messageId; this.inputTokens = inputTokens || 1; this.blocks = []; this.stopReason = 'end_turn'; this.outputTokens = 0; }
  start() {}
  thinkingDelta(t) { if (!t) return; const last = this.blocks[this.blocks.length - 1]; if (last && last.type === 'thinking') last.thinking += t; else this.blocks.push({ type: 'thinking', thinking: t, signature: THINKING_SIG }); }
  textDelta(t) { if (!t) return; const last = this.blocks[this.blocks.length - 1]; if (last && last.type === 'text') last.text += t; else this.blocks.push({ type: 'text', text: t }); this.outputTokens += estimateTokens(t); }
  toolUse(id, name, input) { this.blocks.push({ type: 'tool_use', id, name, input: input || {} }); this.outputTokens += estimateTokens(input); }
  finish(reason) { this.stopReason = reason; }
  error(msg) { this._error = String(msg); }
  setUsage() {}
  toMessage() {
    return {
      id: this.messageId, type: 'message', role: 'assistant', model: this.model,
      content: this.blocks.length ? this.blocks : [{ type: 'text', text: '' }],
      stop_reason: this.stopReason, stop_sequence: null,
      usage: { input_tokens: this.inputTokens, output_tokens: this.outputTokens },
    };
  }
}

// ------------------------------ HTTP glue ------------------------------
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 50 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); } data += c; });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const sendJson = (res, status, obj) => { const s = JSON.stringify(obj); res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) }); res.end(s); };
const anthropicError = (res, status, type, message) => sendJson(res, status, { type: 'error', error: { type, message } });

// --- CWD PROBE ------------------------------------------------------------------
// Client kieu Agent SDK (cc_entrypoint=sdk-ts) KHONG gui "Working directory:" trong system
// prompt va co the khong set header. Khi do proxy tu HOI client: phat 1 tool_use chay lenh
// in thu muc hien tai; client chay tren MAY CUA NO roi tra ket qua -> proxy hoc va cache.
// Tat bang PM_CWD_PROBE=0.
const PROBE_PREFIX = 'pmcwd_';
const PROBE_ENABLED = process.env.PM_CWD_PROBE !== '0';

// KHOI PHUC NGU CANH khi mat session (proxy restart / cache mat): tua dau va cach ngan giua
// phan ngu canh cu (dung lai tu lich su client gui) va luot moi. Tat bang PM_CTX_REBUILD=0.
const CTX_REBUILD = process.env.PM_CTX_REBUILD !== '0';
const CTX_HEADER = '[KHOI PHUC NGU CANH — phien truoc bi mat sau khi proxy khoi dong lai]\nDay la tom tat hoi thoai TRUOC DO (nguoi dung <-> tro ly). Hay doc de nam ngu canh, roi xu ly LUOT MOI o duoi.\n\n=== NGU CANH TRUOC DO ===\n';
const CTX_SEP = '\n\n=== LUOT MOI ===\n';

// Ky tu backslash dung bang ma (92) de ma nguon khong chua escape long nhau.
const BS = String.fromCharCode(92);
const RE_POSIX_DRIVE = new RegExp('^/([a-zA-Z])/(.*)$');          // /c/Users/x
const RE_DRIVE_SEP = new RegExp('^[a-zA-Z]:[/' + BS + BS + ']');  // C:/x hoac C:\x
const RE_WIN_ABS = new RegExp('^[A-Za-z]:' + BS + BS);
const RE_POSIX_ABS = new RegExp('^/[^/]');

/** Chuan hoa duong dan thu duoc ve dang Windows khi co the ('/c/x' va 'C:/x' -> 'C:' + BS + 'x'). */
function normalizeCwd(raw) {
  let t = String(raw == null ? '' : raw).trim();
  if (!t) return null;
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) t = t.slice(1, -1).trim();
  const m = t.match(RE_POSIX_DRIVE);
  if (m) t = m[1].toUpperCase() + ':' + BS + m[2].split('/').join(BS);
  else if (RE_DRIVE_SEP.test(t)) t = t[0].toUpperCase() + t.slice(1).split('/').join(BS);
  if (!(RE_WIN_ABS.test(t) || RE_POSIX_ABS.test(t))) return null;   // phai la duong dan tuyet doi
  while (t.length > 1 && (t.endsWith('/') || t.endsWith(BS))) t = t.slice(0, -1);
  return t || null;
}

/** Boc cwd tu noi dung tool_result: dong dau tien trong nhu duong dan tuyet doi. */
function extractCwdFromProbe(content) {
  const NL = String.fromCharCode(10);
  for (const line of String(content == null ? '' : content).split(NL)) {
    const n = normalizeCwd(line);   // normalizeCwd da trim (nuot luon CR)
    if (n) return n;
  }
  return null;
}

/** Chon tool de hoi cwd, dung DUNG ten client khai bao (khong doan). */
function pickProbeTool(toolDefs) {
  const byName = new Map();
  for (const t of toolDefs || []) { const n = t && t.name; if (n) byName.set(String(n).toLowerCase(), String(n)); }
  const desc = 'pm-ai-proxy: xac dinh thu muc lam viec';
  if (byName.has('powershell')) return { name: byName.get('powershell'), input: { command: '$PWD.Path', description: desc } };
  if (byName.has('bash')) return { name: byName.get('bash'), input: { command: 'pwd -W 2>/dev/null || pwd', description: desc } };
  return null;
}

/** Tra mot luot chi-co-tool_use (probe), ton trong stream/non-stream. */
function replyToolUse(res, { stream, model, id, name, input, inputTokens }) {
  const messageId = genMessageId();
  if (stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const sse = new AnthropicSSE(res, { model, messageId, inputTokens: inputTokens || 1 });
    sse.toolUse(id, name, input); sse.finish('tool_use'); res.end();
  } else {
    sendJson(res, 200, {
      id: messageId, type: 'message', role: 'assistant', model,
      content: [{ type: 'tool_use', id, name, input }],
      stop_reason: 'tool_use', stop_sequence: null,
      usage: { input_tokens: inputTokens || 1, output_tokens: estimateTokens(input) },
    });
  }
}

// Tra nhanh mot message chi-co-text (cho luot tien ich), ton trong stream/non-stream.
function replyText(res, { stream, model, text }) {
  const messageId = genMessageId();
  if (stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const sse = new AnthropicSSE(res, { model, messageId });
    sse.textDelta(text); sse.finish('end_turn'); res.end();
  } else {
    sendJson(res, 200, { id: messageId, type: 'message', role: 'assistant', model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: estimateTokens(text) } });
  }
}

async function handleMessages(req, res, body) {
  const token = readToken();
  if (!token) return anthropicError(res, 401, 'authentication_error', 'Chua co Postman token. Chay: node src/harvest.mjs (va mo Postman Desktop).');
  if (!loadTemplate()) return anthropicError(res, 503, 'api_error', 'Chua co chat template. Chat 1 cau trong Postman roi harvest lai.');

  const anthropicModel = body.model || 'claude-3-5-sonnet';
  const stream = body.stream !== false; // Claude Code luon stream; mac dinh true
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const system = body.system;
  capFull('claude-proxy-lastreq.json', { model: anthropicModel, stream, thinking: body.thinking || null, toolNames: (body.tools || []).map((t) => t && t.name), system: systemText(system).slice(0, 3000), messages });
  // Chan doan conform tham so: ghi nguyen van tools[] client khai (ten + input_schema tho)
  // de biet client dung khoa nao (file_path <-> path) va khai schema o truong nao.
  capFull('claude-proxy-tools.json', body.tools || []);
  try { const _fsSel = /^(exec|dir_list|dir_fetch|dir_[a-z]+|file_[a-z]+|read|write|edit|apply_patch|glob|grep|bash|terminal|process|web_fetch|web_search|ask_user)$/i; cap({ dir: 'toolset', model: anthropicModel, msgCount: messages.length, sysHead: systemText(system).slice(0, 90).replace(/\s+/g, ' '), tools: (body.tools || []).map((t) => t && t.name).filter(Boolean), schemas: (body.tools || []).filter((t) => t && _fsSel.test(t.name)).map((t) => ({ name: t.name, req: (t.input_schema || {}).required, props: Object.keys(((t.input_schema || {}).properties) || {}), addl: (t.input_schema || {}).additionalProperties })) }); } catch (e) {}

  // Luot tien ich (title-gen/quota, khong co tool) -> tra nhanh, KHONG dung gateway (khong dot credit).
  if (isUtilityTurn(body)) { const text = utilityReply(body); cap({ dir: 'utility', text }); return replyText(res, { stream, model: anthropicModel, text }); }
  const key = sessionKey(system, messages);
  // tool_choice: 'none' => coi nhu client khong khai tool nao (gateway se bi cat sach tool).
  const toolChoice = toolChoiceDirective(body.tool_choice, claudeToolSet(body.tools));
  const claudeTools = claudeToolSet(toolChoice.mode === 'none' ? [] : body.tools);
  let { dir: workingDir, source: cwdSource } = resolveWorkingDir(req, system);
  const sessCwd = getSession(key);
  if (!workingDir && sessCwd && sessCwd.cwd) { workingDir = sessCwd.cwd; cwdSource = 'probe-cache'; }
  const thinking = thinkingFlag(body);

  let pmModelKey = null;
  try { const ml = await listModels(); pmModelKey = mapModel(anthropicModel, (ml && ml.models) || []); } catch {}
  dbg('turn', analyzeRequest(body).kind, '- key', key, '- model', anthropicModel, '->', pmModelKey || '(template default)', '- cwd', workingDir ? `${workingDir} (${cwdSource})` : '(template)', '- thinking', thinking === true ? 'ON' : (body.thinking ? JSON.stringify(body.thinking) : 'OFF'));

  let turn = analyzeRequest(body);
  // Luot client tra ket qua PROBE -> hoc cwd, roi phat lai cau hoi goc da cat.
  if (turn.kind === 'tool_result') {
    const probe = turn.results.find((r) => String(r.toolUseId || '').startsWith(PROBE_PREFIX));
    if (probe) {
      const learned = probe.isError ? null : extractCwdFromProbe(probe.content);
      const st = getSession(key) || {};
      if (learned) { setSession(key, { cwd: learned }); workingDir = learned; cwdSource = 'probe'; }
      cap({ dir: 'cwd_probe_result', learned: learned || null, isError: !!probe.isError, raw: String(probe.content).slice(0, 200) });
      dbg('cwd probe ->', learned || '(khong doc duoc)');
      const rest = turn.results.filter((r) => r !== probe);
      const firstUser = messages.find((m) => m && m.role === 'user');
      const replay = (st.probeQuery || '').trim() || contentText(firstUser && firstUser.content).trim();
      setSession(key, { probeQuery: '' });
      turn = rest.length ? { kind: 'tool_result', results: rest } : { kind: 'user_query', text: replay };
    }
  }
  cap({ dir: 'in', kind: turn.kind, model: anthropicModel, stream, toolCount: (body.tools || []).length, workingDir, msgCount: messages.length,
    msgs: messages.map((m) => ({ role: m.role, blocks: Array.isArray(m.content) ? m.content.map((b) => b.type || 'text') : 'string', preview: contentText(m.content).slice(0, 160) })) });

  // tool_choice any/tool: gateway khong co tham so ep goi tool -> ep bang chi dan trong query.
  if (toolChoice.hint && turn.kind === 'user_query') turn = { ...turn, text: toolChoice.hint + '\n' + (turn.text || '') };
  // An toan: khong bao gio gui USER_QUERY rong len gateway (bi 403 INPUT_VALIDATION_ERROR -> loap).
  if (turn.kind === 'user_query' && !String(turn.text || '').trim()) { cap({ dir: 'empty_query_skip' }); return replyText(res, { stream, model: anthropicModel, text: '' }); }
  // Chua biet cwd -> HOI client bang 1 tool_use. Chi thu MOT lan moi phien (tranh lap).
  if (PROBE_ENABLED && turn.kind === 'user_query' && !workingDir) {
    const st = getSession(key) || {};
    if (!st.cwdProbed) {
      const pt = pickProbeTool(body.tools);
      if (pt) {
        const pid = PROBE_PREFIX + genMessageId().slice(4, 18);
        setSession(key, { cwdProbed: true, probeQuery: String(turn.text || '').slice(0, QUERY_CAP) });
        cap({ dir: 'cwd_probe_out', tool: pt.name, id: pid });
        dbg('cwd probe -> hoi client qua', pt.name);
        return replyToolUse(res, { stream, model: anthropicModel, id: pid, name: pt.name, input: pt.input, inputTokens: estimateTokens(system, messages) });
      }
      setSession(key, { cwdProbed: true }); // client khong co Bash/PowerShell -> dung thu lai
    }
  }

  const opts = { workingDir, pmModelKey, claudeTools, claudeToolDefs: body.tools, thinking };
  const inputTokens = estimateTokens(system, messages);
  const messageId = genMessageId();

  // Dung body /chat cho vong DAU.
  let gwBody, conversationId = null;
  const sess = getSession(key);
  if (turn.kind === 'tool_result') {
    const { groups, unknown } = buildToolResponses(turn.results, getToolUse);
    // Nhan dien luot tra loi askUser: tool_use_id da luu co postmanNative==='askUser'.
    const askUserAnswers = turn.results
      .map((r) => ({ r, info: getToolUse(r.toolUseId) }))
      .filter((x) => x.info && x.info.postmanNative === 'askUser');
    cap({ dir: 'tool_result_in', results: turn.results.map((r) => ({ id: r.toolUseId, known: !!getToolUse(r.toolUseId), askUser: !!(getToolUse(r.toolUseId) || {}).postmanNative && (getToolUse(r.toolUseId) || {}).postmanNative === 'askUser' })), unknown });
    if (askUserAnswers.length) {
      // Tap chieu tra loi ve askUser: ghi DUNG noi dung Sep chon de doi chieu format gateway can.
      cap({ dir: 'askuser_answer', answers: askUserAnswers.map((x) => ({ toolUseId: x.r.toolUseId, known: !!x.info, isError: x.r.isError, content: String(x.r.content).slice(0, 600) })) });
    }
    const groupIds = Object.keys(groups);
    if (!groupIds.length) {
      // Khong map duoc tool_use_id (vd proxy vua khoi dong lai) -> gui nhu USER_QUERY text.
      conversationId = sess && sess.conversationId;
      // Glitch #1: neu day la cau tra loi menu askUser ma id da mat (proxy restart), goi ro rang
      // de gateway hieu day la LUA CHON cua nguoi dung, khong phai ket qua tool chung chung.
      const looksAskUser = askUserAnswers.length > 0
        || turn.results.some((r) => /"AskUserQuestion"|\bchoose\b|"answer"|selectedOption/i.test(String(r.content)));
      let text = looksAskUser
        ? 'Nguoi dung da chon (tra loi cau hoi askUser truoc do):\n' + turn.results.map((r) => r.content).join('\n---\n')
        : 'Ket qua tool:\n' + turn.results.map((r) => r.content).join('\n---\n');
      // MAT SESSION: khong map duoc tool_use_id VA khong con conversationId -> hoi thoai cu da mat.
      // Client (Anthropic stateless) van gui full lich su -> dung lai ngu canh va MO LAI hoi thoai,
      // thay vi gui mot 'Ket qua tool: ...' tro trong khien model mat phuong huong.
      if (CTX_REBUILD && !conversationId) {
        const prior = priorMessages(messages);
        if (prior.length) {
          const budget = Math.max(1000, QUERY_CAP - CTX_HEADER.length - CTX_SEP.length - text.length - 32);
          const ctxBlock = rebuildTranscript(prior, budget);
          if (ctxBlock) { text = CTX_HEADER + ctxBlock + CTX_SEP + text; cap({ dir: 'context_rebuilt', from: 'tool_result', priorMsgs: prior.length, chars: ctxBlock.length }); dbg('mat session -> dung lai ngu canh tu', prior.length, 'message (tool_result)'); }
        }
      }
      if (looksAskUser) cap({ dir: 'askuser_answer_fallback', note: 'unknown tool_use_id -> goi thanh USER_QUERY lua chon', preview: text.slice(0, 400) });
      gwBody = buildBody('USER_QUERY', { query: text.slice(0, QUERY_CAP), conversationId });
    } else {
      const gid = groupIds[0];
      const grp = groups[gid];
      conversationId = grp.conversationId || (sess && sess.conversationId) || null;
      const merged = [...grp.toolResponses, ...takePending(conversationId, grp.groupId)];
      for (const extra of groupIds.slice(1)) merged.push(...groups[extra].toolResponses); // hiem: >1 group
      gwBody = buildBody('TOOL_RESPONSE', { conversationId, toolCallGroupId: grp.groupId || undefined, toolResponses: merged });
      if (unknown.length) dbg('tool_result khong ro id:', unknown.join(','));
    }
  } else {
    conversationId = sess && sess.conversationId;
    let query = turn.text || '';
    if (!conversationId) {
      const prior = CTX_REBUILD ? priorMessages(messages) : [];
      if (prior.length) {
        // MAT SESSION giua chung hoi thoai (co assistant truoc do nhung khong con conversationId)
        // -> mo lai ngu canh tu lich su day du client gui, roi noi luot moi vao cuoi.
        const cur = '[Nguoi dung] ' + query;
        const budget = Math.max(1000, QUERY_CAP - CTX_HEADER.length - CTX_SEP.length - cur.length - 32);
        const ctxBlock = rebuildTranscript(prior, budget);
        if (ctxBlock) { query = CTX_HEADER + ctxBlock + CTX_SEP + cur; cap({ dir: 'context_rebuilt', from: 'user_query', priorMsgs: prior.length, chars: ctxBlock.length }); dbg('mat session -> dung lai ngu canh tu', prior.length, 'message (user_query)'); }
      } else {
        query = buildToolCard({ workingDir, claudeToolNames: claudeTools, userRules: readUserRules() }) + '\n\n' + query; // card 1 lan dau hoi thoai
      }
    }
    gwBody = buildBody('USER_QUERY', { query: query.slice(0, QUERY_CAP), conversationId: conversationId || null });
  }

  cap({ dir: 'query_out', chatType: gwBody.input && gwBody.input.chatType, conversationId, queryPreview: (gwBody.input && gwBody.input.query || '').slice(0, 400) });
  const ctx = { conversationId, key, model: anthropicModel, opts, round: 0, signal: undefined };

  if (stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const emitter = new AnthropicSSE(res, { model: anthropicModel, messageId, inputTokens,
      // Tap SSE tho chi khi DEBUG_PROXY (tranh ghi dia nhieu trong phien binh thuong).
      onSend: DEBUG ? (event, data) => { if (event !== 'content_block_delta' || (data.delta && data.delta.type === 'input_json_delta')) cap({ dir: 'sse_out', event, data }); } : null });
    try {
      await runGatewayResilient(token, gwBody, emitter, ctx, { turn, messages, key, model: anthropicModel, opts, conversationId });
      if (!emitter.stopped) emitter.finish('end_turn');
    } catch (e) {
      log('stream error:', e.message, e.errorType ? '(' + e.errorType + ')' : '');
      cap({ dir: 'stream_error', message: e.message, errorType: e.errorType, status: e.status });
      if (!emitter.started) emitter.start();
      emitter.error(e.message || 'proxy error');
    }
    res.end();
  } else {
    const emitter = new BufferEmitter({ model: anthropicModel, messageId, inputTokens });
    try {
      await runGatewayResilient(token, gwBody, emitter, ctx, { turn, messages, key, model: anthropicModel, opts, conversationId });
      sendJson(res, 200, emitter.toMessage());
    } catch (e) {
      log('error:', e.message);
      anthropicError(res, e.status && e.status >= 400 && e.status < 500 ? e.status : 500, 'api_error', e.message || 'proxy error');
    }
  }
}

function handleCountTokens(res, body) {
  const n = estimateTokens(body.system, body.messages, body.tools);
  sendJson(res, 200, { input_tokens: n });
}

async function handleModels(res) {
  let models = [];
  try { const ml = await listModels(); models = (ml && ml.models) || []; } catch {}
  // Mot route phuc vu ca hai dang: Anthropic doc type/display_name, OpenAI doc object/owned_by.
  const oai = toOpenAIModels(models);
  const data = oai.data.map((m, i) => ({ ...m, type: 'model', display_name: (models[i] && models[i].name) || m.id }));
  sendJson(res, 200, { object: 'list', data, has_more: false });
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || '').split('?')[0];
  try {
    if (req.method === 'GET' && (url === '/health' || url === '/')) return sendJson(res, 200, { ok: true, service: 'pm-ai-proxy', gateway: GATEWAY, token: !!readToken(), template: !!loadTemplate() });
    if (req.method === 'GET' && url === '/v1/models') return handleModels(res);
    if (req.method === 'POST' && url === '/v1/messages') return handleMessages(req, res, await readJsonBody(req));
    // Tuong thich OpenAI: dich request/response, dung chung duong ong cua /v1/messages.
    if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/chat/completions')) return handleChatCompletions(req, res, await readJsonBody(req), handleMessages);
    if (req.method === 'POST' && (url === '/v1/messages/count_tokens' || url === '/v1/messages/count-tokens')) return handleCountTokens(res, await readJsonBody(req));
    anthropicError(res, 404, 'not_found_error', `No route ${req.method} ${url}`);
  } catch (e) {
    log('request error:', e && e.message);
    if (!res.headersSent) anthropicError(res, 400, 'invalid_request_error', (e && e.message) || 'bad request');
    else try { res.end(); } catch {}
  }
});

export function startServer(port = PORT, host = HOST) {
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      log(`nghe tai http://${host}:${port}  (gateway ${GATEWAY})`);
      log(`token=${readToken() ? 'co' : 'KHONG'} - template=${loadTemplate() ? 'co' : 'KHONG'}`);
      // Sinh lai rules.md neu ~/.claude/CLAUDE.md hoac ~/.claude/rules/ da doi. Chay nen:
      // hong hay cham deu khong duoc chan proxy khoi dong.
      ensureRules()
        .then((r) => {
          if (r.action === 'written') log(`rules=da sinh lai (${r.reason}) - ${readUserRules().length} ky tu (${RULES_FILE})`);
          else if (r.action === 'failed') log(`rules=KHONG sinh lai duoc (${r.reason}), giu ban cu`);
          else if (r.reason === 'user') log(`rules=ban tu viet tay, khong ghi de (${RULES_FILE})`);
          else if (r.reason === 'no-source') log('rules=KHONG co nguon ~/.claude/CLAUDE.md');
          else log(`rules=${readUserRules().length} ky tu, khop nguon (${RULES_FILE})`);
        })
        .catch(() => {});
      log('Tro Claude Code:  set ANTHROPIC_BASE_URL=http://' + host + ':' + port + '  &&  set ANTHROPIC_API_KEY=pm-proxy  &&  claude');
      resolve(server);
    });
  });
}

export { server, handleMessages, runGateway, runGatewayResilient, prepBody, thinkingFlag, BufferEmitter };

// Chay truc tiep: node src/server.mjs  (launcher src/claude-proxy.mjs goi startServer rieng).
const invoked = process.argv[1] && /(?:^|[\\/])server\.mjs$/.test(process.argv[1].replace(/\\/g, '/'));
if (invoked) startServer();
