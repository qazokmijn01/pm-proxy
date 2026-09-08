#!/usr/bin/env node
/**
 * WINDOWS TOKEN + CHAT-TEMPLATE HARVESTER
 *
 * Khác bản macOS (daemon.js dùng --remote-debugging-pipe fd 3/4 — KHÔNG chạy trên
 * Windows qua Node child_process). Trên Windows, Postman 12+ vẫn BẬT remote-debugging
 * nhưng ép về cổng NGẪU NHIÊN (main.js: appendSwitch("remote-debugging-port","0")).
 * Ta:
 *   1. Tự dò cổng CDP mà tiến trình Postman ĐANG chạy lắng nghe (không cần mở lại app).
 *   2. Gắn (puppeteer-core) vào renderer, inject hook wrap fetch/XHR.
 *   3. Bắt x-access-token + template payload /chat → lưu ra:
 *        %USERPROFILE%\.postman-agent-cli\token
 *        .chat-template.json
 *
 * Dùng:  node harvest.mjs [--port=NNNN] [--timeout=90] [--watch]
 *   --watch : chạy nền, token đổi thì cập nhật cache (Postman refresh token định kỳ)
 */
import puppeteer from 'puppeteer-core';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argOf = (n, d) => { const a = args.find((x) => x.startsWith(n + '=')); return a ? a.slice(n.length + 1) : d; };
const HAS = (n) => args.includes(n);
const FORCE_PORT = argOf('--port', null);
const TIMEOUT_S = parseInt(argOf('--timeout', '90'), 10);
const WATCH = HAS('--watch');

const CACHE_DIR = path.join(os.homedir(), '.postman-agent-cli');
const TOKEN_CACHE = path.join(CACHE_DIR, 'token');
const TEMPLATE_FILE = path.join(__dirname, '.chat-template.json');

const mask = (t) => (t ? t.slice(0, 8) + '…(' + t.length + ' ký tự)' : '(none)');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hook wrap fetch/XHR — copy y nguyên ý tưởng TOKEN_HOOK trong daemon.js bản Mac.
const HOOK = `(function(){
  if (window.__PM_HOOKED__) return 'already';
  window.__PM_HOOKED__ = true;
  window.__PM_TOKEN__ = window.__PM_TOKEN__ || null;
  window.__PM_CHAT_CAPTURE__ = window.__PM_CHAT_CAPTURE__ || null;
  try { const of = window.fetch;
    window.fetch = function(input, init){
      try {
        const h = new Headers((init && init.headers) || (input && input.headers) || {});
        const t = h.get('x-access-token'); if (t) window.__PM_TOKEN__ = t;
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (/\\/chat(\\?|$)/.test(url) && init && init.body && String(init.body).includes('"chatType"')) {
          try {
            const body = JSON.parse(init.body);
            const hdrs = {}; h.forEach((v,k)=>{hdrs[k]=v;});
            delete hdrs['x-access-token']; delete hdrs['authorization'];
            window.__PM_CHAT_CAPTURE__ = { at: new Date().toISOString(), headers: hdrs, body: body };
          } catch(e){}
        }
      } catch(e){}
      return of.apply(this, arguments);
    };
  } catch(e){}
  try { const ox = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function(k,v){
      if (/^x-access-token$/i.test(k)) window.__PM_TOKEN__ = v;
      return ox.apply(this, arguments);
    };
  } catch(e){}
  return 'hooked';
})()`;

/** Liệt kê PID của Postman đang chạy. */
function postmanPids() {
  try {
    const out = execSync('powershell -NoProfile -Command "(Get-Process Postman -ErrorAction SilentlyContinue).Id -join \',\'"').toString().trim();
    return out ? out.split(',').map((s) => parseInt(s, 10)).filter(Boolean) : [];
  } catch (e) { return []; }
}

/** Các cổng 127.0.0.1 mà tiến trình Postman đang lắng nghe (ứng viên cổng CDP). */
function postmanListeningPorts() {
  const pids = postmanPids();
  if (!pids.length) return [];
  const filter = pids.join(',');
  try {
    const ps = `$pids=@(${filter}); Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $pids -contains $_.OwningProcess -and ($_.LocalAddress -eq '127.0.0.1' -or $_.LocalAddress -eq '0.0.0.0') } | ForEach-Object { $_.LocalPort }`;
    const out = execSync(`powershell -NoProfile -Command "${ps}"`).toString().trim();
    return [...new Set(out.split(/\s+/).map((s) => parseInt(s, 10)).filter(Boolean))];
  } catch (e) { return []; }
}

/** Đọc cổng từ file DevToolsActivePort (có thể stale — chỉ dùng làm ứng viên). */
function devToolsActivePortCandidates() {
  const out = [];
  for (const base of [process.env.APPDATA, process.env.LOCALAPPDATA]) {
    if (!base) continue;
    const f = path.join(base, 'Postman', 'DevToolsActivePort');
    try { const p = parseInt(fs.readFileSync(f, 'utf8').split('\n')[0].trim(), 10); if (p) out.push(p); } catch (e) {}
  }
  return out;
}

async function isPostmanCdp(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return false;
    const j = await r.json();
    return /Postman|Electron/i.test((j['User-Agent'] || '') + (j.Browser || ''));
  } catch (e) { return false; }
}

async function detectPort() {
  if (FORCE_PORT) return parseInt(FORCE_PORT, 10);
  const candidates = [...postmanListeningPorts(), ...devToolsActivePortCandidates()];
  for (const p of candidates) { if (await isPostmanCdp(p)) return p; }
  return null;
}

function saveToken(t) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_CACHE, t, { mode: 0o600 });
}

async function main() {
  console.log('🔎 Đang dò cổng CDP của Postman đang chạy…');
  const port = await detectPort();
  if (!port) {
    console.error('❌ Không tìm thấy cổng CDP. Hãy chắc chắn Postman đang mở, rồi chạy lại.');
    console.error('   (Nếu vẫn lỗi, thử: node harvest.mjs --port=<cổng> — xem trong log khởi động Postman "DevTools listening on ws://127.0.0.1:PORT").');
    process.exit(1);
  }
  console.log(`✅ Cổng CDP: ${port}`);

  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null, protocolTimeout: 60000 });

  async function injectAll() {
    const pages = await browser.pages();
    let n = 0;
    for (const p of pages) {
      try {
        await p.evaluate(HOOK);
        try { await p.evaluateOnNewDocument(HOOK); } catch (e) {}
        n++;
      } catch (e) {}
    }
    return n;
  }
  const injected = await injectAll();
  console.log(`🪝 Đã gắn hook vào ${injected} renderer. Đang chờ app gửi request mang token…`);
  console.log('   (Nếu chờ lâu: click vài thứ trong Postman. Để bắt TEMPLATE chat, hãy chat 1 câu bất kỳ trong app Postman.)');

  const t0 = Date.now();
  let savedToken = null;
  let savedTemplate = false;
  for (;;) {
    let token = null, capture = null;
    const pages = await browser.pages();
    for (const p of pages) {
      try {
        const r = await p.evaluate(() => ({ t: window.__PM_TOKEN__ || null, c: window.__PM_CHAT_CAPTURE__ || null }));
        if (r.t) token = r.t;
        if (r.c && r.c.body) capture = r.c;
      } catch (e) {}
    }
    if (token && token !== savedToken) {
      savedToken = token; saveToken(token);
      console.log(`🔑 Đã bắt & lưu access token: ${mask(token)} → ${TOKEN_CACHE}`);
    }
    if (capture && !savedTemplate) {
      fs.writeFileSync(TEMPLATE_FILE, JSON.stringify(capture, null, 2));
      savedTemplate = true;
      const ct = capture.body.input && capture.body.input.chatType;
      console.log(`📦 Đã chụp template /chat (chatType=${ct}) → ${TEMPLATE_FILE}`);
    }
    if (!WATCH && savedToken) {
      if (savedTemplate) { console.log('🎉 Đủ token + template. Xong.'); break; }
      if (Date.now() - t0 > 8000) { console.log('ℹ️  Đã có token. Chưa thấy template chat (cần chat 1 câu trong app). Vẫn có thể test câu hỏi text.'); break; }
    }
    if (Date.now() - t0 > TIMEOUT_S * 1000) {
      if (!savedToken) console.error(`❌ Hết ${TIMEOUT_S}s chưa bắt được token. Thử tương tác trong Postman rồi chạy lại.`);
      break;
    }
    await sleep(1500);
  }

  browser.disconnect();
  process.exit(savedToken ? 0 : 2);
}

main().catch((e) => { console.error('💥 Lỗi:', e.message); process.exit(1); });
