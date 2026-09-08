// Nova verify: kiểm chứng 2 fix (Bug#1 find_path, Bug#2 run_cmd cwd) ở tầng mapping.
import assert from 'node:assert';
import { mapPostmanToolToClaude } from './map.mjs';

// Giả lập tool-set client openclaw (KHÔNG có Glob/Bash; có exec + dir tools remote).
const OPENCLAW = ['exec', 'read', 'write', 'edit', 'dir_fetch', 'dir_list', 'grep', 'web_fetch', 'ask_user'];
// Client kiểu Claude Code thật (có Glob, Bash).
const CLAUDE = ['Bash', 'Glob', 'Grep', 'Read', 'Write', 'Edit'];

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log('PASS', name); } catch (e) { fail++; console.log('FAIL', name, '::', e.message); } };

// Bug#2: run_cmd + cwd → dùng ';' (không '&&') để PS 5.1 nuốt được.
ok('Bug#2 run_cmd+cwd dùng ; không &&', () => {
  const r = mapPostmanToolToClaude('aki-mcp-sv__local__run_cmd', { command: 'Get-ChildItem', cwd: 'C:\\Users\\Win10\\Desktop\\Workspace' }, OPENCLAW);
  assert.equal(r.kind, 'client');
  assert.ok(/;\s*Get-ChildItem/.test(r.input.command), 'phải có "; Get-ChildItem": ' + r.input.command);
  assert.ok(!r.input.command.includes('&&'), 'KHÔNG được còn &&: ' + r.input.command);
});

// Bug#1: find_path trên client openclaw (không Glob) → rơi xuống exec + Get-ChildItem (PowerShell).
ok('Bug#1 find_path(list) → exec + Get-ChildItem', () => {
  const r = mapPostmanToolToClaude('aki-mcp-sv__local__find_path', { query: '*', path: 'C:\\Users\\Win10\\Desktop\\Workspace' }, OPENCLAW);
  assert.equal(r.kind, 'client');
  assert.equal(r.name, 'exec');
  assert.ok(/Get-ChildItem/.test(r.input.command), 'phải là Get-ChildItem: ' + r.input.command);
  assert.ok(!/must have required|dir_fetch/i.test(JSON.stringify(r)), 'không dính dir_fetch');
});

ok('Bug#1 find_path(pattern) → exec + Get-ChildItem -Filter', () => {
  const r = mapPostmanToolToClaude('aki-mcp-sv__local__find_path', { query: '*.md', path: 'C:\\x' }, OPENCLAW);
  assert.equal(r.name, 'exec');
  assert.ok(/-Filter/.test(r.input.command), 'phải có -Filter: ' + r.input.command);
});

// find_path KHÔNG được map vào dir_fetch/dir_list nữa.
ok('Bug#1 find_path KHÔNG map vào dir_fetch/dir_list', () => {
  const r = mapPostmanToolToClaude('aki-mcp-sv__local__find_path', { query: '*', path: 'C:\\x' }, OPENCLAW);
  assert.notEqual(r.name, 'dir_fetch');
  assert.notEqual(r.name, 'dir_list');
});

// Client có Glob thật → vẫn dùng Glob (không hồi quy).
ok('find_path trên client có Glob → vẫn Glob', () => {
  const r = mapPostmanToolToClaude('aki-mcp-sv__local__find_path', { query: '*.md', path: '/x' }, CLAUDE);
  assert.equal(r.kind, 'client');
  assert.equal(r.name, 'Glob');
});

console.log(`\nnova-verify: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
