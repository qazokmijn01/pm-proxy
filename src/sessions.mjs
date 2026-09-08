/**
 * SESSION STORE - cau noi giua Anthropic (STATELESS: client gui lai TOAN BO lich su moi
 * luot) va Postman /chat (STATEFUL: server giu conversationId, ta chi gui luot moi).
 *
 * Khoa phien = hash cua (system on dinh + noi dung user message DAU TIEN) - bat bien qua
 * cac luot cua cung mot hoi thoai Claude Code. Nho do luot USER_QUERY tiep theo tim lai
 * dung conversationId. Luot tool_result thi tra theo tool_use_id (ban do tools).
 *
 * Ngoai ra giu "pending": khi 1 group co tool BI DROP (proxy tu tra) lan tool cho client,
 * ta cat phan drop lai de GOP chung TOOL_RESPONSE khi client tra ket qua (Postman ky vong
 * moi tool trong mot group duoc tra cung nhau - xem core.mjs).
 *
 * Luu o %USERPROFILE%\.postman-agent-cli\.claude-sessions.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CACHE_DIR } from './core.mjs';

const FILE = path.join(CACHE_DIR, '.claude-sessions.json');
const MAX_SESSIONS = 300;
const MAX_TOOLS = 2000;

let state = load();

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { sessions: j.sessions || {}, tools: j.tools || {}, pending: j.pending || {} };
  } catch { return { sessions: {}, tools: {}, pending: {} }; }
}

let saveTimer = null;
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(state)); } catch {}
  }, 200);
}

// Rut text cua mot message.content (string | mang block Anthropic).
function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((b) => b && (b.type === 'text' || typeof b.text === 'string')).map((b) => b.text || '').join('\n');
  }
  return '';
}

/** Khoa phien on dinh tu system + user message dau tien. */
export function sessionKey(system, messages) {
  const sys = typeof system === 'string' ? system : Array.isArray(system) ? system.map((s) => s.text || '').join('\n') : '';
  const firstUser = (messages || []).find((m) => m.role === 'user');
  const seed = (sys.slice(0, 400)) + '\u0000' + contentText(firstUser && firstUser.content).slice(0, 2000);
  return crypto.createHash('sha1').update(seed).digest('hex').slice(0, 20);
}

export function getSession(key) { return state.sessions[key] || null; }

export function setSession(key, data) {
  state.sessions[key] = { ...(state.sessions[key] || {}), ...data, lastAt: Date.now() };
  const keys = Object.keys(state.sessions);
  if (keys.length > MAX_SESSIONS) {
    keys.sort((a, b) => (state.sessions[a].lastAt || 0) - (state.sessions[b].lastAt || 0));
    for (const k of keys.slice(0, keys.length - MAX_SESSIONS)) delete state.sessions[k];
  }
  saveSoon();
  return state.sessions[key];
}

export function recordToolUse(toolUseId, info) {
  state.tools[toolUseId] = { ...info, at: Date.now() };
  const keys = Object.keys(state.tools);
  if (keys.length > MAX_TOOLS) {
    keys.sort((a, b) => (state.tools[a].at || 0) - (state.tools[b].at || 0));
    for (const k of keys.slice(0, keys.length - MAX_TOOLS)) delete state.tools[k];
  }
  saveSoon();
}

export function getToolUse(toolUseId) { return state.tools[toolUseId] || null; }

const gkey = (conversationId, groupId) => `${conversationId || '_'}::${groupId || '_'}`;

/** Cat TOOL_RESPONSE cua tool bi drop de gop cung group o luot sau. */
export function addPending(conversationId, groupId, resp) {
  const k = gkey(conversationId, groupId);
  (state.pending[k] = state.pending[k] || []).push(resp);
  saveSoon();
}

/** Lay & xoa cac pending cua mot group. */
export function takePending(conversationId, groupId) {
  const k = gkey(conversationId, groupId);
  const arr = state.pending[k] || [];
  delete state.pending[k];
  if (arr.length) saveSoon();
  return arr;
}

export function sessionsFile() { return FILE; }
export { contentText };
