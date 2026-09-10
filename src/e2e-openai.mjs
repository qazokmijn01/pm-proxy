/**
 * E2E tuong thich OpenAI: dung GATEWAY GIA (khong ton credit) de soi cac truong hop bien.
 * Chay: node e2e-oai.mjs
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));   // chay duoc o may bat ky
const GW_PORT = 8897, PX_PORT = 8798;
let scenario = 'text';           // dieu khien phan hoi cua gateway gia
let lastBody = null;

const sse = (evts) => evts.map((e) => 'data: ' + (e === 'DONE' ? '[DONE]' : JSON.stringify(e))).join('\n') + '\n';
const ev = (eventType, data) => ({ eventType, data });

const gw = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    try { lastBody = JSON.parse(b); } catch { lastBody = null; }
    let out;
    if (scenario === 'text') out = [ev('conversation', { id: 'c1' }), ev('textChunk', { textContent: 'xin ' }), ev('textChunk', { textContent: 'chao' }), 'DONE'];
    else if (scenario === 'tool') out = [ev('conversation', { id: 'c1' }), ev('toolCallChunk', { toolCalls: [{ id: 't1', toolCallGroupId: 'g1', function: { name: 'readFile', arguments: '{"filePath":"/a.txt"}' } }] }), 'DONE'];
    else if (scenario === 'multitool') out = [ev('conversation', { id: 'c1' }),
      ev('toolCallChunk', { toolCalls: [{ id: 't1', toolCallGroupId: 'g1', function: { name: 'readFile', arguments: '{"filePath":"/a.txt"}' } }] }),
      ev('toolCallChunk', { toolCalls: [{ id: 't2', toolCallGroupId: 'g1', function: { name: 'readFile', arguments: '{"filePath":"/b.txt"}' } }] }), 'DONE'];
    else if (scenario === 'empty') out = [ev('conversation', { id: 'c1' }), 'DONE'];
    else if (scenario === 'gwerror') { res.writeHead(500, { 'content-type': 'application/json' }); return res.end('{"error":"gateway sap"}'); }
    else out = ['DONE'];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse(out));
  });
});

const post = (path, body) => new Promise((resolve) => {
  const data = JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port: PX_PORT, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
    let s = '';
    res.on('data', (c) => (s += c));
    res.on('end', () => resolve({ status: res.statusCode, ct: res.headers['content-type'] || '', body: s }));
  });
  req.on('error', (e) => resolve({ status: 0, body: String(e.message) }));
  req.end(data);
});

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  [v] ' + name); }
  else { fail++; console.log('  [X] ' + name + (detail ? ' -> ' + detail : '')); }
};

const TOOLS = [{ type: 'function', function: { name: 'read_file', description: 'doc file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }];

const px = spawn(process.execPath, [path.join(ROOT, 'claude-proxy.mjs')], {
  env: { ...process.env, PM_ANTHROPIC_PORT: String(PX_PORT), PM_GATEWAY: 'http://127.0.0.1:' + GW_PORT, PM_CAPTURE: '0', PM_MCP_AUTOREGISTER: '0', PM_CWD_PROBE: '0' },
  stdio: process.env.PM_E2E_VERBOSE ? ['ignore', 'inherit', 'inherit'] : 'ignore',
});

await new Promise((r) => gw.listen(GW_PORT, '127.0.0.1', r));
await new Promise((r) => setTimeout(r, 2500));

console.log('\n# chat thuong (non-stream)');
scenario = 'text';
let r = await post('/v1/chat/completions', { model: 'claude-sonnet-4', messages: [{ role: 'user', content: 'chao' }], tools: TOOLS });
let j = JSON.parse(r.body || '{}');
check('status 200 + content-type json', r.status === 200 && r.ct.includes('json'), r.status + ' ' + r.ct);
check('object=chat.completion', j.object === 'chat.completion');
check('noi du text tu nhieu chunk', j.choices && j.choices[0].message.content === 'xin chao', JSON.stringify(j.choices && j.choices[0]));
check('finish_reason=stop', j.choices && j.choices[0].finish_reason === 'stop');
check('usage co du 3 khoa', j.usage && 'prompt_tokens' in j.usage && 'completion_tokens' in j.usage && 'total_tokens' in j.usage);

console.log('\n# chat stream');
r = await post('/v1/chat/completions', { model: 'claude-sonnet-4', stream: true, messages: [{ role: 'user', content: 'chao' }], tools: TOOLS });
check('content-type text/event-stream', r.ct.includes('event-stream'), r.ct);
check('co chunk role assistant dau tien', /"delta":\{"role":"assistant"/.test(r.body));
check('co chunk noi dung', /"content":"xin "/.test(r.body) && /"content":"chao"/.test(r.body));
check('co finish_reason stop', /"finish_reason":"stop"/.test(r.body));
check('ket thuc bang [DONE]', r.body.trim().endsWith('data: [DONE]'));
check('KHONG lan event: cua Anthropic', !r.body.includes('event: message_start'), 'ro ri dinh dang Anthropic');

console.log('\n# goi cong cu');
scenario = 'tool';
r = await post('/v1/chat/completions', { model: 'claude-sonnet-4', messages: [{ role: 'user', content: 'doc file' }], tools: TOOLS });
j = JSON.parse(r.body || '{}');
const tc = j.choices && j.choices[0].message.tool_calls;
check('finish_reason=tool_calls', j.choices && j.choices[0].finish_reason === 'tool_calls', JSON.stringify(j.choices && j.choices[0]));
check('co tool_calls', !!(tc && tc.length));
check('doi ten tool theo client (read_file)', !!(tc && tc[0].function.name === 'read_file'), tc && tc[0].function.name);
check('doi khoa tham so theo schema (path)', !!(tc && JSON.parse(tc[0].function.arguments).path === '/a.txt'), tc && tc[0].function.arguments);
check('content=null khi chi co tool_call', j.choices && j.choices[0].message.content === null);

console.log('\n# nhieu cong cu song song (stream)');
scenario = 'multitool';
r = await post('/v1/chat/completions', { model: 'claude-sonnet-4', stream: true, messages: [{ role: 'user', content: 'doc 2 file' }], tools: TOOLS });
const idxs = [...r.body.matchAll(/"tool_calls":\[\{"index":(\d+)/g)].map((m) => Number(m[1]));
check('phat du 2 tool_call', idxs.length === 2, JSON.stringify(idxs));
check('index tang dan 0,1', JSON.stringify(idxs) === '[0,1]', JSON.stringify(idxs));

console.log('\n# truong hop bien');
scenario = 'text';
r = await post('/v1/chat/completions', { messages: [] });
check('messages rong -> khong 500', r.status !== 500, 'status ' + r.status);
r = await post('/v1/chat/completions', {});
check('body rong -> khong 500', r.status !== 500, 'status ' + r.status);
r = await post('/v1/chat/completions', { model: 'x', messages: [{ role: 'user', content: 'chao' }], tools: TOOLS, stream: true, stream_options: { include_usage: true } });
check('include_usage -> co chunk usage', /"usage":\{"prompt_tokens"/.test(r.body));

scenario = 'gwerror';
r = await post('/v1/chat/completions', { model: 'x', messages: [{ role: 'user', content: 'chao' }], tools: TOOLS });
check('gateway loi -> tra loi dang OpenAI (co .error.message)', (() => { try { return !!JSON.parse(r.body).error.message; } catch { return false; } })(), r.body.slice(0, 120));
r = await post('/v1/chat/completions', { model: 'x', stream: true, messages: [{ role: 'user', content: 'chao' }], tools: TOOLS });
check('gateway loi khi stream -> van ket thuc [DONE]', r.body.includes('[DONE]') || r.body.includes('error'), r.body.slice(0, 120));

scenario = 'text';
// Cong cu lap trinh hay cho huy giua chung -> proxy tuyet doi khong duoc chet theo.
await new Promise((resolve) => {
  const data = JSON.stringify({ model: 'x', stream: true, messages: [{ role: 'user', content: 'chao' }], tools: TOOLS });
  const req = http.request({ host: '127.0.0.1', port: PX_PORT, path: '/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
    res.on('data', () => req.destroy());
    res.on('error', () => {});
  });
  req.on('error', () => {});
  req.end(data);
  setTimeout(resolve, 800);
});
const alive = await post('/v1/chat/completions', { model: 'x', messages: [{ role: 'user', content: 'chao' }], tools: TOOLS });
check('client huy giua stream -> proxy van song', alive.status === 200, 'status ' + alive.status);

console.log('\n# tool_choice');
scenario = 'text';
r = await post('/v1/chat/completions', { model: 'x', messages: [{ role: 'user', content: 'chao' }], tools: TOOLS, tool_choice: 'none' });
check('tool_choice=none -> khong 500', r.status === 200, 'status ' + r.status);
const exclNone = lastBody && lastBody.clientTools && lastBody.clientTools.excludedTools || [];
check('tool_choice=none -> cam readFile o gateway', exclNone.includes('readFile'), JSON.stringify(exclNone).slice(0, 120));
r = await post('/v1/chat/completions', { model: 'x', messages: [{ role: 'user', content: 'chao' }], tools: TOOLS, tool_choice: 'required' });
check('tool_choice=required -> co ep goi tool trong query', /PHAI goi|BAT BUOC/i.test(JSON.stringify(lastBody && lastBody.input && lastBody.input.query || '')), String((lastBody && lastBody.input && lastBody.input.query || '')).slice(0, 200));
r = await post('/v1/chat/completions', { model: 'x', messages: [{ role: 'user', content: 'chao' }], tools: TOOLS, tool_choice: { type: 'function', function: { name: 'read_file' } } });
check('tool_choice=<ten tool> -> neu dich danh ten tool', /read_file|readFile/.test(String(lastBody && lastBody.input && lastBody.input.query || '')), String((lastBody && lastBody.input && lastBody.input.query || '')).slice(0, 200));

console.log('\n# anh trong tin nhan');
r = await post('/v1/chat/completions', { model: 'x', tools: TOOLS, messages: [{ role: 'user', content: [{ type: 'text', text: 'anh nay la gi?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }] });
check('co anh -> khong 500', r.status === 200, 'status ' + r.status);
check('bao cho model biet co anh bi bo', /anh|image/i.test(String(lastBody && lastBody.input && lastBody.input.query || '')), String((lastBody && lastBody.input && lastBody.input.query || '')).slice(0, 200));

console.log(`\n[${fail ? 'X' : 'OK'}] e2e OpenAI: ${pass} pass, ${fail} fail`);
px.kill();
gw.close();
process.exit(fail ? 1 : 0);
