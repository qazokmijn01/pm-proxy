/**
 * TOOL RUNNER (che do web) - thuc thi tool trong pham vi thu muc workspace de agent chay tiep.
 *
 * Nhom tool:
 *  - Doc:    listDirectory, readFile
 *  - Ghi:    createFile, editFile
 *  - Tim:    searchInFiles
 *  - Lenh:   executeShellCommand
 *  - Mang:   sendRequest (HTTP that qua fetch)
 *  - UI/state (ghi nhan, tra SUCCESS): showRichOutput, todoWrite, recommendNextActions, navigateInApp
 *  - Server-side / khong ap dung o web (tra ket qua ro rang): getTabDetails, searchPostman,
 *    webSearch, learnAboutPostmanTerm, searchConversationData, SubAgent
 *
 * Moi duong dan / CWD tool file & lenh deu gioi han trong `workingDir` (chong path traversal).
 * Tool la -> UNSUPPORTED (agent van nhan TOOL_RESPONSE va tiep tuc).
 *
 * [!] createFile/editFile/executeShellCommand/sendRequest GHI, CHAY LENH va GUI REQUEST that,
 *    chay TU DONG (autoRun, loop-approval tat). Chi dung khi workspace tro vao noi ban tin tuong.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isMcpTool, callMcpTool } from './mcp.mjs';

const ok = (o) => ({ status: 'SUCCESS', ...o });
const err = (m) => ({ status: 'ERROR', message: String(m) });

function resolveIn(workingDir, p) {
  if (!p) return path.resolve(workingDir || '.');
  const abs = path.isAbsolute(p) ? p : path.join(workingDir || '.', p);
  return path.resolve(abs);
}
function within(workingDir, abs) {
  if (!workingDir) return true;
  const root = path.resolve(workingDir);
  return abs === root || abs.startsWith(root + path.sep);
}

export const SUPPORTED_TOOLS = [
  'listDirectory', 'readFile', 'createFile', 'editFile', 'searchInFiles', 'executeShellCommand',
  'sendRequest', 'showRichOutput', 'todoWrite', 'recommendNextActions', 'navigateInApp',
  'getTabDetails', 'searchPostman', 'webSearch', 'learnAboutPostmanTerm', 'searchConversationData',
];
export const READ_TOOLS = SUPPORTED_TOOLS; // giu tuong thich nguoc voi import cu

export async function runTool(name, args = {}, workingDir = null) {
  try {
    switch (name) {
      case 'listDirectory': {
        const dir = resolveIn(workingDir, args.relativePath || args.path || '');
        if (!within(workingDir, dir)) return err('Duong dan ngoai pham vi workspace: ' + dir);
        const ents = fs.readdirSync(dir, { withFileTypes: true });
        const items = ents
          .filter((e) => args.includeHidden || !e.name.startsWith('.'))
          .map((e) => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' }))
          .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1));
        return ok({ path: dir, count: items.length, items });
      }
      case 'readFile': {
        const f = resolveIn(workingDir, args.filePath || args.path || args.relativePath || '');
        if (!within(workingDir, f)) return err('Duong dan ngoai pham vi workspace: ' + f);
        const st = fs.statSync(f);
        if (!st.isFile()) return err('Khong phai file: ' + f);
        const MAX = 200 * 1024;
        if (st.size > MAX) {
          const fd = fs.openSync(f, 'r');
          const buf = Buffer.alloc(MAX);
          const n = fs.readSync(fd, buf, 0, MAX, 0);
          fs.closeSync(fd);
          return ok({ path: f, size: st.size, truncated: true, content: buf.slice(0, n).toString('utf8') });
        }
        let content = fs.readFileSync(f, 'utf8');
        if (args.offset != null || args.limit != null) {
          const lines = content.split(/\r?\n/);
          const start = Math.max(0, args.offset ? args.offset - 1 : 0);
          const end = args.limit != null ? start + args.limit : lines.length;
          content = lines.slice(start, end).join('\n');
        }
        return ok({ path: f, size: st.size, content });
      }
      case 'createFile': {
        const f = resolveIn(workingDir, args.filePath || args.path || args.relativePath || '');
        if (!within(workingDir, f)) return err('Duong dan ngoai pham vi workspace: ' + f);
        if (fs.existsSync(f)) return err('File da ton tai (dung editFile de sua): ' + f);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        const content = args.content != null ? String(args.content) : '';
        fs.writeFileSync(f, content, 'utf8');
        return ok({ path: f, created: true, bytesWritten: Buffer.byteLength(content, 'utf8') });
      }
      case 'editFile': {
        const f = resolveIn(workingDir, args.filePath || args.path || args.relativePath || '');
        if (!within(workingDir, f)) return err('Duong dan ngoai pham vi workspace: ' + f);
        if (!fs.existsSync(f) || !fs.statSync(f).isFile()) return err('File khong ton tai: ' + f);
        const oldString = args.oldString;
        const newString = args.newString != null ? String(args.newString) : '';
        if (oldString == null || oldString === '') return err('oldString rong - khong co gi de thay the.');
        if (oldString === newString) return err('oldString va newString giong nhau.');
        const orig = fs.readFileSync(f, 'utf8');
        const parts = orig.split(oldString);
        const count = parts.length - 1;
        if (count === 0) return err('Khong tim thay oldString trong file.');
        if (count > 1 && !args.replaceAll) return err('oldString xuat hien ' + count + ' lan - them ngu canh cho duy nhat hoac dat replaceAll=true.');
        const updated = args.replaceAll ? parts.join(newString) : orig.replace(oldString, () => newString);
        fs.writeFileSync(f, updated, 'utf8');
        return ok({ path: f, replacements: args.replaceAll ? count : 1, size: Buffer.byteLength(updated, 'utf8') });
      }
      case 'searchInFiles': {
        const root = resolveIn(workingDir, '');
        if (!within(workingDir, root)) return err('Duong dan ngoai pham vi workspace.');
        const queryString = args.queryString != null && args.queryString !== '' ? String(args.queryString) : null;
        const regexes = [];
        for (const p of (args.queryPatterns || [])) { try { regexes.push(new RegExp(p)); } catch {} }
        const globToRe = (g) => new RegExp('^' + String(g).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
        const nameGlobs = (args.fileNamePatterns || []).map(globToRe);
        if (!queryString && !regexes.length && !nameGlobs.length) return err('Can queryString, queryPatterns hoac fileNamePatterns.');
        const IGNORE = new Set(['node_modules', '.git', '.hg', '.svn', 'chrome-profiles', '.postman-agent-cli']);
        const MAX = 300;
        const matches = [];
        const stack = [root];
        while (stack.length && matches.length < MAX) {
          const dir = stack.pop();
          let ents = [];
          try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
          for (const e of ents) {
            if (matches.length >= MAX) break;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { if (!IGNORE.has(e.name)) stack.push(full); continue; }
            if (!e.isFile()) continue;
            const nameOk = nameGlobs.length ? nameGlobs.some((re) => re.test(e.name)) : true;
            if (nameGlobs.length && !nameOk) continue;
            const rel = path.relative(root, full);
            if (!queryString && !regexes.length) { matches.push({ file: rel }); continue; }
            let st; try { st = fs.statSync(full); } catch { continue; }
            if (st.size > 2 * 1024 * 1024) continue;
            let text; try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
            if (text.indexOf('\u0000') !== -1) continue;
            const lines = text.split(/\r?\n/);
            for (let i = 0; i < lines.length && matches.length < MAX; i++) {
              const ln = lines[i];
              const hit = (queryString && ln.includes(queryString)) || regexes.some((re) => re.test(ln));
              if (hit) matches.push({ file: rel, line: i + 1, text: ln.trim().slice(0, 200) });
            }
          }
        }
        return ok({ count: matches.length, truncated: matches.length >= MAX, matches });
      }
      case 'executeShellCommand': {
        const command = args.command != null ? String(args.command) : '';
        if (!command.trim()) return err('Thieu command.');
        const pp = args.projectPath || args.cwd;
        const cwd = pp ? (path.isAbsolute(pp) ? path.resolve(pp) : path.resolve(workingDir || '.', pp)) : path.resolve(workingDir || '.');
        if (!within(workingDir, cwd)) return err('projectPath ngoai pham vi workspace: ' + cwd);
        if (!fs.existsSync(cwd)) return err('Thu muc khong ton tai: ' + cwd);
        const timeout = Math.min(Math.max(parseInt(args.blockUntilMs, 10) || 30000, 1000), 600000);
        const cap = (s) => { s = s == null ? '' : String(s); return s.length > 50000 ? s.slice(0, 50000) + '\n...(cat bot)' : s; };
        const r = spawnSync(command, { cwd, timeout, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true, shell: true });
        if (r.error && r.error.code === 'ENOENT') return err('Khong chay duoc lenh: ' + r.error.message);
        const timedOut = (!!r.error && r.error.code === 'ETIMEDOUT') || r.signal === 'SIGTERM';
        return ok({ command, cwd, exitCode: r.status, timedOut, stdout: cap(r.stdout), stderr: cap(r.stderr) || (timedOut ? 'Qua thoi gian (timeout ' + timeout + 'ms)' : (r.error ? String(r.error.message) : '')) });
      }
      case 'sendRequest': {
        if (args.filePath && !args.url) return err('Gui theo filePath (request da luu trong collection) chua ho tro o che do web - hay cung cap url/method truc tiep.');
        let url = args.url;
        if (!url) return err('Thieu url.');
        const method = (args.method || 'GET').toUpperCase();
        const headers = {};
        for (const h of (args.headers || [])) { if (h && h.key && !h.disabled) headers[h.key] = h.value != null ? String(h.value) : ''; }
        if (Array.isArray(args.queryParams) && args.queryParams.length) {
          try { const u = new URL(url); for (const q of args.queryParams) { if (q && q.key && !q.disabled) u.searchParams.append(q.key, q.value != null ? String(q.value) : ''); } url = u.toString(); } catch {}
        }
        const auth = args.auth;
        if (auth && auth.type && auth.type !== 'noauth') {
          const kv = (arr) => { const o = {}; for (const it of (arr || [])) if (it && it.key != null) o[it.key] = it.value; return o; };
          if (auth.type === 'bearer') { const t = kv(auth.bearer).token; if (t) headers['Authorization'] = 'Bearer ' + t; }
          else if (auth.type === 'basic') { const b = kv(auth.basic); headers['Authorization'] = 'Basic ' + Buffer.from((b.username || '') + ':' + (b.password || '')).toString('base64'); }
          else if (auth.type === 'apikey') { const a = kv(auth.apikey); if (a.key) { if ((a.in || 'header') === 'header') headers[a.key] = a.value || ''; else { try { const u = new URL(url); u.searchParams.append(a.key, a.value || ''); url = u.toString(); } catch {} } } }
        }
        let body;
        const b = args.body;
        const hasCT = () => Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
        if (b && b.mode && method !== 'GET' && method !== 'HEAD') {
          if (b.mode === 'raw') { body = b.raw != null ? String(b.raw) : ''; if (!hasCT()) { const lang = b.options && b.options.raw && b.options.raw.language; headers['Content-Type'] = lang === 'json' ? 'application/json' : lang === 'xml' ? 'application/xml' : lang === 'html' ? 'text/html' : lang === 'javascript' ? 'application/javascript' : 'text/plain'; } }
          else if (b.mode === 'urlencoded') { const p = new URLSearchParams(); for (const it of (b.urlencoded || [])) if (it && it.key) p.append(it.key, it.value != null ? String(it.value) : ''); body = p.toString(); if (!hasCT()) headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
          else if (b.mode === 'graphql') { let vars = {}; try { vars = b.graphql && b.graphql.variables ? JSON.parse(b.graphql.variables) : {}; } catch {} body = JSON.stringify({ query: (b.graphql && b.graphql.query) || '', variables: vars }); if (!hasCT()) headers['Content-Type'] = 'application/json'; }
          else if (b.mode === 'formdata') { const p = new URLSearchParams(); let files = 0; for (const it of (b.formdata || [])) { if (!it || !it.key) continue; if (it.type === 'file') { files++; continue; } p.append(it.key, it.value != null ? String(it.value) : ''); } body = p.toString(); if (!hasCT()) headers['Content-Type'] = 'application/x-www-form-urlencoded'; if (files) headers['X-PM-Note'] = files + ' file field(s) skipped (web mode)'; }
        }
        if (/\{\{[^}]+\}\}/.test(url)) return err('URL con bien chua resolve (' + url + ') - che do web khong co environment de thay {{...}}.');
        const t0 = Date.now();
        try {
          const resp = await fetch(url, { method, headers, body, redirect: 'follow', signal: AbortSignal.timeout(30000) });
          const raw = Buffer.from(await resp.arrayBuffer());
          const MAXB = 100 * 1024;
          const respHeaders = {}; resp.headers.forEach((v, k) => { respHeaders[k] = v; });
          return ok({ request: { method, url }, response: { statusCode: resp.status, statusText: resp.statusText, headers: respHeaders, size: raw.length, timeMs: Date.now() - t0, truncated: raw.length > MAXB, body: raw.slice(0, MAXB).toString('utf8') } });
        } catch (e) {
          return err('Gui request loi: ' + (e.name === 'TimeoutError' ? 'timeout 30s' : e.message) + ' (' + method + ' ' + url + ')');
        }
      }
      case 'showRichOutput': {
        const html = args.html != null ? String(args.html) : '';
        const idRaw = args.identifier != null ? String(args.identifier) : 'output';
        const safeId = (idRaw.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80)) || 'output';
        try {
          const dir = path.join(os.homedir(), '.postman-agent-cli', 'richoutput');
          fs.mkdirSync(dir, { recursive: true });
          const file = path.join(dir, safeId + '.html');
          fs.writeFileSync(file, html, 'utf8');
          return ok({ shown: true, identifier: idRaw, htmlBytes: Buffer.byteLength(html, 'utf8'), savedTo: file, note: 'Da luu HTML ra file de mo bang trinh duyet (web mode khong co workbench tab).' });
        } catch (e) {
          return ok({ shown: true, identifier: idRaw, htmlBytes: Buffer.byteLength(html, 'utf8'), note: 'Khong luu duoc file: ' + e.message });
        }
      }
      case 'todoWrite': {
        const todos = Array.isArray(args.todos) ? args.todos : [];
        const byStatus = todos.reduce((m, t) => { const s = (t && t.status) || 'pending'; m[s] = (m[s] || 0) + 1; return m; }, {});
        return ok({ ok: true, count: todos.length, byStatus, todos });
      }
      case 'recommendNextActions': {
        const actions = Array.isArray(args.actions) ? args.actions : [];
        return ok({ ok: true, count: actions.length, actions });
      }
      case 'navigateInApp': {
        return ok({ navigated: false, appPath: args.appPath || null, note: 'Che do web khong dieu huong duoc Postman Desktop; da ghi nhan appPath.' });
      }
      case 'getTabDetails': {
        return ok({ available: false, tabId: args.tab_id || args.tabId || null, note: 'Khong truy cap duoc tab Postman o che do web (TAB_LIST trong).' });
      }
      case 'searchPostman': {
        return ok({ available: false, results: [], query: args.query != null ? String(args.query) : '', note: 'searchPostman chay phia server; che do web khong truy van duoc chi muc tim kiem cua Postman.' });
      }
      case 'webSearch': {
        return ok({ available: false, results: [], note: 'webSearch do gateway xu ly (enableWebAccess); khong chay o client web.' });
      }
      case 'learnAboutPostmanTerm': {
        return ok({ available: false, articles: [], note: 'learnAboutPostmanTerm do gateway xu ly; khong co KB o client web.' });
      }
      case 'searchConversationData': {
        return ok({ available: false, note: 'searchConversationData thao tac tren transcript noi bo; khong ap dung o client web.' });
      }
      case 'SubAgent': {
        return err('SubAgent (uy nhiem sub-agent) khong chay duoc o client web - phai xu ly truc tiep bang cac tool san co.');
      }
      default:
        if (isMcpTool(name)) return await callMcpTool(name, args);
        return { status: 'UNSUPPORTED', message: 'Tool "' + name + '" chua ho tro o che do web (dang ho tro: ' + SUPPORTED_TOOLS.join(', ') + ', va tool MCP mcp__*).' };
    }
  } catch (e) {
    return err(e.message);
  }
}

/** Tom tat ngan ket qua tool de hien thi tren giao dien. */
export function summarizeTool(name, r) {
  if (!r) return '';
  if (r.status !== 'SUCCESS') return r.message || r.status || 'loi';
  if (isMcpTool(name)) { const c = r.content != null ? String(r.content) : ''; return 'MCP ' + (r.server || '') + '/' + (r.tool || '') + (c ? ' - ' + c.slice(0, 120).replace(/\s+/g, ' ') : ''); }
  if (name === 'listDirectory') return (r.count != null ? r.count + ' muc' : 'OK') + (r.path ? ' - ' + r.path : '');
  if (name === 'readFile') return 'doc ' + (r.size != null ? r.size + ' bytes' : 'file') + (r.truncated ? ' (cat bot)' : '');
  if (name === 'createFile') return 'tao file' + (r.bytesWritten != null ? ' - ' + r.bytesWritten + ' bytes' : '') + (r.path ? ' - ' + r.path : '');
  if (name === 'editFile') return 'sua file - ' + (r.replacements != null ? r.replacements + ' thay the' : 'OK') + (r.path ? ' - ' + r.path : '');
  if (name === 'searchInFiles') return (r.count != null ? r.count + ' ket qua' : 'OK') + (r.truncated ? '+' : '');
  if (name === 'executeShellCommand') return 'exit ' + (r.exitCode != null ? r.exitCode : '?') + (r.timedOut ? ' - timeout' : '') + (r.cwd ? ' - ' + r.cwd : '');
  if (name === 'sendRequest') return r.response ? (r.response.statusCode + ' ' + (r.response.statusText || '') + ' - ' + (r.response.timeMs != null ? r.response.timeMs + 'ms' : '')).trim() : 'OK';
  if (name === 'showRichOutput') return 'hien thi' + (r.htmlBytes != null ? ' - ' + r.htmlBytes + ' bytes' : '') + (r.savedTo ? ' - ' + r.savedTo : '');
  if (name === 'todoWrite') return (r.count != null ? r.count + ' todo' : 'OK');
  if (name === 'recommendNextActions') return (r.count != null ? r.count + ' goi y' : 'OK');
  if (name === 'navigateInApp') return 'dieu huong (ghi nhan)' + (r.appPath ? ' - ' + r.appPath : '');
  if (name === 'getTabDetails') return r.available === false ? 'khong co tab' : 'OK';
  if (name === 'searchPostman') return r.available === false ? 'khong kha dung (server-side)' : ((r.results ? r.results.length : 0) + ' ket qua');
  if (name === 'webSearch') return r.available === false ? 'khong kha dung (server-side)' : 'OK';
  if (name === 'learnAboutPostmanTerm') return r.available === false ? 'khong kha dung (server-side)' : 'OK';
  if (name === 'searchConversationData') return r.available === false ? 'khong ap dung' : 'OK';
  return 'OK';
}
