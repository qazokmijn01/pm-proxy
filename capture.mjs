/**
 * WIRE CAPTURE — ghi lại dữ kiện thật để CHẨN ĐOÁN (APPROACH.md §3: "không đoán — chụp thật").
 * Mỗi dòng 1 JSON: chiều 'in' (Claude Code → proxy), 'gw_tool' (tool thô gateway phát),
 * 'emit'/'drop' (kết quả dịch), 'gw_error'/'stream_error', 'tool_result_in'.
 * File: %USERPROFILE%\.postman-agent-cli\.claude-proxy-capture.jsonl
 */
import fs from 'node:fs';
import path from 'node:path';
import { CACHE_DIR } from '../core.mjs';

const FILE = path.join(CACHE_DIR, '.claude-proxy-capture.jsonl');
const ON = process.env.PM_CAPTURE !== '0'; // bật mặc định; tắt bằng PM_CAPTURE=0

export function cap(obj) {
  if (!ON) return;
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.appendFileSync(FILE, JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n'); } catch {}
}
export function capReset() { try { fs.writeFileSync(FILE, ''); } catch {} }
// Ghi đè 1 file JSON đẹp (chỉ giữ bản mới nhất) để soi cấu trúc thô.
export function capFull(name, obj) {
  if (!ON) return;
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(path.join(CACHE_DIR, name), JSON.stringify(obj, null, 2)); } catch {}
}
export function capPath() { return FILE; }
export function capRead() { try { return fs.readFileSync(FILE, 'utf8'); } catch { return ''; } }
