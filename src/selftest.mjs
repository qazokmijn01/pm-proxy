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
  subagentThirdParty, SUBAGENT_SERVER, SUBAGENT_TOOL, nativesToKeep, toolChoiceDirective, hasCapability,
} from './map.mjs';
import { toAnthropicBody, toOpenAIResponse } from './openai.mjs';
import { AnthropicSSE } from './sse.mjs';
import { analyzeRequest, buildToolResponses, extractAskUserAnswer, rebuildTranscript, priorMessages, isUtilityTurn } from './translate.mjs';
import { runGateway, runGatewayResilient, thinkingFlag, prepBody, BufferEmitter } from './server.mjs';
import { loadTemplate } from './core.mjs';
import { recordToolUse, getToolUse, getSession, setSession } from './sessions.mjs';

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

ok('askUser CHON-MOT > 4 options => giu 4 dau, phan du neu trong cau hoi (chuan: KHONG tu them option "Other")', () => {
  const r = mapPostmanToolToClaude('askUser', {
    questions: [{ message: 'Chon quy trinh?', options: ['A', 'B', 'C', 'D', 'E'] }],
  }, claudeToolSet([{ name: 'AskUserQuestion' }]));
  assert.equal(r.input.questions.length, 1, 'chon-mot thi KHONG tach cau');
  const q = r.input.questions[0];
  assert.equal(q.options.length, 4, 'dung 4 options (maxItems)');
  assert.deepEqual(q.options.map((o) => o.label), ['A', 'B', 'C', 'D']);
  assert.ok(!q.options.some((o) => /khac|other/i.test(o.label)), 'khong tu chen option "Other"');
  assert.ok(q.question.includes('E'), 'phan du nam trong noi dung cau hoi (khong mat)');
});

ok('askUser CHON-NHIEU > 4 options => tach thanh nhieu cau, khong mat lua chon nao', () => {
  const opts = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm'];
  const r = mapPostmanToolToClaude('askUser', {
    questions: [{ message: 'Chon cac tinh nang?', options: opts, allow_multiple: true }],
  }, claudeToolSet([{ name: 'AskUserQuestion' }]));
  const qs = r.input.questions;
  assert.ok(qs.length > 1 && qs.length <= 4, 'tach thanh 2..4 cau');
  assert.ok(qs.every((q) => q.multiSelect === true), 'moi cau deu la chon-nhieu');
  assert.ok(qs.every((q) => q.options.length >= 2 && q.options.length <= 4), 'moi cau 2..4 options');
  const all = qs.flatMap((q) => q.options.map((o) => o.label));
  assert.deepEqual(all, opts, 'giu du 13 lua chon, dung thu tu');
});

ok('askUser: header <= 12 ky tu (chuan: chip/tag max 12 chars)', () => {
  const r = mapPostmanToolToClaude('askUser', {
    questions: [{ message: 'Mot cau hoi rat dai de kiem tra viec cat header cho dung chuan?', options: ['A', 'B'] }],
  }, claudeToolSet([{ name: 'AskUserQuestion' }]));
  assert.ok(r.input.questions[0].header.length <= 12, 'header <= 12 ky tu');
});

ok('askUser: label dai duoc tach thanh label ngan + description', () => {
  const r = mapPostmanToolToClaude('askUser', {
    question: 'Chon thu vien?',
    options: ['Tabulator - bang editable, ghi nguoc Base', 'RevoGrid - cam giac spreadsheet'],
  }, claudeToolSet([{ name: 'AskUserQuestion' }]));
  const o = r.input.questions[0].options[0];
  assert.equal(o.label, 'Tabulator');
  assert.equal(o.description, 'bang editable, ghi nguoc Base');
});

ok('askUser 1 option => chen them cho du toi thieu 2 (minItems 2)', () => {
  const r = mapPostmanToolToClaude('askUser', { question: 'Chi 1?', options: ['Only'] }, claudeToolSet([{ name: 'AskUserQuestion' }]));
  const opts = r.input.questions[0].options;
  assert.ok(opts.length >= 2, 'it nhat 2 options');
  assert.equal(opts[0].label, 'Only');
});

ok('askUser allow_multiple => multiSelect true (shape that tren wire)', () => {
  const r = mapPostmanToolToClaude('askUser', {
    questions: [{ id: 'goal', message: 'Muc tieu chinh?', options: ['A', 'B'], allow_multiple: true }],
  }, claudeToolSet([{ name: 'AskUserQuestion' }]));
  assert.equal(r.input.questions[0].multiSelect, true);
});

ok('askUser khong khai multi => multiSelect false', () => {
  const r = mapPostmanToolToClaude('askUser', { question: 'Chon 1?', options: ['A', 'B'] }, claudeToolSet([{ name: 'AskUserQuestion' }]));
  assert.equal(r.input.questions[0].multiSelect, false);
});

console.log('\n# SubAgent -> Task');
ok('SubAgent -> Task {description, prompt, subagent_type}', () => {
  const r = mapPostmanToolToClaude('SubAgent', { task: 'Ra soat toan bo handler auth', agentType: 'code-reviewer' }, claudeToolSet([{ name: 'Task' }]));
  assert.equal(r.kind, 'client');
  assert.equal(r.name, 'Task');
  assert.equal(r.input.prompt, 'Ra soat toan bo handler auth');
  assert.equal(r.input.subagent_type, 'code-reviewer');
  assert.ok(typeof r.input.description === 'string' && r.input.description.length > 0);
});

ok('SubAgent khong co agentType => general-purpose', () => {
  const r = mapPostmanToolToClaude('SubAgent', { prompt: 'Tim tat ca TODO' }, claudeToolSet([{ name: 'Task' }]));
  assert.equal(r.input.subagent_type, 'general-purpose');
});

ok('client khai ten "Agent" => SubAgent doi ten sang Agent', () => {
  const r = mapPostmanToolToClaude('SubAgent', { prompt: 'Tim tat ca TODO' }, claudeToolSet([{ name: 'Agent' }]));
  assert.equal(r.kind, 'client');
  assert.equal(r.name, 'Agent');
  assert.equal(r.input.prompt, 'Tim tat ca TODO');
});

ok('SubAgent thieu noi dung => drop', () => {
  const r = mapPostmanToolToClaude('SubAgent', {}, claudeToolSet([{ name: 'Task' }]));
  assert.equal(r.kind, 'drop');
});

ok('tool AO delegate_subagent (gateway goi) => Task cua Claude Code', () => {
  const r = mapPostmanToolToClaude('pm-proxy__local__delegate_subagent', { description: 'Ra soat auth', prompt: 'Doc toan bo src/auth va bao cao loi' }, claudeToolSet([{ name: 'Task' }]));
  assert.equal(r.kind, 'client');
  assert.equal(r.name, 'Task');
  assert.equal(r.input.prompt, 'Doc toan bo src/auth va bao cao loi');
  assert.equal(r.input.subagent_type, 'general-purpose');
});

ok('subagentThirdParty: chi khai tool ao khi client chay duoc subagent', () => {
  assert.equal(subagentThirdParty(claudeToolSet([{ name: 'Read' }])), null, 'khong co Task/Agent => khong khai');
  const tp = subagentThirdParty(claudeToolSet([{ name: 'Agent' }]));
  assert.ok(tp && tp[SUBAGENT_SERVER], 'co Agent => khai server ao');
  const t = tp[SUBAGENT_SERVER].tools[0];
  assert.equal(t.name, SUBAGENT_TOOL);
  assert.deepEqual(t.parameters.required, ['description', 'prompt']);
});

ok('card: co Task => co huong dan uy nhiem sub-agent (keu goi chay dong thoi)', () => {
  const card = buildToolCard({ workingDir: 'C:/du/an', claudeToolNames: claudeToolSet([{ name: 'Read' }, { name: 'Task' }]) });
  assert.ok(card.includes(SUBAGENT_TOOL), 'card neu dung ten tool subagent');
  assert.ok(/2 VIEC DOC LAP/.test(card), 'co nguong: >=2 viec doc lap');
  assert.ok(/DONG THOI/.test(card), 'yeu cau chay dong thoi thay vi tuan tu');
  assert.ok(/KHONG dung cho viec vat/.test(card), 'co chan lam dung');
});

ok('card: co userRules => chen quy tac, ghi ro nguon la nguoi dung', () => {
  const card = buildToolCard({ workingDir: 'C:/du/an', claudeToolNames: claudeToolSet([{ name: 'Read' }]), userRules: 'Luon tra loi bang TIENG VIET.' });
  assert.ok(card.includes('Luon tra loi bang TIENG VIET.'), 'giu nguyen van quy tac');
  assert.ok(/nguoi dung \(chu phien lam viec\) dat ra/.test(card), 'noi ro nguon goc de model khong coi la injection');
});

ok('card: khong co userRules => khong chen gi them', () => {
  const card = buildToolCard({ workingDir: 'C:/du/an', claudeToolNames: claudeToolSet([{ name: 'Read' }]) });
  assert.ok(!/QUY TAC BAT BUOC/.test(card));
});

ok('card: client khong co Task/Agent => KHONG nhac sub-agent', () => {
  const card = buildToolCard({ workingDir: 'C:/du/an', claudeToolNames: claudeToolSet([{ name: 'Read' }]) });
  assert.ok(!card.includes(SUBAGENT_TOOL));
  assert.ok(!/SUB-AGENT/.test(card));
});

ok('client khong khai Task/Agent => SubAgent bi loai khoi gateway', () => {
  const ex = excludedToolsFor(claudeToolSet([{ name: 'Read' }]), []);
  assert.ok(ex.includes('SubAgent'));
  const ex2 = excludedToolsFor(claudeToolSet([{ name: 'Task' }]), []);
  assert.ok(!ex2.includes('SubAgent'));
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

ok('subagent: run_in_background=false - ket qua phai ve trong tool_result cua chinh luot nay', () => {
  const r = mapPostmanToolToClaude('pm-proxy__local__delegate_subagent', { description: 'Chay demo', prompt: 'node demo.mjs' }, claudeToolSet([{ name: 'Task' }]));
  assert.equal(r.input.run_in_background, false, 'mac dinh client la chay NEN -> tra ve "da khoi dong" thay vi ket qua');
});

ok('subagent: client khong khai run_in_background => tu cat bo (schema strict)', () => {
  const defs = [{ name: 'Task', input_schema: { type: 'object', properties: { description: {}, prompt: {}, subagent_type: {} }, additionalProperties: false } }];
  const r = mapPostmanToolToClaude('pm-proxy__local__delegate_subagent', { description: 'a', prompt: 'b' }, claudeToolSet(defs));
  const input = conformInputToSchema(conformToolName(r.name, defs), r.input, defs);
  assert.equal('run_in_background' in input, false, 'khoa la phai bi cat khi additionalProperties:false');
  assert.equal(input.prompt, 'b');
});

ok('subagent: "subagents" la tool QUAN LY, khong duoc coi la tool tao sub-agent', () => {
  // Schema that: subagents {action, recentMinutes, taskId} - mac dinh action='list'.
  // Gui {description, prompt} vao se nhan lai danh sach rong chu khong chay gi.
  const oc = claudeToolSet([{ name: 'exec' }, { name: 'read' }, { name: 'subagents' }]);
  assert.equal(subagentThirdParty(oc), null, 'chi co tool quan ly => khong khai');
  assert.equal(mapPostmanToolToClaude('pm-proxy__local__delegate_subagent', { description: 'a', prompt: 'b' }, oc).kind, 'drop');
});

ok('subagent: openclaw sessions_spawn -> doi sang khoa task/taskName', () => {
  // Schema that: sessions_spawn { task* , taskName, label, cwd, ... }
  const oc = claudeToolSet([{ name: 'exec' }, { name: 'subagents' }, { name: 'sessions_spawn' }]);
  assert.ok(subagentThirdParty(oc), 'co tool tao sub-agent that => phai khai');
  const r = mapPostmanToolToClaude('pm-proxy__local__delegate_subagent', { description: 'Ra soat auth', prompt: 'Doc src/auth' }, oc);
  assert.equal(r.name, 'sessions_spawn');
  assert.equal(r.input.task, 'Doc src/auth', 'prompt -> task (khoa BAT BUOC cua openclaw)');
  assert.equal(r.input.taskName, 'Ra soat auth');
  assert.equal(r.input.prompt, undefined, 'khong duoc de sot khoa cua Claude Code');
});

ok('subagent: van khai binh thuong cho client co Task/Agent (schema da biet)', () => {
  for (const n of ['Task', 'Agent']) {
    const set = claudeToolSet([{ name: 'exec' }, { name: n }]);
    assert.ok(subagentThirdParty(set), n + ' => phai duoc cap tool ao');
    assert.equal(mapPostmanToolToClaude('pm-proxy__local__delegate_subagent', { description: 'a', prompt: 'b' }, set).name, n);
  }
});

ok('tim kiem: client chi co shell van giu searchFiles (ha xuong shell)', () => {
  const oc = claudeToolSet([{ name: 'exec' }, { name: 'read' }]);
  assert.ok(hasCapability(oc, 'grep'), 'co shell => coi nhu tim kiem duoc');
  assert.ok(nativesToKeep(oc).has('searchFiles'), 'khong duoc cam searchFiles');
  const r = mapPostmanToolToClaude('searchFiles', { queryString: 'TODO', path: '/du/an' }, oc);
  assert.equal(r.kind, 'client');
  assert.equal(r.name, 'exec', 'khong co Grep native => chay bang shell');
  assert.ok(/TODO/.test(r.input.command), r.input.command);
});

ok('tim kiem: client KHONG co shell lan Grep => moi bi cam', () => {
  const only = claudeToolSet([{ name: 'read' }]);
  assert.ok(!hasCapability(only, 'grep'));
  assert.ok(excludedToolsFor(only, []).includes('searchFiles'));
});

console.log('\n# Tuong thich OpenAI (/v1/chat/completions)');
ok('request OpenAI -> Anthropic: system gop lai, tool_calls -> tool_use, role tool -> tool_result', () => {
  const b = toAnthropicBody({
    model: 'x', stream: true,
    messages: [
      { role: 'system', content: 'quy tac 1' },
      { role: 'system', content: 'quy tac 2' },
      { role: 'user', content: 'doc file di' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"/a.txt"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'noi dung file' },
    ],
    tools: [{ type: 'function', function: { name: 'read_file', description: 'doc', parameters: { type: 'object', properties: { path: {} } } } }],
  });
  assert.equal(b.system, 'quy tac 1\n\nquy tac 2', 'gop moi system message');
  assert.equal(b.stream, true);
  assert.equal(b.messages[0].role, 'user');
  const asst = b.messages[1];
  assert.equal(asst.role, 'assistant');
  assert.equal(asst.content[0].type, 'tool_use');
  assert.equal(asst.content[0].name, 'read_file');
  assert.deepEqual(asst.content[0].input, { path: '/a.txt' }, 'arguments (chuoi JSON) -> input (object)');
  const toolMsg = b.messages[2];
  assert.equal(toolMsg.role, 'user', 'OpenAI tach role tool rieng; Anthropic long trong user');
  assert.equal(toolMsg.content[0].type, 'tool_result');
  assert.equal(toolMsg.content[0].tool_use_id, 'call_1');
  assert.equal(b.tools[0].input_schema.properties.path !== undefined, true, 'parameters -> input_schema');
  assert.equal(b.__fromOpenAI, true, 'danh dau nguon de khong bi coi la luot tien ich');
});

ok('request OpenAI: content dang mang [{type:text}] -> chuoi', () => {
  const b = toAnthropicBody({ messages: [{ role: 'user', content: [{ type: 'text', text: 'xin' }, { type: 'text', text: ' chao' }] }] });
  assert.equal(b.messages[0].content, 'xin chao');
});

ok('response Anthropic -> OpenAI: tool_use -> tool_calls, stop_reason -> finish_reason', () => {
  const out = toOpenAIResponse({
    content: [{ type: 'text', text: 'de em doc' }, { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: '/a.txt' } }],
    stop_reason: 'tool_use',
    usage: { input_tokens: 10, output_tokens: 5 },
  }, 'model-x');
  assert.equal(out.object, 'chat.completion');
  assert.equal(out.choices[0].finish_reason, 'tool_calls');
  const tc = out.choices[0].message.tool_calls[0];
  assert.equal(tc.type, 'function');
  assert.equal(tc.function.name, 'read_file');
  assert.equal(tc.function.arguments, '{"path":"/a.txt"}', 'input (object) -> arguments (chuoi JSON)');
  assert.equal(out.usage.total_tokens, 15);
});

ok('response: end_turn -> stop, max_tokens -> length', () => {
  assert.equal(toOpenAIResponse({ content: [{ type: 'text', text: 'a' }], stop_reason: 'end_turn' }).choices[0].finish_reason, 'stop');
  assert.equal(toOpenAIResponse({ content: [{ type: 'text', text: 'a' }], stop_reason: 'max_tokens' }).choices[0].finish_reason, 'length');
});

ok('luot tien ich: chi ap cho Claude Code, KHONG ap cho client OpenAI', () => {
  const noTools = { messages: [{ role: 'user', content: 'chao' }] };
  assert.equal(isUtilityTurn(noTools), true, 'Claude Code khong tool => luot tien ich (title-gen)');
  assert.equal(isUtilityTurn({ ...noTools, __fromOpenAI: true }), false, 'OpenAI chat khong tool la BINH THUONG -> phai di gateway');
});

ok('nhan dien nang luc theo ten phi chuan (read_file, cat, exec...)', () => {
  assert.ok(nativesToKeep(claudeToolSet([{ name: 'read_file' }])).has('readFile'), 'read_file => van giu native readFile');
  assert.ok(nativesToKeep(claudeToolSet([{ name: 'exec' }])).has('executeShellCommand'), 'exec => van giu executeShellCommand');
  assert.ok(!nativesToKeep(claudeToolSet([{ name: 'khong_lien_quan' }])).has('readFile'));
  const ex = excludedToolsFor(claudeToolSet([{ name: 'read_file' }]), []);
  assert.ok(!ex.includes('readFile'), 'khong duoc cam readFile khi client CO kha nang doc file');
});

ok('tool_choice: none -> cat tool VA dan model dung viet cu phap goi tool', () => {
  const d = toolChoiceDirective({ type: 'none' }, claudeToolSet([{ name: 'read_file' }]));
  assert.equal(d.mode, 'none');
  // Cat tool o gateway chua du: model bi cat tool se viet ra cu phap goi tool bang van ban.
  assert.ok(/KHONG duoc goi/.test(d.hint), d.hint);
});

ok('tool_choice: required/any -> sinh chi dan ep goi tool', () => {
  const d = toolChoiceDirective({ type: 'any' }, claudeToolSet([{ name: 'read_file' }]));
  assert.equal(d.mode, 'any');
  assert.ok(/BAT BUOC/.test(d.hint), d.hint);
});

ok('tool_choice: chi dinh ten -> doi sang ten NATIVE ma model that su nhin thay', () => {
  const d = toolChoiceDirective({ type: 'tool', name: 'read_file' }, claudeToolSet([{ name: 'read_file' }]));
  assert.equal(d.name, 'readFile', 'ten client (read_file) -> ten native Postman (readFile)');
  assert.ok(d.hint.includes('readFile') && d.hint.includes('read_file'), d.hint);
});

ok('tool_choice: auto hoac khong khai -> khong lam gi', () => {
  assert.equal(toolChoiceDirective(undefined, claudeToolSet([{ name: 'Read' }])).hint, '');
  assert.equal(toolChoiceDirective({ type: 'auto' }, claudeToolSet([{ name: 'Read' }])).hint, '');
});

ok('tool_choice OpenAI -> dang Anthropic', () => {
  const mk = (tc) => toAnthropicBody({ messages: [{ role: 'user', content: 'a' }], tool_choice: tc }).tool_choice;
  assert.deepEqual(mk('none'), { type: 'none' });
  assert.deepEqual(mk('required'), { type: 'any' });
  assert.deepEqual(mk({ type: 'function', function: { name: 'f' } }), { type: 'tool', name: 'f' });
  assert.equal(mk('auto'), undefined, 'auto la mac dinh -> khong can dat gi');
});

ok('anh: bao ro cho model thay vi bo im lang', () => {
  const b = toAnthropicBody({ messages: [{ role: 'user', content: [{ type: 'text', text: 'anh gi day?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] }] });
  assert.ok(b.messages[0].content.includes('anh gi day?'));
  assert.ok(/khong xem duoc anh/i.test(b.messages[0].content), 'model phai biet minh dang thieu du lieu: ' + b.messages[0].content);
});

console.log('\n# rules.md: sinh lai khi nguon doi, khong de ban tu viet tay');
{
  const os2 = await import('node:os');
  const fs2 = await import('node:fs');
  const path2 = await import('node:path');
  const R = await import('./rules.mjs');
  const tmp = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'pmrules-'));
  const f = path2.join(tmp, 'rules.md');
  const readHash = (txt) => { fs2.writeFileSync(f, txt); const m = fs2.readFileSync(f, 'utf8').slice(0, 200).match(/^<!-- pm-proxy:auto source=([a-f0-9]+) -->/); return m ? m[1] : null; };

  ok('van tay doi khi noi dung nguon doi', () => {
    const a = path2.join(tmp, 'a.md'), b = path2.join(tmp, 'b.md');
    fs2.writeFileSync(a, 'quy tac 1'); fs2.writeFileSync(b, 'quy tac 2');
    const h1 = R.sourceHash([a, b]);
    fs2.writeFileSync(b, 'quy tac 2 - da sua');
    assert.notEqual(R.sourceHash([a, b]), h1, 'sua file => hash phai doi');
    fs2.writeFileSync(b, 'quy tac 2 - da sua');
    assert.equal(R.sourceHash([a, b]), R.sourceHash([a, b]), 'khong sua => hash on dinh');
  });

  ok('nhan dien ban tu sinh vs ban nguoi dung tu viet', () => {
    assert.equal(readHash('<!-- pm-proxy:auto source=abc123 -->\nnoi dung'), 'abc123', 'ban tu sinh: doc duoc hash');
    assert.equal(readHash('# Quy tac cua toi\n- luon tieng Viet'), null, 'ban tu viet tay: khong co hash => khong de');
  });

  ok('joinSources: bo khoi code, ghep theo uu tien', () => {
    const a = path2.join(tmp, 'c.md');
    fs2.writeFileSync(a, 'giu dong nay\n```js\nconst x = 1; // phai bi bo\n```\ncon dong nay');
    const out = R.joinSources([a]);
    assert.ok(out.includes('giu dong nay') && out.includes('con dong nay'));
    assert.ok(!out.includes('const x = 1'), 'khoi code bi loai khoi phan gui di');
  });

  ok('readUserRules: boc het header comment, chi tra quy tac', () => {
    assert.ok(typeof R.readUserRules() === 'string');
  });

  fs2.rmSync(tmp, { recursive: true, force: true });
}

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

await okAsync('gateway phat SubAgent (client co Task) => proxy phat tool_use Task', async () => {
  if (!loadTemplate()) throw new Error('can .chat-template.json (da harvest) de buildBody');
  const CT_TASK = claudeToolSet([{ name: 'Read' }, { name: 'Task' }]);
  const orig = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.ok(!body.clientTools.excludedTools.includes('SubAgent'), 'SubAgent KHONG bi loai khi client khai Task');
    return sseRes([
      ev('conversation', { id: 'conv_sub' }),
      ev('toolCallChunk', { toolCalls: [{ id: 'toolu_sub', toolCallGroupId: 'grp_sub', function: { name: 'SubAgent', arguments: '{"task":"Ra soat module auth","agentType":"code-reviewer"}' } }] }),
      '[DONE]',
    ]);
  };
  try {
    const { buildBody } = await import('./core.mjs');
    const emitter = new BufferEmitter({ model: 'claude-x' });
    const gw = buildBody('USER_QUERY', { query: 'ra soat ho em', conversationId: null });
    await runGateway('faketoken', gw, emitter, { conversationId: 'conv_sub', key: 'ksub', model: 'claude-x', opts: { workingDir: null, pmModelKey: null, claudeTools: CT_TASK, thinking: null }, round: 0 });
    const msg = emitter.toMessage();
    assert.equal(msg.stop_reason, 'tool_use');
    const tu = msg.content.find((b) => b.type === 'tool_use');
    assert.ok(tu, 'co tool_use block');
    assert.equal(tu.name, 'Task');
    assert.equal(tu.input.prompt, 'Ra soat module auth');
    assert.equal(tu.input.subagent_type, 'code-reviewer');
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

await okAsync('CONVERSATION_NOT_FOUND -> mo hoi thoai MOI ngay (KHONG thu lai id da chet)', async () => {
  const orig = globalThis.fetch;
  let round = 0; const sent = [];
  globalThis.fetch = async (_url, init) => {
    round++;
    const body = JSON.parse(init.body);
    sent.push(body.input.conversationId);
    if (round === 1) return sseRes([ev('failure', { errorType: 'CONVERSATION_NOT_FOUND', userMessage: "Looks like I couldn't find this chat." })]);
    return sseRes([ev('conversation', { id: 'conv_moi' }), ev('textChunk', { textContent: 'ok' }), '[DONE]']);
  };
  try {
    const { buildBody } = await import('./core.mjs');
    setSession('kconv', { conversationId: 'conv_da_chet' });
    const emitter = new BufferEmitter({ model: 'claude-x' });
    const gw = buildBody('USER_QUERY', { query: 'cau hoi', conversationId: 'conv_da_chet' });
    const turn = { kind: 'user_query', text: 'cau hoi' };
    const recov = { turn, messages: [{ role: 'user', content: 'cau hoi' }], key: 'kconv', model: 'claude-x', opts: baseOpts, conversationId: 'conv_da_chet' };
    await runGatewayResilient('faketoken', gw, emitter, { conversationId: 'conv_da_chet', key: 'kconv', model: 'claude-x', opts: baseOpts, round: 0 }, recov);
    assert.equal(round, 2, 'chi retry 1 lan - khong thu lai id da chet');
    assert.equal(sent[1], null, 'lan 2 phai la hoi thoai MOI (conversationId=null)');
  } finally { globalThis.fetch = orig; }
});

ok('CONVERSATION_NOT_FOUND -> phien KHONG con giu id da chet (chong lap vo han)', () => {
  const sess = getSession('kconv');
  const cur = sess && sess.conversationId;
  assert.notEqual(cur, 'conv_da_chet', 'con giu id chet thi luot sau lai gui len va lai loi');
  assert.equal(cur, 'conv_moi', 'phai la hoi thoai moi vua mo');
});


console.log('\n# tool_use_id bi client sanitize (openclaw bo dau "_")');
ok('client tra ve id da bo dau "_" => proxy VAN nhan ra', () => {
  recordToolUse('toolu_bdrk_01DHLjNUr6e9Vmfeagoo5ijq', { conversationId: 'c1', groupId: 'g1', nativeName: 'read' });
  const info = getToolUse('toolubdrk01DHLjNUr6e9Vmfeagoo5ijq');   // dung shape openclaw tra ve
  assert.ok(info, 'khong nhan ra => moi ket qua tool bi day len duoi dang USER_QUERY');
  assert.equal(info.groupId, 'g1');
});

ok('id nguyen ven van tra cuu binh thuong', () => {
  recordToolUse('toolu_bdrk_02Xyz', { conversationId: 'c2', groupId: 'g2' });
  assert.ok(getToolUse('toolu_bdrk_02Xyz'));
});

ok('gui len gateway phai la ID GOC, khong phai id client da cat', () => {
  recordToolUse('toolu_bdrk_03AbCdEf', { conversationId: 'c3', groupId: 'g3' });
  const { groups, unknown } = buildToolResponses(
    [{ toolUseId: 'toolubdrk03AbCdEf', content: 'ket qua', isError: false }],   // id da bi sanitize
    getToolUse,
  );
  assert.equal(unknown.length, 0, 'khong duoc coi la mo coi');
  const tr = groups.g3.toolResponses[0];
  assert.equal(tr.toolCallId, 'toolu_bdrk_03AbCdEf', 'gui id da cat len gateway se bi TOOL_CALL_NOT_FOUND');
});

ok('id khong ton tai van bao mo coi (khong nhan bua)', () => {
  const { unknown } = buildToolResponses([{ toolUseId: 'khong_he_ton_tai_123', content: 'x' }], getToolUse);
  assert.equal(unknown.length, 1);
});


console.log(`\n${fail ? '[X]' : '[OK]'} selftest: ${pass} pass, ${fail} fail\n`);
process.exit(fail ? 1 : 0);
