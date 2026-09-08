/**
 * SESSION CONTEXT — workspace + thư mục làm việc theo TỪNG phiên (state per-request).
 * Ghi đè đúng field trong payload /chat mà app dùng:
 *   - mandatoryContext.workspaceId
 *   - backgroundContext[ACTIVE_WORKSPACE]  = { name, id }
 *   - backgroundContext[FILE_VIEWER_FOLDER] = { path, isOpen, platform, description, projectOverview }
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadTemplate } from './core.mjs';

/** Liệt kê thư mục con + file (path rỗng → danh sách ổ đĩa). Dùng cho folder browser. */
export function listDir(dir) {
  if (!dir || dir === '' || dir === '\\' || dir === '/') {
    const drives = [];
    for (let c = 65; c <= 90; c++) { const d = String.fromCharCode(c) + ':\\'; try { if (fs.existsSync(d)) drives.push(d); } catch {} }
    return { path: '', drives, dirs: [], files: [] };
  }
  try {
    const ents = fs.readdirSync(dir, { withFileTypes: true });
    return {
      path: dir,
      parent: path.dirname(dir) === dir ? '' : path.dirname(dir),
      drives: [],
      dirs: ents.filter((e) => e.isDirectory()).map((e) => e.name).filter((n) => !n.startsWith('$')).sort().map((n) => ({ name: n, path: path.join(dir, n) })),
      files: ents.filter((e) => e.isFile()).map((e) => e.name).sort().slice(0, 300),
    };
  } catch (e) { return { path: dir, parent: path.dirname(dir), error: e.message, dirs: [], files: [] }; }
}

/** projectOverview đúng shape app dùng. */
export function projectOverview(dir) {
  try {
    const ents = fs.readdirSync(dir, { withFileTypes: true });
    return {
      rootPath: dir,
      topLevelDirectories: ents.filter((e) => e.isDirectory()).map((e) => e.name).sort(),
      topLevelFiles: ents.filter((e) => e.isFile()).map((e) => e.name).sort(),
    };
  } catch { return { rootPath: dir, topLevelDirectories: [], topLevelFiles: [] }; }
}

export function fileViewerFolder(dir) {
  return {
    path: dir, isOpen: true, platform: 'desktop',
    description: `Selected folder: ${dir}. All file operations will operate relative to this directory. Use paths like 'package.json', 'src/main.js', 'docs/README.md' relative to this location. Platform: desktop.`,
    projectOverview: projectOverview(dir),
  };
}

/** Ghi đè workspace + thư mục làm việc cho phiên vào payload. */
export function applySession(body, session = {}) {
  const { workspaceId, workspaceName, workingDir } = session;
  body.backgroundContext = Array.isArray(body.backgroundContext) ? body.backgroundContext : [];
  if (workspaceId) {
    body.mandatoryContext = body.mandatoryContext || {};
    body.mandatoryContext.workspaceId = workspaceId;
    if ('selectedWorkspaceId' in body.mandatoryContext) body.mandatoryContext.selectedWorkspaceId = workspaceId;
    const aw = body.backgroundContext.find((x) => x.type === 'ACTIVE_WORKSPACE');
    const val = { name: workspaceName || (aw && aw.value && aw.value.name) || 'Workspace', id: workspaceId };
    if (aw) aw.value = val; else body.backgroundContext.push({ type: 'ACTIVE_WORKSPACE', value: val });
  }
  if (workingDir) {
    const fv = body.backgroundContext.find((x) => x.type === 'FILE_VIEWER_FOLDER');
    const val = fileViewerFolder(workingDir);
    if (fv) fv.value = val; else body.backgroundContext.push({ type: 'FILE_VIEWER_FOLDER', value: val });
  }
  return body;
}

export function templateWorkspace() {
  const tpl = loadTemplate();
  const bg = tpl && tpl.body && Array.isArray(tpl.body.backgroundContext) ? tpl.body.backgroundContext : [];
  const aw = bg.find((x) => x.type === 'ACTIVE_WORKSPACE');
  if (aw && aw.value) return aw.value;
  const wid = tpl && tpl.body && tpl.body.mandatoryContext ? tpl.body.mandatoryContext.workspaceId : null;
  return wid ? { id: wid, name: 'Workspace' } : null;
}

export function templateFolder() {
  const tpl = loadTemplate();
  const bg = tpl && tpl.body && Array.isArray(tpl.body.backgroundContext) ? tpl.body.backgroundContext : [];
  const fv = bg.find((x) => x.type === 'FILE_VIEWER_FOLDER');
  return fv && fv.value ? fv.value.path : null;
}
