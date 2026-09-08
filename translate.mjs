/**
 * DỊCH REQUEST: Anthropic Messages  →  mô tả lượt cho Postman /chat.
 *
 * Anthropic là stateless: client gửi lại toàn bộ `messages` mỗi lượt. Ta chỉ cần biết
 * LƯỢT MỚI là gì bằng cách nhìn message CUỐI:
 *   - user chứa block tool_result  → lượt TOOL_RESPONSE (client đã chạy tool xong).
 *   - user text thường            → lượt USER_QUERY (câu hỏi/chỉ thị mới).
 */
import { contentText } from './sessions.mjs';

/** Gom system (string | mảng block) thành 1 chuỗi. */
export function systemText(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) return system.map((s) => (typeof s === 'string' ? s : s.text || '')).join('\n');
  return '';
}

/** Rút "working directory" từ system prompt của Claude Code (khối <env>). */
export function extractWorkingDir(system) {
  const t = systemText(system);
  const m = t.match(/working directory:\s*([^\n<]+)/i) || t.match(/\bcwd:\s*([^\n<]+)/i);
  return m ? m[1].trim() : null;
}

/** tool_result.content (string | mảng block) → chuỗi cho model đọc. */
export function toolResultToString(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => {
      if (typeof b === 'string') return b;
      if (!b || typeof b !== 'object') return '';
      if (b.type === 'text' || typeof b.text === 'string') return b.text || '';
      if (b.type === 'image') return '[image omitted]';
      return JSON.stringify(b);
    }).join('\n');
  }
  if (typeof content === 'object' && typeof content.text === 'string') return content.text;
  return JSON.stringify(content);
}

const summarize = (s) => {
  const one = String(s || '').replace(/\s+/g, ' ').trim();
  return one.length > 140 ? one.slice(0, 137) + '…' : (one || '(empty)');
};

// Chiều về của AskUserQuestion: content thường là { questions, answers:{"<q>":"<label>"}, response }.
// Rút ra lựa chọn của người dùng để gói cho gateway.
export function extractAskUserAnswer(raw) {
  const s = raw == null ? '' : String(raw);
  const t = s.trim();
  if (t[0] === '{' || t[0] === '[') {
    try {
      const o = JSON.parse(t);
      if (o && typeof o === 'object') {
        if (o.response) return String(o.response);
        if (o.answers && typeof o.answers === 'object') {
          const vals = Object.values(o.answers).map((v) => (Array.isArray(v) ? v.join(', ') : String(v))).filter(Boolean);
          if (vals.length) return vals.join(' | ');
        }
        if (o.answer != null) return String(o.answer);
      }
    } catch {}
  }
  return s;
}

// Claude Code nhét ngữ cảnh (claudeMd, trạng thái git, nhắc việc…) trong các khối
// <system-reminder>…</system-reminder>. Gateway đã có ngữ cảnh riêng (AGENTS_MD,
// FILE_VIEWER_FOLDER) nên ta BÓC các khối này ra khỏi query — nếu không, chúng chiếm
// hết QUERY_CAP và đẩy câu hỏi thật ra ngoài (bị cắt) → model tưởng "không có yêu cầu".
const REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/gi;
export function stripReminders(t) { return String(t == null ? '' : t).replace(REMINDER_RE, '').trim(); }

/** Lấy ĐÚNG lượt nhập mới của con người: các user message sau assistant cuối,
 *  bỏ khối tool_result + <system-reminder>. Fallback: toàn bộ text user cuối. */
export function extractUserQuery(messages) {
  let start = 0;
  for (let i = (messages || []).length - 1; i >= 0; i--) { if (messages[i].role === 'assistant') { start = i + 1; break; } }
  const parts = [];
  for (const m of (messages || []).slice(start)) {
    if (!m || m.role !== 'user') continue;
    const c = m.content;
    if (typeof c === 'string') { const s = stripReminders(c); if (s) parts.push(s); continue; }
    if (Array.isArray(c)) {
      for (const b of c) {
        if (typeof b === 'string') { const s = stripReminders(b); if (s) parts.push(s); continue; }
        if (!b || typeof b !== 'object' || b.type === 'tool_result') continue;
        if (typeof b.text === 'string') { const s = stripReminders(b.text); if (s) parts.push(s); }
      }
    }
  }
  const q = parts.join('\n\n').trim();
  if (q) return q;
  const lu = [...(messages || [])].reverse().find((m) => m && m.role === 'user');
  return contentText(lu && lu.content).trim();
}

// Claude Code mở đầu bằng các lượt NỀN không cần gateway: sinh tiêu đề hội thoại,
// dò quota… (thường toolCount=0). Đừng đốt credit + đừng tạo conversation rác cho chúng.
export function isUtilityTurn(body) {
  const toolCount = Array.isArray(body.tools) ? body.tools.length : 0;
  if (toolCount > 0) return false;
  const t = (body.messages || []).map((m) => contentText(m.content)).join('\n');
  return /predominant language of the session|write a? ?\d?.{0,12}title|isNewTopic|<session>/i.test(t) || true; // toolCount===0 ⇒ coi là tiện ích
}

/** Sinh tiêu đề ngắn từ nội dung <session> (hoặc text đầu) — trả về cho lượt title-gen. */
export function utilityReply(body) {
  const t = (body.messages || []).map((m) => contentText(m.content)).join('\n');
  const m = t.match(/<session>\s*([\s\S]*?)\s*<\/session>/i);
  const seed = stripReminders(m ? m[1] : t).split('\n').map((s) => s.trim()).filter(Boolean)[0] || 'Session';
  return seed.length > 60 ? seed.slice(0, 57) + '…' : seed;
}

/**
 * Phân tích 1 body Anthropic → { kind, ... }.
 *   kind:'user_query'    → { text }
 *   kind:'tool_result'   → { results:[{ toolUseId, content, isError }] }
 */
export function analyzeRequest(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  // Quét CẢ lượt sau assistant cuối (không chỉ message cuối): Claude Code hay chèn thêm
  // một message role:"system" (nhắc việc) SAU user:[tool_result]. Nếu chỉ nhìn message cuối
  // thì tool_result bị bỏ sót → gửi USER_QUERY rỗng → gateway 403 INPUT_VALIDATION_ERROR → loặp.
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i--) { if (messages[i].role === 'assistant') { start = i + 1; break; } }
  const results = [];
  for (const m of messages.slice(start)) {
    if (!m || m.role !== 'user' || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b && b.type === 'tool_result') {
        results.push({ toolUseId: b.tool_use_id || b.toolUseId, content: toolResultToString(b.content), isError: !!b.is_error });
      }
    }
  }
  if (results.length) return { kind: 'tool_result', results };
  // Lượt câu hỏi mới: lấy đúng lượt nhập mới của con người (đã bóc <system-reminder>).
  return { kind: 'user_query', text: extractUserQuery(messages) };
}

/**
 * Từ các tool_result của client → toolResponses[] Postman, gom theo groupId.
 * getToolUse(id) trả { conversationId, groupId, nativeName } đã lưu lúc phát tool_use.
 * @returns { groups: { [groupId]: { conversationId, toolResponses:[…] } }, unknown:[ids] }
 */
export function buildToolResponses(results, getToolUse) {
  const groups = {};
  const unknown = [];
  for (const r of results) {
    const info = getToolUse(r.toolUseId);
    if (!info) { unknown.push(r.toolUseId); continue; }
    const gid = info.groupId || '_';
    const g = (groups[gid] = groups[gid] || { conversationId: info.conversationId, groupId: info.groupId, toolResponses: [] });
    let content = r.content == null ? '' : String(r.content);
    let sum = summarize(r.content);
    // askUser: gateway kỳ vọng answer nằm trong content JSON {status, answer} (theo core.mjs đã chạy tốt),
    // KHÔNG phải JSON thô của AskUserQuestion. Gói lại để model đọc đúng lựa chọn.
    if (info.postmanNative === 'askUser') {
      const answer = extractAskUserAnswer(r.content);
      content = JSON.stringify({ status: 'SUCCESS', answer });
      sum = 'askUser answer: ' + summarize(answer);
    }
    g.toolResponses.push({
      toolCallId: r.toolUseId,
      content,
      toolResponseSummary: sum,
      toolResponseStatus: r.isError ? 'FAILURE' : 'SUCCESS',
    });
  }
  return { groups, unknown };
}

export { summarize };
