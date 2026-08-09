import { createHash } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, relative, resolve, sep } from 'node:path';

export const WORKBENCH_CONTRACT = 'helmion.workbench.v1';
const MAX_CONTEXT_FILES = 250;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'bin', 'obj', '.next', 'dist-cache']);
const PRIVATE_NAMES = /(^|[._-])(env|secret|secrets|credential|credentials|token|tokens|private[-_]?key)([._-]|$)/i;

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizedRoot(workspaceRoot) {
  const root = resolve(workspaceRoot);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error('The selected workspace is not an available directory.');
  }
  return root;
}

export function resolveWorkbenchPath(workspaceRoot, userPath = '.') {
  const root = normalizedRoot(workspaceRoot);
  const raw = String(userPath ?? '.').trim() || '.';
  if (resolve(raw) === raw) throw new Error('Workbench paths must be relative to the selected workspace.');
  const full = resolve(root, raw);
  const rel = relative(root, full);
  if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(full) === resolve(root, '..')) {
    throw new Error(`Path escapes the selected workspace: ${raw}`);
  }
  return { root, full, relativePath: rel || '.' };
}

export function assertNoFilesystemLinks(workspaceRoot, targetPath, { allowMissingLeaf = true } = {}) {
  const { root, full } = resolveWorkbenchPath(workspaceRoot, targetPath);
  const rel = relative(root, full);
  let cursor = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    if (!existsSync(cursor)) {
      if (allowMissingLeaf) break;
      throw new Error(`Path does not exist: ${targetPath}`);
    }
    if (lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`Filesystem links are not allowed in workbench paths: ${targetPath}`);
    }
  }
  return full;
}

export function isPrivateWorkbenchPath(path) {
  return String(path).split(/[\\/]+/).some((part) => PRIVATE_NAMES.test(part));
}

function walkContext(root) {
  const files = [];
  const visit = (dir) => {
    if (files.length >= MAX_CONTEXT_FILES) return;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= MAX_CONTEXT_FILES) break;
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      const rel = relative(root, full).split(sep).join('/');
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !isPrivateWorkbenchPath(rel)) visit(full);
        continue;
      }
      if (!entry.isFile() || isPrivateWorkbenchPath(rel)) continue;
      try {
        const info = statSync(full);
        files.push({ path: rel, bytes: info.size });
      } catch { /* one unreadable file does not hide the rest */ }
    }
  };
  visit(root);
  return { files, truncated: files.length >= MAX_CONTEXT_FILES };
}

export function discoverProjectTasks(workspaceRoot) {
  const root = normalizedRoot(workspaceRoot);
  const tasks = [];
  const packagePath = join(root, 'package.json');
  if (existsSync(packagePath)) {
    try {
      const parsed = JSON.parse(readFileSync(packagePath, 'utf8'));
      for (const name of Object.keys(parsed?.scripts ?? {}).sort()) {
        if (/^[a-z0-9][a-z0-9:_-]{0,79}$/i.test(name)) {
          tasks.push({ id: `npm:${name}`, label: `npm run ${name}`, source: 'package.json' });
        }
      }
    } catch { /* malformed manifest is reported by the project task itself */ }
  }
  const rootNames = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(sln|slnx|csproj)$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (rootNames.length > 0) {
    tasks.push(
      { id: 'dotnet:build', label: 'dotnet build', source: rootNames[0] },
      { id: 'dotnet:test', label: 'dotnet test', source: rootNames[0] },
    );
  }
  return tasks;
}

export function projectTaskCommand(workspaceRoot, taskId) {
  const task = discoverProjectTasks(workspaceRoot).find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`Task is not declared by this project: ${taskId}`);
  if (task.id.startsWith('npm:')) {
    const script = task.id.slice(4);
    // Windows cannot CreateProcess a .cmd file directly. Use cmd.exe only as
    // the fixed launcher for this manifest-declared, regex-constrained name;
    // no model-authored command text or argument is accepted.
    if (process.platform === 'win32') {
      return {
        task,
        executable: process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
        args: ['/d', '/s', '/c', `npm.cmd run ${script} --silent`],
      };
    }
    return { task, executable: 'npm', args: ['run', script, '--silent'] };
  }
  if (task.id === 'dotnet:build') return { task, executable: 'dotnet', args: ['build', '--nologo'] };
  if (task.id === 'dotnet:test') return { task, executable: 'dotnet', args: ['test', '--nologo'] };
  throw new Error(`Unsupported project task: ${taskId}`);
}

export function discoverWorkbenchArtifacts(workspaceRoot, limit = 40) {
  const root = normalizedRoot(workspaceRoot);
  const artifactRoot = join(root, '.helmion', 'artifacts');
  if (!existsSync(artifactRoot)) return [];
  const artifacts = [];
  const visit = (dir) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (artifacts.length >= limit || entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) {
        const info = statSync(full);
        artifacts.push({
          path: relative(root, full).split(sep).join('/'),
          bytes: info.size,
          sha256: hash(readFileSync(full)),
        });
      }
    }
  };
  visit(artifactRoot);
  return artifacts;
}

export function workspaceContext(workspaceRoot) {
  const root = normalizedRoot(workspaceRoot);
  const context = walkContext(root);
  return {
    contract: WORKBENCH_CONTRACT,
    kind: 'workspace_context',
    status: 'ready',
    workspace: { id: hash(root.toLowerCase()).slice(0, 24), root },
    files: context.files,
    filesTruncated: context.truncated,
    tasks: discoverProjectTasks(root),
    artifacts: discoverWorkbenchArtifacts(root),
    boundaries: {
      paths: 'selected-workspace-only',
      writes: 'typed-create-or-exact-edit',
      execution: 'declared-project-tasks-only',
      preview: 'loopback-static-files-only',
      privateFilesExcluded: true,
    },
  };
}

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.htm', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'], ['.gif', 'image/gif'], ['.webp', 'image/webp'],
]);

export async function startStaticPreview(workspaceRoot, relativePath = '.') {
  const root = normalizedRoot(workspaceRoot);
  const target = assertNoFilesystemLinks(root, relativePath, { allowMissingLeaf: false });
  if (isPrivateWorkbenchPath(relative(root, target))) throw new Error('Private configuration paths cannot be previewed.');
  const targetInfo = statSync(target);
  const previewRoot = targetInfo.isDirectory() ? target : resolve(target, '..');
  const entry = targetInfo.isDirectory() ? 'index.html' : relative(previewRoot, target);
  const entryPath = join(previewRoot, entry);
  if (!existsSync(entryPath) || !statSync(entryPath).isFile()) {
    throw new Error(`Static preview entry was not found: ${relativePath}`);
  }

  const server = createServer((request, response) => {
    try {
      const requestPath = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
      const wanted = requestPath === '/' ? entry : requestPath.replace(/^\/+/, '');
      const resolved = resolve(previewRoot, wanted);
      const rel = relative(previewRoot, resolved);
      if (rel === '..' || rel.startsWith(`..${sep}`) || isPrivateWorkbenchPath(rel)) {
        response.writeHead(403).end('Forbidden'); return;
      }
      assertNoFilesystemLinks(previewRoot, wanted, { allowMissingLeaf: false });
      if (!existsSync(resolved) || !statSync(resolved).isFile() || lstatSync(resolved).isSymbolicLink()) {
        response.writeHead(404).end('Not found'); return;
      }
      response.writeHead(200, {
        'Content-Type': MIME.get(extname(resolved).toLowerCase()) ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'",
      });
      createReadStream(resolved).pipe(response);
    } catch {
      response.writeHead(400).end('Bad request');
    }
  });
  await new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', ok);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    server,
    result: {
      contract: WORKBENCH_CONTRACT,
      kind: 'preview',
      status: 'ready',
      url: `http://127.0.0.1:${port}/`,
      path: relative(root, entryPath).split(sep).join('/'),
      boundary: 'Loopback-only static preview. No terminal or browser-control API is exposed.',
    },
  };
}
