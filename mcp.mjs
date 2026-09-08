/**
 * MCP CLIENT (chế độ web) — biến tool này thành MCP *host*: kết nối tới các MCP server
 * (stdio hoặc HTTP streamable), liệt kê tool (tools/list) và thực thi tool (tools/call).
 *
 * Vì sao cần: agent-mode của Postman coi MCP tool là "client tool" — CHÍNH client phải
 * chạy tool rồi trả kết quả. Bản replay này trước đây không có ai chạy nên tool MCP luôn
 * rơi vào UNSUPPORTED. Module này bổ sung phần thực thi đó.
 *
 * CONFIG: %USERPROFILE%\.postman-agent-cli\mcp.json
 * {
 *   "advertise": false,          // true = tự khai báo tool MCP vào payload /chat (thử nghiệm)
 *   "servers": {
 *     "fs":      { "type": "stdio", "command": "npx", "args": ["-y","@modelcontextprotocol/server-filesystem","."], "env": {}, "cwd": "." },
 *     "remote":  { "type": "http",  "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ..." } }
 *   }
 * }
 *
 * Tên tool expose cho agent: mcp__<server>__<tool>  → khi agent gọi, ta decode để định tuyến.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const MCP_CONFIG_FILE = path.join(os.homedir(), '.postman-agent-cli', 'mcp.json');
export const PREFIX = 'mcp__';
const RPC_TIMEOUT = 30000;

export function mcpConfigPath() { return MCP_CONFIG_FILE; }

export function loadMcpConfig() {
  let advertise = false; const servers = {};
  try {
    const c = JSON.parse(fs.readFileSync(MCP_CONFIG_FILE, 'utf8'));
    if (c && typeof c === 'object') { advertise = !!c.advertise; if (c.servers && typeof c.servers === 'object') Object.assign(servers, c.servers); }
  } catch {}
  // AUTO-REGISTER: merge OpenClaw-managed mcp.servers so `openclaw mcp add <name>` shows up here too.
  try {
    const oc = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.openclaw', 'openclaw.json'), 'utf8'));
    const ocs = oc && oc.mcp && oc.mcp.servers;
    if (ocs && typeof ocs === 'object') {
      for (const [name, cfg] of Object.entries(ocs)) {
        if (servers[name] || !cfg || typeof cfg !== 'object') continue;
        if (cfg.url) servers[name] = { type: 'http', url: cfg.url, headers: cfg.headers || {} };
        else if (cfg.command) servers[name] = { type: 'stdio', command: cfg.command, args: cfg.args || [], env: cfg.env || {}, cwd: cfg.cwd };
      }
    }
  } catch {}
  return { advertise, servers };
}

/** Tạo file config mẫu nếu chưa có. Trả về { created, path }. */
export function ensureMcpConfig() {
  if (fs.existsSync(MCP_CONFIG_FILE)) return { created: false, path: MCP_CONFIG_FILE };
  const sample = {
    advertise: false,
    servers: {
      // Ví dụ stdio (bỏ comment & sửa lại để dùng):
      // "fs": { "type": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] }
      // Ví dụ HTTP:
      // "remote": { "type": "http", "url": "https://your-server/mcp", "headers": {} }
    },
  };
  try { fs.mkdirSync(path.dirname(MCP_CONFIG_FILE), { recursive: true }); fs.writeFileSync(MCP_CONFIG_FILE, JSON.stringify(sample, null, 2)); return { created: true, path: MCP_CONFIG_FILE }; }
  catch (e) { return { created: false, path: MCP_CONFIG_FILE, error: e.message }; }
}

export const encodeName = (server, tool) => `${PREFIX}${server}__${tool}`;
export function decodeName(full) {
  if (!full || !full.startsWith(PREFIX)) return null;
  const rest = full.slice(PREFIX.length);
  const i = rest.indexOf('__');
  if (i < 0) return null;
  return { server: rest.slice(0, i), tool: rest.slice(i + 2) };
}
export const isMcpTool = (name) => typeof name === 'string' && name.startsWith(PREFIX);

// ---------------- Connections (giữ sống, cache theo tên server) ----------------
const conns = new Map(); // name -> conn

function stdioConnect(name, cfg) {
  const child = spawn(cfg.command, cfg.args || [], {
    cwd: cfg.cwd ? path.resolve(cfg.cwd) : process.cwd(),
    env: { ...process.env, ...(cfg.env || {}) },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false,
  });
  const conn = { type: 'stdio', name, child, buf: '', pending: new Map(), nextId: 1, initialized: false, lastErr: '' };
  child.stdout.on('data', (d) => {
    conn.buf += d.toString('utf8');
    let i;
    while ((i = conn.buf.indexOf('\n')) !== -1) {
      const line = conn.buf.slice(0, i).trim(); conn.buf = conn.buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && conn.pending.has(msg.id)) {
        const { resolve, reject, timer } = conn.pending.get(msg.id); conn.pending.delete(msg.id); clearTimeout(timer);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error))); else resolve(msg.result);
      }
    }
  });
  child.stderr.on('data', (d) => { conn.lastErr = String(d).slice(-500); });
  child.on('error', (e) => { conn.lastErr = e.message; });
  child.on('exit', (code) => {
    conns.delete(name);
    for (const { reject, timer } of conn.pending.values()) { clearTimeout(timer); reject(new Error('MCP server "' + name + '" thoát (code ' + code + ')' + (conn.lastErr ? ': ' + conn.lastErr : ''))); }
    conn.pending.clear(); conn.initialized = false;
  });
  conn.rpc = (method, params) => new Promise((resolve, reject) => {
    const id = conn.nextId++;
    const timer = setTimeout(() => { if (conn.pending.has(id)) { conn.pending.delete(id); reject(new Error('MCP timeout (' + method + ') từ "' + name + '"')); } }, RPC_TIMEOUT);
    conn.pending.set(id, { resolve, reject, timer });
    try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n'); }
    catch (e) { clearTimeout(timer); conn.pending.delete(id); reject(e); }
  });
  conn.notify = (method, params) => { try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params: params || {} }) + '\n'); } catch {} };
  conn.close = () => { try { child.kill(); } catch {} };
  return conn;
}

function parseSse(text, id) {
  let result = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const p = line.slice(5).trim(); if (!p || p === '[DONE]') continue;
    try { const m = JSON.parse(p); if (m && (m.id === id || m.result || m.error)) result = m; } catch {}
  }
  return result;
}

function httpConnect(name, cfg) {
  const conn = { type: 'http', name, url: cfg.url, headers: cfg.headers || {}, session: null, nextId: 1, initialized: false };
  const doFetch = async (payload, isNotify) => {
    const res = await fetch(conn.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(conn.session ? { 'Mcp-Session-Id': conn.session } : {}), ...conn.headers },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(RPC_TIMEOUT),
    });
    const sid = res.headers.get('mcp-session-id'); if (sid) conn.session = sid;
    if (isNotify) return null;
    const ct = res.headers.get('content-type') || '';
    const text = await res.text();
    let data;
    if (ct.includes('text/event-stream')) data = parseSse(text, payload.id);
    else { try { data = JSON.parse(text); } catch { data = parseSse(text, payload.id); } }
    if (!res.ok && !data) throw new Error('MCP HTTP ' + res.status + ': ' + text.slice(0, 200));
    if (data && data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    return data ? data.result : undefined;
  };
  conn.rpc = (method, params) => doFetch({ jsonrpc: '2.0', id: conn.nextId++, method, params: params || {} }, false);
  conn.notify = (method, params) => doFetch({ jsonrpc: '2.0', method, params: params || {} }, true).catch(() => {});
  conn.close = () => {};
  return conn;
}

async function ensureConn(name) {
  const existing = conns.get(name);
  if (existing && existing.initialized) return existing;
  const cfg = loadMcpConfig().servers[name];
  if (!cfg) throw new Error('MCP server chưa được cấu hình: ' + name);
  const conn = cfg.type === 'http' ? httpConnect(name, cfg) : stdioConnect(name, cfg);
  conns.set(name, conn);
  await conn.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'postman-agent-cli', version: '1.0.0' } });
  try { conn.notify('notifications/initialized'); } catch {}
  conn.initialized = true;
  return conn;
}

/** Kết nối mọi server đã cấu hình & liệt kê tool. Trả về { tools, errors, advertise }. */
export async function listMcpTools() {
  const cfg = loadMcpConfig();
  const tools = [], errors = [];
  for (const name of Object.keys(cfg.servers || {})) {
    try {
      const conn = await ensureConn(name);
      const r = await conn.rpc('tools/list', {});
      for (const t of (r && r.tools) || []) {
        tools.push({ name: encodeName(name, t.name), rawName: t.name, server: name, description: t.description || '', inputSchema: t.inputSchema || { type: 'object' } });
      }
    } catch (e) { errors.push({ server: name, error: e.message }); }
  }
  return { tools, errors, advertise: !!cfg.advertise };
}

/** Gọi 1 tool MCP theo tên đã encode (mcp__server__tool). Trả về shape giống runTool. */
export async function callMcpTool(fullName, args) {
  const d = decodeName(fullName);
  if (!d) return { status: 'ERROR', message: 'Tên tool MCP không hợp lệ: ' + fullName };
  try {
    const conn = await ensureConn(d.server);
    const r = await conn.rpc('tools/call', { name: d.tool, arguments: args || {} });
    const content = (r && r.content) || [];
    const text = content.map((c) => (c && c.type === 'text' ? c.text : (c && c.type === 'resource' ? JSON.stringify(c.resource) : JSON.stringify(c)))).join('\n');
    return { status: r && r.isError ? 'ERROR' : 'SUCCESS', server: d.server, tool: d.tool, content: text || '(không có nội dung)', structuredContent: r && r.structuredContent };
  } catch (e) { return { status: 'ERROR', message: e.message }; }
}

/** Đóng toàn bộ kết nối (khi cần reload config). */
export function closeAllMcp() { for (const c of conns.values()) { try { c.close(); } catch {} } conns.clear(); }
