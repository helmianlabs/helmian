// Workspace canvas: per-project scratchpad (note box + decision box), the
// cloud counterpart of the desktop Canvas tab. One row per (tenant, project);
// saving upserts. Any active tenant member may read or write (it is a shared
// project scratchpad, like the desktop's). Canvas text is untrusted user
// input: the store bounds its length, and renderers must escape it.
//
// Route handling lives here next to the store so the live admin handler only
// imports and delegates (live-admin.mjs is near the push tool's size limit).

import { withTenantTransaction, requireActiveTenantMembership } from '../core/tenant-context.mjs';
import { appendAuditEvent } from './audit-event-repository.mjs';

export const CANVAS_PATH = '/api/admin/workspace/canvas';

const MAX_CANVAS_TEXT = 32768;

function assertProjectKey(value) {
  const key = String(value ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._:-]{0,95}$/.test(key) || key.includes('..') || /^[a-z]:/.test(key)) {
    throw Object.assign(new Error('workspace project key is invalid'), { status: 400 });
  }
  return key;
}

function boundedCanvasText(value, name) {
  const text = String(value ?? '');
  if (text.length > MAX_CANVAS_TEXT) {
    throw Object.assign(new Error(`${name} exceeds the ${MAX_CANVAS_TEXT}-character limit`), { status: 400 });
  }
  return text;
}

function emptyCanvas(projectKey) {
  return Object.freeze({ projectKey, noteText: '', decisionText: '', updatedAt: null });
}

export function createCanvasStore(pool) {
  if (!pool?.connect) throw new Error('canvas store needs a Postgres pool');

  async function read(actor, projectKey) {
    const context = {
      tenantId: actor.tenantId,
      actorSubject: actor.subject,
      actorRole: actor.role,
      sessionId: actor.sessionId,
      requestId: actor.requestId,
    };
    return withTenantTransaction(pool, context, async (client) => {
      await requireActiveTenantMembership(client, context);
      try {
        const result = await client.query(
          `select note_text, decision_text, updated_at
           from helmion.workspace_project_canvases
           where tenant_id = $1 and project_key = $2`,
          [context.tenantId, projectKey],
        );
        if (result.rowCount !== 1) return { ...emptyCanvas(projectKey), canvasUnavailable: false };
        const row = result.rows[0];
        return {
          projectKey,
          noteText: String(row.note_text ?? ''),
          decisionText: String(row.decision_text ?? ''),
          updatedAt: row.updated_at == null ? null : new Date(row.updated_at).toISOString(),
        };
      } catch (error) {
        // Migration 053 not applied yet: report the canvas as unavailable
        // instead of failing the request.
        if (error?.code === '42P01') return { ...emptyCanvas(projectKey), canvasUnavailable: true };
        throw error;
      }
    });
  }

  return Object.freeze({
    async load(actor, projectKeyInput) {
      return read(actor, assertProjectKey(projectKeyInput));
    },

    async save(actor, input) {
      const projectKey = assertProjectKey(input?.projectKey);
      const noteText = boundedCanvasText(input?.noteText, 'note text');
      const decisionText = boundedCanvasText(input?.decisionText, 'decision text');
      const context = {
        tenantId: actor.tenantId,
        actorSubject: actor.subject,
        actorRole: actor.role,
        sessionId: actor.sessionId,
        requestId: actor.requestId,
      };
      return withTenantTransaction(pool, context, async (client) => {
        await requireActiveTenantMembership(client, context);
        const project = await client.query(
          `select 1 from helmion.workspace_projects where tenant_id = $1 and project_key = $2`,
          [context.tenantId, projectKey],
        );
        if (project.rowCount !== 1) throw Object.assign(new Error('workspace project was not found'), { status: 404 });
        try {
          await client.query(
            `insert into helmion.workspace_project_canvases (tenant_id, project_key, note_text, decision_text, updated_at)
             values ($1, $2, $3, $4, clock_timestamp())
             on conflict (tenant_id, project_key)
             do update set note_text = excluded.note_text, decision_text = excluded.decision_text, updated_at = clock_timestamp()`,
            [context.tenantId, projectKey, noteText, decisionText],
          );
        } catch (error) {
          if (error?.code === '42P01') throw Object.assign(new Error('workspace canvas is not available yet'), { status: 503 });
          throw error;
        }
        const receiptId = await appendAuditEvent(client, context, {
          actionType: 'workspace.canvas.saved',
          canonicalTarget: { resource: 'workspace_project_canvas', projectKey },
          policyVersion: 'workspace-canvas.v1',
          decision: 'ALLOW',
          privacySummary: 'Project scratchpad saved; canvas text is user content and is never sent to a provider',
          result: {
            projectKey,
            noteChars: noteText.length,
            decisionChars: decisionText.length,
            execution: 'not_performed',
            providerInvocation: 'not_performed',
          },
        });
        return { durable: true, receiptId, projectKey };
      });
    },
  });
}

// HTTP route handling for the canvas reads/writes. Returns true when the
// request was handled, false when it is not a canvas route.
export async function handleCanvasRoute({ request, response, requestUrl, pool, canvas, activeTenantActor, send, readJsonObject, exactKeys, TenantAuthorizationError }) {
  const membershipError = (error) => error?.status === 403 || error instanceof TenantAuthorizationError;
  if (requestUrl.pathname !== CANVAS_PATH) return false;
  const store = canvas ?? createCanvasStore(pool);
  if (request.method === 'GET') {
    try {
      const actor = await activeTenantActor(request);
      send(response, 200, JSON.stringify({ valid: true, ...(await store.load(actor, requestUrl.searchParams.get('projectKey'))) }));
    } catch (error) {
      send(response, membershipError(error) ? 403 : error?.status === 400 ? 400 : 503, JSON.stringify({ valid: false, code: membershipError(error) ? 'CANVAS_MEMBERSHIP_REQUIRED' : error?.status === 400 ? 'CANVAS_PROJECT_INVALID' : 'CANVAS_READ_FAILED' }));
    }
    return true;
  }
  if (request.method === 'PUT') {
    try {
      const actor = await activeTenantActor(request);
      const body = await readJsonObject(request);
      exactKeys(body, ['projectKey', 'noteText', 'decisionText']);
      if (Object.prototype.hasOwnProperty.call(body, 'tenantId')) throw new Error('tenant selector is not accepted');
      send(response, 200, JSON.stringify({ valid: true, ...(await store.save(actor, body)) }));
    } catch (error) {
      const status = membershipError(error) ? 403 : error?.status === 404 ? 404 : error?.status === 503 ? 503 : 400;
      send(response, status, JSON.stringify({ valid: false, code: status === 403 ? 'CANVAS_MEMBERSHIP_REQUIRED' : status === 404 ? 'CANVAS_PROJECT_NOT_FOUND' : status === 503 ? 'CANVAS_MIGRATION_PENDING' : 'CANVAS_SAVE_INVALID' }));
    }
    return true;
  }
  return false;
}
