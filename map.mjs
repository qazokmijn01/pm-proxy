/**
 * TOOL + MODEL MAPPING — Postman native  ⇄  Claude Code (Anthropic wire).
 *
 * SSoT của code cho tầng dịch tool. Tài liệu đối chiếu: docs/tool-mapping.md.
 * Ràng buộc gốc (tool-mapping.md §1): tool call trên wire LUÔN mang tên native của
 * Postman; proxy chỉ đổi tên + đổi tham số sang tên của Claude Code. Card chỉ "gợi ý",
 * KHÔNG cấp tool mới — nên card quảng cáo TÊN NATIVE, và mô tả môi trường ở thể khẳng
 * định, không đối đầu danh tính (tool-mapping.md §4).
 *
 * Ở "phương pháp Anthropic": CHÍNH Claude Code CLI chạy tool (Bash/Read/Write/Edit…),
 * proxy không chạy tool. Vì vậy module này chỉ DỊCH, không thực thi.
 */

export const QUERY_CAP = Number(process.env.PM_QUERY_CAP || 8500); // tool-mapping.md §7

// ---------------------------------------------------------------------------
// pickArg — chuẩn hoá khoá (lowercase, bỏ ký tự không phải chữ/số) rồi mới tra alias.
// filePath / file_path / File-Path → cùng một khoá. Schema native chưa được công bố,
// nên phòng thủ theo *vai trò* thay vì liệt kê tay từng biến thể (tool-mapping.md §3).
// ---------------------------------------------------------------------------
const norm = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
export function pickArg(args, ...aliases) {
  if (!args || typeof args !== 'object') return undefined;
  const table = {};
  for (const k of Object.keys(args)) table[norm(k)] = args[k];
  for (const a of aliases) {
    const v = table[norm(a)];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

// Bọc chuỗi cho shell (single-quote an toàn cho POSIX; Claude Code Bash chạy qua shell).
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// ---------------------------------------------------------------------------
// Bảng map: Postman native  →  Claude Code. (docs/tool-mapping.md §5)
// Mỗi entry trả { name, input }.  Trả null nghĩa là "drop" (xử lý ở mapPostmanToolToClaude).
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// CLIENT-AWARE tool-name adaptation. The gateway emits Claude-Code names; each
// client may declare different names for the same capability (openclaw uses
// exec/dir_list/dir_fetch/web_fetch/ask_user...). Pick the name the client
// actually declares and rebuild input where the target shape differs.
// ---------------------------------------------------------------------------
const CAP_EQUIV = {
  bash: ['Bash', 'exec', 'terminal', 'PowerShell', 'shell', 'sh'],
  glob: ['Glob'], // dir_fetch/dir_list là paired-node (remote), KHÔNG phải lister local → không map glob vào đó
  grep: ['Grep'],
  read: ['Read', 'read', 'read_file', 'file_read', 'cat'],
  write: ['Write', 'write', 'write_file', 'file_write', 'create_file'],
  edit: ['Edit', 'edit', 'apply_patch'],
  webfetch: ['WebFetch', 'web_fetch', 'fetch_url', 'file_fetch'],
  websearch: ['WebSearch', 'web_search'],
  askuserquestion: ['AskUserQuestion', 'ask_user', 'askuser'],
};
function adaptToClient(out, set) {
  if (!out || !out.name) return out;
  const has = (n) => !!(set && typeof set.has === 'function' && set.has(String(n).toLowerCase()));
  if (has(out.name)) return out;
  const nlc = String(out.name).toLowerCase();
  let cap = null;
  for (const k of Object.keys(CAP_EQUIV)) { if (k === nlc || CAP_EQUIV[k].some((x) => x.toLowerCase() === nlc)) { cap = k; break; } }
  if (!cap) return out;
  const target = CAP_EQUIV[cap].find((x) => has(x));
  const input = out.input || {};
  const anyShell = () => ['exec', 'terminal', 'Bash', 'PowerShell', 'shell', 'sh'].find(has);
  if (cap === 'bash') {
    const sh = target || anyShell();
    if (!sh) return out;
    const inp = { command: input.command };
    if (String(sh).toLowerCase() === 'bash' && input.description) inp.description = input.description;
    return { name: sh, input: inp };
  }
  if (cap === 'glob') {
    if (target && target.toLowerCase() === 'glob') return { name: target, input };
    // Không có Glob native local ⇒ rơi xuống shell. Sinh cú pháp đúng theo shell host (Win→PowerShell).
    const sh = anyShell();
    if (sh) {
      const nm = String(input.pattern || '').replace(/\*\*\//g, '').replace(/^\*+|\*+$/g, '');
      const base = String(input.path || '.');
      const isPwsh = /pwsh|powershell/i.test(String(process.env.PM_SHELL || (process.platform === 'win32' ? 'powershell' : 'posix')));
      const cmd = isPwsh
        ? (nm ? ('Get-ChildItem -Recurse -Force -ErrorAction SilentlyContinue -LiteralPath ' + shq(base) + ' -Filter ' + shq('*' + nm + '*') + ' | Select-Object -ExpandProperty FullName')
              : ('Get-ChildItem -Force -LiteralPath ' + shq(base) + ' | Select-Object -ExpandProperty FullName'))
        : (nm ? ('find ' + shq(base) + ' -iname ' + shq('*' + nm + '*')) : ('ls -la ' + shq(base)));
      return { name: sh, input: { command: cmd } };
    }
    return out;
  }
  if (cap === 'grep') {
    if (target) return { name: target, input };
    const sh = anyShell();
    if (sh) { let cmd = 'grep -rniE ' + shq(String(input.pattern || '')) + ' ' + shq(String(input.path || '.')); if (input.glob) cmd += ' --include=' + shq(String(input.glob)); return { name: sh, input: { command: cmd } }; }
    return out;
  }
  if (target) return { name: target, input };
  return out;
}
const TRANSLATORS = {
  executeShellCommand(a) {
    let command = pickArg(a, 'command', 'cmd', 'script');
    if (!command) return null;
    const projectPath = pickArg(a, 'projectPath', 'cwd', 'directory', 'path');
    const description = pickArg(a, 'explanation', 'description');
    // Claude Bash không nhận cwd → ghép cd (tool-mapping.md §3).
    // Dùng ';' thay '&&': hoạt động cho cả bash lẫn PowerShell (PS 5.1 không nhận '&&').
    if (projectPath) command = `cd ${shq(projectPath)}; ${command}`;
    const input = { command };
    if (description) input.description = String(description);
    return { name: 'Bash', input };
  },
  listDirectory(a) {
    const dir = pickArg(a, 'relativePath', 'path', 'directory') || '.';
    return { name: 'Bash', input: { command: `ls -la -- ${shq(dir)}`, description: `List ${dir}` } };
  },
  searchInFiles(a) { return TRANSLATORS.searchFiles(a); },
  searchFiles(a) {
    // Dùng tool NATIVE của Claude Code (Grep/Glob) thay vì `Bash rg`: Grep bọc ripgrep bundled
    // sẵn trong Claude Code, không phụ thuộc `rg` trên PATH và không đi qua hook shell (rtk).
    const pattern = pickArg(a, 'queryString', 'query', 'pattern', 'regex')
      || (Array.isArray(pickArg(a, 'queryPatterns')) ? pickArg(a, 'queryPatterns')[0] : undefined);
    const path = pickArg(a, 'path', 'relativePath', 'directory');
    const glob = Array.isArray(pickArg(a, 'fileNamePatterns')) ? pickArg(a, 'fileNamePatterns')[0] : pickArg(a, 'glob');
    if (pattern) {
      const input = { pattern: String(pattern), output_mode: 'content' };
      if (path) input.path = String(path);
      if (glob) input.glob = String(glob);
      return { name: 'Grep', input };
    }
    if (glob) return { name: 'Glob', input: { pattern: String(glob) } }; // chỉ tìm theo tên file
    return null; // thiếu cả pattern lẫn glob ⇒ drop
  },
  readFile(a) {
    const file_path = pickArg(a, 'filePath', 'path', 'file');
    if (!file_path) return null;
    const input = { file_path: String(file_path) };
    const offset = pickArg(a, 'offset'); if (offset != null) input.offset = Number(offset);
    const limit = pickArg(a, 'limit'); if (limit != null) input.limit = Number(limit);
    return { name: 'Read', input };
  },
  createFile(a) { return TRANSLATORS.writeFile(a); },
  writeFile(a) {
    const file_path = pickArg(a, 'filePath', 'path', 'file');
    if (!file_path) return null;
    const content = pickArg(a, 'content', 'text', 'body');
    return { name: 'Write', input: { file_path: String(file_path), content: content == null ? '' : String(content) } };
  },
  editFile(a) {
    const file_path = pickArg(a, 'filePath', 'path', 'file');
    const old_string = pickArg(a, 'oldString', 'old_string', 'old');
    const new_string = pickArg(a, 'newString', 'new_string', 'new');
    if (!file_path) return null;
    const input = { file_path: String(file_path), old_string: old_string == null ? '' : String(old_string), new_string: new_string == null ? '' : String(new_string) };
    const replaceAll = pickArg(a, 'replaceAll', 'replace_all');
    if (replaceAll != null) input.replace_all = !!replaceAll;
    return { name: 'Edit', input };
  },
  fetchUrl(a) {
    const url = pickArg(a, 'url', 'href', 'link');
    if (!url) return null;
    const prompt = pickArg(a, 'prompt', 'query', 'question') || 'Extract the relevant content from this page.';
    return { name: 'WebFetch', input: { url: String(url), prompt: String(prompt) } };
  },
  webSearch(a) {
    let query = pickArg(a, 'query', 'q');
    const queries = pickArg(a, 'queries');
    if (!query && Array.isArray(queries)) query = queries.join(' ');
    if (!query) query = pickArg(a, 'userProblem') || '';
    if (!query) return null;
    return { name: 'WebSearch', input: { query: String(query) } };
  },
  askUser(a) {
    // Postman phát 1 trong 2 shape:
    //   (cũ/số ít)  { question, options }
    //   (mới/số nhiều) { questions: [{ id, message, options, header?, ... }] }
    // options: string[] hoặc {label,value}[]. AskUserQuestion đòi questions[].options là
    // {label} và KHÔNG rỗng → tự chèn Yes/No khi thiếu.
    // AskUserQuestion (Claude Code) BẮT BUỘC: questions[].header là string, và MỌI
    // options[].description là string. Thiếu → InputValidationError "expected string but
    // provided unknown". Vì vậy LUÔN set cả hai (mặc định '') dù gateway không cung cấp.
    const toOptions = (rawOptions) => {
      let options = [];
      if (Array.isArray(rawOptions)) {
        options = rawOptions.map((o) => {
          if (o && typeof o === 'object') {
            const label = o.label != null ? o.label : (o.value != null ? o.value : o.title);
            if (label == null) return null;
            return { label: String(label), description: String(o.description != null ? o.description : '') };
          }
          return { label: String(o), description: '' };
        }).filter(Boolean);
      }
      if (!options.length) options = [{ label: 'Yes', description: '' }, { label: 'No', description: '' }];
      return options;
    };
    // AskUserQuestion: options mỗi câu phải 2..4 phần tử (minItems:2, maxItems:4). Gateway có thể
    // phát >4 → giữ 3 đầu + gộp phần dư vào 1 option "Lựa chọn khác…" (không mất thông tin, hợp lệ).
    // Thiếu (<2) → chèn thêm để đủ tối thiểu 2.
    const capOptions = (options) => {
      if (options.length > 4) {
        const kept = options.slice(0, 3);
        const restLabels = options.slice(3).map((o) => o.label);
        kept.push({ label: 'Lựa chọn khác…', description: ('Gồm: ' + restLabels.join(' | ')).slice(0, 500) });
        options = kept;
      }
      while (options.length < 2) options.push({ label: options.length ? 'Huỷ' : 'Yes', description: '' });
      return options;
    };
    const buildQ = (src) => {
      const question = pickArg(src, 'question', 'prompt', 'message', 'text');
      if (!question) return null;
      const rawHeader = pickArg(src, 'header', 'title', 'category');
      const header = String(rawHeader || question).trim().slice(0, 40) || 'Chọn';
      return { header, question: String(question), multiSelect: !!pickArg(src, 'multiSelect', 'multiselect'), options: capOptions(toOptions(pickArg(src, 'options', 'choices'))) };
    };

    // Shape số nhiều: { questions: [...] } — AskUserQuestion cho tối đa 4 câu hỏi.
    const rawQuestions = pickArg(a, 'questions');
    if (Array.isArray(rawQuestions) && rawQuestions.length) {
      const questions = rawQuestions.map(buildQ).filter(Boolean).slice(0, 4);
      if (questions.length) return { name: 'AskUserQuestion', input: { questions } };
    }

    // Shape số ít: { question, options }
    const q = buildQ(a);
    if (!q) return null;
    return { name: 'AskUserQuestion', input: { questions: [q] } };
  },
};

// Claude Code tool  →  các tên native Postman mà nó "phủ" được.
// Dùng để (a) lọc card, (b) tính excludedTools cho gateway.
// ---------------------------------------------------------------------------
// MCP filesystem/shell tools (names like "<server>__local__<action>", e.g.
// aki-mcp-sv__local__find_path). The Postman gateway can offer these when the
// workspace has local MCP servers configured; openclaw does not declare them,
// so without a translator they get DROPPED. They map cleanly onto the native
// Claude Code tools openclaw already has (Bash/Glob/Grep/Read/Write/Edit).
// ---------------------------------------------------------------------------
const MCP_TRANSLATORS = {
  run_cmd: (a) => TRANSLATORS.executeShellCommand(a),
  search_content: (a) => TRANSLATORS.searchFiles(a),
  read_text_file: (a) => TRANSLATORS.readFile(a),
  write_file: (a) => TRANSLATORS.writeFile(a),
  find_path: (a) => {
    const q = pickArg(a, 'query', 'pattern', 'glob', 'name');
    if (!q) return null;
    const p = pickArg(a, 'path', 'relativePath', 'directory');
    const qs = String(q);
    const hasGlob = qs.indexOf('*') >= 0 || qs.indexOf('?') >= 0 || qs.indexOf('[') >= 0;
    const input = { pattern: hasGlob ? qs : ('**/*' + qs + '*') };
    if (p) input.path = String(p);
    return { name: 'Glob', input };
  },
  create_directory: (a) => { const d = pickArg(a, 'path', 'dir', 'directory'); if (!d) return null; return { name: 'Bash', input: { command: 'mkdir -p ' + shq(d), description: 'mkdir ' + d } }; },
  move_file: (a) => { const src = pickArg(a, 'source', 'from', 'src'); const dst = pickArg(a, 'destination', 'to', 'dest'); if (!src || !dst) return null; return { name: 'Bash', input: { command: 'mv ' + shq(src) + ' ' + shq(dst), description: 'move' } }; },
  get_file_info: (a) => { const f = pickArg(a, 'path', 'file'); if (!f) return null; return { name: 'Bash', input: { command: 'stat ' + shq(f), description: 'stat ' + f } }; },
  list_allowed_directories: () => ({ name: 'Bash', input: { command: 'pwd', description: 'working directory (allowed root)' } }),
  postman_status: () => ({ name: 'Bash', input: { command: "try{Invoke-RestMethod 'http://localhost:8788/health' -TimeoutSec 3|ConvertTo-Json}catch{'proxy_not_running'}", description: 'pm-ai-proxy health check' } }),
  edit_file: (a) => {
    const f = pickArg(a, 'path', 'filePath', 'file');
    if (!f) return null;
    let oldT, newT;
    const edits = pickArg(a, 'edits');
    if (Array.isArray(edits) && edits.length) {
      const e0 = edits[0] || {};
      oldT = e0.oldText != null ? e0.oldText : (e0.old_string != null ? e0.old_string : e0.old);
      newT = e0.newText != null ? e0.newText : (e0.new_string != null ? e0.new_string : e0.new);
    } else {
      oldT = pickArg(a, 'oldString', 'old_string', 'oldText', 'old');
      newT = pickArg(a, 'newString', 'new_string', 'newText', 'new');
    }
    return { name: 'Edit', input: { file_path: String(f), old_string: oldT == null ? '' : String(oldT), new_string: newT == null ? '' : String(newT) } };
  },
};

// Recognise "<server>__local__<action>" (double-underscore segments) and route by action.
function mcpFsTranslate(nativeName, args) {
  if (typeof nativeName !== 'string' || nativeName.indexOf('__') < 0) return null;
  const action = nativeName.split('__').pop();
  const fn = MCP_TRANSLATORS[action];
  return fn ? fn(args || {}) : null;
}

export const CLAUDE_TO_NATIVES = {
  bash: ['executeShellCommand', 'listDirectory'],
  grep: ['searchFiles', 'searchInFiles'],
  glob: ['searchFiles', 'searchInFiles'],
  read: ['readFile'],
  write: ['createFile', 'writeFile'],
  edit: ['editFile'],
  multiedit: ['editFile'],
  webfetch: ['fetchUrl'],
  websearch: ['webSearch'],
  askuserquestion: ['askUser'],
};

// Mọi native Postman ta biết cách dịch (dùng để tính excludedTools).
export const MAPPABLE_NATIVES = [
  'executeShellCommand', 'listDirectory', 'searchFiles', 'searchInFiles',
  'readFile', 'createFile', 'writeFile', 'editFile', 'fetchUrl', 'webSearch', 'askUser',
];

// Native không bao giờ có đường về Claude Code → luôn loại khỏi gateway khi có thể
// (tool-mapping.md §5/§6). Nếu vẫn lọt, runtime sẽ tự trả TOOL_RESPONSE (xem server).
export const ALWAYS_EXCLUDE = [
  'navigateInApp', 'linkToLocalDirectory', 'todoWrite', 'recommendNextActions',
  'getTabDetails', 'searchPostman', 'learnAboutPostmanTerm', 'searchConversationData',
  'SubAgent', 'getVariables', 'getSharedVariables', 'sendRequest', 'showRichOutput',
];

/** Tập tên Claude Code mà client khai, chuẩn hoá lowercase. */
export function claudeToolSet(tools) {
  const s = new Set();
  for (const t of tools || []) {
    const n = typeof t === 'string' ? t : (t && t.name);
    if (n) s.add(String(n).toLowerCase());
  }
  return s;
}

/** Các native Postman NÊN giữ, dựa trên bộ tool Claude Code khai. */
export function nativesToKeep(claudeToolNames) {
  const keep = new Set();
  const set = claudeToolNames instanceof Set ? claudeToolNames : claudeToolSet(claudeToolNames);
  for (const [claude, natives] of Object.entries(CLAUDE_TO_NATIVES)) {
    if (set.has(claude)) natives.forEach((n) => keep.add(n));
  }
  return keep;
}

/** Danh sách excludedTools gửi lên gateway: native không map được + native client không khai.
 *  Lưu ý: template đã harvest có thể sẵn chứa native ta MUỐN giữ (vd 'askUser' bị Postman
 *  Desktop tự loại). Vì vậy phải BỎ khỏi excluded mọi native nằm trong `keep` — nếu không
 *  askUser sẽ mãi bị loại và gateway không bao giờ phát menu chọn option. */
export function excludedToolsFor(claudeToolNames, templateExcluded = []) {
  const keep = nativesToKeep(claudeToolNames);
  const excl = new Set(templateExcluded);
  for (const n of keep) excl.delete(n);                    // ép GIỮ native client thực sự khai
  for (const n of MAPPABLE_NATIVES) if (!keep.has(n)) excl.add(n);
  for (const n of ALWAYS_EXCLUDE) excl.add(n);
  return [...excl];
}

/**
 * Dịch 1 tool call của Postman sang Claude Code.
 * @returns
 *   { kind:'client', name, input }              → phát tool_use cho Claude Code chạy
 *   { kind:'drop', reason, syntheticResult }    → proxy tự trả TOOL_RESPONSE, gateway chạy tiếp
 */
export function mapPostmanToolToClaude(nativeName, rawArgs, claudeToolNames) {
  const set = claudeToolNames instanceof Set ? claudeToolNames : claudeToolSet(claudeToolNames);
  // MCP filesystem/shell tools (no exact translator) -> Bash/Glob/Read/Write/Edit.
  const mcp0 = mcpFsTranslate(nativeName, rawArgs);
  if (mcp0) {
    const mcp = adaptToClient(mcp0, set) || mcp0;
    if (!set.has(mcp.name.toLowerCase())) return { kind: 'drop', reason: 'Client khong bat ' + mcp.name, syntheticResult: '[proxy] Bo qua ' + nativeName + ': client khong bat ' + mcp.name + '.' };
    return { kind: 'client', name: mcp.name, input: mcp.input };
  }
  const fn = TRANSLATORS[nativeName];
  if (fn) {
    const out = adaptToClient(fn(rawArgs || {}), set);
    if (!out) return { kind: 'drop', reason: `Thiếu tham số bắt buộc cho ${nativeName}`, syntheticResult: `[proxy] Bỏ qua ${nativeName}: thiếu tham số bắt buộc.` };
    if (!set.has(out.name.toLowerCase())) {
      return { kind: 'drop', reason: `Client không khai tool ${out.name}`, syntheticResult: `[proxy] Bỏ qua ${nativeName}: client Claude Code không bật ${out.name}.` };
    }
    return { kind: 'client', name: out.name, input: out.input };
  }
  // Không có translator → drop, nhưng vẫn trả kết quả để gateway không treo.
  return { kind: 'drop', reason: `Không có ánh xạ cho ${nativeName}`, syntheticResult: `[proxy] Bỏ qua tool ${nativeName}: không có tương đương trong Claude Code.` };
}

// ---------------------------------------------------------------------------
// CONFORM tới SCHEMA client — sửa lỗi "Validation failed for tool read: must have
// required property path". Translator phát khoá canonical của Claude Code gốc
// (readFile → Read {file_path}); nhưng client có thể là harness/MCP khác, tool đọc
// dùng {path} thay vì {file_path}. Thay vì hard-code/đoán, đọc body.tools[].input_schema
// và tự đổi tên tool + khoá tham số sang đúng cái client khai. Không có schema ⇒ giữ
// nguyên (hành vi cũ). (docs/tool-mapping.md §3 — phòng thủ theo *vai trò*)
// ---------------------------------------------------------------------------
// Nhóm khoá ĐỒNG NGHĨA (cùng vai trò) giữa các biến thể schema tool file.
const PARAM_ALIASES = [
  ['file_path', 'path', 'filePath', 'filepath', 'absolute_path', 'dir', 'directory'],
  ['command', 'cmd', 'script', 'code'],
  ['old_string', 'oldString', 'old_str', 'oldText', 'old'],
  ['new_string', 'newString', 'new_str', 'newText', 'new'],
  ['content', 'contents', 'text', 'file_text', 'data'],
  ['replace_all', 'replaceAll'],
];

function toolDefFor(toolDefs, toolName) {
  if (!Array.isArray(toolDefs) || !toolName) return null;
  const lc = String(toolName).toLowerCase();
  return toolDefs.find((t) => t && typeof t.name === 'string' && t.name.toLowerCase() === lc) || null;
}

/** Tên tool đúng casing client khai (client có thể dùng 'read' thay vì 'Read'). */
export function conformToolName(toolName, toolDefs) {
  const t = toolDefFor(toolDefs, toolName);
  return t && t.name ? t.name : toolName;
}

/** Đổi khoá input cho khớp input_schema client khai (file_path ⇄ path…). Không rõ schema ⇒ giữ nguyên. */
export function conformInputToSchema(toolName, input, toolDefs) {
  if (!input || typeof input !== 'object') return input;
  const t = toolDefFor(toolDefs, toolName);
  const schema = t && (t.input_schema || t.inputSchema || t.schema);
  const props = schema && schema.properties;
  if (!props || typeof props !== 'object') return input;   // không có schema → giữ như cũ
  // Array-style edit tools: some clients (e.g. openclaw) declare the edit tool as
  //   { path, edits: [ { oldText, newText } ] }  instead of flat { old_string, new_string }.
  // The rename loop below only renames flat keys, so it cannot pack them into the array and
  // the client rejects it with "edits: must be array". Detect that schema and pack it here.
  {
    const editsProp = props.edits;
    const editsIsArray = editsProp && (editsProp.type === 'array' || editsProp.items != null || (Array.isArray(editsProp.type) && editsProp.type.includes('array')));
    const OLD = ['old_string', 'oldString', 'old_str', 'oldText', 'old'];
    const NEW = ['new_string', 'newString', 'new_str', 'newText', 'new'];
    const RA = ['replace_all', 'replaceAll'];
    const PATHK = ['file_path', 'path', 'filePath', 'filepath', 'absolute_path'];
    const readRole = (obj, group) => { for (const k of group) if (obj[k] !== undefined) return obj[k]; return undefined; };
    if (editsIsArray && !('edits' in input) && (readRole(input, OLD) !== undefined || readRole(input, NEW) !== undefined)) {
      const itemProps = (editsProp.items && editsProp.items.properties) || {};
      const keyOf = (group, fb) => group.find((k) => itemProps[k] !== undefined) || fb;
      const oldKey = keyOf(OLD, 'oldText');
      const newKey = keyOf(NEW, 'newText');
      const raKey = keyOf(RA, null);
      const oldVal = readRole(input, OLD);
      const newVal = readRole(input, NEW);
      const raVal = readRole(input, RA);
      const item = {};
      item[oldKey] = oldVal == null ? '' : String(oldVal);
      item[newKey] = newVal == null ? '' : String(newVal);
      if (raKey && raVal != null) item[raKey] = !!raVal;
      const pathKey = PATHK.find((k) => props[k] !== undefined) || 'path';
      const pathVal = readRole(input, PATHK);
      const packed = { edits: [item] };
      if (pathVal !== undefined) packed[pathKey] = pathVal;
      return packed;
    }
  }
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (props[k] !== undefined) { out[k] = v; continue; }   // schema chấp nhận đúng khoá này
    const group = PARAM_ALIASES.find((g) => g.includes(k));
    const alt = group && group.find((a) => props[a] !== undefined);
    if (alt) out[alt] = v;
    else if (schema && schema.additionalProperties === false) { /* drop unknown key on strict schema */ }
    else out[k] = v;                                       // đổi sang khoá schema chấp nhận (nếu có)
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tool card (tool-mapping.md §4): nêu ngữ cảnh client + mô tả môi trường ở thể
// KHẲNG ĐỊNH, quảng cáo TÊN NATIVE đang bật, khuyên dùng đường dẫn tuyệt đối.
// Tuyệt đối không có câu phủ định danh tính.
// ---------------------------------------------------------------------------
export function buildToolCard({ workingDir, claudeToolNames } = {}) {
  const set = claudeToolNames instanceof Set ? claudeToolNames : claudeToolSet(claudeToolNames);
  const keep = [...nativesToKeep(set)];
  const toolLine = keep.length ? keep.join(', ') : 'các công cụ đọc/ghi/tìm kiếm/chạy lệnh của workspace';
  const lines = [
    'Bạn đang được điều khiển bởi Claude Code CLI thông qua pm-ai-proxy (cầu nối tương thích Anthropic tới Postman agent gateway).',
  ];
  if (workingDir) lines.push(`Thư mục làm việc đã kết nối: ${workingDir}`);
  lines.push(`Các công cụ đang bật trong môi trường này: ${toolLine}. Hãy thao tác trực tiếp với file và dùng ĐƯỜNG DẪN TUYỆT ĐỐI.`);
  // Nudge (§4): Claude Code chỉ render menu khi model GỌI askUser (không có heuristic text).
  // Thúc model dùng askUser khi cần lựa chọn — chỉ khi client thật sự khai AskUserQuestion.
  if (set.has('askuserquestion')) lines.push('Khi cần người dùng quyết định giữa các phương án, HÃY GỌI công cụ askUser để hiện menu chọn — ĐỪNG liệt kê lựa chọn bằng văn bản.');
  lines.push('Nếu thư mục làm việc có file CLAUDE.md, hãy tuân theo nó.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Model: tên Anthropic (claude-sonnet-4-…, claude-opus-…, claude-haiku-…) → key Postman.
// Không map được ⇒ trả null (giữ selectedModel mặc định của template).
// ---------------------------------------------------------------------------
export function mapModel(anthropicModel, postmanModelKeys = []) {
  if (process.env.PM_FORCE_MODEL) return process.env.PM_FORCE_MODEL;
  const m = String(anthropicModel || '').toLowerCase();
  let tier = null;
  if (m.includes('opus')) tier = 'OPUS';
  else if (m.includes('haiku')) tier = 'HAIKU';
  else if (m.includes('sonnet')) tier = 'SONNET';
  if (!tier) return null;
  const keys = postmanModelKeys.map((k) => (typeof k === 'string' ? k : k && k.key)).filter(Boolean);
  // Ưu tiên key chứa đúng tier; trong đó ưu tiên bản có số version cao nhất (sort giảm dần theo chuỗi).
  const hit = keys.filter((k) => k.toUpperCase().includes(tier)).sort().reverse()[0];
  return hit || null;
}
