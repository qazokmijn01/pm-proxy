/**
 * WINDOWS POSTMAN AGENT — CORE dùng chung cho harvest.mjs / agent.mjs / ui.mjs
 *
 * Cơ chế Windows (khác bản Mac dùng pipe fd 3/4): Postman 12+ vẫn bật remote-debugging
 * nhưng ép về cổng NGẪU NHIÊN. Ta tự dò cổng CDP mà tiến trình Postman ĐANG chạy lắng
 * nghe, gắn puppeteer-core vào renderer để bắt token + template /chat, rồi replay /chat.
 *
 * ⚠️ API nội bộ chưa công khai của Postman — có thể đổi bất cứ lúc nào; tiêu thụ credit AI.
 */
import puppeteer from 'puppeteer-core';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTool, summarizeTool } from './tools.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const CACHE_DIR = path.join(os.homedir(), '.postman-agent-cli');
export const TOKEN_CACHE = path.join(CACHE_DIR, 'token');
export const TEMPLATE_FILE = path.join(__dirname, '.chat-template.json');
export const IMAGE_SAMPLE_FILE = path.join(__dirname, '.chat-image-sample.json');
export const GATEWAY = process.env.PM_GATEWAY || 'https://gateway.postman.com';
export const APP_VERSION_FALLBACK = process.env.PM_APP_VERSION || '12.22.6';

export const mask = (t) => (t ? t.slice(0, 8) + '…(' + t.length + ' ký tự)' : '(none)');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function readToken() { try { return fs.readFileSync(TOKEN_CACHE, 'utf8').trim() || null; } catch { return null; } }
export function saveToken(t) { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(TOKEN_CACHE, t, { mode: 0o600 }); }
export function loadTemplate() { try { return JSON.parse(fs.readFileSync(TEMPLATE_FILE, 'utf8')); } catch { return null; } }
export function saveTemplate(cap) { fs.writeFileSync(TEMPLATE_FILE, JSON.stringify(cap, null, 2)); }

// Hook wrap fetch/XHR — bắt x-access-token + payload /chat thật của app làm template.
export const HOOK = `(function(){
  if (window.__PM_HOOKED__) return 'already';
  window.__PM_HOOKED__ = true;
  window.__PM_TOKEN__ = window.__PM_TOKEN__ || null;
  window.__PM_CHAT_CAPTURE__ = window.__PM_CHAT_CAPTURE__ || null;
  try { const of = window.fetch;
    window.fetch = function(input, init){
      try {
        const h = new Headers((init && init.headers) || (input && input.headers) || {});
        const t = h.get('x-access-token'); if (t) window.__PM_TOKEN__ = t;
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (/\\/chat(\\?|$)/.test(url) && init && init.body && String(init.body).includes('"chatType"')) {
          try {
            const body = JSON.parse(init.body);
            const hdrs = {}; h.forEach((v,k)=>{hdrs[k]=v;});
            delete hdrs['x-access-token']; delete hdrs['authorization'];
            window.__PM_CHAT_CAPTURE__ = { at: new Date().toISOString(), headers: hdrs, body: body };
          } catch(e){}
        }
      } catch(e){}
      return of.apply(this, arguments);
    };
  } catch(e){}
  try { const ox = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function(k,v){
      if (/^x-access-token$/i.test(k)) window.__PM_TOKEN__ = v;
      return ox.apply(this, arguments);
    };
  } catch(e){}
  return 'hooked';
})()`;

// Hook PHỤ (độc lập với HOOK) — bắt request liên quan ẢNH/đính kèm + payload /chat có ảnh.
// Base64/data-URI được REDACT (chỉ giữ độ dài + đầu chuỗi) để file mẫu gọn & dễ đọc.
export const IMAGE_HOOK = `(function(){
  if (window.__PM_IMG_HOOKED__) return 'already';
  window.__PM_IMG_HOOKED__ = true;
  window.__PM_CHAT_IMAGE_CAPTURE__ = window.__PM_CHAT_IMAGE_CAPTURE__ || null;
  window.__PM_CAPTURES__ = window.__PM_CAPTURES__ || [];
  function pmRedact(v, d){
    d = d || 0;
    if (v == null) return v;
    var t = typeof v;
    if (t === 'string') return v.length > 200 ? ('<string len=' + v.length + ' head=' + v.slice(0, 100) + '>') : v;
    if (t === 'number' || t === 'boolean') return v;
    if (Array.isArray(v)) { if (d > 7) return '<array ' + v.length + '>'; return v.slice(0, 40).map(function(x){ return pmRedact(x, d + 1); }); }
    if (t === 'object') { if (d > 7) return '<object>'; var o = {}, n = 0, k; for (k in v) { if (Object.prototype.hasOwnProperty.call(v, k)) { o[k] = pmRedact(v[k], d + 1); if (++n > 80) { o.__more__ = '<truncated>'; break; } } } return o; }
    return String(v);
  }
  function pmImagey(url, ct, body){
    url = (url || '').toLowerCase(); ct = (ct || '').toLowerCase(); body = body || '';
    if (ct.indexOf('image/') >= 0) return true;
    if (ct.indexOf('multipart/form-data') >= 0 && /(filename|image|png|jpeg|jpg|gif|webp|blob)/i.test(body)) return true;
    if (url.indexOf('upload') >= 0 || url.indexOf('attachment') >= 0 || url.indexOf('blob') >= 0 || url.indexOf('media') >= 0 || url.indexOf('image') >= 0) return true;
    if (body.indexOf('data:image/') >= 0) return true;
    if (/"(image|imageUrl|image_url|imageData|attachment|attachments|media|screenshot|mimeType|images|fileId|assetId)"/.test(body)) return true;
    return false;
  }
  function pmFD(fd){ var names = []; try { fd.forEach(function(val, key){ names.push(key + (val && val.name ? '(' + val.name + ',' + (val.type || '') + ',' + (val.size || '?') + 'b)' : '')); }); } catch(e){} return 'FormData{ ' + names.join(', ') + ' }'; }
  function pmHandle(url, method, ct, body, isFD){
    try {
      if (!pmImagey(url, ct, body)) return;
      var rec = { at: new Date().toISOString(), url: url, method: method || 'GET', contentType: ct || '', formData: !!isFD, bodyPreview: (body || '').slice(0, 600) };
      if (!isFD && body && (body.charAt(0) === '{' || body.charAt(0) === '[')) { try { rec.redactedBody = pmRedact(JSON.parse(body)); } catch(e){} }
      window.__PM_CAPTURES__.push(rec);
      while (window.__PM_CAPTURES__.length > 40) window.__PM_CAPTURES__.shift();
      if (!isFD && body && body.indexOf('chatType') >= 0) {
        try { window.__PM_CHAT_IMAGE_CAPTURE__ = { at: rec.at, url: url, redactedBody: pmRedact(JSON.parse(body)) }; } catch(e){}
      }
    } catch(e){}
  }
  try {
    var of = window.fetch;
    window.fetch = function(input, init){
      try {
        var h = new Headers((init && init.headers) || (input && input.headers) || {});
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        var ct = h.get('content-type') || '';
        var method = (init && init.method) || 'GET';
        var body = init && init.body;
        var isFD = (typeof FormData !== 'undefined') && body && body instanceof FormData;
        var bstr = isFD ? pmFD(body) : (typeof body === 'string' ? body : '');
        pmHandle(url, method, ct, bstr, isFD);
      } catch(e){}
      return of.apply(this, arguments);
    };
  } catch(e){}
  try {
    var oopen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(m, u){ try { this.__pm_m = m; this.__pm_u = u; } catch(e){} return oopen.apply(this, arguments); };
    var oset = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function(k, v){ try { if (String(k).toLowerCase() === 'content-type') this.__pm_ct = v; } catch(e){} return oset.apply(this, arguments); };
    var osend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function(bd){
      try {
        var isFD = (typeof FormData !== 'undefined') && bd && bd instanceof FormData;
        var bstr = isFD ? pmFD(bd) : (typeof bd === 'string' ? bd : '');
        pmHandle(this.__pm_u || '', this.__pm_m || 'GET', this.__pm_ct || '', bstr, isFD);
      } catch(e){}
      return osend.apply(this, arguments);
    };
  } catch(e){}
  return 'img-hooked';
})()`;

// ---------------- Dò cổng CDP ----------------
function ps(cmd) { return execSync(`powershell -NoProfile -Command "${cmd}"`, { timeout: 15000 }).toString().trim(); }

export function postmanPids() {
  try {
    const out = ps("(Get-Process Postman -ErrorAction SilentlyContinue).Id -join ','");
    return out ? out.split(',').map((s) => parseInt(s, 10)).filter(Boolean) : [];
  } catch { return []; }
}

export function postmanListeningPorts() {
  const pids = postmanPids();
  if (!pids.length) return [];
  try {
    const filter = pids.join(',');
    const cmd = `$pids=@(${filter}); Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $pids -contains $_.OwningProcess -and ($_.LocalAddress -eq '127.0.0.1' -or $_.LocalAddress -eq '0.0.0.0') } | ForEach-Object { $_.LocalPort }`;
    const out = ps(cmd);
    return [...new Set(out.split(/\s+/).map((s) => parseInt(s, 10)).filter(Boolean))];
  } catch { return []; }
}

export function devToolsActivePortCandidates() {
  const out = [];
  for (const base of [process.env.APPDATA, process.env.LOCALAPPDATA]) {
    if (!base) continue;
    try { const p = parseInt(fs.readFileSync(path.join(base, 'Postman', 'DevToolsActivePort'), 'utf8').split('\n')[0].trim(), 10); if (p) out.push(p); } catch {}
  }
  return out;
}

export async function isPostmanCdp(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return false;
    const j = await r.json();
    return /Postman|Electron/i.test((j['User-Agent'] || '') + (j.Browser || ''));
  } catch { return false; }
}

export async function detectPort(force) {
  if (force) return parseInt(force, 10);
  const candidates = [...postmanListeningPorts(), ...devToolsActivePortCandidates()];
  for (const p of candidates) { if (await isPostmanCdp(p)) return p; }
  return null;
}

// ---------------- Harvest token + template ----------------
export async function harvest({ port = null, timeout = 90, watch = false, requireTemplate = false, log = () => {} } = {}) {
  const cdpPort = await detectPort(port);
  if (!cdpPort) throw new Error('Không tìm thấy cổng CDP của Postman. Hãy chắc chắn Postman đang mở.');
  log(`Cổng CDP: ${cdpPort}`);
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${cdpPort}`, defaultViewport: null, protocolTimeout: 60000 });

  async function injectAll() {
    const pages = await browser.pages();
    let n = 0;
    for (const p of pages) { try { await p.evaluate(HOOK); try { await p.evaluateOnNewDocument(HOOK); } catch {} n++; } catch {} }
    return n;
  }
  await injectAll();
  log('Đã gắn hook. Đang chờ token…');

  const t0 = Date.now();
  let token = null, template = loadTemplate();
  try {
    for (;;) {
      const pages = await browser.pages();
      let capture = null;
      for (const p of pages) {
        try {
          const r = await p.evaluate(() => ({ t: window.__PM_TOKEN__ || null, c: window.__PM_CHAT_CAPTURE__ || null }));
          if (r.t) token = r.t;
          if (r.c && r.c.body) capture = r.c;
        } catch {}
      }
      if (token) { const cur = readToken(); if (token !== cur) { saveToken(token); log('Đã lưu token: ' + mask(token)); } }
      if (capture) { const chatType = capture.body.input && capture.body.input.chatType; saveTemplate(capture); template = capture; log('Đã chụp template /chat (chatType=' + chatType + ')'); }
      const enough = token && (!requireTemplate || template);
      if (!watch && enough) { if (template || Date.now() - t0 > 8000) break; }
      if (Date.now() - t0 > timeout * 1000) break;
      await sleep(1500);
    }
  } finally {
    if (!watch) browser.disconnect();
  }
  return { port: cdpPort, token, template, browser: watch ? browser : null };
}

// ---------------- Bắt mẫu payload có ẢNH (để xem field/định dạng gateway nhận) ----------------
// KHÔNG ghi đè .chat-template.json. Chờ tối đa `timeout` giây cho tới khi thấy /chat có ảnh.
// Trả về { file, sample } với base64 đã redact. Lưu ra .chat-image-sample.json.
export async function harvestImageSample({ port = null, timeout = 120, log = () => {} } = {}) {
  const cdpPort = await detectPort(port);
  if (!cdpPort) throw new Error('Không tìm thấy cổng CDP của Postman. Hãy chắc chắn Postman đang mở.');
  log('Cổng CDP: ' + cdpPort);
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${cdpPort}`, defaultViewport: null, protocolTimeout: 60000 });
  const inject = async () => {
    const pages = await browser.pages();
    for (const p of pages) {
      try { await p.evaluate(HOOK); } catch {}
      try { await p.evaluate(IMAGE_HOOK); } catch {}
      try { await p.evaluateOnNewDocument(HOOK); } catch {}
      try { await p.evaluateOnNewDocument(IMAGE_HOOK); } catch {}
    }
  };
  await inject();
  log('Đã gắn hook ảnh. HÃY paste/đính kèm 1 ẢNH trong Agent Mode (app Postman) rồi GỬI…');

  const t0 = Date.now();
  let img = null, captures = [];
  try {
    for (;;) {
      const pages = await browser.pages();
      for (const p of pages) {
        try {
          const r = await p.evaluate(() => ({ t: window.__PM_TOKEN__ || null, img: window.__PM_CHAT_IMAGE_CAPTURE__ || null, caps: window.__PM_CAPTURES__ || [] }));
          if (r.t) { const cur = readToken(); if (r.t !== cur) saveToken(r.t); }
          if (r.img && r.img.redactedBody) img = r.img;
          if (Array.isArray(r.caps) && r.caps.length) captures = r.caps;
        } catch {}
      }
      if (img) { log('Đã bắt được payload /chat có ảnh.'); break; }
      if (Date.now() - t0 > timeout * 1000) { log('Hết thời gian chờ (chưa thấy /chat có ảnh).'); break; }
      await sleep(1500);
    }
  } finally {
    try { browser.disconnect(); } catch {}
  }

  const sample = { at: new Date().toISOString(), found: !!img, chatWithImage: img, otherImageRequests: captures };
  try { fs.writeFileSync(IMAGE_SAMPLE_FILE, JSON.stringify(sample, null, 2)); } catch {}
  return { file: IMAGE_SAMPLE_FILE, sample };
}

// ---------------- Chat relay ----------------
const DEFAULT_WORKSPACE_ID = process.env.PM_WORKSPACE_ID || null;
// Tool có tác động (ghi/chạy lệnh/gửi request) — ở chế độ Ask sẽ hỏi duyệt trước khi chạy.
export const MUTATING_TOOLS = new Set(['createFile', 'editFile', 'executeShellCommand', 'sendRequest']);
// Tool cần "gate" ở chế độ Ask/Plan: tool ghi/chạy/gửi + MỌI tool MCP (mcp__*) vì có thể gây tác động.
export const isGatedTool = (name) => MUTATING_TOOLS.has(name) || (typeof name === 'string' && name.startsWith('mcp__'));

export function applyMode(body, mode) {
  if (!body) return body;
  const dm = (body.devModeOptions = body.devModeOptions || {});
  const ct = (body.clientTools = body.clientTools || {});
  let excluded = Array.isArray(ct.excludedTools) ? ct.excludedTools.slice() : [];
  if (mode === 'ask') {
    dm.supportsAskUser = true;
    excluded = excluded.filter((t) => t !== 'askUser');
  } else {
    dm.supportsAskUser = false;
    if (!excluded.includes('askUser')) excluded.push('askUser');
  }
  if (mode === 'plan') {
    dm.supportsAskUser = true;
    excluded = excluded.filter((t) => t !== 'askUser');
    for (const mt of ['createFile', 'editFile', 'executeShellCommand', 'sendRequest']) if (!excluded.includes(mt)) excluded.push(mt);
  }
  dm.isLoopApprovalEnabled = false; // tự gate ở phía tool, không dùng loop-approval của gateway
  ct.excludedTools = excluded;
  return body;
}

export function buildBody(chatType, extraInput = {}) {
  const tpl = loadTemplate();
  const tplProduct = (tpl && tpl.body && tpl.body.input && tpl.body.input.product) || 'workspace_v12';
  const input = { chatType, query: extraInput.query ?? '', useCase: null, conversationId: extraInput.conversationId ?? null, product: tplProduct, ...extraInput };
  if (tpl && tpl.body) {
    const base = JSON.parse(JSON.stringify(tpl.body));
    base.input = { ...input };
    if (base.devModeOptions) base.devModeOptions.isLoopApprovalEnabled = false;
    return base;
  }
  return {
    input,
    platform: 'DESKTOP_WINDOWS',
    clientTools: { native: [], thirdParty: [], excludedTools: [], nativeToolsHash: null },
    availableSkills: [],
    mandatoryContext: { currentView: 'list', workspaceId: DEFAULT_WORKSPACE_ID, selectedWorkspaceId: DEFAULT_WORKSPACE_ID, selectedSystemEnvironmentId: null },
    selectedContext: [], backgroundContext: [],
    devModeOptions: { selectedModel: null, isParallelToolCallingSupported: true, autoRun: true, supportsAskUser: false, supportsActionRecommendations: true, useThinkingModeIfAvailable: false, thinkingLevel: null, isLoopApprovalEnabled: false, enableWebAccess: false },
  };
}

function chatHeaders(token) {
  const tpl = loadTemplate();
  return {
    'x-access-token': token,
    'x-pstmn-req-service': 'agent-mode-service',
    'x-app-version': (tpl && tpl.headers && tpl.headers['x-app-version']) || APP_VERSION_FALLBACK,
    'Content-Type': 'application/json',
  };
}

/**
 * Gọi /chat, stream SSE, phát sự kiện chuẩn hoá qua send({type,...}).
 * Điểm mấu chốt (streaming format postman-agentmode-2025-06-25): tool call phát dưới dạng
 * toolCallChunk (arguments theo mảnh) rồi [DONE]. Ta GOM theo id → khi hết stream mà còn
 * tool chờ, THỰC THI tool đọc trong thư mục workspace rồi trả TOOL_RESPONSE (theo group)
 * để agent chạy tiếp. ctx: { conversationId, workingDir, signal, onConversationId, toolRounds }
 */
export async function chatRoundtrip(token, body, send, depth = 0, ctx = {}) { if (ctx.applyContext) { try { ctx.applyContext(body); } catch {} }
  const res = await fetch(`${GATEWAY}/chat`, { method: 'POST', signal: ctx.signal, headers: chatHeaders(token), body: JSON.stringify(body) });
  if (!res.ok) { const text = await res.text().catch(() => ''); const e = new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`); e.status = res.status; throw e; }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', modelShown = false, done = false;
  const toolAcc = {};   // id -> { id, name, groupId, args }
  const order = [];

  const handle = async (type, d) => {
    switch (type) {
      case 'conversation':
        if (d && d.id) { ctx.conversationId = d.id; if (ctx.onConversationId) ctx.onConversationId(d.id); send({ type: 'conversation', conversationId: d.id }); }
        break;
      case 'textChunk': {
        const t = (d && (d.textContent || d.text || d.delta || d.content)) || '';
        const mdl = d && d.metadata && d.metadata.model;
        if (mdl && mdl !== 'none' && !modelShown) { modelShown = true; send({ type: 'model', model: mdl }); }
        if (t) send({ type: 'text', text: t });
        break;
      }
      case 'thinkingChunk': { const t = (d && (d.thinkingContent || d.thinking || d.text || d.textContent)) || ''; if (t) send({ type: 'thinking', text: t }); break; }
      case 'planningChunk': { const t = d && (d.textContent || d.text); if (t) send({ type: 'plan', text: t }); break; }
      case 'toolCallChunk': {
        const calls = (d && d.toolCalls) || [];
        for (const c of calls) {
          if (!c || !c.id) continue;
          let a = toolAcc[c.id];
          if (!a) { a = { id: c.id, name: (c.function && c.function.name) || c.name || 'tool', groupId: c.toolCallGroupId || (d && d.toolCallGroupId) || null, args: '' }; toolAcc[c.id] = a; order.push(c.id); send({ type: 'tool', name: a.name, note: 'agent gọi tool…' }); }
          if (c.function && c.function.name) a.name = c.function.name;
          if (c.function && typeof c.function.arguments === 'string') a.args += c.function.arguments;
        }
        break;
      }
      case 'toolCall': {
        const id = d && (d.toolCallId || d.id);
        if (id && !toolAcc[id]) { toolAcc[id] = { id, name: (d.toolName || d.name || 'tool'), groupId: d.toolCallGroupId || null, args: d.arguments != null ? (typeof d.arguments === 'string' ? d.arguments : JSON.stringify(d.arguments)) : '' }; order.push(id); }
        break;
      }
      case 'loopApprovalChunk':
        send({ type: 'status', text: '🔁 Checkpoint — tự động Continue' });
        if (depth < 10) await chatRoundtrip(token, buildBody('USER_CONTINUE_LOOP', { conversationId: ctx.conversationId }), send, depth + 1, ctx).catch(() => {});
        break;
      case 'usage': if (d) send({ type: 'usage', usage: d.usage, limit: d.limit, state: d.usageState }); break;
      case 'notification': if (d && (d.heading || d.content)) send({ type: 'notice', text: `${d.heading || ''} ${d.content || ''}`.trim() }); break;
      case 'progressUpdate': break;
      case 'failure': { const e = new Error((d && (d.userMessage || d.message)) || 'Stream failure'); e.errorType = d && d.errorType; throw e; }
      default: send({ type: 'debug', eventType: type, data: d });
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
      await handle(evt.eventType, evt.data);
    }
    if (done) break;
  }

  // Hết stream: nếu còn tool đang chờ → chạy tool đọc rồi trả TOOL_RESPONSE để agent tiếp tục.
  const ids = order.filter((id) => toolAcc[id]);
  if (ids.length && depth < 10) {
    const groups = {};
    for (const id of ids) { const t = toolAcc[id]; const g = t.groupId || '_'; (groups[g] = groups[g] || []).push(t); }
    for (const gid of Object.keys(groups)) {
      const toolResponses = [];
      for (const t of groups[gid]) {
        let args = {};
        try { args = t.args ? JSON.parse(t.args) : {}; } catch { args = {}; }
        send({ type: 'tool', name: t.name, args: t.args || '', note: (t.name === 'askUser' ? 'đang hỏi bạn…' : (ctx.mode === 'ask' && isGatedTool(t.name) ? 'chờ bạn duyệt…' : 'đang chạy trên server (thư mục workspace)…')) });
        let result;
        if (t.name === 'askUser' && ctx.askUser) {
          const q = args.question || args.prompt || args.message || args.text || 'Agent cần thêm thông tin.';
          const ans = await ctx.askUser({ question: q, options: args.options || null });
          result = { status: 'SUCCESS', answer: (ans && ans.answer) || '' };
        } else if (ctx.mode === 'plan' && isGatedTool(t.name)) {
          result = { status: 'REJECTED', message: 'Chế độ Plan: chỉ lập kế hoạch, chưa thực thi tool ghi/chạy lệnh/gửi request/MCP. Hãy nêu kế hoạch rồi chuyển Auto/Ask để chạy.' };
        } else if (ctx.mode === 'ask' && isGatedTool(t.name) && ctx.requestApproval) {
          const dec = await ctx.requestApproval({ name: t.name, args: t.args || '' });
          result = (dec && dec.approved) ? await runTool(t.name, args, ctx.workingDir) : { status: 'REJECTED', message: 'Người dùng từ chối chạy tool này.' };
        } else {
          result = await runTool(t.name, args, ctx.workingDir);
        }
        send({ type: 'toolResult', name: t.name, ok: result.status === 'SUCCESS', summary: summarizeTool(t.name, result) });
        toolResponses.push({ toolCallId: t.id, content: JSON.stringify(result), toolResponseSummary: summarizeTool(t.name, result), toolResponseStatus: result.status === 'SUCCESS' ? 'SUCCESS' : 'FAILURE' });
      }
      await chatRoundtrip(token, buildBody('TOOL_RESPONSE', { conversationId: ctx.conversationId, toolCallGroupId: gid === '_' ? undefined : gid, toolResponses }), send, depth + 1, ctx)
        .catch((e) => { send({ type: 'error', message: 'Lỗi gửi TOOL_RESPONSE: ' + e.message, errorType: e.errorType }); });
    }
  }
}

// ---------------- Danh sách model (GET /config) ----------------
let modelsCache = { at: 0, data: null };
export async function listModels() {
  const token = readToken();
  if (!token) return { error: 'Chưa có token.' };
  if (modelsCache.data && Date.now() - modelsCache.at < 300000) return modelsCache.data;
  const res = await fetch(`${GATEWAY}/config`, { headers: { 'x-access-token': token, 'x-pstmn-req-service': 'agent-mode-service', 'x-app-version': APP_VERSION_FALLBACK } });
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const j = await res.json();
  const tpl = loadTemplate();
  const data = {
    models: (j.models || []).map((m) => ({ key: m.key, name: m.displayName || m.key, thinking: !!m.supportsThinkingMode })),
    current: tpl && tpl.body && tpl.body.devModeOptions ? tpl.body.devModeOptions.selectedModel : null,
  };
  modelsCache = { at: Date.now(), data };
  return data;
}
