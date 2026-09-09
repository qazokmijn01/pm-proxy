/**
 * QUY TAC NGUOI DUNG -> gateway.
 *
 * He thong prompt cua Claude Code khong di qua duoc gateway Postman (da do tren wire:
 * truong 'system' chi co 136 ky tu boilerplate; noi dung that nam o 72 message
 * role:"system" + cac khoi <system-reminder>, ca hai deu bi lop dich bo). Cac truong
 * ngu canh cua gateway cung khong dung duoc: availableSkills / mandatoryContext /
 * backgroundContext kieu la deu bi bo qua, con chi dan nhet vao FILE_VIEWER_FOLDER
 * .description thi TOI duoc model nhung bi model TU CHOI vi coi la prompt-injection.
 * Kenh hop le duy nhat la input.query -> tool card. Tran QUERY_CAP 8500 ky tu.
 *
 * Vi vay: giu mot file rules.md NGAN, sinh tu ~/.claude/CLAUDE.md + ~/.claude/rules/
 * bang chinh model (no biet bo cac quy tac chi danh cho Claude Code), va chi sinh lai
 * khi nguon doi. File do nguoi dung TU VIET (khong co header auto) khong bao gio bi de.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { CACHE_DIR, GATEWAY, APP_VERSION_FALLBACK, readToken, loadTemplate, buildBody } from './core.mjs';

export const RULES_FILE = path.join(CACHE_DIR, 'rules.md');
export const RULES_MAX = Number(process.env.PM_RULES_MAX || 4000);
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const AUTO_MARK = '<!-- pm-proxy:auto source=';       // header danh dau ban do proxy sinh
const SRC_SEND_CAP = 7000;                            // phan nguon gui di de nho tom tat

/** Noi dung rules.md (da bo header auto) va cat theo RULES_MAX. Khong co file -> ''. */
export function readUserRules() {
  try {
    const raw = fs.readFileSync(RULES_FILE, 'utf8');
    const t = raw.replace(/<!--[\s\S]*?-->/g, '').trim();
    if (!t) return '';
    return t.length > RULES_MAX ? t.slice(0, RULES_MAX) + '\n...(cat bot: rules.md dai qua ' + RULES_MAX + ' ky tu)' : t;
  } catch { return ''; }
}

/** Cac file nguon, uu tien giam dan (CLAUDE.md chinh truoc, roi rules/). */
export function sourceFiles() {
  const out = [];
  const main = path.join(CLAUDE_DIR, 'CLAUDE.md');
  if (fs.existsSync(main)) out.push(main);
  const dir = path.join(CLAUDE_DIR, 'rules');
  try {
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort()) out.push(path.join(dir, f));
  } catch {}
  return out;
}

/** Van tay cua TOAN BO nguon - doi mot file bat ky la hash doi. */
export function sourceHash(files = sourceFiles()) {
  const h = crypto.createHash('sha1');
  for (const f of files) {
    try { h.update(f).update('\0').update(fs.readFileSync(f)); } catch {}
  }
  return h.digest('hex').slice(0, 16);
}

/** Hash ghi trong rules.md hien co. null = ban nguoi dung tu viet; undefined = chua co file. */
export function currentHash() {
  try {
    const head = fs.readFileSync(RULES_FILE, 'utf8').slice(0, 200);
    const m = head.match(/^<!-- pm-proxy:auto source=([a-f0-9]+) -->/);
    return m ? m[1] : null;
  } catch { return undefined; }
}

/** Co can sinh lai khong? reason: missing | stale | fresh | user | no-source */
export function checkRules() {
  const files = sourceFiles();
  if (!files.length) return { need: false, reason: 'no-source', hash: null, files };
  const hash = sourceHash(files);
  const cur = currentHash();
  if (cur === undefined) return { need: true, reason: 'missing', hash, files };
  if (cur === null) return { need: false, reason: 'user', hash, files };
  if (cur !== hash) return { need: true, reason: 'stale', hash, files };
  return { need: false, reason: 'fresh', hash, files };
}

/** Gop nguon lai, bo khoi code, cat theo SRC_SEND_CAP (uu tien file dau). */
export function joinSources(files) {
  let out = '', left = SRC_SEND_CAP;
  for (const f of files || []) {
    if (left <= 200) break;
    let t = '';
    try { t = fs.readFileSync(f, 'utf8'); } catch { continue; }
    t = t.replace(/```[\s\S]*?```/g, '').replace(/\n{3,}/g, '\n\n').trim();
    if (!t) continue;
    const piece = '## ' + path.basename(f) + '\n' + t.slice(0, left - 100);
    out += (out ? '\n\n' : '') + piece;
    left -= piece.length;
  }
  return out;
}

const PROMPT = [
  'Nhiem vu: rut gon bo quy tac duoi day thanh mot ban NGAN de dieu khien hanh vi cua chinh ban.',
  'Yeu cau ban ra:',
  '- Chi giu quy tac ap dung duoc cho mot tro ly lam viec truc tiep tren file va workspace.',
  '- BO cac quy tac chi danh rieng cho Claude Code CLI: thu muc plans/, feature docs, subagent,',
  '  git commit, ten file bao cao, skill noi bo, hook. Chung vo nghia trong moi truong nay.',
  '- GIU cac quy tac ve ngon ngu, cach xung ho, cach hoi lai nguoi dung, muc do don gian cua code.',
  '- Viet bang tieng Viet KHONG DAU, dang gach dau dong, toi da 2500 ky tu.',
  '- Chi xuat ban quy tac. Khong loi dan, khong giai thich, khong hoi lai, khong goi cong cu nao.',
  '',
  'BO QUY TAC NGUON:',
].join('\n');

// Luot tom tat la luot THUAN VAN BAN: khoa het tool de khong dong cham gi den may nguoi dung.
const NO_TOOLS = ['executeShellCommand', 'listDirectory', 'readFile', 'createFile', 'writeFile',
  'editFile', 'searchFiles', 'searchInFiles', 'fetchUrl', 'webSearch', 'askUser', 'todoWrite',
  'recommendNextActions', 'navigateInApp', 'sendRequest', 'showRichOutput', 'getTabDetails',
  'searchPostman', 'learnAboutPostmanTerm', 'searchConversationData', 'getVariables',
  'getSharedVariables', 'linkToLocalDirectory', 'SubAgent'];

/** Goi gateway nho tom tat. Nem loi neu that bai. */
async function summarize(sourceText) {
  const token = readToken();
  if (!token) throw new Error('chua co token');
  const tpl = loadTemplate();
  const body = buildBody('USER_QUERY', { query: PROMPT + '\n' + sourceText, conversationId: null });
  body.clientTools = { ...(body.clientTools || {}), thirdParty: {}, excludedTools: NO_TOOLS };
  const res = await fetch(GATEWAY + '/chat', {
    method: 'POST',
    headers: {
      'x-access-token': token,
      'x-pstmn-req-service': 'agent-mode-service',
      'x-app-version': (tpl && tpl.headers && tpl.headers['x-app-version']) || APP_VERSION_FALLBACK,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop();
    for (const l of lines) {
      if (!l.startsWith('data:')) continue;
      const p = l.slice(5).trim();
      if (p === '[DONE]') continue;
      let e; try { e = JSON.parse(p); } catch { continue; }
      if (e.eventType === 'textChunk') text += (e.data && e.data.textContent) || '';
    }
  }
  return text.trim();
}

/**
 * Sinh lai rules.md neu nguon doi. Khong nem loi ra ngoai - hong thi giu nguyen file cu.
 * @returns { action:'kept'|'written'|'skipped'|'failed', reason, bytes? }
 */
export async function ensureRules({ force = false } = {}) {
  const st = checkRules();
  if (st.reason === 'no-source') return { action: 'skipped', reason: 'no-source' };
  if (!force && !st.need) return { action: 'kept', reason: st.reason };
  try {
    const body = await summarize(joinSources(st.files));
    if (!body || body.length < 40) return { action: 'failed', reason: 'ket qua rong' };
    const out = AUTO_MARK + st.hash + ' -->\n' +
      '<!-- Ban nay do pm-proxy tu sinh tu ~/.claude/CLAUDE.md + ~/.claude/rules/.\n' +
      '     Xoa dong header dau tien neu muon tu viet tay - proxy se khong ghi de nua. -->\n\n' +
      body.slice(0, RULES_MAX) + '\n';
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(RULES_FILE, out, 'utf8');
    return { action: 'written', reason: st.reason, bytes: out.length };
  } catch (e) {
    return { action: 'failed', reason: (e && e.message) || 'loi khong ro' };
  }
}
