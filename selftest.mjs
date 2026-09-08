#!/usr/bin/env node
/**
 * SELFTEST OFFLINE — không tốn credit, không cần Postman mở.
 * Kiểm: pickArg, bảng map tool (§5), excludedTools, tool card (§4), model map,
 * chuỗi SSE Anthropic, phát hiện lượt (tool_result vs user_query), và MỘT vòng
 * roundtrip đầy đủ qua gateway GIẢ (mock fetch) — cả nhánh tool-cho-client lẫn
 * nhánh drop-rồi-tiếp-tục.
 *
 *   node win/claude/selftest.mjs
 */
import assert from 'node:assert';
import {
  pickArg, mapPostmanToolToClaude, excludedToolsFor, buildToolCard, mapModel, claudeToolSet,
  conformToolName, conformInputToSchema,
} from './map.mjs';
import { AnthropicSSE } from './sse.mjs';
import { analyzeRequest, buildToolResponses, extractAskUserAnswer } from './translate.mjs';
import { runGateway, thinkingFlag, prepBody, BufferEmitter } from './server.mjs';
import { loadTemplate } from '../core.mjs';

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); console.log('  ✓', name); pass++; } catch (e) { console.log('  ✗', name, '→', e.message); fail++; } };
const okAsync = async (name, fn) => { try { await fn(); console.log('  ✓', name); pass++; } catch (e) { console.log('  ✗', name, '→', e.message); fail++; } };

console.log('\n# pickArg — chuẩn hoá khoá');
ok('filePath / file_path / File-Path quy về cùng vai trò', () => {
  assert.equal(pickArg({ filePath: '/a' }, 'filePath'), '/a');
  assert.equal(pickArg({ file_path: '/b' }, 'filePath'), '/b');
  assert.equal(pickArg({ 'File-Path': '/c' }, 'filePath'), '/c');
  assert.equal(pickArg({}, 'filePath'), undefined);
});

console.log('\n# Bảng map tool (docs/tool-mapping.md §5)');
const CT = claudeToolSet([{ name: 'Bash' }, { name: 'Read' }, { name: 'Write' }, { name: 'Edit' }, { name: 'WebFetch' }, { name: 'WebSearch' }, { name: 'Grep' }, { name: 'Glob' }]);
ok('executeShellCommand → Bash, ghép cd <projectPath>', () => {
  const r = mapPostmanToolToClaude('executeShellCommand', { projectPath: '/proj', command: 'ls' }, CT);
  assert.equal(r.kind, 'client'); assert.equal(r.name, 'Bash');
  assert.match(r.input.command, /cd '\/proj'; ls/);
});
ok('listDirectory → Bash ls -la', () => {
  const r = mapPostmanToolToClaude('listDirectory', { relativePath: '/x' }, CT);
  assert.equal(r.name, 'Bash'); assert.match(r.input.command, /ls -la -- '\/x'/);
});
ok('searchInFiles → Grep native (không dùng `Bash rg`); chỉ fileNamePatterns → Glob; rỗng ⇒ drop', () => {
  const g = mapPostmanToolToClaude('searchInFiles', { queryString: 'CONFIG' }, CT);
  assert.equal(g.name, 'Grep'); assert.equal(g.input.pattern, 'CONFIG'); assert.equal(g.input.output_mode, 'content');
  const gl = mapPostmanToolToClaude('searchInFiles', { fileNamePatterns: ['*.ts'] }, CT);
  assert.equal(gl.name, 'Glob'); assert.equal(gl.input.pattern, '*.ts');
  assert.equal(mapPostmanToolToClaude('searchInFiles', {}, CT).kind, 'drop');
});
ok('readFile → Read {file_path} (từ filePath trên wire)', () => {
  const r = mapPostmanToolToClaude('readFile', { filePath: '/pkg.json' }, CT);
  assert.equal(r.name, 'Read'); assert.equal(r.input.file_path, '/pkg.json');
});
ok('createFile → Write {file_path, content}', () => {
  const r = mapPostmanToolToClaude('createFile', { filePath: '/n.txt', content: 'HI' }, CT);
  assert.equal(r.name, 'Write'); assert.equal(r.input.file_path, '/n.txt'); assert.equal(r.input.content, 'HI');
});
ok('editFile → Edit {file_path, old_string, new_string}', () => {
  const r = mapPostmanToolToClaude('editFile', { filePath: '/f', oldString: 'a', newString: 'b' }, CT);
  assert.equal(r.name, 'Edit'); assert.equal(r.input.old_string, 'a'); assert.equal(r.input.new_string, 'b');
});
ok('webSearch → WebSearch (gộp queries[])', () => {
  const r = mapPostmanToolToClaude('webSearch', { queries: ['a', 'b'] }, CT);
  assert.equal(r.name, 'WebSearch'); assert.equal(r.input.query, 'a b');
});

console.log('\n# conform tới schema client (file_path ⇄ path) — sửa "tool read must have required property path"');
const READ_FILEPATH = [{ name: 'Read', input_schema: { properties: { file_path: {}, offset: {}, limit: {} }, required: ['file_path'] } }];
const READ_PATH = [{ name: 'read', input_schema: { properties: { path: {} }, required: ['path'] } }];
ok('schema có file_path → giữ nguyên file_path + tên Read', () => {
  assert.equal(conformToolName('Read', READ_FILEPATH), 'Read');
  const inp = conformInputToSchema('Read', { file_path: '/a' }, READ_FILEPATH);
  assert.equal(inp.file_path, '/a'); assert.equal(inp.path, undefined);
});
ok('schema đòi path → đổi file_path→path + tên read (đúng ca lỗi Win10)', () => {
  assert.equal(conformToolName('Read', READ_PATH), 'read');
  const inp = conformInputToSchema('read', { file_path: 'C:\\x\\test.txt' }, READ_PATH);
  assert.equal(inp.path, 'C:\\x\\test.txt'); assert.equal(inp.file_path, undefined);
});
ok('không có schema/toolDefs → giữ nguyên (hành vi cũ, không phá máy đang chạy)', () => {
  const inp = conformInputToSchema('Read', { file_path: '/a' }, undefined);
  assert.equal(inp.file_path, '/a');
  assert.equal(conformToolName('Read', undefined), 'Read');
});
ok('Write theo schema path: content giữ nguyên, file_path→path', () => {
  const WRITE_PATH = [{ name: 'Write', input_schema: { properties: { path: {}, content: {} }, required: ['path', 'content'] } }];
  const inp = conformInputToSchema('Write', { file_path: '/n.txt', content: 'HI' }, WRITE_PATH);
  assert.equal(inp.path, '/n.txt'); assert.equal(inp.content, 'HI'); assert.equal(inp.file_path, undefined);
});
ok('askUser → AskUserQuestion {questions:[{question, options:[{label}]}]}', () => {
  const CTA = claudeToolSet([{ name: 'AskUserQuestion' }]);
  const r = mapPostmanToolToClaude('askUser', { question: 'JSON hay YAML?', options: ['JSON', 'YAML'] }, CTA);
  assert.equal(r.kind, 'client'); assert.equal(r.name, 'AskUserQuestion');
  assert.equal(r.input.questions[0].question, 'JSON hay YAML?');
  assert.equal(r.input.questions[0].options[0].label, 'JSON');
});
ok('askUser: LUÔN có header (string) + mọi options[].description (string) — fix InputValidationError', () => {
  const CTA = claudeToolSet([{ name: 'AskUserQuestion' }]);
  // shape số nhiều với `message`, KHÔNG có header/description (giống gateway thật đã fail)
  const r = mapPostmanToolToClaude('askUser', { questions: [{ message: 'Chọn vị trí?', options: ['A', 'B', 'C'] }] }, CTA);
  assert.equal(r.name, 'AskUserQuestion');
  const q = r.input.questions[0];
  assert.equal(typeof q.header, 'string'); assert.ok(q.header.length > 0);
  assert.ok(q.options.length === 3);
  assert.ok(q.options.every((o) => typeof o.label === 'string' && typeof o.description === 'string'));
});
ok('todoWrite / navigateInApp → drop (kèm syntheticResult)', () => {
  const r = mapPostmanToolToClaude('todoWrite', { todos: [] }, CT);
  assert.equal(r.kind, 'drop'); assert.ok(r.syntheticResult.includes('todoWrite'));
});
ok('client không khai Bash ⇒ executeShellCommand bị drop', () => {
  const r = mapPostmanToolToClaude('executeShellCommand', { command: 'ls' }, claudeToolSet([{ name: 'Read' }]));
  assert.equal(r.kind, 'drop');
});

console.log('\n# excludedTools');
ok('client chỉ có Read ⇒ loại executeShellCommand & askUser, GIỮ readFile', () => {
  const ex = excludedToolsFor(claudeToolSet([{ name: 'Read' }]), []);
  assert.ok(ex.includes('executeShellCommand'));
  assert.ok(ex.includes('askUser'));
  assert.ok(!ex.includes('readFile'));
});

ok('client CÓ AskUserQuestion ⇒ GIỮ askUser (không loại)', () => {
  const ex = excludedToolsFor(claudeToolSet([{ name: 'AskUserQuestion' }]), []);
  assert.ok(!ex.includes('askUser'));
});

ok('askUser {question,options[string]} ⇒ AskUserQuestion questions[].options[].label', () => {
  const r = mapPostmanToolToClaude('askUser', { question: 'Chọn DB?', options: ['Postgres', 'MySQL'] }, claudeToolSet([{ name: 'AskUserQuestion' }]));
  assert.equal(r.kind, 'client');
  assert.equal(r.name, 'AskUserQuestion');
  assert.equal(r.input.questions[0].question, 'Chọn DB?');
  assert.deepEqual(r.input.questions[0].options, [{ label: 'Postgres', description: '' }, { label: 'MySQL', description: '' }]);
});

ok('askUser thiếu options ⇒ tự chèn Yes/No', () => {
  const r = mapPostmanToolToClaude('askUser', { question: 'Tiếp tục?' }, claudeToolSet([{ name: 'AskUserQuestion' }]));
  assert.deepEqual(r.input.questions[0].options, [{ label: 'Yes', description: '' }, { label: 'No', description: '' }]);
});

ok('askUser shape số nhiều {questions:[{message,options}]} ⇒ KHÔNG drop, map đúng', () => {
  const r = mapPostmanToolToClaude('askUser', {
    questions: [{ id: 'fmt', message: 'JSON hay YAML?', options: ['JSON', 'YAML'] }],
  }, claudeToolSet([{ name: 'AskUserQuestion' }]));
  assert.equal(r.kind, 'client');
  assert.equal(r.name, 'AskUserQuestion');
  assert.equal(r.input.questions[0].question, 'JSON hay YAML?');
  assert.deepEqual(r.input.questions[0].options, [{ label: 'JSON', description: '' }, { label: 'YAML', description: '' }]);
});

ok('askUser số nhiều nhiều câu hỏi ⇒ map tất cả questions', () => {
  const r = mapPostmanToolToClaude('askUser', {
    questions: [
      { id: 'a', message: 'Câu 1?', options: ['X', 'Y'] },
      { id: 'b', message: 'Câu 2?' },
    ],
  }, claudeToolSet([{ name: 'AskUserQuestion' }]));
  assert.equal(r.kind, 'client');
  assert.equal(r.input.questions.length, 2);
  assert.equal(r.input.questions[1].question, 'Câu 2?');
  assert.deepEqual(r.input.questions[1].options, [{ label: 'Yes', description: '' }, { label: 'No', description: '' }]);
});

ok('askUser > 4 options ⇒ cắt còn 4 (giữ 3 đầu + "Lựa chọn khác…") — fix InputValidationError too_big max 4', () => {
  const r = mapPostmanToolToClaude('askUser', {
    questions: [{ message: 'Chọn quy trình?', options: ['A', 'B', 'C', 'D', 'E'] }],
  }, claudeToolSet([{ name: 'AskUserQuestion' }]));
  const opts = r.input.questions[0].options;
  assert.equal(opts.length, 4, 'đúng 4 options (max)');
  assert.deepEqual(opts.slice(0, 3).map((o) => o.label), ['A', 'B', 'C']);
  assert.equal(opts[3].label, 'Lựa chọn khác…');
  assert.ok(opts[3].description.includes('D') && opts[3].description.includes('E'), 'phần dư nằm trong description (không mất)');
  assert.ok(opts.every((o) => typeof o.label === 'string' && typeof o.description === 'string'));
});

ok('askUser 1 option ⇒ chèn thêm cho đủ tối thiểu 2 (minItems 2)', () => {
  const r = mapPostmanToolToClaude('askUser', { question: 'Chỉ 1?', options: ['Only'] }, claudeToolSet([{ name: 'AskUserQuestion' }]));
  const opts = r.input.questions[0].options;
  assert.ok(opts.length >= 2, 'ít nhất 2 options');
  assert.equal(opts[0].label, 'Only');
});

ok('askUser > 4 câu hỏi ⇒ cắt còn 4 (maxItems 4)', () => {
  const many = Array.from({ length: 6 }, (_, i) => ({ message: 'Câu ' + i + '?', options: ['X', 'Y'] }));
  const r = mapPostmanToolToClaude('askUser', { questions: many }, claudeToolSet([{ name: 'AskUserQuestion' }]));
  assert.equal(r.input.questions.length, 4, 'tối đa 4 câu hỏi');
});

console.log('\n# Tool card (§4 — khẳng định, quảng cáo tên native, không phủ định)');
ok('card nêu native name + không có câu phủ định danh tính', () => {
  const card = buildToolCard({ workingDir: 'C:/proj', claudeToolNames: CT });
  assert.ok(card.includes('readFile') || card.includes('executeShellCommand'));
  assert.ok(card.includes('C:/proj'));
  assert.ok(!/only have Postman|không phải Postman|did not come from/i.test(card));
});

console.log('\n# mapModel');
ok('claude-opus-* → key chứa OPUS; sonnet → SONNET; lạ → null', () => {
  const keys = ['CLAUDE_OPUS_48_BEDROCK', 'CLAUDE_SONNET_45_BEDROCK', 'GPT_5'];
  assert.match(mapModel('claude-opus-4-6', keys), /OPUS/);
  assert.match(mapModel('claude-sonnet-4-5-20250929', keys), /SONNET/);
  assert.equal(mapModel('gpt-4o', keys), null);
});

console.log('\n# Chuỗi SSE Anthropic');
ok('message_start → content_block(text) → tool_use → message_delta(tool_use) → message_stop', () => {
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
  // REGRESSION GUARD: mọi content_block_start phải có content_block_stop khớp index
  // (bug cũ: tool_use không được đóng → "tool call could not be parsed").
  const starts = [...out.matchAll(/"content_block_start","index":(\d+)/g)].map((m) => m[1]).sort();
  const stops = [...out.matchAll(/"content_block_stop","index":(\d+)/g)].map((m) => m[1]).sort();
  assert.deepEqual(stops, starts, 'mọi block mở phải được đóng (kể cả tool_use)');
  const lastStop = out.lastIndexOf('content_block_stop');
  assert.ok(lastStop !== -1 && lastStop < out.indexOf('message_delta'), 'content_block_stop phải trước message_delta');
});
ok('thinking: content_block(thinking) → thinking_delta → signature_delta → stop, đứng TRƯỚC text', () => {
  const chunks = [];
  const sse = new AnthropicSSE({ write: (s) => chunks.push(s) }, { model: 'x' });
  sse.thinkingDelta('reasoning...');
  sse.textDelta('answer');
  sse.finish('end_turn');
  const out = chunks.join('');
  assert.ok(out.includes('"type":"thinking"'), 'có thinking block');
  assert.ok(out.includes('"thinking_delta"'), 'có thinking_delta');
  assert.ok(out.includes('"signature_delta"'), 'có signature_delta');
  const sigIdx = out.indexOf('signature_delta');
  const firstStop = out.indexOf('content_block_stop');
  assert.ok(sigIdx !== -1 && sigIdx < firstStop, 'signature_delta trước content_block_stop');
  assert.ok(out.indexOf('"type":"thinking"') < out.indexOf('"type":"text"'), 'thinking trước text');
});

ok("thinkingFlag: 'adaptive' va 'enabled' deu BAT, chi 'disabled' moi tat", () => {
  // Claude Code moi gui {type:'adaptive'} — coi la tat thi proxy set
  // useThinkingModeIfAvailable=false va gateway khong bao gio phat thinkingChunk.
  assert.equal(thinkingFlag({ thinking: { type: 'adaptive', display: 'summarized' } }), true);
  assert.equal(thinkingFlag({ thinking: { type: 'enabled', budget_tokens: 31999 } }), true);
  assert.equal(thinkingFlag({ thinking: { type: 'disabled' } }), false);
  assert.equal(thinkingFlag({}), null, 'khong khai bao ⇒ null (de template gateway quyet)');
});
ok('prepBody: thinking=true ⇒ useThinkingModeIfAvailable + thinkingLevel', () => {
  const body = { thinking: { type: 'adaptive' } };
  const on = prepBody(body, { claudeTools: CT, thinking: thinkingFlag(body) });
  assert.equal(on.devModeOptions.useThinkingModeIfAvailable, true);
  assert.equal(on.devModeOptions.thinkingLevel, 'medium');
  const off = prepBody({}, { claudeTools: CT, thinking: false });
  assert.equal(off.devModeOptions.useThinkingModeIfAvailable, false);
});

console.log('\n# Phát hiện lượt + toolResponses');
ok('analyzeRequest: user text ⇒ user_query; tool_result ⇒ tool_result', () => {
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
ok('analyzeRequest: vẫn nhận tool_result khi có message role:system chen sau (bug 403 loop)', () => {
  const tr = analyzeRequest({ messages: [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_5', name: 'Write', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_5', content: 'OK' }] },
    { role: 'system', content: 'The task tools haven\'t been used recently...' },
  ] });
  assert.equal(tr.kind, 'tool_result');
  assert.equal(tr.results[0].toolUseId, 'toolu_5');
});
ok('buildToolResponses: đủ 4 trường + gom theo groupId', () => {
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
ok('askUser answer → gói content thành {status:SUCCESS, answer} (theo core.mjs)', () => {
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

console.log('\n# Gateway GIẢ — roundtrip đầy đủ (mock fetch, không tốn credit)');
// Helper: dựng "res" giả có body.getReader() phát các dòng SSE Postman.
function sseRes(lines) {
  const enc = new TextEncoder().encode(lines.map((l) => (l === '[DONE]' ? 'data: [DONE]' : 'data: ' + JSON.stringify(l))).join('\n') + '\n');
  let sent = false;
  return { ok: true, status: 200, body: { getReader: () => ({ read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: enc })) }) } };
}
const ev = (eventType, data) => ({ eventType, data });

const baseOpts = { workingDir: null, pmModelKey: null, claudeTools: CT, thinking: null };

await okAsync('gateway trả readFile ⇒ proxy phát tool_use Read, stop_reason tool_use', async () => {
  if (!loadTemplate()) throw new Error('cần .chat-template.json (đã harvest) để buildBody');
  const orig = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.ok(body.clientTools && body.clientTools.nativeToolsHash, 'giữ nativeToolsHash từ template');
    assert.ok(body.clientTools.excludedTools.includes('askUser'), 'excludedTools có askUser');
    return sseRes([
      ev('conversation', { id: 'conv_1' }),
      ev('textChunk', { textContent: 'Đọc file nhé. ' }),
      ev('toolCallChunk', { toolCalls: [{ id: 'toolu_a', toolCallGroupId: 'grp_1', function: { name: 'readFile', arguments: '{"filePath":"/pkg.json"}' } }] }),
      '[DONE]',
    ]);
  };
  try {
    const emitter = new BufferEmitter({ model: 'claude-x' });
    const { buildBody } = await import('../core.mjs');
    const gw = buildBody('USER_QUERY', { query: 'hi', conversationId: null });
    await runGateway('faketoken', gw, emitter, { conversationId: null, key: 'k1', model: 'claude-x', opts: baseOpts, round: 0 });
    const msg = emitter.toMessage();
    assert.equal(msg.stop_reason, 'tool_use');
    const tu = msg.content.find((b) => b.type === 'tool_use');
    assert.ok(tu, 'có tool_use block');
    assert.equal(tu.name, 'Read');
    assert.equal(tu.input.file_path, '/pkg.json');
    assert.equal(tu.id, 'toolu_a');
  } finally { globalThis.fetch = orig; }
});

await okAsync('gateway trả todoWrite (drop) ⇒ proxy tự trả TOOL_RESPONSE rồi nhận text end_turn', async () => {
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
    // vòng 2: proxy đã gửi TOOL_RESPONSE cho tool bị drop
    assert.equal(body.input.chatType, 'TOOL_RESPONSE');
    assert.equal(body.input.toolResponses[0].toolCallId, 'toolu_t');
    assert.equal(body.input.toolResponses[0].toolResponseStatus, 'SUCCESS');
    return sseRes([ev('textChunk', { textContent: 'Xong rồi.' }), '[DONE]']);
  };
  try {
    const { buildBody } = await import('../core.mjs');
    const emitter = new BufferEmitter({ model: 'claude-x' });
    const gw = buildBody('USER_QUERY', { query: 'làm gì đó', conversationId: null });
    await runGateway('faketoken', gw, emitter, { conversationId: null, key: 'k2', model: 'claude-x', opts: baseOpts, round: 0 });
    const msg = emitter.toMessage();
    assert.equal(round, 2, 'phải có đúng 2 vòng gateway');
    assert.equal(msg.stop_reason, 'end_turn');
    assert.ok(msg.content.some((b) => b.type === 'text' && b.text.includes('Xong')));
  } finally { globalThis.fetch = orig; }
});

await okAsync('gateway phát askUser (client có AskUserQuestion) ⇒ proxy phát tool_use AskUserQuestion, giữ options', async () => {
  if (!loadTemplate()) throw new Error('cần .chat-template.json (đã harvest) để buildBody');
  const CT_ASK = claudeToolSet([{ name: 'Read' }, { name: 'AskUserQuestion' }]);
  const orig = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    // Vì client CÓ AskUserQuestion → askUser KHÔNG bị đẩy vào excludedTools (gateway được phép hỏi).
    assert.ok(!body.clientTools.excludedTools.includes('askUser'), 'askUser KHÔNG bị loại khi client khai AskUserQuestion');
    assert.equal(body.devModeOptions.supportsAskUser, true, 'supportsAskUser=true');
    return sseRes([
      ev('conversation', { id: 'conv_ask' }),
      ev('toolCallChunk', { toolCalls: [{ id: 'toolu_ask', toolCallGroupId: 'grp_ask', function: { name: 'askUser', arguments: '{"question":"Sếp chọn DB nào?","options":["Postgres","MySQL"]}' } }] }),
      '[DONE]',
    ]);
  };
  try {
    const { buildBody } = await import('../core.mjs');
    const emitter = new BufferEmitter({ model: 'claude-x' });
    const gw = buildBody('USER_QUERY', { query: 'giúp em chọn DB', conversationId: null });
    await runGateway('faketoken', gw, emitter, { conversationId: 'conv_ask', key: 'kask', model: 'claude-x', opts: { workingDir: null, pmModelKey: null, claudeTools: CT_ASK, thinking: null }, round: 0 });
    const msg = emitter.toMessage();
    assert.equal(msg.stop_reason, 'tool_use');
    const tu = msg.content.find((b) => b.type === 'tool_use');
    assert.ok(tu, 'có tool_use block');
    assert.equal(tu.name, 'AskUserQuestion');
    assert.ok(Array.isArray(tu.input.questions) && tu.input.questions[0], 'có questions[]');
    assert.equal(tu.input.questions[0].question, 'Sếp chọn DB nào?');
    const labels = tu.input.questions[0].options.map((o) => o.label);
    assert.deepEqual(labels, ['Postgres', 'MySQL'], 'giữ đúng options làm label');
  } finally { globalThis.fetch = orig; }
});

console.log(`\n${fail ? '❌' : '✅'} selftest: ${pass} pass, ${fail} fail\n`);
process.exit(fail ? 1 : 0);
