/**
 * Client mo phong: chay TRON vong lap agent qua proxy (giong openclaw/Claude Code that).
 * Nhan tool_use -> THUC THI THAT -> tra tool_result -> lap den khi end_turn.
 * Muc dich: tai hien dung canh Sep gap (uy nhiem sub-agent chay lenh) va soi tung buoc.
 *
 * node agent-loop.mjs <port> <kieu-client> "<cau lenh>"
 *   kieu-client: openclaw | claudecode
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const PORT = process.argv[2] || '8799';
const KIND = process.argv[3] || 'openclaw';
const TASK = process.argv[4] || 'Uy nhiem sub-agent chay lenh: node --version';
const MAX_ROUNDS = 12;

const TOOLS_OPENCLAW = [
  { name: 'exec', description: 'Run one shell command', input_schema: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' } }, required: ['command'] } },
  { name: 'read', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'subagents', description: 'List/manage sub-agents', input_schema: { type: 'object', properties: { action: { type: 'string' }, taskId: { type: 'string' } } } },
  { name: 'sessions_spawn', description: 'Spawn a sub-agent session to run a task', input_schema: { type: 'object', properties: { task: { type: 'string' }, taskName: { type: 'string' }, cwd: { type: 'string' } }, required: ['task'] } },
  { name: 'agents_wait', description: 'Wait for sub-agent tasks to finish', input_schema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } }, timeoutSeconds: { type: 'number' } }, required: ['ids'] } },
];
const TOOLS_CC = [
  { name: 'Bash', description: 'Run a shell command', input_schema: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' } }, required: ['command'] } },
  { name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
  { name: 'Agent', description: 'Launch a new agent', input_schema: { type: 'object', properties: { description: { type: 'string' }, prompt: { type: 'string' }, subagent_type: { type: 'string' }, run_in_background: { type: 'boolean' } }, required: ['description', 'prompt'], additionalProperties: false } },
];
const TOOLS = KIND === 'openclaw' ? TOOLS_OPENCLAW : TOOLS_CC;

// Thuc thi tool THAT (gioi han: chi doc + chay lenh ngan).
function runTool(name, input) {
  const t0 = Date.now();
  try {
    if (name === 'exec' || name === 'Bash') {
      const cmd = input.command;
      // Mo phong DUNG shell that cua tung client: Claude Code Bash la Git Bash (POSIX),
      // openclaw exec la PowerShell. Dung sai shell thi ket qua test vo nghia.
      const shell = KIND === 'claudecode' ? 'bash.exe' : 'powershell.exe';
      const out = execSync(cmd, { cwd: input.cwd || process.cwd(), encoding: 'utf8', timeout: 60000, windowsHide: true, shell });
      return { ok: true, ms: Date.now() - t0, out: String(out).slice(0, 2000) };
    }
    if (name === 'read' || name === 'Read') {
      return { ok: true, ms: Date.now() - t0, out: fs.readFileSync(input.path || input.file_path, 'utf8').slice(0, 2000) };
    }
    if (name === 'sessions_spawn' || name === 'Agent') {
      // SUB-AGENT: client that se chay mot agent con. O day ta mo phong: bao da chay xong
      // va tra ve BAO CAO - de xem gateway co dung ket qua do va di tiep khong.
      const task = input.task || input.prompt || '';
      const delay = Number(process.env.SUBAGENT_DELAY_MS || 0);
      if (delay) { const end = Date.now() + delay; while (Date.now() < end) execSync('powershell -NoProfile -Command "Start-Sleep -Milliseconds 900"', { windowsHide: true }); }
      // ASYNC: mo phong openclaw that - spawn xong tra ve ID tac vu, KHONG co ket qua.
      if (process.env.SUBAGENT_ASYNC) return { ok: true, ms: Date.now() - t0, subagent: true, out: JSON.stringify({ status: 'ok', action: 'spawn', taskId: 'task-abc123', sessionKey: 'agent:sub:abc123', text: 'Spawned sub-agent task-abc123. Use agents_wait to await completion.' }) };
      return { ok: true, ms: Date.now() - t0, subagent: true, out: '[sub-agent da chay xong]\nBao cao: ' + String(task).slice(0, 120) + '\nKet qua: 14 file .mjs.' };
    }
    if (name === 'agents_wait') {
      return { ok: true, ms: Date.now() - t0, subagent: true, out: JSON.stringify({ status: 'ok', results: [{ taskId: (input.ids || ['?'])[0], state: 'completed', report: 'Da dem xong: 14 file .mjs trong src.' }] }) };
    }
    if (name === 'subagents') return { ok: true, ms: Date.now() - t0, out: JSON.stringify({ status: 'ok', action: input.action || 'list', tasks: [] }) };
    return { ok: false, ms: Date.now() - t0, out: 'khong ho tro tool ' + name };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, out: String(e.stdout || '') + String(e.stderr || e.message).slice(0, 800) };
  }
}

const messages = [{ role: 'user', content: TASK }];
console.log(`\n=== client=${KIND} port=${PORT} ===`);
console.log(`Lenh: ${TASK}\n`);

for (let round = 1; round <= MAX_ROUNDS; round++) {
  const body = { model: 'claude-sonnet-4-20250514', max_tokens: 4096, stream: false, system: 'agent-loop-test-' + KIND, tools: TOOLS, messages };
  const t0 = Date.now();
  let res, data;
  try {
    res = await fetch(`http://127.0.0.1:${PORT}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pm-working-dir': 'C:/Users/Win10/Desktop/Workspace/pm-proxy' }, body: JSON.stringify(body) });
    data = await res.json();
  } catch (e) {
    console.log(`[vong ${round}] LOI MANG: ${e.message}`); break;
  }
  const ms = Date.now() - t0;
  if (data.type === 'error') { console.log(`[vong ${round}] LOI PROXY (${ms}ms): ${JSON.stringify(data.error).slice(0, 200)}`); break; }

  const blocks = data.content || [];
  const texts = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  const calls = blocks.filter((b) => b.type === 'tool_use');
  console.log(`[vong ${round}] ${ms}ms | stop=${data.stop_reason} | tool=${calls.length}${texts ? ' | text: ' + texts.slice(0, 100).replace(/\n/g, ' ') : ''}`);

  if (!calls.length) { console.log(`\n=== KET THUC sau ${round} vong: ${data.stop_reason} ===`); break; }

  messages.push({ role: 'assistant', content: blocks });
  const results = [];
  for (const c of calls) {
    const r = runTool(c.name, c.input || {});
    const mark = r.subagent ? ' [SUB-AGENT]' : '';
    console.log(`         -> ${c.name}${mark} (${r.ms}ms) ${r.ok ? 'OK' : 'LOI'}: ${String(r.out).slice(0, 90).replace(/\n/g, ' ')}`);
    results.push({ type: 'tool_result', tool_use_id: c.id, content: r.out, is_error: !r.ok });
  }
  messages.push({ role: 'user', content: results });
  if (round === MAX_ROUNDS) console.log('\n=== HET SO VONG CHO PHEP (co the dang lap) ===');
}
