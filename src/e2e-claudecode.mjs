/**
 * E2E CLAUDE CODE: ep gateway (GIA) phat TUNG tool native cua Postman, kiem tra proxy dich
 * ra dung ten tool va dung khoa tham so theo schema Claude Code that; roi kiem tra chieu ve
 * (tool_result -> TOOL_RESPONSE) va cac native khong co duong ve.
 *
 * Gateway gia nen KHONG ton credit va khong phu thuoc model co chon tool hay khong.
 * Chay: npm run test:cc     (PM_E2E_VERBOSE=1 de xem log proxy)
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const GW_PORT = 8894, PX_PORT = 8795;
const WD = 'C:/du/an';

// Bo tool DUNG NHU Claude Code khai (ten + input_schema that).
const TOOLS = [
  { name: 'Bash', description: 'Run a shell command', input_schema: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' }, timeout: { type: 'number' }, run_in_background: { type: 'boolean' } }, required: ['command'], additionalProperties: false } },
  { name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { file_path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }, required: ['file_path'], additionalProperties: false } },
  { name: 'Write', description: 'Write a file', input_schema: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'], additionalProperties: false } },
  { name: 'Edit', description: 'Edit a file', input_schema: { type: 'object', properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['file_path', 'old_string', 'new_string'], additionalProperties: false } },
  { name: 'Glob', description: 'Find files by pattern', input_schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'], additionalProperties: false } },
  { name: 'Grep', description: 'Search file contents', input_schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' }, output_mode: { type: 'string' } }, required: ['pattern'], additionalProperties: false } },
  { name: 'WebFetch', description: 'Fetch a URL', input_schema: { type: 'object', properties: { url: { type: 'string' }, prompt: { type: 'string' } }, required: ['url', 'prompt'], additionalProperties: false } },
  { name: 'WebSearch', description: 'Search the web', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } },
  { name: 'AskUserQuestion', description: 'Ask the user', input_schema: { type: 'object', properties: { questions: { type: 'array' } }, required: ['questions'], additionalProperties: false } },
];

const CASES = [
  { name: 'Bash: chay lenh', native: 'executeShellCommand', args: { command: 'npm test' }, tool: 'Bash',
    check: (i) => i.command === 'npm test' },
  { name: 'Bash: co cwd -> ghep cd', native: 'executeShellCommand', args: { command: 'npm test', projectPath: 'C:/khac' }, tool: 'Bash',
    check: (i) => /^cd 'C:\/khac'; npm test$/.test(i.command) },
  { name: 'Bash: liet ke thu muc (POSIX vi Bash la git bash)', native: 'listDirectory', args: { relativePath: 'src' }, tool: 'Bash',
    check: (i) => /ls -la/.test(i.command) && i.command.includes('C:/du/an/src') && !/Get-ChildItem/.test(i.command) },
  { name: 'Read: doc file', native: 'readFile', args: { filePath: '/a.txt' }, tool: 'Read',
    check: (i) => i.file_path === '/a.txt' && !('path' in i) },
  { name: 'Read: co offset/limit', native: 'readFile', args: { filePath: '/a.txt', offset: 10, limit: 5 }, tool: 'Read',
    check: (i) => i.offset === 10 && i.limit === 5 },
  { name: 'Write: tao file', native: 'createFile', args: { filePath: '/b.txt', content: 'noi dung' }, tool: 'Write',
    check: (i) => i.file_path === '/b.txt' && i.content === 'noi dung' },
  { name: 'Write: writeFile cung ra Write', native: 'writeFile', args: { filePath: '/b.txt', content: 'x' }, tool: 'Write',
    check: (i) => i.file_path === '/b.txt' && i.content === 'x' },
  { name: 'Write: content rong van hop le', native: 'createFile', args: { filePath: '/c.txt' }, tool: 'Write',
    check: (i) => i.content === '' },
  { name: 'Edit: sua file', native: 'editFile', args: { filePath: '/d.txt', oldString: 'cu', newString: 'moi' }, tool: 'Edit',
    check: (i) => i.file_path === '/d.txt' && i.old_string === 'cu' && i.new_string === 'moi' },
  { name: 'Edit: replaceAll', native: 'editFile', args: { filePath: '/d.txt', oldString: 'a', newString: 'b', replaceAll: true }, tool: 'Edit',
    check: (i) => i.replace_all === true },
  { name: 'Grep: tim noi dung', native: 'searchInFiles', args: { queryString: 'TODO', path: 'src' }, tool: 'Grep',
    check: (i) => i.pattern === 'TODO' && i.path === 'C:/du/an/src' && i.output_mode === 'content' },
  { name: 'Grep: co glob loc file', native: 'searchFiles', args: { queryString: 'TODO', fileNamePatterns: ['*.mjs'] }, tool: 'Grep',
    check: (i) => i.pattern === 'TODO' && i.glob === '*.mjs' },
  { name: 'Glob: chi tim theo ten file', native: 'searchFiles', args: { fileNamePatterns: ['*.json'] }, tool: 'Glob',
    check: (i) => i.pattern === '*.json' },
  { name: 'WebFetch: lay URL', native: 'fetchUrl', args: { url: 'https://x.dev', prompt: 'tom tat' }, tool: 'WebFetch',
    check: (i) => i.url === 'https://x.dev' && i.prompt === 'tom tat' },
  { name: 'WebFetch: thieu prompt -> tu dien', native: 'fetchUrl', args: { url: 'https://x.dev' }, tool: 'WebFetch',
    check: (i) => typeof i.prompt === 'string' && i.prompt.length > 0 },
  { name: 'WebSearch: tim web', native: 'webSearch', args: { query: 'pm-proxy' }, tool: 'WebSearch',
    check: (i) => i.query === 'pm-proxy' },
  { name: 'AskUserQuestion: dung chuan SDK', native: 'askUser', args: { questions: [{ message: 'Chon cai nao?', options: ['A - mot', 'B - hai'] }] }, tool: 'AskUserQuestion',
    check: (i) => {
      const q = i.questions && i.questions[0];
      return !!q && typeof q.header === 'string' && q.header.length > 0 && q.header.length <= 12
        && typeof q.multiSelect === 'boolean' && Array.isArray(q.options)
        && q.options.length >= 2 && q.options.length <= 4
        && q.options.every((o) => typeof o.label === 'string' && typeof o.description === 'string');
    } },
  { name: 'AskUserQuestion: chon-nhieu giu du lua chon', native: 'askUser',
    args: { questions: [{ message: 'Chon cac muc?', allow_multiple: true, options: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }] }, tool: 'AskUserQuestion',
    check: (i) => {
      const all = i.questions.flatMap((q) => q.options.map((o) => o.label));
      return i.questions.every((q) => q.multiSelect === true && q.options.length >= 2 && q.options.length <= 4) && all.length === 7;
    } },
];

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log('  [v] ' + name); }
  else { fail++; console.log('  [X] ' + name + (detail ? ' -> ' + detail : '')); }
};

let current = null;           // 1 tool call
let multi = null;             // nhieu tool call trong cung mot luot
const seen = { body: null };  // body cuoi cung gateway nhan duoc

const sse = (parts) => parts.map((p) => 'data: ' + JSON.stringify(p)).join('\n') + '\ndata: [DONE]\n';
const toolChunk = (id, name, args) => ({ eventType: 'toolCallChunk', data: { toolCalls: [{ id, toolCallGroupId: 'g1', function: { name, arguments: JSON.stringify(args) } }] } });

const gw = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    let j; try { j = JSON.parse(b); } catch { res.writeHead(200); return res.end(); }
    seen.body = j;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const isQuery = j.input.chatType === 'USER_QUERY';
    if (isQuery && multi) {
      return res.end(sse([{ eventType: 'conversation', data: { id: 'c-multi' } }, ...multi.map((m) => toolChunk(m.id, m.name, m.args))]));
    }
    if (isQuery && current) {
      return res.end(sse([{ eventType: 'conversation', data: { id: 'c-' + Date.now() } }, toolChunk('toolu_' + Date.now(), current.native, current.args)]));
    }
    res.end(sse([{ eventType: 'textChunk', data: { textContent: 'xong' } }]));
  });
});

const post = (body) => new Promise((resolve) => {
  const data = JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port: PX_PORT, path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'x-pm-working-dir': WD } }, (res) => {
    let s = '';
    res.on('data', (c) => (s += c));
    res.on('end', () => { try { resolve(JSON.parse(s)); } catch { resolve({ _raw: s }); } });
  });
  req.on('error', (e) => resolve({ _err: e.message }));
  req.end(data);
});

const ask = (sys, messages) => post({ model: 'claude-sonnet-4-20250514', max_tokens: 512, stream: false, system: sys, tools: TOOLS, messages });

const px = spawn(process.execPath, [path.join(ROOT, 'claude-proxy.mjs')], {
  env: { ...process.env, PM_ANTHROPIC_PORT: String(PX_PORT), PM_GATEWAY: 'http://127.0.0.1:' + GW_PORT, PM_CAPTURE: '0', PM_MCP_AUTOREGISTER: '0', PM_CWD_PROBE: '0' },
  stdio: process.env.PM_E2E_VERBOSE ? ['ignore', 'inherit', 'inherit'] : 'ignore',
});

await new Promise((r) => gw.listen(GW_PORT, '127.0.0.1', r));
await new Promise((r) => setTimeout(r, 2500));

console.log('\n# Moi native Postman -> dung tool + dung khoa tham so');
for (const c of CASES) {
  current = c; multi = null;
  const d = await ask('cc-' + c.native + '-' + Math.random(), [{ role: 'user', content: 'lam viec di' }]);
  const tu = (d.content || []).find((b) => b.type === 'tool_use');
  if (!tu) { check(c.name, false, 'khong phat tool_use: ' + JSON.stringify(d).slice(0, 120)); continue; }
  if (tu.name !== c.tool) { check(c.name, false, 'ra tool ' + tu.name + ' thay vi ' + c.tool); continue; }
  let ok = false, err = '';
  try { ok = c.check(tu.input || {}); } catch (e) { err = e.message; }
  check(c.name, ok, ok ? '' : (err || JSON.stringify(tu.input).slice(0, 160)));
}

console.log('\n# Nhieu tool trong cung mot luot');
current = null;
multi = [
  { id: 'toolu_p1', name: 'readFile', args: { filePath: '/a.txt' } },
  { id: 'toolu_p2', name: 'readFile', args: { filePath: '/b.txt' } },
  { id: 'toolu_p3', name: 'executeShellCommand', args: { command: 'echo hi' } },
];
const SYS = 'cc-multi-fixed';
let d = await ask(SYS, [{ role: 'user', content: 'lam nhieu viec' }]);
const calls = (d.content || []).filter((b) => b.type === 'tool_use');
check('phat du 3 tool_use', calls.length === 3, 'co ' + calls.length);
check('dung ten tung tool', calls.length === 3 && calls[0].name === 'Read' && calls[1].name === 'Read' && calls[2].name === 'Bash', calls.map((c) => c.name).join(','));
check('giu nguyen id cua gateway', calls.length === 3 && calls[0].id === 'toolu_p1', calls.map((c) => c.id).join(','));

console.log('\n# Chieu ve: tool_result -> TOOL_RESPONSE');
multi = null;
const results = calls.map((c, i) => ({ type: 'tool_result', tool_use_id: c.id, content: i === 1 ? '' : 'ket qua ' + i, is_error: i === 2 }));
await ask(SYS, [{ role: 'user', content: 'lam nhieu viec' }, { role: 'assistant', content: calls }, { role: 'user', content: results }]);
const inp = (seen.body && seen.body.input) || {};
check('gateway nhan TOOL_RESPONSE (khong phai USER_QUERY)', inp.chatType === 'TOOL_RESPONSE', String(inp.chatType));
const trs = inp.toolResponses || [];
check('tra du 3 ket qua', trs.length === 3, 'co ' + trs.length);
check('toolCallId khop id goc', trs.length === 3 && trs.every((t) => /^toolu_p[123]$/.test(t.toolCallId)), JSON.stringify(trs.map((t) => t.toolCallId)));
check('ket qua RONG duoc thay the (gateway 403 neu rong)', trs.length === 3 && trs.every((t) => String(t.content || '').trim().length > 0), JSON.stringify(trs.map((t) => t.content)));
check('ket qua loi danh dau khong-SUCCESS', trs.some((t) => t.toolResponseStatus !== 'SUCCESS'), JSON.stringify(trs.map((t) => t.toolResponseStatus)));

console.log('\n# Native khong co duong ve Claude Code');
for (const n of ['todoWrite', 'navigateInApp', 'getVariables']) {
  current = { native: n, args: { x: 1 } }; multi = null;
  const r = await ask('cc-drop-' + n + '-' + Math.random(), [{ role: 'user', content: 'lam gi di' }]);
  const hasTool = (r.content || []).some((b) => b.type === 'tool_use');
  check(n + ' -> khong ep client chay, luot van xong', !hasTool && r.stop_reason === 'end_turn', JSON.stringify(r).slice(0, 120));
}

console.log(`\n[${fail ? 'X' : 'OK'}] e2e Claude Code: ${pass} pass, ${fail} fail`);
px.kill();
gw.close();
process.exit(fail ? 1 : 0);
