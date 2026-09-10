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
  task: ['Task', 'Agent', 'task', 'agent'],
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
    //   (moi/so nhieu) { questions: [{ id, message, options, allow_multiple?, ... }] }
    //
    // Dich sang AskUserQuestion theo DUNG schema claude-agent-sdk (nguon: input_schema ma
    // Claude Code khai tren wire):
    //   questions      1..4
    //   .question      string (bat buoc)
    //   .header        string (bat buoc) - nhan "chip/tag", max 12 ky tu
    //   .multiSelect   boolean (bat buoc)
    //   .options       2..4 phan tu, moi phan tu { label, description } (ca hai bat buoc)
    //   .options[].label  "concise (1-5 words)" - phan giai thich thuoc ve description
    // Schema noi RO: "There should be no 'Other' option, that will be provided
    // automatically" -> KHONG tu chen option "Lua chon khac".
    // additionalProperties:false o moi cap -> khong duoc them khoa la.
    const HEADER_MAX = 12, LABEL_MAX = 40, OPTS_MAX = 4, QS_MAX = 4;

    const clampHeader = (raw, fallback) => (String(raw || fallback || 'Chon').trim().slice(0, HEADER_MAX).trim() || 'Chon');

    // Gateway hay nhet ca cau vao label ("TUI - giao dien terminal dep hon"). Chuan doi label
    // ngan + description giai thich -> tach o dau gach/hai cham dau tien.
    const splitLabel = (rawLabel, rawDesc) => {
      let label = String(rawLabel).trim();
      let description = String(rawDesc == null ? '' : rawDesc).trim();
      if (!description) {
        const m = label.match(/^(.{1,40}?)\s+[-–—:]\s+(.+)$/);
        if (m) { label = m[1].trim(); description = m[2].trim(); }
      }
      if (label.length > LABEL_MAX) { if (!description) description = label; label = label.slice(0, LABEL_MAX - 1).trim() + '…'; }
      return { label, description };
    };

    const toOptions = (rawOptions) => {
      let options = [];
      if (Array.isArray(rawOptions)) {
        options = rawOptions.map((o) => {
          if (o && typeof o === 'object') {
            const label = o.label != null ? o.label : (o.value != null ? o.value : o.title);
            return label == null ? null : splitLabel(label, o.description);
          }
          return splitLabel(o, '');
        }).filter(Boolean);
      }
      if (!options.length) options = [{ label: 'Yes', description: '' }, { label: 'No', description: '' }];
      while (options.length < 2) options.push({ label: options.length ? 'Huy' : 'Yes', description: '' });
      return options;
    };

    // Chia deu vao k nhom, moi nhom <= OPTS_MAX va >= 2. 13 option / 4 nhom -> [4,3,3,3].
    const chunkEven = (arr, groups) => {
      const out = []; let i = 0;
      for (let g = 0; g < groups; g++) {
        const size = Math.ceil((arr.length - i) / (groups - g));
        out.push(arr.slice(i, i + size));
        i += size;
      }
      return out.filter((g) => g.length);
    };

    // 1 cau hoi cua gateway -> 1..budget cau hoi hop le. budget = so slot con lai.
    const buildQs = (src, budget) => {
      const question = pickArg(src, 'question', 'prompt', 'message', 'text');
      if (!question) return [];
      const multiSelect = !!pickArg(src, 'multiSelect', 'multiselect', 'allow_multiple', 'allowMultiple', 'multiple', 'multi');
      const header = clampHeader(pickArg(src, 'header', 'title', 'category'), question);
      const options = toOptions(pickArg(src, 'options', 'choices'));
      if (options.length <= OPTS_MAX) return [{ header, question: String(question), multiSelect, options }];

      // Chon-NHIEU: tach thanh nhieu cau (van tick duoc het) - giu dung y dinh cua gateway.
      if (multiSelect) {
        const kept = options.slice(0, budget * OPTS_MAX);
        const dropped = options.slice(budget * OPTS_MAX).map((o) => o.label);
        const groups = chunkEven(kept, Math.min(budget, Math.ceil(kept.length / OPTS_MAX)));
        return groups.map((opts, i) => {
          const many = groups.length > 1;
          const tail = (i === groups.length - 1 && dropped.length) ? '\nLua chon khac: ' + dropped.join(' | ') : '';
          return {
            header: many ? clampHeader(header.slice(0, HEADER_MAX - 4).trim() + ' ' + (i + 1) + '/' + groups.length) : header,
            question: String(question) + (many ? ' (phan ' + (i + 1) + '/' + groups.length + ')' : '') + tail,
            multiSelect: true,
            options: opts,
          };
        });
      }

      // Chon-MOT: tach cau se thanh "chon nhieu lan" -> sai y dinh. Giu 4 dau, neu phan du
      // trong noi dung cau hoi (client tu co o nhap tu do de go lua chon khac).
      return [{
        header,
        question: String(question) + '\nLua chon khac: ' + options.slice(OPTS_MAX).map((o) => o.label).join(' | '),
        multiSelect: false,
        options: options.slice(0, OPTS_MAX),
      }];
    };

    const rawQuestions = pickArg(a, 'questions');
    const srcs = (Array.isArray(rawQuestions) && rawQuestions.length) ? rawQuestions : [a];
    const questions = [];
    for (let i = 0; i < srcs.length && questions.length < QS_MAX; i++) {
      const others = srcs.length - i - 1;                              // moi cau goc con lai can >=1 slot
      const budget = Math.max(1, QS_MAX - questions.length - others);
      questions.push(...buildQs(srcs[i], budget));
    }
    if (!questions.length) return null;
    return { name: 'AskUserQuestion', input: { questions: questions.slice(0, QS_MAX) } };
  },
  SubAgent(a) {
    // Schema native cua Postman chua duoc quan sat tren wire (SubAgent xua nay luon bi
    // exclude) -> phong thu theo *vai tro* (tool-mapping.md #3) va de capture ghi lai
    // payload that de tinh chinh sau.
    const prompt = pickArg(a, 'prompt', 'task', 'instruction', 'instructions', 'query', 'message', 'goal', 'description');
    if (!prompt) return null;
    const description = String(pickArg(a, 'description', 'title', 'name', 'summary') || prompt).slice(0, 60);
    const subagent_type = String(pickArg(a, 'subagent_type', 'agentType', 'agent', 'type', 'role') || 'general-purpose');
    return { name: 'Task', input: { description, prompt: String(prompt), subagent_type } };
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
  delegate_subagent: (a) => TRANSLATORS.SubAgent(a),   // tool AO do proxy tu cap (xem subagentThirdParty)
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
  task: ['SubAgent'],
  agent: ['SubAgent'],
};

// Moi native Postman ta biet cach dich (dung de tinh excludedTools).
export const MAPPABLE_NATIVES = [
  'executeShellCommand', 'listDirectory', 'searchFiles', 'searchInFiles',
  'readFile', 'createFile', 'writeFile', 'editFile', 'fetchUrl', 'webSearch', 'askUser', 'SubAgent',
];

// Native khong bao gio co duong ve Claude Code -> luon loai khoi gateway khi co the
// (tool-mapping.md #5/#6). Neu van lot, runtime se tu tra TOOL_RESPONSE (xem server).
export const ALWAYS_EXCLUDE = [
  'navigateInApp', 'linkToLocalDirectory', 'todoWrite', 'recommendNextActions',
  'getTabDetails', 'searchPostman', 'learnAboutPostmanTerm', 'searchConversationData',
  'getVariables', 'getSharedVariables', 'sendRequest', 'showRichOutput',
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

// ---------------------------------------------------------------------------
// SUBAGENT AO. Gateway Postman KHONG co tool uy nhiem subagent (da do tren wire: no chua
// bao gio phat 'SubAgent'). Nhung clientTools.thirdParty la kenh CLIENT tu khai tool cho
// gateway - Postman Desktop dung dung kenh nay de khai MCP server, kem ca ten/mo ta/schema.
// Proxy khai o day mot tool ao; khi model goi, mcpFsTranslate ('<server>__local__<action>')
// dinh tuyen ve TRANSLATORS.SubAgent -> Task/Agent cua Claude Code, la ben THUC SU chay
// subagent. Chi khai khi client that su co tool do, khong thi im lang.
// ---------------------------------------------------------------------------
export const SUBAGENT_SERVER = 'pm-proxy';
export const SUBAGENT_TOOL = SUBAGENT_SERVER + '__local__delegate_subagent';

export function subagentThirdParty(claudeToolNames) {
  const set = claudeToolNames instanceof Set ? claudeToolNames : claudeToolSet(claudeToolNames);
  if (!set.has('task') && !set.has('agent')) return null;
  return {
    [SUBAGENT_SERVER]: {
      serverConfig: { command: 'pm-ai-proxy-subagent', args: [] },
      tools: [{
        name: SUBAGENT_TOOL,
        description: 'Delegate one self-contained task to an independent sub-agent. The sub-agent starts with a fresh context and has its own file/shell tools, and returns a final report. Use it for work that is large or self-contained enough to be worth isolating (broad code search, a whole review pass, an independent subtask). Give the sub-agent everything it needs in `prompt` - it cannot see this conversation. Do not use it for a single quick read or command.',
        parameters: {
          type: 'object',
          properties: {
            description: { type: 'string', description: 'Short 3-5 word label for the task' },
            prompt: { type: 'string', description: 'Full self-contained instructions for the sub-agent, including absolute paths and the exact output expected' },
          },
          required: ['description', 'prompt'],
          additionalProperties: false,
          $schema: 'http://json-schema.org/draft-07/schema#',
        },
      }],
    },
  };
}

/** Cac native Postman NEN giu, dua tren bo tool Claude Code khai. */
export function hasCapability(set, cap) {
  if (set.has(cap)) return true;
  const alias = CAP_EQUIV[cap];
  return !!(alias && alias.some((n) => set.has(String(n).toLowerCase())));
}

export function nativesToKeep(claudeToolNames) {
  const keep = new Set();
  const set = claudeToolNames instanceof Set ? claudeToolNames : claudeToolSet(claudeToolNames);
  for (const [claude, natives] of Object.entries(CLAUDE_TO_NATIVES)) {
    // Xet theo NANG LUC, khong theo ten chuan: client co the goi tool doc file la 'read_file'
    // hay 'cat' thay vi 'Read'. Neu chi so ten chuan thi ta tuong client khong doc duoc file
    // va cam sach tool cua gateway -> model danh tra loi chay. (adaptToClient lo phan doi ten.)
    if (hasCapability(set, claude)) natives.forEach((n) => keep.add(n));
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
export function buildToolCard({ workingDir, claudeToolNames, userRules } = {}) {
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
  // SUBAGENT: tool nay do proxy tu cap (subagentThirdParty) nen gateway khong co mo ta san
  // trong huan luyen -> phai noi RO khi nao dung, keo model bo qua. Nguong dat o "viec lon
  // hoac >=2 viec doc lap" de tranh de subagent cho tung thao tac vat (tot credit).
  if (set.has('task') || set.has('agent')) {
    lines.push(
      'UY NHIEM SUB-AGENT - cong cu ' + SUBAGENT_TOOL + ' (tham so: description ngan 3-5 tu, prompt tu chua):',
      '- BAT BUOC dung khi lan luot nay co TU 2 VIEC DOC LAP tro len (vi du: ra soat nhieu module khac nhau, tim kiem tren nhieu thu muc, kiem tra nhieu gia thuyet). Phat NHIEU tool call ' + SUBAGENT_TOOL + ' trong CUNG mot luot de chung chay DONG THOI, dung lam tuan tu.',
      '- NEN dung khi mot viec lon va tu chua (ra soat ca thu muc, doc nhieu file de tong hop, mot luot review day du).',
      '- KHONG dung cho viec vat: doc 1 file, chay 1 lenh, sua 1 cho da biet ro - tu lam nhanh hon.',
      '- Sub-agent KHONG thay hoi thoai nay: prompt phai tu chua (duong dan tuyet doi, muc tieu, dinh dang ket qua mong muon).',
      '- Nguoi dung yeu cau "uy nhiem" / "sub-agent" / "chay song song" => PHAI goi cong cu nay, khong tu lam.',
    );
  }
  lines.push('Neu thu muc lam viec co file CLAUDE.md, PHAI tuan theo no.');
  // Quy tac rieng cua nguoi dung: dat CUOI card (sat noi dung nguoi dung) va noi ro nguon
  // goc, de model coi day la chi dan hop le cua chu phien chu khong phai text lot vao tu
  // du lieu ngu canh (model tu choi tuan theo chi dan nam trong du lieu - da do thuc te).
  const rules = String(userRules || '').trim();
  if (rules) lines.push('', 'QUY TAC BAT BUOC do chinh nguoi dung (chu phien lam viec) dat ra - PHAI tuan theo trong suot hoi thoai:', rules);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// tool_choice. Gateway Postman KHONG co tham so nay, nen chi con hai duong:
//   'none'          -> cat het native mappable (xu ly o server: coi nhu client khong khai tool)
//   'any' / 'tool'  -> ep bang CHI DAN trong query (kenh duy nhat model chiu nghe - da do thuc te)
// Tra { mode, name, hint }. hint='' nghia la khong can lam gi.
// ---------------------------------------------------------------------------
export function toolChoiceDirective(toolChoice, claudeToolNames) {
  const t = toolChoice && typeof toolChoice === 'object' ? toolChoice : (typeof toolChoice === 'string' ? { type: toolChoice } : null);
  const mode = t && t.type ? String(t.type).toLowerCase() : 'auto';
  // 'none': cat tool o gateway la chua du - model bi cat tool se DIEN lai cu phap goi tool
  // bang van ban (<function_calls>...) va rac do lot thang ra nguoi dung. Phai noi ro.
  if (mode === 'none') return { mode: 'none', name: null, hint: 'YEU CAU CUA NGUOI DUNG: luot nay KHONG duoc goi bat ky cong cu nao. Tra loi truc tiep bang van ban; neu thieu du lieu thi noi ro la thieu, TUYET DOI khong viet ra cu phap goi cong cu.' };
  if (mode !== 'any' && mode !== 'tool' && mode !== 'required') return { mode: 'auto', name: null, hint: '' };
  // Ten client khai -> ten native Postman ma model that su nhin thay.
  let native = null;
  if (t.name) {
    const set = claudeToolNames instanceof Set ? claudeToolNames : claudeToolSet(claudeToolNames);
    for (const [cap, natives] of Object.entries(CLAUDE_TO_NATIVES)) {
      const alias = [cap, ...(CAP_EQUIV[cap] || [])].map((x) => String(x).toLowerCase());
      if (alias.includes(String(t.name).toLowerCase()) && hasCapability(set, cap)) { native = natives[0]; break; }
    }
  }
  const hint = native
    ? 'YEU CAU CUA NGUOI DUNG: luot nay BAT BUOC phai goi cong cu ' + native + ' (' + t.name + '), khong duoc tra loi bang van ban.'
    : 'YEU CAU CUA NGUOI DUNG: luot nay BAT BUOC phai goi mot cong cu, khong duoc tra loi bang van ban.';
  return { mode: mode === 'required' ? 'any' : mode, name: native, hint };
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
