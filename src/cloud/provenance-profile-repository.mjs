// Tenant provenance weighting profiles (Scribe 1154, Milestones 3+4):
// the cloud half of Profile Sync for provenance. One row per tenant holds
// the Milestone 4 sync payload — the resolved weighting profile plus the
// guardrail policy it builds — validated as a unit on the way in AND on
// the way out, so a stored payload whose policy no longer matches its
// profile is refused rather than served. A tenant that has never saved
// reads back the default profile's payload, named as default.

import { requireActiveTenantMembership, withTenantTransaction } from '../core/tenant-context.mjs';
import {
  createProvenanceSyncPayload,
  validateProvenanceSyncPayload,
  ProvenanceProfileSyncError,
} from '../core/provenance-profile-sync.mjs';
import { DEFAULT_WEIGHTING_PROFILE } from '../core/provenance-verification.mjs';

function context(actor) {
  if (!actor?.tenantId || !actor.subject || !actor.role || !actor.sessionId || !actor.requestId) {
    throw new Error('verified Organization membership is required');
  }
  return { tenantId: actor.tenantId, actorSubject: actor.subject, actorRole: actor.role, sessionId: actor.sessionId, requestId: actor.requestId };
}

function defaultPayload() {
  return createProvenanceSyncPayload(DEFAULT_WEIGHTING_PROFILE, { source: 'default' });
}

function assertValidPayload(payload) {
  const check = validateProvenanceSyncPayload(payload);
  if (!check.valid) {
    throw new ProvenanceProfileSyncError(`stored provenance payload is invalid: ${check.errors.join('; ')}`);
  }
  return payload;
}

export function createProvenanceProfileRepository(pool) {
  return Object.freeze({
    async read(actor) {
      const active = context(actor);
      return withTenantTransaction(pool, active, async (client) => {
        await requireActiveTenantMembership(client, active);
        const result = await client.query(
          'select payload, updated_by_subject, updated_at from helmion.provenance_weighting_profiles where tenant_id=$1',
          [active.tenantId],
        );
        if (result.rowCount !== 1) return { source: 'default', payload: defaultPayload() };
        // A stored payload is re-validated on every read: if the row was
        // written by anything other than this repository, its policy must
        // still match its profile or the read fails closed.
        const payload = assertValidPayload(result.rows[0].payload);
        return {
          source: 'saved',
          payload,
          updatedBy: result.rows[0].updated_by_subject,
          updatedAt: result.rows[0].updated_at,
        };
      });
    },

    async save(actor, input) {
      const active = context(actor);
      if (!input || typeof input !== 'object' || Array.isArray(input) || !('profile' in input)) {
        throw Object.assign(new Error('a profile object is required'), { status: 400 });
      }
      let payload;
      try {
        payload = createProvenanceSyncPayload(input.profile, { source: 'helmian-settings' });
      } catch (err) {
        if (err instanceof ProvenanceProfileSyncError) {
          throw Object.assign(new Error(err.message), { status: 400 });
        }
        throw err;
      }
      return withTenantTransaction(pool, active, async (client) => {
        await requireActiveTenantMembership(client, active);
        const result = await client.query(
          `insert into helmion.provenance_weighting_profiles (tenant_id, payload, updated_by_subject)
           values ($1, $2::jsonb, $3)
           on conflict (tenant_id) do update set payload=excluded.payload,
             updated_by_subject=excluded.updated_by_subject, updated_at=clock_timestamp()
           returning payload, updated_by_subject, updated_at`,
          [active.tenantId, JSON.stringify(payload), active.actorSubject],
        );
        return {
          source: 'saved',
          payload: assertValidPayload(result.rows[0].payload),
          updatedBy: result.rows[0].updated_by_subject,
          updatedAt: result.rows[0].updated_at,
        };
      });
    },
  });
}
