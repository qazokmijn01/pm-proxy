# pm-ai-proxy

Server **tương thích Anthropic Messages API**, bắc cầu từ Claude Code CLI / Claude Agent SDK sang **Postman Agent Mode gateway**. Client tưởng đang nói chuyện với `api.anthropic.com`, thực chất proxy dịch qua lại với Postman và dùng credit của Postman làm model.

**Tool built-in KHÔNG chạy trên proxy.** Chính client (Claude Code / Agent SDK) chạy `Bash`, `Read`, `Write`, `Edit`… trên máy của nó. Proxy chỉ dịch tên + tham số tool giữa Postman native ⇄ Claude Code, và dịch stream SSE Postman ⇄ Anthropic.

**Ngoại lệ: tool MCP.** Proxy tự làm **MCP host** — nó khai báo tool của các MCP server đã cấu hình lên gateway, rồi **tự chạy** những tool tên `mcp__*` và trả kết quả về vòng lặp tool bình thường. Xem mục 6.

```
Claude Code CLI / Agent SDK          pm-ai-proxy              Postman gateway
  ANTHROPIC_BASE_URL ───────────►  /v1/messages  ──────────►  /chat  (SSE)
       ◄─── SSE Anthropic ───────  dịch 2 chiều   ◄───────────  SSE Postman
       (tool built-in chạy ĐÂY)          │
                                         ├─► MCP server (stdio: npx …)
                                         └─► MCP server (http: /mcp)
                                          (tool mcp__* chạy TẠI PROXY)
```

---

## 1. Yêu cầu

| Thành phần | Ghi chú |
|---|---|
| **Node.js** | LTS. `start-proxy.bat` tự cài qua `winget` nếu chưa có. |
| **Postman Desktop** | Phải **đang mở + đã đăng nhập** để harvest token/template. |
| **Claude Code** | Client. Cần **≥ v2.1.227** nếu muốn dùng `ANTHROPIC_CUSTOM_HEADERS`. |

Cài dependency (chỉ `puppeteer-core`, dùng cho harvest) — chạy tại thư mục repo:

```bat
cd C:\Users\Win10\Desktop\Workspace\pm-proxy
npm install
```

---

## 2. Khởi động nhanh

### Cách A — một lệnh (khuyến nghị)

```bat
cd C:\Users\Win10\Desktop\Workspace\pm-proxy
start-proxy.bat
```

Script này tự động: kiểm tra/cài Node → **harvest** token + chat-template từ Postman Desktop (tối đa ~30s) → khởi động proxy trên cổng `8788`.

Bỏ qua bước harvest (dùng cache lần trước):

```bat
start-proxy.bat noharvest
```

### Cách B — thủ công

```bat
cd C:\Users\Win10\Desktop\Workspace\pm-proxy
node harvest.mjs --timeout=30
node claude-proxy.mjs
```

hoặc qua npm script:

```bat
npm start
```

### Kiểm tra proxy đã sống

```bat
curl http://127.0.0.1:8788/health
```

Kết quả mong đợi — cả `token` và `template` phải là `true`:

```json
{"ok":true,"service":"pm-ai-proxy","gateway":"https://gateway.postman.com","token":true,"template":true}
```

---

## 3. Restart

```bat
restart-proxy.bat            :: tự kill tiến trình đang giữ cổng, bật DEBUG_PROXY
restart-proxy.bat nodebug    :: tắt log debug
```

> **Lưu ý:** nếu proxy cũ được khởi động ở **quyền Administrator**, cửa sổ thường không kill được nó (`Access is denied`). Hãy mở `restart-proxy.bat` **bằng quyền Administrator** (chuột phải → Run as administrator).

---

## 4. Trỏ client vào proxy

### Cách A — dùng sẵn `claude-pm.bat`

```bat
cd C:\du-an-cua-ban
C:\Users\Win10\Desktop\Workspace\pm-proxy\claude-pm.bat
```

File này set sẵn:

```bat
set ANTHROPIC_BASE_URL=http://127.0.0.1:8788
set ANTHROPIC_API_KEY=pm-proxy
set ANTHROPIC_CUSTOM_HEADERS=x-pm-working-dir: %CD%
claude %*
```

### Cách B — set tay

```bat
set ANTHROPIC_BASE_URL=http://127.0.0.1:8788
set ANTHROPIC_API_KEY=pm-proxy
set ANTHROPIC_CUSTOM_HEADERS=x-pm-working-dir: %CD%
claude
```

PowerShell:

```powershell
$env:ANTHROPIC_BASE_URL = 'http://127.0.0.1:8788'
$env:ANTHROPIC_API_KEY  = 'pm-proxy'
$env:ANTHROPIC_CUSTOM_HEADERS = "x-pm-working-dir: $($PWD.Path)"
claude
```

`ANTHROPIC_API_KEY` là giá trị bất kỳ — proxy bỏ qua, nó dùng token Postman đã harvest.

---

## 5. Thư mục làm việc (cwd) & bộ nhớ phiên

Postman gateway cần biết thư mục dự án (`FILE_VIEWER_FOLDER`). Proxy tìm theo thứ tự:

| # | Nguồn | Ghi chú |
|---|---|---|
| 1 | Header `x-pm-working-dir` (hoặc `x-working-directory`) | **Ưu tiên cao nhất.** Chuẩn hoá: mảng → phần tử đầu, trim, bỏ nháy; chuỗi rỗng bị bỏ qua. |
| 2 | Dòng `Working directory:` trong system prompt | Claude Code CLI gửi trong khối `<env>`. **Agent SDK (`cc_entrypoint=sdk-ts`) KHÔNG có dòng này.** |
| 3 | **Cache cwd của phiên** | Đã học ở lượt trước, lưu theo `sessionKey` trong `.claude-sessions.json` (nguồn hiện là `probe-cache`). |
| 4 | **Probe** — proxy tự hỏi client | Phát một `tool_use` (`PowerShell` → `$PWD.Path`, hoặc `Bash` → `pwd -W 2>/dev/null \|\| pwd`), client chạy trên máy nó rồi trả kết quả. |

Về probe:

- Chỉ chạy **một lần mỗi phiên**, kể cả khi thất bại → không thể lặp vô hạn.
- Lượt probe **không gọi gateway**, không tốn credit.
- Tự chuẩn hoá `/c/Users/x` và `C:/Users/x` → `C:\Users\x`.
- Tắt bằng `PM_CWD_PROBE=0`.
- Nếu đã gửi header ở bước 1 thì probe bị bỏ qua hoàn toàn (không tốn round-trip).
- Câu hỏi gốc được cất tạm trong phiên (`probeQuery`) và **phát lại nguyên văn** ngay sau khi biết cwd — không phải hỏi lại.
- Client không khai `Bash` lẫn `PowerShell` → proxy đánh dấu đã probe và không thử nữa.

### Bộ nhớ phiên (`.claude-sessions.json`)

Anthropic API là **stateless** (client gửi lại toàn bộ lịch sử mỗi lượt), còn Postman `/chat` là **stateful** (giữ `conversationId`). Proxy bắc cầu bằng một *session store*:

| Khoá | Nội dung | Dùng để |
|---|---|---|
| `sessionKey` | hash(system + user message đầu tiên) | Tìm lại đúng `conversationId` cho các lượt sau. |
| `cwd` | Thư mục đã học qua probe | Không phải probe lại ở lượt sau (`probe-cache`). |
| `cwdProbed` / `probeQuery` | Đã probe chưa + câu hỏi đang cất | Chặn probe lặp, phát lại câu hỏi gốc. |
| `tools` | `tool_use_id` → conversation/group/tên native | Ghép `tool_result` về đúng group của gateway. |
| `pending` | TOOL_RESPONSE của tool bị drop | Gộp chung một group khi client trả kết quả. |

Giữ tối đa 300 phiên và 2000 tool gần nhất. **Reset**: đóng proxy rồi xoá `%USERPROFILE%\.postman-agent-cli\.claude-sessions.json` — phiên sau sẽ probe lại cwd từ đầu.

Nếu cả 4 nguồn đều trống, proxy dùng folder mặc định nằm trong chat-template đã harvest — **có thể là thư mục của máy khác**, dẫn tới việc model khai sai thư mục dự án.

---

## 6. MCP — proxy làm MCP host

Postman agent-mode coi tool MCP là **client tool**: gateway chỉ *gọi tên*, ai đó phải chạy thật. Proxy đảm nhận vai trò đó — nó kết nối tới các MCP server đã cấu hình, khai báo tool của chúng lên gateway, tự chạy khi model gọi, rồi trả kết quả qua vòng `TOOL_RESPONSE` như mọi tool khác.

```
model gọi mcp__fs__read_file  ──►  proxy (mcp.mjs)  ──►  MCP server (stdio/http)
     ◄── TOOL_RESPONSE (nội dung) ──┘
```

### 6.1 Cấu hình

File: `%USERPROFILE%\.postman-agent-cli\mcp.json`

```json
{
  "advertise": false,
  "servers": {
    "fs":     { "type": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."], "env": {}, "cwd": "." },
    "remote": { "type": "http",  "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ..." } }
  }
}
```

| Trường | Ý nghĩa |
|---|---|
| `type` | `stdio` (spawn tiến trình, JSON-RPC qua stdin/stdout) hoặc `http` (MCP streamable, tự giữ `Mcp-Session-Id`). |
| `advertise` | Chỉ ảnh hưởng **chế độ web UI** (`ui.mjs` của repo PostmanTool, không thuộc repo này). Với proxy Claude, việc khai báo do `PM_MCP_AUTOREGISTER` quyết định. |
| `servers.<tên>` | Tên server; tool sẽ lộ ra dưới dạng `mcp__<server>__<tool>`. |

Chưa có file? Tạo mẫu bằng UI web (`POST /api/mcp/init`) hoặc tự tạo tay theo mẫu trên.

**Tự động gộp cấu hình OpenClaw:** nếu `%USERPROFILE%\.openclaw\openclaw.json` có `mcp.servers`, proxy tự nạp thêm (server trùng tên thì `mcp.json` thắng). Nghĩa là `openclaw mcp add <tên> …` là dùng được ngay, không cần khai lại.

### 6.2 Auto-register (bật sẵn)

Mỗi lượt, proxy `tools/list` toàn bộ server rồi nhét vào `clientTools.thirdParty` của payload `/chat`, nhóm theo tên server, để gateway quảng bá cho model.

- Danh sách tool được **cache ~5 phút** (`PM_MCP_WARM_TTL_MS`), hâm nóng nền — lượt đầu không bị chặn chờ.
- Server lỗi/không kết nối được thì bị bỏ qua, các server còn lại vẫn chạy.
- Tắt hẳn: `set PM_MCP_AUTOREGISTER=0`.

### 6.3 Thực thi

Khi gateway phát tool tên `mcp__*`, proxy **không** chuyển cho client mà tự gọi `tools/call`, gói kết quả text vào TOOL_RESPONSE (`SUCCESS` / `ERROR`), và ghi capture `{"dir":"mcp_exec"}`.

- Timeout mỗi RPC: 30s. Kết nối được giữ sống và tái dùng giữa các lượt.
- **chrome-devtools**: nếu tool báo không nối được Chrome, proxy tự chạy `openclaw browser start` một lần rồi thử lại.
- Lỗi trả về cho model dưới dạng `[mcp error] …` để model tự xử lý, không làm hỏng lượt.

### 6.4 Kiểm tra nhanh

```bat
node -e "import('./mcp.mjs').then(async m=>{const r=await m.listMcpTools();console.log(r.tools.map(t=>t.name));console.log('errors:',r.errors)})"
```

Bật `DEBUG_PROXY=1` sẽ thấy dòng `[pm-proxy:dbg] mcp thirdParty warmed: fs,chrome-devtools` (hoặc `(none)` khi chưa cấu hình server nào).

---

## 7. Biến môi trường

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PM_ANTHROPIC_PORT` | `8788` | Cổng proxy lắng nghe. |
| `PM_ANTHROPIC_HOST` | `127.0.0.1` | Địa chỉ bind. |
| `PM_GATEWAY` | `https://gateway.postman.com` | Đổi để test với gateway giả. |
| `DEBUG_PROXY` | tắt | `=1` để in log từng lượt (model, cwd + nguồn, thinking). |
| `PM_CWD_PROBE` | bật | `=0` để tắt cơ chế probe cwd. |
| `PM_MCP_AUTOREGISTER` | bật | `=0` để ngừng khai báo tool MCP lên gateway. |
| `PM_MCP_WARM_TTL_MS` | `300000` | Thời gian cache danh sách tool MCP (ms). |
| `PM_CAPTURE` | bật | `=0` để ngừng ghi file capture. |
| `PM_MAX_ROUNDS` | `16` | Giới hạn số vòng tool mỗi lượt. |
| `PM_QUERY_CAP` | `8500` | Giới hạn ký tự query gửi lên gateway. |
| `PM_FORCE_MODEL` | — | Ép cứng model key phía Postman. |
| `PM_SHELL` | `powershell` (Windows) | Shell dùng khi map lệnh chạy. |
| `PM_APP_VERSION` | `12.22.6` | Header `x-app-version` fallback. |
| `PM_WORKSPACE_ID` | — | Ép workspace Postman. |

---

## 8. Endpoint

| Method | Đường dẫn | Công dụng |
|---|---|---|
| `GET` | `/health`, `/` | Trạng thái: có token / có template chưa. |
| `GET` | `/v1/models` | Danh sách model (map từ Postman). |
| `POST` | `/v1/messages` | Endpoint chính, tương thích Anthropic. |
| `POST` | `/v1/messages/count_tokens` | Đếm token. |

---

## 9. Chẩn đoán

### Log debug trực tiếp

Chạy `restart-proxy.bat` (DEBUG bật sẵn), mỗi lượt sẽ in:

```
[pm-proxy:dbg] mcp thirdParty warmed: fs,chrome-devtools
[pm-proxy:dbg] turn user_query · key 25f5… · model claude-3-5-sonnet → … · cwd C:\du-an (header) · thinking OFF
[pm-proxy:dbg] cwd probe → hoi client qua PowerShell
[pm-proxy:dbg] cwd probe → C:\du-an
```

Phần trong ngoặc sau `cwd` cho biết **nguồn**: `header`, `system`, `probe`, `probe-cache`, hoặc `(template)` nghĩa là đang dùng folder mặc định của template.

### File capture

Nằm tại `%USERPROFILE%\.postman-agent-cli\`:

| File | Nội dung |
|---|---|
| `.claude-proxy-capture.jsonl` | Mỗi dòng 1 JSON: chiều `in`, `emit`, `drop`, `gw_tool`, `cwd_probe_out`, `cwd_probe_result`, `mcp_exec`… |
| `claude-proxy-lastreq.json` | Request Anthropic gần nhất (system, messages, tools). |
| `claude-proxy-tools.json` | Nguyên văn `tools[]` client khai báo. |
| `.claude-sessions.json` | Map phiên → conversationId, cwd đã học, tool_use_id, pending (mục 5). |
| `mcp.json` | Cấu hình MCP server (mục 6). |
| `token` | Token Postman đã harvest. |

### Chạy test

```bat
node selftest.mjs      :: hoặc: npm start:test
node nova-verify.mjs
```

---

## 10. Sự cố thường gặp

| Triệu chứng | Nguyên nhân & cách xử lý |
|---|---|
| `EADDRINUSE ... :8788` | Proxy đã chạy sẵn. Không cần chạy lại, hoặc đổi cổng: `set PM_ANTHROPIC_PORT=9000`. |
| HTTP **401** "Chưa có Postman token" | Chưa harvest. Mở Postman Desktop rồi chạy `node harvest.mjs`. |
| HTTP **503** "Chưa có chat template" | Chat thử 1 câu trong Postman Agent Mode rồi harvest lại. |
| `taskkill` báo `Access is denied` | Proxy đang chạy quyền admin → mở `restart-proxy.bat` bằng Run as administrator. |
| Model khai **sai thư mục dự án** | cwd không tới được proxy. Xem mục 5: gửi header `x-pm-working-dir`, hoặc để probe tự hỏi. |
| Model **không thấy tool MCP** | Kiểm tra `mcp.json` (hoặc `openclaw.json`) có `servers`; xem log `mcp thirdParty warmed`. Danh sách cache 5 phút — đổi config thì khởi động lại proxy. |
| Tool MCP trả `[mcp error] …` | Server MCP không khởi động được: soi `command`/`args`/`url`. Chạy lệnh ở mục 6.4 để xem `errors[]`. |
| `chrome-devtools` báo không nối được Chrome | Proxy tự thử `openclaw browser start`; vẫn lỗi thì chạy tay lệnh đó rồi hỏi lại. |
| Model dùng **cwd cũ** sau khi đổi thư mục | Phiên đã cache cwd. Mở hội thoại mới, hoặc xoá `.claude-sessions.json` (mục 5). |
| Harvest thất bại | Postman Desktop chưa mở / chưa đăng nhập. Thử `node harvest.mjs --watch`. |

---

## 11. Cấu trúc thư mục

```
pm-proxy/
├── claude-proxy.mjs          launcher gọn (startServer)
├── server.mjs                HTTP server + vòng đời một lượt (cwd, probe, MCP, gateway)
├── harvest.mjs               lấy token + chat-template từ Postman Desktop
├── core.mjs                  token/template, buildBody, listModels, GATEWAY
├── session.mjs               applySession: workspace + FILE_VIEWER_FOLDER
├── tools.mjs                 runTool/summarizeTool (bash, file, MCP passthrough)
├── mcp.mjs                   MCP host: kết nối stdio/http, tools/list, tools/call
├── map.mjs                   map tool Postman ⇄ Claude Code, map model
├── translate.mjs             phân tích request Anthropic, gom tool_result
├── sse.mjs                   phát SSE đúng chuẩn Anthropic
├── sessions.mjs              lưu phiên, cwd đã học, tool_use_id, pending
├── capture.mjs               ghi log chẩn đoán
├── selftest.mjs              39 test
├── nova-verify.mjs           5 test mapping
├── package.json              type: module + puppeteer-core
├── start-proxy.bat           harvest + khởi động
├── restart-proxy.bat         kill cổng + khởi động lại (DEBUG)
├── claude-pm.bat             chạy Claude Code trỏ vào proxy
└── .chat-template.json       template đã harvest (sinh ra, không commit)
```

Repo này **chạy độc lập** — không cần thư mục `PostmanTool`. Lần đầu clone về máy mới:
`npm install` (cài `puppeteer-core`), rồi `start-proxy.bat`.

Tài liệu liên quan: `docs/claude-cli-anthropic.md`, `docs/tool-mapping.md`, `docs/APPROACH.md`.
