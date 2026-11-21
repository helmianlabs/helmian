// The on-disk home of the synced weighting profile (Milestone 4 of Scribe
// 1154). Node-side companion to provenance-profile-sync.mjs: the contract
// module is browser-safe and holds no filesystem; this one does the reading
// and writing, in the workspace state directory the provenance ledger
// already uses (.helmion/).
//
// loadSyncedProvenanceProfile(root) is the apply path every device and agent
// uses after Profile Sync delivers the file:
//   - no file        -> { source: 'default', profile: defaults, policy:
//                        buildProvenancePolicy(defaults) } — named as
//                        default, never dressed as synced;
//   - a valid file   -> { source: 'synced', profile, policy, updatedAt };
//   - a corrupt file -> throws ProvenanceProfileSyncError. A surface that
//                        cannot read the user's synced choices must say so,
//                        not silently run on defaults.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { resolveWeightingProfile } from './provenance-verification.mjs';
import { buildProvenancePolicy } from './provenance-policy.mjs';
import {
  PROVENANCE_PROFILE_RELATIVE_PATH,
  ProvenanceProfileSyncError,
  applyProvenanceSyncPayload,
  createProvenanceSyncPayload,
  parseProvenanceProfileFile,
  renderProvenanceProfileFile,
} from './provenance-profile-sync.mjs';

export function provenanceProfilePath(root) {
  if (typeof root !== 'string' || root.trim() === '') {
    throw new ProvenanceProfileSyncError('a workspace root is required');
  }
  return join(root, PROVENANCE_PROFILE_RELATIVE_PATH);
}

/** Write the user's profile as the synced file. Returns the payload. */
export async function saveSyncedProvenanceProfile(root, profile, { now = new Date(), source = null } = {}) {
  const payload = createProvenanceSyncPayload(profile, { now, source });
  const path = provenanceProfilePath(root);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, renderProvenanceProfileFile(payload), 'utf8');
  return payload;
}

/** Read the synced profile, or the named default when none has synced. */
export async function loadSyncedProvenanceProfile(root) {
  const path = provenanceProfilePath(root);
  let content;
  try {
    content = await readFile(path, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') {
      const profile = resolveWeightingProfile(null);
      return {
        source: 'default',
        profile,
        policy: buildProvenancePolicy(profile),
        updatedAt: null,
      };
    }
    throw err;
  }
  const applied = applyProvenanceSyncPayload(parseProvenanceProfileFile(content));
  return { source: 'synced', ...applied };
}
