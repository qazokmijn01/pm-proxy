/**
 * LOP TUONG THICH OpenAI  ->  Anthropic (/v1/chat/completions).
 *
 * Cach lam: KHONG viet lai duong ong. Dich request OpenAI sang dang Anthropic, cho chay
 * qua dung handleMessages() san co (giu nguyen do cwd, phien, dung lai ngu canh, luot tien
 * ich...), thu lai dau ra bang mot `res` cau noi, roi dich nguoc sang dang OpenAI.
 *
 * Nho vay moi sua doi ve tool/model sau nay chi can lam mot lan o lop Anthropic.
 */
import { genMessageId, estimateTokens } from './sse.mjs';

const nowSec = () => Math.floor(Date.now() / 1000);
const cmplId = () => 'chatcmpl-' + genMessageId().slice(4);

// stop_reason (Anthropic) -> finish_reason (OpenAI)
const FINISH = { end_turn: 'stop', stop_sequence: 'stop', tool_use: 'tool_calls', max_tokens: 'length' };
const finishOf = (r) => FINISH[r] || 'stop';

/** content cua OpenAI: string | [{type:'text'|'image_url',...}] -> chuoi. */
function oaiText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => {
      if (typeof p === 'string') return p;
      if (p && p.type === 'text') return p.text || '';
      return '';
    }).join('');
  }
  return '';
}

/**
 * Request OpenAI -> body Anthropic cho handleMessages.
 * - role 'system'    -> gop vao body.system
 * - role 'tool'      -> user[tool_result]  (OpenAI tach rieng, Anthropic long trong user)
 * - assistant.tool_calls -> assistant[tool_use]
 */
export function toAnthropicBody(oai = {}) {
  const sys = [];
  const messages = [];
  for (const m of Array.isArray(oai.messages) ? oai.messages : []) {
    if (!m || !m.role) continue;
    if (m.role === 'system' || m.role === 'developer') { const t = oaiText(m.content); if (t) sys.push(t); continue; }
    if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.tool_call_id || m.toolCallId || '', content: oaiText(m.content) };
      const last = messages[messages.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content)) last.content.push(block);
      else messages.push({ role: 'user', content: [block] });
      continue;
    }
    if (m.role === 'assistant') {
      const blocks = [];
      const t = oaiText(m.content);
      if (t) blocks.push({ type: 'text', text: t });
      for (const tc of m.tool_calls || []) {
        if (!tc || !tc.function) continue;
        let input = {};
        try { input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}; } catch { input = {}; }
        blocks.push({ type: 'tool_use', id: tc.id || genMessageId(), name: tc.function.name, input });
      }
      messages.push({ role: 'assistant', content: blocks.length ? blocks : '' });
      continue;
    }
    messages.push({ role: 'user', content: oaiText(m.content) });   // user + vai tro la
  }

  const tools = [];
  for (const t of Array.isArray(oai.tools) ? oai.tools : []) {
    const f = t && (t.function || (t.type === 'function' ? t : null));
    if (f && f.name) tools.push({ name: f.name, description: f.description || '', input_schema: f.parameters || { type: 'object', properties: {} } });
  }
  for (const f of Array.isArray(oai.functions) ? oai.functions : []) {   // dang cu (legacy)
    if (f && f.name) tools.push({ name: f.name, description: f.description || '', input_schema: f.parameters || { type: 'object', properties: {} } });
  }

  const out = {
    // Danh dau nguon: lop duoi coi 'khong co tool' la luot tien ich (title-gen) cua Claude
    // Code va tra loi tai cho. Chat OpenAI khong kem tool la binh thuong -> phai di gateway.
    __fromOpenAI: true,
    model: oai.model || 'claude-3-5-sonnet',
    max_tokens: oai.max_completion_tokens || oai.max_tokens || 4096,
    stream: oai.stream === true,
    messages,
  };
  if (sys.length) out.system = sys.join('\n\n');
  if (tools.length) out.tools = tools;
  return out;
}

/** Message Anthropic (non-stream) -> response OpenAI. */
export function toOpenAIResponse(msg, model) {
  const blocks = Array.isArray(msg && msg.content) ? msg.content : [];
  let text = '';
  const toolCalls = [];
  for (const b of blocks) {
    if (!b) continue;
    if (b.type === 'text') text += b.text || '';
    else if (b.type === 'tool_use') {
      toolCalls.push({ id: b.id || genMessageId(), type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } });
    }
  }
  const message = { role: 'assistant', content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  const u = (msg && msg.usage) || {};
  return {
    id: cmplId(),
    object: 'chat.completion',
    created: nowSec(),
    model: model || (msg && msg.model) || '',
    choices: [{ index: 0, message, finish_reason: finishOf(msg && msg.stop_reason), logprobs: null }],
    usage: {
      prompt_tokens: u.input_tokens || 0,
      completion_tokens: u.output_tokens || 0,
      total_tokens: (u.input_tokens || 0) + (u.output_tokens || 0),
    },
  };
}

/** GET /v1/models: tra dang OpenAI. */
export function toOpenAIModels(models) {
  return {
    object: 'list',
    data: (models || []).map((m) => ({ id: m.key, object: 'model', created: nowSec(), owned_by: 'postman' })),
  };
}

/**
 * `res` CAU NOI: nhan dau ra dang Anthropic tu handleMessages, dich sang OpenAI va ghi ra
 * `res` that. Vua chay vua phat (stream) nen client thay chu chay ngay, khong doi tron luot.
 */
class BridgeRes {
  constructor(res, { model, wantStream, includeUsage }) {
    this.res = res;
    this.model = model;
    this.wantStream = wantStream;
    this.includeUsage = includeUsage;
    this.id = cmplId();
    this.status = 200;
    this.isSSE = false;
    this.buf = '';          // buffer SSE cho dang stream
    this.jsonBuf = '';      // buffer body cho dang JSON
    this.sentRole = false;
    this.toolIdx = -1;
    this.cur = null;        // block dang mo: {type,id,name,args}
    this.stopReason = 'end_turn';
    this.usage = { input_tokens: 0, output_tokens: 0 };
    this.text = '';
    this.headSent = false;
  }

  writeHead(status, headers) {
    this.status = status;
    const ct = String((headers && (headers['Content-Type'] || headers['content-type'])) || '');
    this.isSSE = ct.includes('event-stream');
  }

  _head() {
    if (this.headSent) return;
    this.headSent = true;
    this.res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  }

  _chunk(delta, finish = null) {
    this._head();
    const payload = { id: this.id, object: 'chat.completion.chunk', created: nowSec(), model: this.model, choices: [{ index: 0, delta, finish_reason: finish }] };
    this.res.write('data: ' + JSON.stringify(payload) + '\n\n');
  }

  _role() {
    if (this.sentRole) return;
    this.sentRole = true;
    this._chunk({ role: 'assistant', content: '' });
  }

  write(s) {
    if (!this.isSSE) { this.jsonBuf += s; return true; }
    this.buf += s;
    const events = this.buf.split('\n\n');
    this.buf = events.pop() || '';
    for (const ev of events) this._onEvent(ev);
    return true;
  }

  _onEvent(raw) {
    const line = raw.split('\n').find((l) => l.startsWith('data:'));
    if (!line) return;
    let d; try { d = JSON.parse(line.slice(5).trim()); } catch { return; }
    const t = d.type;
    if (t === 'message_start') { this.usage.input_tokens = ((d.message || {}).usage || {}).input_tokens || 0; return; }
    if (t === 'content_block_start') {
      const cb = d.content_block || {};
      this.cur = cb.type === 'tool_use' ? { type: 'tool_use', id: cb.id, name: cb.name, args: '' } : { type: cb.type };
      return;
    }
    if (t === 'content_block_delta') {
      const dl = d.delta || {};
      if (dl.type === 'text_delta' && dl.text) { if (this.wantStream) { this._role(); this._chunk({ content: dl.text }); } this.text += dl.text; }
      else if (dl.type === 'input_json_delta' && this.cur) this.cur.args += dl.partial_json || '';
      return;
    }
    if (t === 'content_block_stop') {
      if (this.cur && this.cur.type === 'tool_use') {
        this.toolIdx += 1;
        const call = { index: this.toolIdx, id: this.cur.id, type: 'function', function: { name: this.cur.name, arguments: this.cur.args || '{}' } };
        if (this.wantStream) { this._role(); this._chunk({ tool_calls: [call] }); }
        (this.calls = this.calls || []).push(call);
      }
      this.cur = null;
      return;
    }
    if (t === 'message_delta') {
      if (d.delta && d.delta.stop_reason) this.stopReason = d.delta.stop_reason;
      if (d.usage && d.usage.output_tokens != null) this.usage.output_tokens = d.usage.output_tokens;
      return;
    }
    if (t === 'error') { this._fail(502, (d.error && d.error.message) || 'gateway error'); }
  }

  _fail(status, message, type = 'server_error') {
    if (this.headSent) {                       // da bat dau stream -> chi con cach dong lai
      this.res.write('data: ' + JSON.stringify({ error: { message: String(message), type } }) + '\n\n');
      this.res.write('data: [DONE]\n\n');
      this.res.end();
      return;
    }
    const b = JSON.stringify({ error: { message: String(message), type, code: null } });
    this.res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) });
    this.res.end(b);
    this.headSent = true;
  }

  end(s) {
    if (s) this.write(s);

    // Loi tu handleMessages (JSON dang Anthropic) -> loi dang OpenAI.
    if (this.status >= 400) {
      let msg = 'upstream error';
      try { const j = JSON.parse(this.jsonBuf); msg = (j.error && j.error.message) || msg; } catch {}
      return this._fail(this.status, msg, 'invalid_request_error');
    }

    // Dau ra JSON (non-stream cua lop Anthropic).
    if (!this.isSSE) {
      let msg = null;
      try { msg = JSON.parse(this.jsonBuf); } catch { return this._fail(502, 'khong doc duoc tra loi tu upstream'); }
      const out = toOpenAIResponse(msg, this.model);
      if (!this.wantStream) {
        const b = JSON.stringify(out);
        this.res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) });
        this.res.end(b);
        return;
      }
      // Client doi stream nhung lop duoi tra gon 1 cuc -> phat lai thanh chunk.
      const m = out.choices[0].message;
      this._role();
      if (m.content) this._chunk({ content: m.content });
      (m.tool_calls || []).forEach((c, i) => this._chunk({ tool_calls: [{ index: i, ...c }] }));
      this._finishStream(out.choices[0].finish_reason, out.usage);
      return;
    }

    // Dau ra SSE.
    if (this.wantStream) {
      this._finishStream(finishOf(this.stopReason), {
        prompt_tokens: this.usage.input_tokens,
        completion_tokens: this.usage.output_tokens || estimateTokens(this.text),
        total_tokens: (this.usage.input_tokens || 0) + (this.usage.output_tokens || estimateTokens(this.text)),
      });
      return;
    }
    // Client muon 1 cuc nhung lop duoi stream -> gom lai.
    const message = { role: 'assistant', content: this.text || null };
    if (this.calls && this.calls.length) message.tool_calls = this.calls.map(({ index, ...c }) => c);
    const body = JSON.stringify({
      id: this.id, object: 'chat.completion', created: nowSec(), model: this.model,
      choices: [{ index: 0, message, finish_reason: finishOf(this.stopReason), logprobs: null }],
      usage: {
        prompt_tokens: this.usage.input_tokens,
        completion_tokens: this.usage.output_tokens || estimateTokens(this.text),
        total_tokens: (this.usage.input_tokens || 0) + (this.usage.output_tokens || estimateTokens(this.text)),
      },
    });
    this.res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    this.res.end(body);
  }

  _finishStream(finish, usage) {
    this._role();
    this._chunk({}, finish);
    if (this.includeUsage && usage) {
      this._head();
      this.res.write('data: ' + JSON.stringify({ id: this.id, object: 'chat.completion.chunk', created: nowSec(), model: this.model, choices: [], usage }) + '\n\n');
    }
    this.res.write('data: [DONE]\n\n');
    this.res.end();
  }
}

/**
 * POST /v1/chat/completions
 * @param handleMessages ham xu ly cua lop Anthropic (req, res, body)
 */
export async function handleChatCompletions(req, res, body, handleMessages) {
  const wantStream = body && body.stream === true;
  const includeUsage = !!(body && body.stream_options && body.stream_options.include_usage);
  const model = (body && body.model) || 'claude-3-5-sonnet';
  const anth = toAnthropicBody(body || {});
  const bridge = new BridgeRes(res, { model, wantStream, includeUsage });
  await handleMessages(req, bridge, anth);
}
