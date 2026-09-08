// Nova verify: kiem chung 2 fix (Bug#1 find_path, Bug#2 run_cmd cwd) o tang mapping.
import assert from 'node:assert';
import { mapPostmanToolToClaude } from './map.mjs';

// Gia lap tool-set client openclaw (KHONG co Glob/Bash; co exec + dir tools remote).
const OPENCLAW = ['exec', 'read', 'write', 'edit', 'dir_fetch', 'dir_list', 'grep', 'web_fetch', 'ask_user'];
// Client kieu Claude Code that (co Glob, Bash).
const CLAUDE = ['Bash', 'Glob', 'Grep', 'Read', 'Write', 'Edit'];

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log('PASS', name); } catch (e) { fail++; console.log('FAIL', name, '::', e.message); } };

// Bug#2: run_cmd + cwd -> dung ';' (khong '&&') de PS 5.1 nuot duoc.
ok('Bug#2 run_cmd+cwd dung ; khong &&', () => {
  const r = mapPostmanToolToClaude('aki-mcp-sv__local__run_cmd', { command: 'Get-ChildItem', cwd: 'C:\\Users\\Win10\\Desktop\\Workspace' }, OPENCLAW);
  assert.equal(r.kind, 'client');
  assert.ok(/;\s*Get-ChildItem/.test(r.input.command), 'phai co "; Get-ChildItem": ' + r.input.command);
  assert.ok(!r.input.command.includes('&&'), 'KHONG duoc con &&: ' + r.input.command);
});

// Bug#1: find_path tren client openclaw (khong Glob) -> roi xuong exec + Get-ChildItem (PowerShell).
ok('Bug#1 find_path(list) -> exec + Get-ChildItem', () => {
  const r = mapPostmanToolToClaude('aki-mcp-sv__local__find_path', { query: '*', path: 'C:\\Users\\Win10\\Desktop\\Workspace' }, OPENCLAW);
  assert.equal(r.kind, 'client');
  assert.equal(r.name, 'exec');
  assert.ok(/Get-ChildItem/.test(r.input.command), 'phai la Get-ChildItem: ' + r.input.command);
  assert.ok(!/must have required|dir_fetch/i.test(JSON.stringify(r)), 'khong dinh dir_fetch');
});

ok('Bug#1 find_path(pattern) -> exec + Get-ChildItem -Filter', () => {
  const r = mapPostmanToolToClaude('aki-mcp-sv__local__find_path', { query: '*.md', path: 'C:\\x' }, OPENCLAW);
  assert.equal(r.name, 'exec');
  assert.ok(/-Filter/.test(r.input.command), 'phai co -Filter: ' + r.input.command);
});

// find_path KHONG duoc map vao dir_fetch/dir_list nua.
ok('Bug#1 find_path KHONG map vao dir_fetch/dir_list', () => {
  const r = mapPostmanToolToClaude('aki-mcp-sv__local__find_path', { query: '*', path: 'C:\\x' }, OPENCLAW);
  assert.notEqual(r.name, 'dir_fetch');
  assert.notEqual(r.name, 'dir_list');
});

// Client co Glob that -> van dung Glob (khong hoi quy).
ok('find_path tren client co Glob -> van Glob', () => {
  const r = mapPostmanToolToClaude('aki-mcp-sv__local__find_path', { query: '*.md', path: '/x' }, CLAUDE);
  assert.equal(r.kind, 'client');
  assert.equal(r.name, 'Glob');
});

console.log(`\nnova-verify: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
