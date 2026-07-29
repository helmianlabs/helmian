// Loads one of the extension's content scripts into a sandbox and hands back
// what it published.
//
// The point is that the tests run the exact file Chrome runs. Nothing is
// re-implemented for testing, so a test passing means that file works, not that
// a copy of it works.

import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const EXTENSION_ROOT = path.resolve(HERE, '..');

export async function loadContentScript(relativePath, extras = {}) {
  return loadContentScripts([relativePath], extras);
}

// Loads several content scripts into ONE shared sandbox, in order — the same
// way Chrome loads the list in manifest.json. Order matters: guard.js calls the
// other three the moment it loads.
export async function loadContentScripts(relativePaths, extras = {}) {
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    ...extras,
  };
  vm.createContext(sandbox);

  for (const relativePath of relativePaths) {
    const file = path.join(EXTENSION_ROOT, relativePath);
    const source = await readFile(file, 'utf8');
    vm.runInContext(source, sandbox, { filename: file });
  }

  return sandbox;
}
