#!/usr/bin/env node
/**
 * WINDOWS TOKEN + CHAT-TEMPLATE HARVESTER
 *
 * Khac ban macOS (daemon.js dung --remote-debugging-pipe fd 3/4 - KHONG chay tren
 * Windows qua Node child_process). Tren Windows, Postman 12+ van BAT remote-debugging
 * nhung ep ve cong NGAU NHIEN (main.js: appendSwitch("remote-debugging-port","0")).
 * Ta:
 *   1. Tu do cong CDP ma tien trinh Postman DANG chay lang nghe (khong can mo lai app).
 *   2. Gan (puppeteer-core) vao renderer, inject hook wrap fetch/XHR.
 *   3. Bat x-access-token + template payload /chat -> luu ra:
 *        %USERPROFILE%\.postman-agent-cli\token
 *        .chat-template.json
 *
 * Dung:  node src/harvest.mjs [--port=NNNN] [--timeout=90] [--watch]
 *   --watch : chay nen, token doi thi cap nhat cache (Postman refresh token dinh ky)
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

const mask = (t) => (t ? t.slice(0, 8) + '...(' + t.length + ' ky tu)' : '(none)');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Chi chap nhan template /chat THAT SU dung duoc: phai co clientTools.nativeToolsHash.
// Postman con ban cac request /chat khac (vd chatType=CANCEL_QUERY khi huy 1 luot chat)
// chi gom vai truong; ghi de cache bang chung se lam proxy mat toan bo toolset.
const isUsableTemplate = (c) => {
  const b = c && c.body;
  if (!b || !b.input || b.input.chatType === 'CANCEL_QUERY') return false;
  return !!(b.clientTools && b.clientTools.nativeToolsHash);
};

// Hook wrap fetch/XHR - copy y nguyen y tuong TOKEN_HOOK trong daemon.js ban Mac.
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
            // Chi giu request /chat THAT SU dung lam template. Postman con ban
            // CANCEL_QUERY (va cac loai khac) khong co clientTools; neu ghi de o day
            // thi ban tot da bat duoc se mat TRUOC KHI phia Node kip doc (poll 1500ms).
            const ok = body && body.input && body.input.chatType !== 'CANCEL_QUERY'
                    && body.clientTools && body.clientTools.nativeToolsHash;
            if (ok) window.__PM_CHAT_CAPTURE__ = { at: new Date().toISOString(), headers: hdrs, body: body };
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

/** Liet ke PID cua Postman dang chay. */
function postmanPids() {
  try {
    const out = execSync('powershell -NoProfile -Command "(Get-Process Postman -ErrorAction SilentlyContinue).Id -join \',\'"').toString().trim();
    return out ? out.split(',').map((s) => parseInt(s, 10)).filter(Boolean) : [];
  } catch (e) { return []; }
}

/** Cac cong 127.0.0.1 ma tien trinh Postman dang lang nghe (ung vien cong CDP). */
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

/** Doc cong tu file DevToolsActivePort (co the stale - chi dung lam ung vien). */
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
  console.log('[search] Dang do cong CDP cua Postman dang chay...');
  const port = await detectPort();
  if (!port) {
    console.error('[X] Khong tim thay cong CDP. Hay chac chan Postman dang mo, roi chay lai.');
    console.error('   (Neu van loi, thu: node src/harvest.mjs --port=<cong> - xem trong log khoi dong Postman "DevTools listening on ws://127.0.0.1:PORT").');
    process.exit(1);
  }
  console.log(`[OK] Cong CDP: ${port}`);

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
  console.log(`[hook] Da gan hook vao ${injected} renderer. Dang cho app gui request mang token...`);
  console.log('   (Neu cho lau: click vai thu trong Postman. De bat TEMPLATE chat, hay chat 1 cau bat ky trong app Postman.)');

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
      console.log(`[key] Da bat & luu access token: ${mask(token)} -> ${TOKEN_CACHE}`);
    }
    if (capture && !savedTemplate && isUsableTemplate(capture)) {
      fs.writeFileSync(TEMPLATE_FILE, JSON.stringify(capture, null, 2));
      savedTemplate = true;
      const ct = capture.body.input && capture.body.input.chatType;
      console.log(`[pkg] Da chup template /chat (chatType=${ct}) -> ${TEMPLATE_FILE}`);
    }
    if (!WATCH && savedToken) {
      if (savedTemplate) { console.log('[done] Du token + template. Xong.'); break; }
      if (Date.now() - t0 > 8000) { console.log('[i]  Da co token. Chua thay template chat (can chat 1 cau trong app). Van co the test cau hoi text.'); break; }
    }
    if (Date.now() - t0 > TIMEOUT_S * 1000) {
      if (!savedToken) console.error(`[X] Het ${TIMEOUT_S}s chua bat duoc token. Thu tuong tac trong Postman roi chay lai.`);
      break;
    }
    await sleep(1500);
  }

  browser.disconnect();
  process.exit(savedToken ? 0 : 2);
}

main().catch((e) => { console.error('[err] Loi:', e.message); process.exit(1); });
