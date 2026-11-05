// Device side of the profile-sync job (S1, 2026-11-05): run the Agent
// OS installer for real and turn its per-file plan into the report the
// cloud job carries back — one entry per file the installer actually
// wrote (its create / update / append actions), with the sha256 of the
// bytes read BACK from the disk after the write. Files the installer
// skipped (already in place) are not reported: a no-op sync reports an
// empty list, never a success story. If a written file cannot be read
// back, the whole run fails — a report that cannot be verified is not
// sent as one.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { installAgentOsTargets, AGENT_OS_TARGETS } from './agent-os.mjs';

const WRITTEN_ACTIONS = new Map([
  ['create', 'created'],
  ['update', 'updated'],
  ['append', 'updated'],
]);

export async function buildWrittenFileReport(installResult, { readFileImpl = readFile } = {}) {
  const files = [];
  for (const targetResult of installResult?.targets ?? []) {
    for (const file of targetResult?.files ?? []) {
      const action = WRITTEN_ACTIONS.get(file?.action);
      if (!action) continue;
      const fullPath = join(targetResult.directory, file.path);
      const bytes = await readFileImpl(fullPath);
      files.push({
        target: String(targetResult.target ?? ''),
        path: fullPath,
        action,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }
  }
  return files;
}

export async function executeProfileSync({
  home,
  targets = AGENT_OS_TARGETS,
  installImpl = installAgentOsTargets,
  readFileImpl = readFile,
} = {}) {
  const installResult = await installImpl({ targets, apply: true, home });
  const files = await buildWrittenFileReport(installResult, { readFileImpl });
  return { files, targets: installResult?.targets?.map((t) => t.target) ?? [] };
}
