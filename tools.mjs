/**
 * TOOL RUNNER (chế độ web) — thực thi tool trong phạm vi thư mục workspace để agent chạy tiếp.
 *
 * Nhóm tool:
 *  • Đọc:    listDirectory, readFile
 *  • Ghi:    createFile, editFile
 *  • Tìm:    searchInFiles
 *  • Lệnh:   executeShellCommand
 *  • Mạng:   sendRequest (HTTP thật qua fetch)
 *  • UI/state (ghi nhận, trả SUCCESS): showRichOutput, todoWrite, recommendNextActions, navigateInApp
 *  • Server-side / không áp dụng ở web (trả kết quả rõ ràng): getTabDetails, searchPostman,
 *    webSearch, learnAboutPostmanTerm, searchConversationData, SubAgent
 *
 * Mọi đường dẫn / CWD tool file & lệnh đều giới hạn trong `workingDir` (chống path traversal).
 * Tool lạ → UNSUPPORTED (agent vẫn nhận TOOL_RESPONSE và tiếp tục).
 *
 * ⚠️ createFile/editFile/executeShellCommand/sendRequest GHI, CHẠY LỆNH và GỬI REQUEST thật,
 *    chạy TỰ ĐỘNG (autoRun, loop-approval tắt). Chỉ dùng khi workspace trỏ vào nơi bạn tin tưởng.
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
export const READ_TOOLS = SUPPORTED_TOOLS; // giữ tương thích ngược với import cũ

export async function runTool(name, args = {}, workingDir = null) {
  try {
    switch (name) {
      case 'listDirectory': {
        const dir = resolveIn(workingDir, args.relativePath || args.path || '');
        if (!within(workingDir, dir)) return err('Đường dẫn ngoài phạm vi workspace: ' + dir);
        const ents = fs.readdirSync(dir, { withFileTypes: true });
        const items = ents
          .filter((e) => args.includeHidden || !e.name.startsWith('.'))
          .map((e) => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' }))
          .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1));
        return ok({ path: dir, count: items.length, items });
      }
      case 'readFile': {
        const f = resolveIn(workingDir, args.filePath || args.path || args.relativePath || '');
        if (!within(workingDir, f)) return err('Đường dẫn ngoài phạm vi workspace: ' + f);
        const st = fs.statSync(f);
        if (!st.isFile()) return err('Không phải file: ' + f);
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
        if (!within(workingDir, f)) return err('Đường dẫn ngoài phạm vi workspace: ' + f);
        if (fs.existsSync(f)) return err('File đã tồn tại (dùng editFile để sửa): ' + f);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        const content = args.content != null ? String(args.content) : '';
        fs.writeFileSync(f, content, 'utf8');
        return ok({ path: f, created: true, bytesWritten: Buffer.byteLength(content, 'utf8') });
      }
      case 'editFile': {
        const f = resolveIn(workingDir, args.filePath || args.path || args.relativePath || '');
        if (!within(workingDir, f)) return err('Đường dẫn ngoài phạm vi workspace: ' + f);
        if (!fs.existsSync(f) || !fs.statSync(f).isFile()) return err('File không tồn tại: ' + f);
        const oldString = args.oldString;
        const newString = args.newString != null ? String(args.newString) : '';
        if (oldString == null || oldString === '') return err('oldString rỗng — không có gì để thay thế.');
        if (oldString === newString) return err('oldString và newString giống nhau.');
        const orig = fs.readFileSync(f, 'utf8');
        const parts = orig.split(oldString);
        const count = parts.length - 1;
        if (count === 0) return err('Không tìm thấy oldString trong file.');
        if (count > 1 && !args.replaceAll) return err('oldString xuất hiện ' + count + ' lần — thêm ngữ cảnh cho duy nhất hoặc đặt replaceAll=true.');
        const updated = args.replaceAll ? parts.join(newString) : orig.replace(oldString, () => newString);
        fs.writeFileSync(f, updated, 'utf8');
        return ok({ path: f, replacements: args.replaceAll ? count : 1, size: Buffer.byteLength(updated, 'utf8') });
      }
      case 'searchInFiles': {
        const root = resolveIn(workingDir, '');
        if (!within(workingDir, root)) return err('Đường dẫn ngoài phạm vi workspace.');
        const queryString = args.queryString != null && args.queryString !== '' ? String(args.queryString) : null;
        const regexes = [];
        for (const p of (args.queryPatterns || [])) { try { regexes.push(new RegExp(p)); } catch {} }
        const globToRe = (g) => new RegExp('^' + String(g).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
        const nameGlobs = (args.fileNamePatterns || []).map(globToRe);
        if (!queryString && !regexes.length && !nameGlobs.length) return err('Cần queryString, queryPatterns hoặc fileNamePatterns.');
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
        if (!command.trim()) return err('Thiếu command.');
        const pp = args.projectPath || args.cwd;
        const cwd = pp ? (path.isAbsolute(pp) ? path.resolve(pp) : path.resolve(workingDir || '.', pp)) : path.resolve(workingDir || '.');
        if (!within(workingDir, cwd)) return err('projectPath ngoài phạm vi workspace: ' + cwd);
        if (!fs.existsSync(cwd)) return err('Thư mục không tồn tại: ' + cwd);
        const timeout = Math.min(Math.max(parseInt(args.blockUntilMs, 10) || 30000, 1000), 600000);
        const cap = (s) => { s = s == null ? '' : String(s); return s.length > 50000 ? s.slice(0, 50000) + '\n…(cắt bớt)' : s; };
        const r = spawnSync(command, { cwd, timeout, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true, shell: true });
        if (r.error && r.error.code === 'ENOENT') return err('Không chạy được lệnh: ' + r.error.message);
        const timedOut = (!!r.error && r.error.code === 'ETIMEDOUT') || r.signal === 'SIGTERM';
        return ok({ command, cwd, exitCode: r.status, timedOut, stdout: cap(r.stdout), stderr: cap(r.stderr) || (timedOut ? 'Quá thời gian (timeout ' + timeout + 'ms)' : (r.error ? String(r.error.message) : '')) });
      }
      case 'sendRequest': {
        if (args.filePath && !args.url) return err('Gửi theo filePath (request đã lưu trong collection) chưa hỗ trợ ở chế độ web — hãy cung cấp url/method trực tiếp.');
        let url = args.url;
        if (!url) return err('Thiếu url.');
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
        if (/\{\{[^}]+\}\}/.test(url)) return err('URL còn biến chưa resolve (' + url + ') — chế độ web không có environment để thay {{...}}.');
        const t0 = Date.now();
        try {
          const resp = await fetch(url, { method, headers, body, redirect: 'follow', signal: AbortSignal.timeout(30000) });
          const raw = Buffer.from(await resp.arrayBuffer());
          const MAXB = 100 * 1024;
          const respHeaders = {}; resp.headers.forEach((v, k) => { respHeaders[k] = v; });
          return ok({ request: { method, url }, response: { statusCode: resp.status, statusText: resp.statusText, headers: respHeaders, size: raw.length, timeMs: Date.now() - t0, truncated: raw.length > MAXB, body: raw.slice(0, MAXB).toString('utf8') } });
        } catch (e) {
          return err('Gửi request lỗi: ' + (e.name === 'TimeoutError' ? 'timeout 30s' : e.message) + ' (' + method + ' ' + url + ')');
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
          return ok({ shown: true, identifier: idRaw, htmlBytes: Buffer.byteLength(html, 'utf8'), savedTo: file, note: 'Đã lưu HTML ra file để mở bằng trình duyệt (web mode không có workbench tab).' });
        } catch (e) {
          return ok({ shown: true, identifier: idRaw, htmlBytes: Buffer.byteLength(html, 'utf8'), note: 'Không lưu được file: ' + e.message });
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
        return ok({ navigated: false, appPath: args.appPath || null, note: 'Chế độ web không điều hướng được Postman Desktop; đã ghi nhận appPath.' });
      }
      case 'getTabDetails': {
        return ok({ available: false, tabId: args.tab_id || args.tabId || null, note: 'Không truy cập được tab Postman ở chế độ web (TAB_LIST trống).' });
      }
      case 'searchPostman': {
        return ok({ available: false, results: [], query: args.query != null ? String(args.query) : '', note: 'searchPostman chạy phía server; chế độ web không truy vấn được chỉ mục tìm kiếm của Postman.' });
      }
      case 'webSearch': {
        return ok({ available: false, results: [], note: 'webSearch do gateway xử lý (enableWebAccess); không chạy ở client web.' });
      }
      case 'learnAboutPostmanTerm': {
        return ok({ available: false, articles: [], note: 'learnAboutPostmanTerm do gateway xử lý; không có KB ở client web.' });
      }
      case 'searchConversationData': {
        return ok({ available: false, note: 'searchConversationData thao tác trên transcript nội bộ; không áp dụng ở client web.' });
      }
      case 'SubAgent': {
        return err('SubAgent (uỷ nhiệm sub-agent) không chạy được ở client web — hãy xử lý trực tiếp bằng các tool sẵn có.');
      }
      default:
        if (isMcpTool(name)) return await callMcpTool(name, args);
        return { status: 'UNSUPPORTED', message: 'Tool "' + name + '" chưa hỗ trợ ở chế độ web (đang hỗ trợ: ' + SUPPORTED_TOOLS.join(', ') + ', và tool MCP mcp__*).' };
    }
  } catch (e) {
    return err(e.message);
  }
}

/** Tóm tắt ngắn kết quả tool để hiển thị trên giao diện. */
export function summarizeTool(name, r) {
  if (!r) return '';
  if (r.status !== 'SUCCESS') return r.message || r.status || 'lỗi';
  if (isMcpTool(name)) { const c = r.content != null ? String(r.content) : ''; return 'MCP ' + (r.server || '') + '/' + (r.tool || '') + (c ? ' · ' + c.slice(0, 120).replace(/\s+/g, ' ') : ''); }
  if (name === 'listDirectory') return (r.count != null ? r.count + ' mục' : 'OK') + (r.path ? ' · ' + r.path : '');
  if (name === 'readFile') return 'đọc ' + (r.size != null ? r.size + ' bytes' : 'file') + (r.truncated ? ' (cắt bớt)' : '');
  if (name === 'createFile') return 'tạo file' + (r.bytesWritten != null ? ' · ' + r.bytesWritten + ' bytes' : '') + (r.path ? ' · ' + r.path : '');
  if (name === 'editFile') return 'sửa file · ' + (r.replacements != null ? r.replacements + ' thay thế' : 'OK') + (r.path ? ' · ' + r.path : '');
  if (name === 'searchInFiles') return (r.count != null ? r.count + ' kết quả' : 'OK') + (r.truncated ? '+' : '');
  if (name === 'executeShellCommand') return 'exit ' + (r.exitCode != null ? r.exitCode : '?') + (r.timedOut ? ' · timeout' : '') + (r.cwd ? ' · ' + r.cwd : '');
  if (name === 'sendRequest') return r.response ? (r.response.statusCode + ' ' + (r.response.statusText || '') + ' · ' + (r.response.timeMs != null ? r.response.timeMs + 'ms' : '')).trim() : 'OK';
  if (name === 'showRichOutput') return 'hiển thị' + (r.htmlBytes != null ? ' · ' + r.htmlBytes + ' bytes' : '') + (r.savedTo ? ' · ' + r.savedTo : '');
  if (name === 'todoWrite') return (r.count != null ? r.count + ' todo' : 'OK');
  if (name === 'recommendNextActions') return (r.count != null ? r.count + ' gợi ý' : 'OK');
  if (name === 'navigateInApp') return 'điều hướng (ghi nhận)' + (r.appPath ? ' · ' + r.appPath : '');
  if (name === 'getTabDetails') return r.available === false ? 'không có tab' : 'OK';
  if (name === 'searchPostman') return r.available === false ? 'không khả dụng (server-side)' : ((r.results ? r.results.length : 0) + ' kết quả');
  if (name === 'webSearch') return r.available === false ? 'không khả dụng (server-side)' : 'OK';
  if (name === 'learnAboutPostmanTerm') return r.available === false ? 'không khả dụng (server-side)' : 'OK';
  if (name === 'searchConversationData') return r.available === false ? 'không áp dụng' : 'OK';
  return 'OK';
}
