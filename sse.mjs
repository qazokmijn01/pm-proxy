/**
 * ANTHROPIC SSE WRITER — phát đúng chuỗi sự kiện của Messages API (stream=true):
 *
 *   message_start
 *   ( content_block_start → content_block_delta* → content_block_stop )*
 *   message_delta   (mang stop_reason)
 *   message_stop
 *
 * Sai một tên delta là client im lặng (APPROACH.md §4) → giữ đúng shape tuyệt đối.
 * text  → delta {type:'text_delta', text}
 * tool  → content_block_start {type:'tool_use', id, name, input:{}} rồi
 *          content_block_delta {type:'input_json_delta', partial_json} (gửi trọn 1 mảnh)
 * Claude Code tự gom partial_json và JSON.parse ở content_block_stop.
 */

const now36 = () => Date.now().toString(36);
export function genMessageId() { return 'msg_' + now36() + Math.random().toString(36).slice(2, 10); }

// Chữ ký placeholder cho thinking block. Anthropic thật dùng chữ ký mật mã để UPSTREAM verify
// ở lượt sau; ở đây PROXY chính là upstream và KHÔNG verify (analyzeRequest bỏ qua thinking block
// khi đọc lại), nên một giá trị non-empty là đủ để client hiển thị thinking.
export const THINKING_SIG = process.env.PM_THINKING_SIG || 'pm-ai-proxy-thinking-sig';

/** Ước lượng token thô (~4 ký tự/token) — đủ cho message_start.usage và /count_tokens. */
export function estimateTokens(...parts) {
  let chars = 0;
  const walk = (v) => {
    if (v == null) return;
    if (typeof v === 'string') { chars += v.length; return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (typeof v === 'object') { for (const k of Object.keys(v)) walk(v[k]); return; }
    chars += String(v).length;
  };
  parts.forEach(walk);
  return Math.max(1, Math.ceil(chars / 4));
}

export class AnthropicSSE {
  constructor(res, { model = 'claude-3-5-sonnet', messageId = genMessageId(), inputTokens = 1, onSend = null } = {}) {
    this.res = res;
    this.model = model;
    this.messageId = messageId;
    this.inputTokens = inputTokens;
    this.onSend = onSend;
    this.outputTokens = 0;
    this.index = -1;
    this.open = false;
    this.blockType = null;
    this.started = false;
    this.stopped = false;
  }

  _send(event, data) {
    if (this.stopped) return;
    if (this.onSend) { try { this.onSend(event, data); } catch {} }
    this.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  start() {
    if (this.started) return;
    this.started = true;
    this._send('message_start', {
      type: 'message_start',
      message: {
        id: this.messageId, type: 'message', role: 'assistant', model: this.model,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: this.inputTokens, output_tokens: 0 },
      },
    });
    this._send('ping', { type: 'ping' });
  }

  _closeBlock() {
    if (!this.open) return;
    // Thinking block: Anthropic phát signature_delta NGAY TRƯỚC content_block_stop.
    if (this.blockType === 'thinking') {
      this._send('content_block_delta', { type: 'content_block_delta', index: this.index, delta: { type: 'signature_delta', signature: THINKING_SIG } });
    }
    this._send('content_block_stop', { type: 'content_block_stop', index: this.index });
    this.open = false;
    this.blockType = null;
  }

  /** Phát thinking (extended thinking). Chỉ gọi khi client bật thinking. */
  thinkingDelta(text) {
    if (!text) return;
    this.start();
    if (!this.open || this.blockType !== 'thinking') {
      this._closeBlock();
      this.index += 1;
      this._send('content_block_start', { type: 'content_block_start', index: this.index, content_block: { type: 'thinking', thinking: '' } });
      this.open = true; this.blockType = 'thinking';
    }
    this._send('content_block_delta', { type: 'content_block_delta', index: this.index, delta: { type: 'thinking_delta', thinking: text } });
  }

  textDelta(text) {
    if (!text) return;
    this.start();
    if (!this.open || this.blockType !== 'text') {
      this._closeBlock();
      this.index += 1;
      this._send('content_block_start', { type: 'content_block_start', index: this.index, content_block: { type: 'text', text: '' } });
      this.open = true; this.blockType = 'text';
    }
    this.outputTokens += estimateTokens(text);
    this._send('content_block_delta', { type: 'content_block_delta', index: this.index, delta: { type: 'text_delta', text } });
  }

  /** Phát trọn 1 tool_use block. input là object đã dịch sang Claude Code. */
  toolUse(id, name, input) {
    this.start();
    this._closeBlock();
    this.index += 1;
    this._send('content_block_start', { type: 'content_block_start', index: this.index, content_block: { type: 'tool_use', id, name, input: {} } });
    // BẮT BUỘC đánh dấu block đang mở, nếu không _closeBlock() bên dưới sẽ return sớm và
    // BỎ content_block_stop → Claude Code coi tool_use là dở dang: "tool call could not be parsed".
    this.open = true; this.blockType = 'tool_use';
    const partial = JSON.stringify(input || {});
    this._send('content_block_delta', { type: 'content_block_delta', index: this.index, delta: { type: 'input_json_delta', partial_json: partial } });
    this.outputTokens += estimateTokens(partial);
    this._closeBlock();
  }

  /** Kết thúc lượt: stop_reason ∈ 'end_turn' | 'tool_use' | 'max_tokens'. */
  finish(stopReason = 'end_turn') {
    this.start();
    this._closeBlock();
    this._send('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: this.outputTokens } });
    this._send('message_stop', { type: 'message_stop' });
    this.stopped = true;
  }

  /** Lỗi giữa stream (sau khi đã message_start). Nếu chưa start, gọi nơi khác trả HTTP JSON. */
  error(message, type = 'api_error') {
    this._send('error', { type: 'error', error: { type, message: String(message || 'error') } });
    this.stopped = true;
  }
}
