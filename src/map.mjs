/**
 * TOOL + MODEL MAPPING - Postman native  <->  Claude Code (Anthropic wire).
 *
 * SSoT cua code cho tang dich tool. Tai lieu doi chieu: docs/tool-mapping.md.
 * Rang buoc goc (tool-mapping.md #1): tool call tren wire LUON mang ten native cua
 * Postman; proxy chi doi ten + doi tham so sang ten cua Claude Code. Card chi "goi y",
 * KHONG cap tool moi - nen card quang cao TEN NATIVE, va mo ta moi truong o the khang
 * dinh, khong doi dau danh tinh (tool-mapping.md #4).
 *
 * O "phuong phap Anthropic": CHINH Claude Code CLI chay tool (Bash/Read/Write/Edit...),
 * proxy khong chay tool. Vi vay module nay chi DICH, khong thuc thi.
 */

export const QUERY_CAP = Number(process.env.PM_QUERY_CAP || 8500); // tool-mapping.md #7

// ---------------------------------------------------------------------------
// pickArg - chuan hoa khoa (lowercase, bo ky tu khong phai chu/so) roi moi tra alias.
// filePath / file_path / File-Path -> cung mot khoa. Schema native chua duoc cong bo,
// nen phong thu theo *vai tro* thay vi liet ke tay tung bien the (tool-mapping.md #3).
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

// Boc chuoi cho shell (single-quote an toan cho POSIX; Claude Code Bash chay qua shell).
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// ---------------------------------------------------------------------------
// Bang map: Postman native  ->  Claude Code. (docs/tool-mapping.md #5)
// Moi entry tra { name, input }.  Tra null nghia la "drop" (xu ly o mapPostmanToolToClaude).
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// CLIENT-AWARE tool-name adaptation. The gateway emits Claude-Code names; each
// client may declare different names for the same capability (openclaw uses
// exec/dir_list/dir_fetch/web_fetch/ask_user...). Pick the name the client
// actually declares and rebuild input where the target shape differs.
// ---------------------------------------------------------------------------
const CAP_EQUIV = {
  bash: ['Bash', 'exec', 'terminal', 'PowerShell', 'shell', 'sh'],
  glob: ['Glob'], // dir_fetch/dir_list la paired-node (remote), KHONG phai lister local -> khong map glob vao do
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
    // Khong co Glob native local => roi xuong shell. Sinh cu phap dung theo shell host (Win->PowerShell).
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
    // Claude Bash khong nhan cwd -> ghep cd (tool-mapping.md #3).
    // Dung ';' thay '&&': hoat dong cho ca bash lan PowerShell (PS 5.1 khong nhan '&&').
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
    // Dung tool NATIVE cua Claude Code (Grep/Glob) thay vi `Bash rg`: Grep boc ripgrep bundled
    // san trong Claude Code, khong phu thuoc `rg` tren PATH va khong di qua hook shell (rtk).
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
    if (glob) return { name: 'Glob', input: { pattern: String(glob) } }; // chi tim theo ten file
    return null; // thieu ca pattern lan glob => drop
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
    // Postman phat 1 trong 2 shape:
    //   (cu/so it)  { question, options }
    //   (moi/so nhieu) { questions: [{ id, message, options, header?, ... }] }
    // options: string[] hoac {label,value}[]. AskUserQuestion doi questions[].options la
    // {label} va KHONG rong -> tu chen Yes/No khi thieu.
    // AskUserQuestion (Claude Code) BAT BUOC: questions[].header la string, va MOI
    // options[].description la string. Thieu -> InputValidationError "expected string but
    // provided unknown". Vi vay LUON set ca hai (mac dinh '') du gateway khong cung cap.
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
    // AskUserQuestion: options moi cau phai 2..4 phan tu (minItems:2, maxItems:4). Gateway co the
    // phat >4 -> giu 3 dau + gop phan du vao 1 option "Lua chon khac..." (khong mat thong tin, hop le).
    // Thieu (<2) -> chen them de du toi thieu 2.
    const capOptions = (options) => {
      if (options.length > 4) {
        const kept = options.slice(0, 3);
        const restLabels = options.slice(3).map((o) => o.label);
        kept.push({ label: 'Lua chon khac...', description: ('Gom: ' + restLabels.join(' | ')).slice(0, 500) });
        options = kept;
      }
      while (options.length < 2) options.push({ label: options.length ? 'Huy' : 'Yes', description: '' });
      return options;
    };
    const buildQ = (src) => {
      const question = pickArg(src, 'question', 'prompt', 'message', 'text');
      if (!question) return null;
      const rawHeader = pickArg(src, 'header', 'title', 'category');
      const header = String(rawHeader || question).trim().slice(0, 40) || 'Chon';
      return { header, question: String(question), multiSelect: !!pickArg(src, 'multiSelect', 'multiselect'), options: capOptions(toOptions(pickArg(src, 'options', 'choices'))) };
    };

    // Shape so nhieu: { questions: [...] } - AskUserQuestion cho toi da 4 cau hoi.
    const rawQuestions = pickArg(a, 'questions');
    if (Array.isArray(rawQuestions) && rawQuestions.length) {
      const questions = rawQuestions.map(buildQ).filter(Boolean).slice(0, 4);
      if (questions.length) return { name: 'AskUserQuestion', input: { questions } };
    }

    // Shape so it: { question, options }
    const q = buildQ(a);
    if (!q) return null;
    return { name: 'AskUserQuestion', input: { questions: [q] } };
  },
};

// Claude Code tool  ->  cac ten native Postman ma no "phu" duoc.
// Dung de (a) loc card, (b) tinh excludedTools cho gateway.
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

// Moi native Postman ta biet cach dich (dung de tinh excludedTools).
export const MAPPABLE_NATIVES = [
  'executeShellCommand', 'listDirectory', 'searchFiles', 'searchInFiles',
  'readFile', 'createFile', 'writeFile', 'editFile', 'fetchUrl', 'webSearch', 'askUser',
];

// Native khong bao gio co duong ve Claude Code -> luon loai khoi gateway khi co the
// (tool-mapping.md #5/#6). Neu van lot, runtime se tu tra TOOL_RESPONSE (xem server).
export const ALWAYS_EXCLUDE = [
  'navigateInApp', 'linkToLocalDirectory', 'todoWrite', 'recommendNextActions',
  'getTabDetails', 'searchPostman', 'learnAboutPostmanTerm', 'searchConversationData',
  'SubAgent', 'getVariables', 'getSharedVariables', 'sendRequest', 'showRichOutput',
];

/** Tap ten Claude Code ma client khai, chuan hoa lowercase. */
export function claudeToolSet(tools) {
  const s = new Set();
  for (const t of tools || []) {
    const n = typeof t === 'string' ? t : (t && t.name);
    if (n) s.add(String(n).toLowerCase());
  }
  return s;
}

/** Cac native Postman NEN giu, dua tren bo tool Claude Code khai. */
export function nativesToKeep(claudeToolNames) {
  const keep = new Set();
  const set = claudeToolNames instanceof Set ? claudeToolNames : claudeToolSet(claudeToolNames);
  for (const [claude, natives] of Object.entries(CLAUDE_TO_NATIVES)) {
    if (set.has(claude)) natives.forEach((n) => keep.add(n));
  }
  return keep;
}

/** Danh sach excludedTools gui len gateway: native khong map duoc + native client khong khai.
 *  Luu y: template da harvest co the san chua native ta MUON giu (vd 'askUser' bi Postman
 *  Desktop tu loai). Vi vay phai BO khoi excluded moi native nam trong `keep` - neu khong
 *  askUser se mai bi loai va gateway khong bao gio phat menu chon option. */
export function excludedToolsFor(claudeToolNames, templateExcluded = []) {
  const keep = nativesToKeep(claudeToolNames);
  const excl = new Set(templateExcluded);
  for (const n of keep) excl.delete(n);                    // ep GIU native client thuc su khai
  for (const n of MAPPABLE_NATIVES) if (!keep.has(n)) excl.add(n);
  for (const n of ALWAYS_EXCLUDE) excl.add(n);
  return [...excl];
}

/**
 * Dich 1 tool call cua Postman sang Claude Code.
 * @returns
 *   { kind:'client', name, input }              -> phat tool_use cho Claude Code chay
 *   { kind:'drop', reason, syntheticResult }    -> proxy tu tra TOOL_RESPONSE, gateway chay tiep
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
    if (!out) return { kind: 'drop', reason: `Thieu tham so bat buoc cho ${nativeName}`, syntheticResult: `[proxy] Bo qua ${nativeName}: thieu tham so bat buoc.` };
    if (!set.has(out.name.toLowerCase())) {
      return { kind: 'drop', reason: `Client khong khai tool ${out.name}`, syntheticResult: `[proxy] Bo qua ${nativeName}: client Claude Code khong bat ${out.name}.` };
    }
    return { kind: 'client', name: out.name, input: out.input };
  }
  // Khong co translator -> drop, nhung van tra ket qua de gateway khong treo.
  return { kind: 'drop', reason: `Khong co anh xa cho ${nativeName}`, syntheticResult: `[proxy] Bo qua tool ${nativeName}: khong co tuong duong trong Claude Code.` };
}

// ---------------------------------------------------------------------------
// CONFORM toi SCHEMA client - sua loi "Validation failed for tool read: must have
// required property path". Translator phat khoa canonical cua Claude Code goc
// (readFile -> Read {file_path}); nhung client co the la harness/MCP khac, tool doc
// dung {path} thay vi {file_path}. Thay vi hard-code/doan, doc body.tools[].input_schema
// va tu doi ten tool + khoa tham so sang dung cai client khai. Khong co schema => giu
// nguyen (hanh vi cu). (docs/tool-mapping.md #3 - phong thu theo *vai tro*)
// ---------------------------------------------------------------------------
// Nhom khoa DONG NGHIA (cung vai tro) giua cac bien the schema tool file.
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

/** Ten tool dung casing client khai (client co the dung 'read' thay vi 'Read'). */
export function conformToolName(toolName, toolDefs) {
  const t = toolDefFor(toolDefs, toolName);
  return t && t.name ? t.name : toolName;
}

/** Doi khoa input cho khop input_schema client khai (file_path <-> path...). Khong ro schema => giu nguyen. */
export function conformInputToSchema(toolName, input, toolDefs) {
  if (!input || typeof input !== 'object') return input;
  const t = toolDefFor(toolDefs, toolName);
  const schema = t && (t.input_schema || t.inputSchema || t.schema);
  const props = schema && schema.properties;
  if (!props || typeof props !== 'object') return input;   // khong co schema -> giu nhu cu
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
    if (props[k] !== undefined) { out[k] = v; continue; }   // schema chap nhan dung khoa nay
    const group = PARAM_ALIASES.find((g) => g.includes(k));
    const alt = group && group.find((a) => props[a] !== undefined);
    if (alt) out[alt] = v;
    else if (schema && schema.additionalProperties === false) { /* drop unknown key on strict schema */ }
    else out[k] = v;                                       // doi sang khoa schema chap nhan (neu co)
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tool card (tool-mapping.md #4): neu ngu canh client + mo ta moi truong o the
// KHANG DINH, quang cao TEN NATIVE dang bat, khuyen dung duong dan tuyet doi.
// Tuyet doi khong co cau phu dinh danh tinh.
// ---------------------------------------------------------------------------
export function buildToolCard({ workingDir, claudeToolNames } = {}) {
  const set = claudeToolNames instanceof Set ? claudeToolNames : claudeToolSet(claudeToolNames);
  const keep = [...nativesToKeep(set)];
  const toolLine = keep.length ? keep.join(', ') : 'cac cong cu doc/ghi/tim kiem/chay lenh cua workspace';
  const lines = [
    'Ban dang duoc dieu khien boi Claude Code CLI thong qua pm-ai-proxy (cau noi tuong thich Anthropic toi Postman agent gateway).',
  ];
  if (workingDir) lines.push(`Thu muc lam viec da ket noi: ${workingDir}`);
  lines.push(`Cac cong cu dang bat trong moi truong nay: ${toolLine}. Thao tac truc tiep voi file va LUON dung DUONG DAN TUYET DOI.`);
  // Nudge (#4): Claude Code chi render menu khi model GOI askUser (khong co heuristic text).
  // Thuc model dung askUser khi can lua chon - chi khi client that su khai AskUserQuestion.
  if (set.has('askuserquestion')) lines.push('Khi can nguoi dung quyet dinh giua cac phuong an, PHAI GOI cong cu askUser de hien menu chon - TUYET DOI KHONG liet ke lua chon bang van ban.');
  lines.push('Neu thu muc lam viec co file CLAUDE.md, PHAI tuan theo no.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Model: ten Anthropic (claude-sonnet-4-..., claude-opus-..., claude-haiku-...) -> key Postman.
// Khong map duoc => tra null (giu selectedModel mac dinh cua template).
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
  // Uu tien key chua dung tier; trong do uu tien ban co so version cao nhat (sort giam dan theo chuoi).
  const hit = keys.filter((k) => k.toUpperCase().includes(tier)).sort().reverse()[0];
  return hit || null;
}
