#!/usr/bin/env node
/**
 * SELFTEST OFFLINE - khong ton credit, khong can Postman mo.
 * Kiem: pickArg, bang map tool (#5), excludedTools, tool card (#4), model map,
 * chuoi SSE Anthropic, phat hien luot (tool_result vs user_query), va MOT vong
 * roundtrip day du qua gateway GIA (mock fetch) - ca nhanh tool-cho-client lan
 * nhanh drop-roi-tiep-tuc.
 *
 *   node src/selftest.mjs
 */
import assert from 'node:assert';
import {
  pickArg, mapPostmanToolToClaude, excludedToolsFor, buildToolCard, mapModel, claudeToolSet,
  conformToolName, conformInputToSchema,
} from './map.mjs';
import { AnthropicSSE } from './sse.mjs';
import { analyzeRequest, buildToolResponses, extractAskUserAnswer, rebuildTranscript, priorMessages } from './translate.mjs';
import { runGateway, runGatewayResilient, thinkingFlag, prepBody, BufferEmitter } from './server.mjs';
import { loadTemplate } from './core.mjs';
import { recordToolUse, getToolUse } from './sessions.mjs';

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); console.log('  [v]', name); pass++; } catch (e) { console.log('  [x]', name, '->', e.message); fail++; } };
const okAsync = async (name, fn) => { try { await fn(); console.log('  [v]', name); pass++; } catch (e) { console.log('  [x]', name, '->', e.message); fail++; } };

console.log('\n# pickArg - chuan hoa khoa');
ok('filePath / file_path / File-Path quy ve cung vai tro', () => {
  assert.equal(pickArg({ filePath: '/a' }, 'filePath'), '/a');
  assert.equal(pickArg({ file_path: '/b' }, 'filePath'), '/b');
  assert.equal(pickArg({ 'File-Path': '/c' }, 'filePath'), '/c');
  assert.equal(pickArg({}, 'filePath'), undefined);
});

console.log('\n# Bang map tool (docs/tool-mapping.md #5)');
const CT = claudeToolSet([{ name: 'Bash' }, { name: 'Read' }, { name: 'Write' }, { name: 'Edit' }, { name: 'WebFetch' }, { name: 'WebSearch' }, { name: 'Grep' }, { name: 'Glob' }]);
ok('executeShellCommand -> Bash, ghep cd <projectPath>', () => {
  const r = mapPostmanToolToClaude('executeShellCommand', { projectPath: '/proj', command: 'ls' }, CT);
  assert.equal(r.kind, 'client'); assert.equal(r.name, 'Bash');
  assert.match(r.input.command, /cd '\/proj'; ls/);
});
ok('listDirectory -> Bash ls -la', () => {
  const r = mapPostmanToolToClaude('listDirectory', { relativePath: '/x' }, CT);
  assert.equal(r.name, 'Bash'); assert.match(r.input.command, /ls -la -- '\/x'/);
});
ok('searchInFiles -> Grep native (khong dung `Bash rg`); chi fileNamePatterns -> Glob; rong => drop', () => {
  const g = mapPostmanToolToClaude('searchInFiles', { queryString: 'CONFIG' }, CT);
  assert.equal(g.name, 'Grep'); assert.equal(g.input.pattern, 'CONFIG'); assert.equal(g.input.output_mode, 'content');
  const gl = mapPostmanToolToClaude('searchInFiles', { fileNamePatterns: ['*.ts'] }, CT);
  assert.equal(gl.name, 'Glob'); assert.equal(gl.input.pattern, '*.ts');
  assert.equal(mapPostmanToolToClaude('searchInFiles', {}, CT).kind, 'drop');
});
ok('readFile -> Read {file_path} (tu filePath tren wire)', () => {
  const r = mapPostmanToolToClaude('readFile', { filePath: '/pkg.json' }, CT);
  assert.equal(r.name, 'Read'); assert.equal(r.input.file_path, '/pkg.json');
});
ok('createFile -> Write {file_path, content}', () => {
  const r = mapPostmanToolToClaude('createFile', { filePath: '/n.txt', content: 'HI' }, CT);
  assert.equal(r.name, 'Write'); assert.equal(r.input.file_path, '/n.txt'); assert.equal(r.input.content, 'HI');
});
ok('editFile -> Edit {file_path, old_string, new_string}', () => {
  const r = mapPostmanToolToClaude('editFile', { filePath: '/f', oldString: 'a', newString: 'b' }, CT);
  assert.equal(r.name, 'Edit'); assert.equal(r.input.old_string, 'a'); assert.equal(r.input.new_string, 'b');
});
ok('webSearch -> WebSearch (gop queries[])', () => {
  const r = mapPostmanToolToClaude('webSearch', { queries: ['a', 'b'] }, CT);
  assert.equal(r.name, 'WebSearch'); assert.equal(r.input.query, 'a b');
});

console.log('\n# conform toi schema client (file_path <-> path) - sua "tool read must have required property path"');
const READ_FILEPATH = [{ name: 'Read', input_schema: { properties: { file_path: {}, offset: {}, limit: {} }, required: ['file_path'] } }];
const READ_PATH = [{ name: 'read', input_schema: { properties: { path: {} }, required: ['path'] } }];
ok('schema co file_path -> giu nguyen file_path + ten Read', () => {
  assert.equal(conformToolName('Read', READ_FILEPATH), 'Read');
  const inp = conformInputToSchema('Read', { file_path: '/a' }, READ_FILEPATH);
  assert.equal(inp.file_path, '/a'); assert.equal(inp.path, undefined);
});
ok('schema doi path -> doi file_path->path + ten read (dung ca loi Win10)', () => {
  assert.equal(conformToolName('Read', READ_PATH), 'read');
  const inp = conformInputToSchema('read', { file_path: 'C:\\x\\test.txt' }, READ_PATH);
  assert.equal(inp.path, 'C:\\x\\test.txt'); assert.equal(inp.file_path, undefined);
});
ok('khong co schema/toolDefs -> giu nguyen (hanh vi cu, khong pha may dang chay)', () => {
  const inp = conformInputToSchema('Read', { file_path: '/a' }, undefined);
  assert.equal(inp.file_path, '/a');
  assert.equal(conformToolName('Read', undefined), 'Read');
});
ok('Write theo schema path: content giu nguyen, file_path->path', () => {
  const WRITE_PATH = [{ name: 'Write', input_schema: { properties: { path: {}, content: {} }, required: ['path', 'content'] } }];
  const inp = conformInputToSchema('Write', { file_path: '/n.txt', content: 'HI' }, WRITE_PATH);
  assert.equal(inp.path, '/n.txt'); assert.equal(inp.content, 'HI'); assert.equal(inp.file_path, undefined);
});
ok('askUser -> AskUserQuestion {questions:[{question, options:[{label}]}]}', () => {
  const CTA = claudeToolSet([{ name: 'AskUserQuestion' }]);
  const r = mapPostmanToolToClaude('askUser', { question: 'JSON hay YAML?', options: ['JSON', 'YAML'] }, CTA);
  assert.equal(r.kind, 'client'); assert.equal(r.name, 'AskUserQuestion');
  assert.equal(r.input.questions[0].question, 'JSON hay YAML?');
  assert.equal(r.input.questions[0].options[0].label, 'JSON');
});
ok('askUser: LUON co header (string) + moi options[].description (string) - fix InputValidationError', () => {
  const CTA = claudeToolSet([{ name: 'AskUserQuestion' }]);
  // shape so nhieu voi `message`, KHONG co header/description (giong gateway that da fail)
  const r = mapPostmanToolToClaude('askUser', { questions: [{ message: 'Chon vi tri?', options: ['A', 'B', 'C'] }] }, CTA);
  assert.equal(r.name, 'AskUserQuestion');
  const q = r.input.questions[0];
  assert.equal(typeof q.header, 'string'); assert.ok(q.header.length > 0);
  assert.ok(q.options.length === 3);
  assert.ok(q.options.every((o) => typeof o.label === 'string' && typeof o.description === 'string'));
});
ok('todoWrite / navigateInApp -> drop (kem syntheticResult)', () => {
  const r = mapPostmanToolToClaude('todoWrite', { todos: [] }, CT);
  assert.equal(r.kind, 'drop'); assert.ok(r.syntheticResult.includes('todoWrite'));
});
ok('client khong khai Bash => executeShellCommand bi drop', () => {
  const r = mapPostmanToolToClaude('executeShellCommand', { command: 'ls' }, claudeToolSet([{ name: 'Read' }]));
  assert.equal(r.kind, 'drop');
});

console.log('\n# excludedTools');
ok('client chi co Read => loai executeShellCommand & askUser, GIU readFile', () => {
  const ex = excludedToolsFor(claudeToolSet([{ name: 'Read' }]), []);
  assert.ok(ex.includes('executeShellCommand'));
  assert.ok(ex.includes('askUser'));
  assert.ok(!ex.includes('readFile'));
});

ok('client CO AskUserQuestion => GIU askUser (khong loai)', () => {
  const ex = excludedToolsFor(claudeToolSet([{ name: 'AskUserQuestion' }]), []);
  assert.ok(!ex.includes('askUser'));
});

ok('askUser {question,options[string]} => AskUserQuestion questions[].options[].label', () => {
  const r = mapPostmanToolToClaude('askUser', { question: 'Chon DB?', options: ['Postgres', 'MySQL'] }, claudeToolSet([{ name: 'AskUserQuestion' }]));
  assert.equal(r.kind, 'client');
  assert.equal(r.name, 'AskUserQuestion');
  assert.equal(r.input.questions[0].question, 'Chon DB?');
  assert.deepEqual(r.input.questions[0].options, [{ label: 'Postgres', description: '' }, { label: 'MySQL', description: '' }]);
});

ok('askUser thieu options => tu chen Yes/No', () => {
  const r = mapPostmanToolToClaude('askUser', { question: 'Tiep tuc?' }, claudeToolSet([{ name: 'AskUserQuestion' }]));
  assert.deepEqual(r.input.questions[0].options, [{ label: 'Yes', description: '' }, { label: 'No', description: '' }]);
});

ok('askUser shape so nhieu {questions:[{message,options}]} => KHONG drop, map dung', () => {
  const r = mapPostmanToolToClaude('askUser', {
    questions: [{ id: 'fmt', message: 'JSON hay YAML?', options: ['JSON', 'YAML'] }],
  }, claudeToolSet([{ name: 'AskUserQuestion' }]));
  assert.equal(r.kind, 'client');
  assert.equal(r.name, 'AskUserQuestion');
  assert.equal(r.input.questions[0].question, 'JSON hay YAML?');
  assert.deepEqual(r.input.questions[0].options, [{ label: 'JSON', description: '' }, { label: 'YAML', description: '' }]);
});

ok('askUser so nhieu nhieu cau hoi => map tat ca questions', () => {
  const r = mapPostmanToolToClaude('askUser', {
    questions: [
      { id: 'a', message: 'Cau 1?', options: ['X', 'Y'] },
      { id: 'b', message: 'Cau 2?' },
    ],
  }, claudeToolSet([{ name: 'AskUserQuestion' }]));
  assert.equal(r.kind, 'client');
  assert.equal(r.input.questions.length, 2);
  assert.equal(r.input.questions[1].question, 'Cau 2?');
  assert.deepEqual(r.input.questions[1].options, [{ label: 'Yes', description: '' }, { label: 'No', description: '' }]);
});

ok('askUser > 4 options => cat con 4 (giu 3 dau + "Lua chon khac...") - fix InputValidationError too_big max 4', () => {
  const r = mapPostmanToolToClaude('askUser', {
    questions: [{ message: 'Chon quy trinh?', options: ['A', 'B', 'C', 'D', 'E'] }],
  }, claudeToolSet([{ name: 'AskUserQuestion' }]));
  const opts = r.input.questions[0].options;
  assert.equal(opts.length, 4, 'dung 4 options (max)');
  assert.deepEqual(opts.slice(0, 3).map((o) => o.label), ['A', 'B', 'C']);
  assert.equal(opts[3].label, 'Lua chon khac...');
  assert.ok(opts[3].description.includes('D') && opts[3].description.includes('E'), 'phan du nam trong description (khong mat)');
  assert.ok(opts.every((o) => typeof o.label === 'string' && typeof o.description === 'string'));
});

ok('askUser 1 option => chen them cho du toi thieu 2 (minItems 2)', () => {
  const r = mapPostmanToolToClaude('askUser', { question: 'Chi 1?', options: ['Only'] }, claudeToolSet([{ name: 'AskUserQuestion' }]));
  const opts = r.input.questions[0].options;
  assert.ok(opts.length >= 2, 'it nhat 2 options');
  assert.equal(opts[0].label, 'Only');
});

ok('askUser > 4 cau hoi => cat con 4 (maxItems 4)', () => {
  const many = Array.from({ length: 6 }, (_, i) => ({ message: 'Cau ' + i + '?', options: ['X', 'Y'] }));
  const r = mapPostmanToolToClaude('askUser', { questions: many }, claudeToolSet([{ name: 'AskUserQuestion' }]));
  assert.equal(r.input.questions.length, 4, 'toi da 4 cau hoi');
});

console.log('\n# Tool card (#4 - khang dinh, quang cao ten native, khong phu dinh)');
ok('card neu native name + khong co cau phu dinh danh tinh', () => {
  const card = buildToolCard({ workingDir: 'C:/proj', claudeToolNames: CT });
  assert.ok(card.includes('readFile') || card.includes('executeShellCommand'));
  assert.ok(card.includes('C:/proj'));
  assert.ok(!/only have Postman|khong phai Postman|did not come from/i.test(card));
});

console.log('\n# mapModel');
ok('claude-opus-* -> key chua OPUS; sonnet -> SONNET; la -> null', () => {
  const keys = ['CLAUDE_OPUS_48_BEDROCK', 'CLAUDE_SONNET_45_BEDROCK', 'GPT_5'];
  assert.match(mapModel('claude-opus-4-6', keys), /OPUS/);
  assert.match(mapModel('claude-sonnet-4-5-20250929', keys), /SONNET/);
  assert.equal(mapModel('gpt-4o', keys), null);
});

console.log('\n# Chuoi SSE Anthropic');
ok('message_start -> content_block(text) -> tool_use -> message_delta(tool_use) -> message_stop', () => {
  const chunks = [];
  const fakeRes = { write: (s) => chunks.push(s) };
  const sse = new AnthropicSSE(fakeRes, { model: 'claude-x' });
  sse.textDelta('Hello');
  sse.toolUse('toolu_1', 'Read', { file_path: '/a' });
  sse.finish('tool_use');
  const out = chunks.join('');
  const order = [...out.matchAll(/event: (\w+)/g)].map((m) => m[1]);
  assert.equal(order[0], 'message_start');
  assert.ok(order.includes('content_block_start'));
  assert.ok(order.includes('content_block_delta'));
  assert.equal(order[order.length - 2], 'message_delta');
  assert.equal(order[order.length - 1], 'message_stop');
  assert.ok(out.includes('"input_json_delta"'));
  assert.ok(out.includes('"stop_reason":"tool_use"'));
  // REGRESSION GUARD: moi content_block_start phai co content_block_stop khop index
  // (bug cu: tool_use khong duoc dong -> "tool call could not be parsed").
  const starts = [...out.matchAll(/"content_block_start","index":(\d+)/g)].map((m) => m[1]).sort();
  const stops = [...out.matchAll(/"content_block_stop","index":(\d+)/g)].map((m) => m[1]).sort();
  assert.deepEqual(stops, starts, 'moi block mo phai duoc dong (ke ca tool_use)');
  const lastStop = out.lastIndexOf('content_block_stop');
  assert.ok(lastStop !== -1 && lastStop < out.indexOf('message_delta'), 'content_block_stop phai truoc message_delta');
});
ok('thinking: content_block(thinking) -> thinking_delta -> signature_delta -> stop, dung TRUOC text', () => {
  const chunks = [];
  const sse = new AnthropicSSE({ write: (s) => chunks.push(s) }, { model: 'x' });
  sse.thinkingDelta('reasoning...');
  sse.textDelta('answer');
  sse.finish('end_turn');
  const out = chunks.join('');
  assert.ok(out.includes('"type":"thinking"'), 'co thinking block');
  assert.ok(out.includes('"thinking_delta"'), 'co thinking_delta');
  assert.ok(out.includes('"signature_delta"'), 'co signature_delta');
  const sigIdx = out.indexOf('signature_delta');
  const firstStop = out.indexOf('content_block_stop');
  assert.ok(sigIdx !== -1 && sigIdx < firstStop, 'signature_delta truoc content_block_stop');
  assert.ok(out.indexOf('"type":"thinking"') < out.indexOf('"type":"text"'), 'thinking truoc text');
});

ok("thinkingFlag: 'adaptive' va 'enabled' deu BAT, chi 'disabled' moi tat", () => {
  // Claude Code moi gui {type:'adaptive'} - coi la tat thi proxy set
  // useThinkingModeIfAvailable=false va gateway khong bao gio phat thinkingChunk.
  assert.equal(thinkingFlag({ thinking: { type: 'adaptive', display: 'summarized' } }), true);
  assert.equal(thinkingFlag({ thinking: { type: 'enabled', budget_tokens: 31999 } }), true);
  assert.equal(thinkingFlag({ thinking: { type: 'disabled' } }), false);
  assert.equal(thinkingFlag({}), null, 'khong khai bao => null (de template gateway quyet)');
});
ok('prepBody: thinking=true => useThinkingModeIfAvailable + thinkingLevel', () => {
  const body = { thinking: { type: 'adaptive' } };
  const on = prepBody(body, { claudeTools: CT, thinking: thinkingFlag(body) });
  assert.equal(on.devModeOptions.useThinkingModeIfAvailable, true);
  assert.equal(on.devModeOptions.thinkingLevel, 'medium');
  const off = prepBody({}, { claudeTools: CT, thinking: false });
  assert.equal(off.devModeOptions.useThinkingModeIfAvailable, false);
});

console.log('\n# Phat hien luot + toolResponses');
ok('analyzeRequest: user text => user_query; tool_result => tool_result', () => {
  assert.equal(analyzeRequest({ messages: [{ role: 'user', content: 'hi' }] }).kind, 'user_query');
  const tr = analyzeRequest({ messages: [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_9', name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: 'FILE BODY' }] },
  ] });
  assert.equal(tr.kind, 'tool_result');
  assert.equal(tr.results[0].toolUseId, 'toolu_9');
  assert.equal(tr.results[0].content, 'FILE BODY');
});
ok('analyzeRequest: van nhan tool_result khi co message role:system chen sau (bug 403 loop)', () => {
  const tr = analyzeRequest({ messages: [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_5', name: 'Write', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_5', content: 'OK' }] },
    { role: 'system', content: 'The task tools haven\'t been used recently...' },
  ] });
  assert.equal(tr.kind, 'tool_result');
  assert.equal(tr.results[0].toolUseId, 'toolu_5');
});
ok('buildToolResponses: du 4 truong + gom theo groupId', () => {
  const map = { toolu_9: { conversationId: 'c1', groupId: 'g1', nativeName: 'readFile' } };
  const { groups } = buildToolResponses([{ toolUseId: 'toolu_9', content: 'X', isError: false }], (id) => map[id]);
  const g = groups.g1;
  assert.equal(g.conversationId, 'c1');
  const r = g.toolResponses[0];
  assert.equal(r.toolCallId, 'toolu_9');
  assert.equal(r.toolResponseStatus, 'SUCCESS');
  assert.ok('toolResponseSummary' in r);
  assert.ok('content' in r);
});
ok('askUser answer -> goi content thanh {status:SUCCESS, answer} (theo core.mjs)', () => {
  const map = { toolu_a: { conversationId: 'c', groupId: 'g', postmanNative: 'askUser' } };
  const { groups } = buildToolResponses([{ toolUseId: 'toolu_a', content: JSON.stringify({ answers: { 'JSON hay YAML?': 'YAML' } }), isError: false }], (id) => map[id]);
  const parsed = JSON.parse(groups.g.toolResponses[0].content);
  assert.equal(parsed.status, 'SUCCESS'); assert.equal(parsed.answer, 'YAML');
});
ok('extractAskUserAnswer: response > answers > raw', () => {
  assert.equal(extractAskUserAnswer(JSON.stringify({ response: 'freetext' })), 'freetext');
  assert.equal(extractAskUserAnswer(JSON.stringify({ answers: { q: 'A' } })), 'A');
  assert.equal(extractAskUserAnswer('plain'), 'plain');
});

console.log('\n# Gateway GIA - roundtrip day du (mock fetch, khong ton credit)');
// Helper: dung "res" gia co body.getReader() phat cac dong SSE Postman.
function sseRes(lines) {
  const enc = new TextEncoder().encode(lines.map((l) => (l === '[DONE]' ? 'data: [DONE]' : 'data: ' + JSON.stringify(l))).join('\n') + '\n');
  let sent = false;
  return { ok: true, status: 200, body: { getReader: () => ({ read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: enc })) }) } };
}
const ev = (eventType, data) => ({ eventType, data });

const baseOpts = { workingDir: null, pmModelKey: null, claudeTools: CT, thinking: null };

await okAsync('gateway tra readFile => proxy phat tool_use Read, stop_reason tool_use', async () => {
  if (!loadTemplate()) throw new Error('can .chat-template.json (da harvest) de buildBody');
  const orig = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.ok(body.clientTools && body.clientTools.nativeToolsHash, 'giu nativeToolsHash tu template');
    assert.ok(body.clientTools.excludedTools.includes('askUser'), 'excludedTools co askUser');
    return sseRes([
      ev('conversation', { id: 'conv_1' }),
      ev('textChunk', { textContent: 'Doc file nhe. ' }),
      ev('toolCallChunk', { toolCalls: [{ id: 'toolu_a', toolCallGroupId: 'grp_1', function: { name: 'readFile', arguments: '{"filePath":"/pkg.json"}' } }] }),
      '[DONE]',
    ]);
  };
  try {
    const emitter = new BufferEmitter({ model: 'claude-x' });
    const { buildBody } = await import('./core.mjs');
    const gw = buildBody('USER_QUERY', { query: 'hi', conversationId: null });
    await runGateway('faketoken', gw, emitter, { conversationId: null, key: 'k1', model: 'claude-x', opts: baseOpts, round: 0 });
    const msg = emitter.toMessage();
    assert.equal(msg.stop_reason, 'tool_use');
    const tu = msg.content.find((b) => b.type === 'tool_use');
    assert.ok(tu, 'co tool_use block');
    assert.equal(tu.name, 'Read');
    assert.equal(tu.input.file_path, '/pkg.json');
    assert.equal(tu.id, 'toolu_a');
  } finally { globalThis.fetch = orig; }
});

await okAsync('gateway tra todoWrite (drop) => proxy tu tra TOOL_RESPONSE roi nhan text end_turn', async () => {
  const orig = globalThis.fetch;
  let round = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    round++;
    if (round === 1) {
      assert.equal(body.input.chatType, 'USER_QUERY');
      return sseRes([
        ev('conversation', { id: 'conv_2' }),
        ev('toolCallChunk', { toolCalls: [{ id: 'toolu_t', toolCallGroupId: 'grp_9', function: { name: 'todoWrite', arguments: '{"todos":[]}' } }] }),
        '[DONE]',
      ]);
    }
    // vong 2: proxy da gui TOOL_RESPONSE cho tool bi drop
    assert.equal(body.input.chatType, 'TOOL_RESPONSE');
    assert.equal(body.input.toolResponses[0].toolCallId, 'toolu_t');
    assert.equal(body.input.toolResponses[0].toolResponseStatus, 'SUCCESS');
    return sseRes([ev('textChunk', { textContent: 'Xong roi.' }), '[DONE]']);
  };
  try {
    const { buildBody } = await import('./core.mjs');
    const emitter = new BufferEmitter({ model: 'claude-x' });
    const gw = buildBody('USER_QUERY', { query: 'lam gi do', conversationId: null });
    await runGateway('faketoken', gw, emitter, { conversationId: null, key: 'k2', model: 'claude-x', opts: baseOpts, round: 0 });
    const msg = emitter.toMessage();
    assert.equal(round, 2, 'phai co dung 2 vong gateway');
    assert.equal(msg.stop_reason, 'end_turn');
    assert.ok(msg.content.some((b) => b.type === 'text' && b.text.includes('Xong')));
  } finally { globalThis.fetch = orig; }
});

await okAsync('gateway phat askUser (client co AskUserQuestion) => proxy phat tool_use AskUserQuestion, giu options', async () => {
  if (!loadTemplate()) throw new Error('can .chat-template.json (da harvest) de buildBody');
  const CT_ASK = claudeToolSet([{ name: 'Read' }, { name: 'AskUserQuestion' }]);
  const orig = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    // Vi client CO AskUserQuestion -> askUser KHONG bi day vao excludedTools (gateway duoc phep hoi).
    assert.ok(!body.clientTools.excludedTools.includes('askUser'), 'askUser KHONG bi loai khi client khai AskUserQuestion');
    assert.equal(body.devModeOptions.supportsAskUser, true, 'supportsAskUser=true');
    return sseRes([
      ev('conversation', { id: 'conv_ask' }),
      ev('toolCallChunk', { toolCalls: [{ id: 'toolu_ask', toolCallGroupId: 'grp_ask', function: { name: 'askUser', arguments: '{"question":"Sep chon DB nao?","options":["Postgres","MySQL"]}' } }] }),
      '[DONE]',
    ]);
  };
  try {
    const { buildBody } = await import('./core.mjs');
    const emitter = new BufferEmitter({ model: 'claude-x' });
    const gw = buildBody('USER_QUERY', { query: 'giup em chon DB', conversationId: null });
    await runGateway('faketoken', gw, emitter, { conversationId: 'conv_ask', key: 'kask', model: 'claude-x', opts: { workingDir: null, pmModelKey: null, claudeTools: CT_ASK, thinking: null }, round: 0 });
    const msg = emitter.toMessage();
    assert.equal(msg.stop_reason, 'tool_use');
    const tu = msg.content.find((b) => b.type === 'tool_use');
    assert.ok(tu, 'co tool_use block');
    assert.equal(tu.name, 'AskUserQuestion');
    assert.ok(Array.isArray(tu.input.questions) && tu.input.questions[0], 'co questions[]');
    assert.equal(tu.input.questions[0].question, 'Sep chon DB nao?');
    const labels = tu.input.questions[0].options.map((o) => o.label);
    assert.deepEqual(labels, ['Postgres', 'MySQL'], 'giu dung options lam label');
  } finally { globalThis.fetch = orig; }
});

console.log('\n# Khoi phuc ngu canh khi mat session (rebuildTranscript / priorMessages)');
const CONVO = [
  { role: 'user', content: 'Chao, giup toi sua proxy' },
  { role: 'assistant', content: [ { type: 'text', text: 'Duoc, de toi doc file' }, { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/a' } } ] },
  { role: 'user', content: [ { type: 'tool_result', tool_use_id: 'toolu_1', content: 'noi dung file A' } ] },
  { role: 'assistant', content: [ { type: 'text', text: 'Da xong buoc 1' } ] },
  { role: 'user', content: [ { type: 'text', text: 'tiep tuc di' }, { type: 'text', text: '<system-reminder>nhac viec khong lien quan</system-reminder>' } ] },
];
ok('priorMessages: lay toi & gom assistant cuoi (bo luot user hien tai)', () => {
  const p = priorMessages(CONVO);
  assert.equal(p.length, 4, 'giu 4 message dau (toi assistant cuoi)');
  assert.equal(p[p.length - 1].role, 'assistant');
});
ok('priorMessages: hoi thoai moi hoan toan (chua co assistant) -> rong', () => {
  assert.equal(priorMessages([{ role: 'user', content: 'cau hoi dau tien' }]).length, 0);
});
ok('rebuildTranscript: co nhan [Nguoi dung]/[Tro ly], [goi tool], [ket qua tool]', () => {
  const t = rebuildTranscript(priorMessages(CONVO));
  assert.match(t, /\[Nguoi dung\] Chao, giup toi sua proxy/);
  assert.match(t, /\[Tro ly\] Duoc, de toi doc file/);
  assert.match(t, /\[goi tool Read\]/);
  assert.match(t, /\[ket qua tool: noi dung file A\]/);
});
ok('rebuildTranscript: boc <system-reminder>', () => {
  const t = rebuildTranscript(CONVO);
  assert.ok(!/system-reminder/.test(t), 'khong con the reminder');
  assert.match(t, /\[Nguoi dung\] tiep tuc di/);
});
ok('rebuildTranscript: ton trong budget (giu phan cuoi)', () => {
  const big = [];
  for (let i = 0; i < 50; i++) big.push({ role: 'user', content: 'dong ' + i + ' ' + 'x'.repeat(50) });
  const t = rebuildTranscript(big, 400);
  assert.ok(t.length <= 400 + 40, 'khong vuot budget dang ke');
  assert.match(t, /luoc bot phan dau/);
  assert.match(t, /dong 49/, 'giu duoc luot gan nhat');
});
ok('analyzeRequest: luot tool_result sau restart van nhan dien dung kind', () => {
  const r = analyzeRequest({ messages: CONVO.slice(0, 3) });
  assert.equal(r.kind, 'tool_result');
  assert.equal(r.results[0].toolUseId, 'toolu_1');
});

console.log('\n# TOOL_CALL_NOT_FOUND: tu phuc hoi (giu ngu canh) thay vi loop');
ok('getToolUse: tool vua ghi phien nay -> lay lai duoc + co boot id', () => {
  recordToolUse('toolu_boot', { conversationId: 'cX', groupId: 'gX', nativeName: 'Read' });
  const t = getToolUse('toolu_boot');
  assert.ok(t && t.conversationId === 'cX', 'lay lai duoc tool cung phien');
  assert.ok(t.boot, 'co gan boot id (tool cua phien CU se bi coi la unknown -> tranh TOOL_RESPONSE mo coi)');
});
await okAsync('runGatewayResilient: TOOL_CALL_NOT_FOUND -> retry USER_QUERY tren CUNG conversationId (giu ngu canh)', async () => {
  const orig = globalThis.fetch;
  let round = 0; let secondBody = null;
  globalThis.fetch = async (_url, init) => {
    round++;
    const body = JSON.parse(init.body);
    if (round === 1) return sseRes([ ev('failure', { errorType: 'TOOL_CALL_NOT_FOUND', userMessage: 'Looks like I lost my way.' }) ]);
    secondBody = body;
    return sseRes([ ev('textChunk', { textContent: 'Tiep tuc nhe.' }), '[DONE]' ]);
  };
  try {
    const { buildBody } = await import('./core.mjs');
    const emitter = new BufferEmitter({ model: 'claude-x' });
    const toolBody = buildBody('TOOL_RESPONSE', { conversationId: 'conv_keep', toolResponses: [{ toolCallId: 't1', content: 'x', toolResponseStatus: 'SUCCESS' }] });
    const turn = { kind: 'tool_result', results: [{ toolUseId: 't1', content: 'ket qua ABC', isError: false }] };
    const messages = [ { role: 'user', content: 'lam di' }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } ];
    await runGatewayResilient('faketoken', toolBody, emitter, { conversationId: 'conv_keep', key: 'kr', model: 'claude-x', opts: baseOpts, round: 0 }, { turn, messages, key: 'kr', model: 'claude-x', opts: baseOpts, conversationId: 'conv_keep' });
    const msg = emitter.toMessage();
    assert.equal(round, 2, 'phai retry dung 1 lan');
    assert.equal(secondBody.input.chatType, 'USER_QUERY', 'retry la USER_QUERY');
    assert.equal(secondBody.input.conversationId, 'conv_keep', 'GIU conversationId cu -> khong mat ngu canh');
    assert.match(secondBody.input.query, /ket qua ABC/, 'dua ket qua tool vao query');
    assert.equal(msg.stop_reason, 'end_turn');
    assert.ok(msg.content.some((b) => b.type === 'text' && b.text.includes('Tiep tuc')));
  } finally { globalThis.fetch = orig; }
});
await okAsync('runGatewayResilient: khong con conversationId -> hoi thoai MOI kem transcript dung lai', async () => {
  const orig = globalThis.fetch;
  let round = 0; let secondBody = null;
  globalThis.fetch = async (_url, init) => {
    round++;
    const body = JSON.parse(init.body);
    if (round === 1) return sseRes([ ev('failure', { errorType: 'TOOL_CALL_NOT_FOUND', userMessage: 'lost' }) ]);
    secondBody = body;
    return sseRes([ ev('conversation', { id: 'conv_new' }), ev('textChunk', { textContent: 'da mo lai' }), '[DONE]' ]);
  };
  try {
    const { buildBody } = await import('./core.mjs');
    const emitter = new BufferEmitter({ model: 'claude-x' });
    const toolBody = buildBody('TOOL_RESPONSE', { conversationId: null, toolResponses: [{ toolCallId: 't2', content: 'x', toolResponseStatus: 'SUCCESS' }] });
    const turn = { kind: 'tool_result', results: [{ toolUseId: 't2', content: 'OUTPUT_XYZ', isError: false }] };
    const messages = [ { role: 'user', content: 'cau hoi goc' }, { role: 'assistant', content: [ { type: 'text', text: 'tra loi truoc do' } ] } ];
    await runGatewayResilient('faketoken', toolBody, emitter, { conversationId: null, key: 'kr2', model: 'claude-x', opts: baseOpts, round: 0 }, { turn, messages, key: 'kr2', model: 'claude-x', opts: baseOpts, conversationId: null });
    assert.equal(round, 2, 'retry 1 lan');
    assert.equal(secondBody.input.chatType, 'USER_QUERY');
    assert.equal(secondBody.input.conversationId, null, 'hoi thoai MOI');
    assert.match(secondBody.input.query, /KHOI PHUC NGU CANH/, 'co header khoi phuc');
    assert.match(secondBody.input.query, /tra loi truoc do/, 'co ngu canh cu dung lai');
    assert.match(secondBody.input.query, /OUTPUT_XYZ/, 'co ket qua tool luot hien tai');
  } finally { globalThis.fetch = orig; }
});

console.log(`\n${fail ? '[X]' : '[OK]'} selftest: ${pass} pass, ${fail} fail\n`);
process.exit(fail ? 1 : 0);
