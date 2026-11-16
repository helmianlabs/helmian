// Device side of the profile-sync job (S1, 2026-11-05): run the Agent
// OS installer for real and turn its per-file plan into the report the
// cloud job carries back — one entry per file the installer wrote (its
// create / update / append actions) AND per file it examined and found
// already current (its unchanged action, reported as "current"), each
// with the sha256 of the bytes read BACK from the disk after the run.
// A seat that was already up to date is reported as current, with its
// hash — never silently dropped, so a report that names no change for
// a seat still proves what that seat is running. Files the installer
// skipped (user files left untouched, merges it could not safely run)
// are not reported: the report vouches only for bytes it read back. If
// a reported file cannot be read back, the whole run fails — a report
// that cannot be verified is not sent as one.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { installAgentOsTargets, AGENT_OS_TARGETS } from './agent-os.mjs';

const REPORT_ACTIONS = new Map([
  ['create', 'created'],
  ['update', 'updated'],
  ['append', 'updated'],
  ['unchanged', 'current'],
]);

export async function buildProfileSyncFileReport(installResult, { readFileImpl = readFile } = {}) {
  const files = [];
  for (const targetResult of installResult?.targets ?? []) {
    for (const file of targetResult?.files ?? []) {
      const action = REPORT_ACTIONS.get(file?.action);
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

// Kept for callers written against the written-only report's name.
export const buildWrittenFileReport = buildProfileSyncFileReport;

export async function executeProfileSync({
  home,
  targets = AGENT_OS_TARGETS,
  installImpl = installAgentOsTargets,
  readFileImpl = readFile,
} = {}) {
  const installResult = await installImpl({ targets, apply: true, home });
  const files = await buildProfileSyncFileReport(installResult, { readFileImpl });
  return { files, targets: installResult?.targets?.map((t) => t.target) ?? [] };
}
