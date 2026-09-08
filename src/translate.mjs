/**
 * DICH REQUEST: Anthropic Messages  ->  mo ta luot cho Postman /chat.
 *
 * Anthropic la stateless: client gui lai toan bo `messages` moi luot. Ta chi can biet
 * LUOT MOI la gi bang cach nhin message CUOI:
 *   - user chua block tool_result  -> luot TOOL_RESPONSE (client da chay tool xong).
 *   - user text thuong            -> luot USER_QUERY (cau hoi/chi thi moi).
 */
import { contentText } from './sessions.mjs';

/** Gom system (string | mang block) thanh 1 chuoi. */
export function systemText(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) return system.map((s) => (typeof s === 'string' ? s : s.text || '')).join('\n');
  return '';
}

/** Rut "working directory" tu system prompt cua Claude Code (khoi <env>). */
export function extractWorkingDir(system) {
  const t = systemText(system);
  const m = t.match(/working directory:\s*([^\n<]+)/i) || t.match(/\bcwd:\s*([^\n<]+)/i);
  return m ? m[1].trim() : null;
}

/** tool_result.content (string | mang block) -> chuoi cho model doc. */
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
  return one.length > 140 ? one.slice(0, 137) + '...' : (one || '(empty)');
};

// Chieu ve cua AskUserQuestion: content thuong la { questions, answers:{"<q>":"<label>"}, response }.
// Rut ra lua chon cua nguoi dung de goi cho gateway.
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

// Claude Code nhet ngu canh (claudeMd, trang thai git, nhac viec...) trong cac khoi
// <system-reminder>...</system-reminder>. Gateway da co ngu canh rieng (AGENTS_MD,
// FILE_VIEWER_FOLDER) nen ta BOC cac khoi nay ra khoi query - neu khong, chung chiem
// het QUERY_CAP va day cau hoi that ra ngoai (bi cat) -> model tuong "khong co yeu cau".
const REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/gi;
export function stripReminders(t) { return String(t == null ? '' : t).replace(REMINDER_RE, '').trim(); }

/** Lay DUNG luot nhap moi cua con nguoi: cac user message sau assistant cuoi,
 *  bo khoi tool_result + <system-reminder>. Fallback: toan bo text user cuoi. */
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

// Claude Code mo dau bang cac luot NEN khong can gateway: sinh tieu de hoi thoai,
// do quota... (thuong toolCount=0). Dung dot credit + dung tao conversation rac cho chung.
export function isUtilityTurn(body) {
  const toolCount = Array.isArray(body.tools) ? body.tools.length : 0;
  if (toolCount > 0) return false;
  const t = (body.messages || []).map((m) => contentText(m.content)).join('\n');
  return /predominant language of the session|write a? ?\d?.{0,12}title|isNewTopic|<session>/i.test(t) || true; // toolCount===0 => coi la tien ich
}

/** Sinh tieu de ngan tu noi dung <session> (hoac text dau) - tra ve cho luot title-gen. */
export function utilityReply(body) {
  const t = (body.messages || []).map((m) => contentText(m.content)).join('\n');
  const m = t.match(/<session>\s*([\s\S]*?)\s*<\/session>/i);
  const seed = stripReminders(m ? m[1] : t).split('\n').map((s) => s.trim()).filter(Boolean)[0] || 'Session';
  return seed.length > 60 ? seed.slice(0, 57) + '...' : seed;
}

/**
 * Phan tich 1 body Anthropic -> { kind, ... }.
 *   kind:'user_query'    -> { text }
 *   kind:'tool_result'   -> { results:[{ toolUseId, content, isError }] }
 */
export function analyzeRequest(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  // Quet CA luot sau assistant cuoi (khong chi message cuoi): Claude Code hay chen them
  // mot message role:"system" (nhac viec) SAU user:[tool_result]. Neu chi nhin message cuoi
  // thi tool_result bi bo sot -> gui USER_QUERY rong -> gateway 403 INPUT_VALIDATION_ERROR -> loap.
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
  // Luot cau hoi moi: lay dung luot nhap moi cua con nguoi (da boc <system-reminder>).
  return { kind: 'user_query', text: extractUserQuery(messages) };
}

/**
 * Tu cac tool_result cua client -> toolResponses[] Postman, gom theo groupId.
 * getToolUse(id) tra { conversationId, groupId, nativeName } da luu luc phat tool_use.
 * @returns { groups: { [groupId]: { conversationId, toolResponses:[...] } }, unknown:[ids] }
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
    // askUser: gateway ky vong answer nam trong content JSON {status, answer} (theo core.mjs da chay tot),
    // KHONG phai JSON tho cua AskUserQuestion. Goi lai de model doc dung lua chon.
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
