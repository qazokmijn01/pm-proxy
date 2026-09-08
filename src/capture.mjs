/**
 * WIRE CAPTURE - ghi lai du kien that de CHAN DOAN (APPROACH.md #3: "khong doan - chup that").
 * Moi dong 1 JSON: chieu 'in' (Claude Code -> proxy), 'gw_tool' (tool tho gateway phat),
 * 'emit'/'drop' (ket qua dich), 'gw_error'/'stream_error', 'tool_result_in'.
 * File: %USERPROFILE%\.postman-agent-cli\.claude-proxy-capture.jsonl
 */
import fs from 'node:fs';
import path from 'node:path';
import { CACHE_DIR } from './core.mjs';

const FILE = path.join(CACHE_DIR, '.claude-proxy-capture.jsonl');
const ON = process.env.PM_CAPTURE !== '0'; // bat mac dinh; tat bang PM_CAPTURE=0

export function cap(obj) {
  if (!ON) return;
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.appendFileSync(FILE, JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n'); } catch {}
}
export function capReset() { try { fs.writeFileSync(FILE, ''); } catch {} }
// Ghi de 1 file JSON dep (chi giu ban moi nhat) de soi cau truc tho.
export function capFull(name, obj) {
  if (!ON) return;
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(path.join(CACHE_DIR, name), JSON.stringify(obj, null, 2)); } catch {}
}
export function capPath() { return FILE; }
export function capRead() { try { return fs.readFileSync(FILE, 'utf8'); } catch { return ''; } }
