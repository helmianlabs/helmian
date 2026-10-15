// Organization invite links (join as member) and desktop app links (Envoy chat in the EXE).
// Raw tokens are returned once to the caller and only their SHA-256 hashes are stored.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { withTenantTransaction, requireActiveTenantMembership } from '../core/tenant-context.mjs';
import { appendAuditEvent } from './audit-event-repository.mjs';

export const INVITE_TOKEN = /^hinv_[A-Za-z0-9_-]{32,64}$/;
export const DESKTOP_CODE = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
export const DESKTOP_TOKEN = /^hdt_[A-Za-z0-9_-]{40,80}$/;
const sha = (v) => createHash('sha256').update(String(v)).digest('hex');
const err = (status, code, message) => Object.assign(new Error(message), { status, code });
const ADMIN = new Set(['owner', 'admin']);

export function newInviteToken() { return `hinv_${randomBytes(24).toString('base64url')}`; }
export function newDesktopToken() { return `hdt_${randomBytes(32).toString('base64url')}`; }
export function newDesktopCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const b = randomBytes(8);
  const s = [...b].map((x) => alphabet[x % alphabet.length]).join('');
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}
export const hashSecret = sha;

export function normalizeInviteInput(input = {}) {
  const days = input.expiresInDays == null ? 7 : Number(input.expiresInDays);
  const maxUses = input.maxUses == null ? 25 : Number(input.maxUses);
  if (!Number.isInteger(days) || days < 1 || days > 30) throw err(400, 'INVITE_INVALID', 'expiresInDays must be 1-30');
  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 500) throw err(400, 'INVITE_INVALID', 'maxUses must be 1-500');
  return { days, maxUses };
}

const ctx = (actor) => ({ tenantId: actor.tenantId, actorSubject: actor.subject, actorRole: actor.role, sessionId: actor.sessionId ?? randomUUID(), requestId: actor.requestId ?? randomUUID() });

export function createOrgInviteStore(pool, { now = () => new Date() } = {}) {
  return Object.freeze({
    async create(actor, input, origin) {
      if (!ADMIN.has(actor?.role)) throw err(403, 'INVITE_FORBIDDEN', 'owner or admin required');
      const { days, maxUses } = normalizeInviteInput(input);
      const token = newInviteToken();
      const expiresAt = new Date(now().getTime() + days * 86_400_000);
      return withTenantTransaction(pool, ctx(actor), async (client, scoped) => {
        await requireActiveTenantMembership(client, scoped);
        const r = await client.query('insert into helmion.organization_invites(tenant_id, token_hash, role, created_by_subject, expires_at, max_uses) values ($1,$2,$3,$4,$5,$6) returning id, created_at, expires_at, max_uses', [scoped.tenantId, sha(token), 'member', scoped.actorSubject, expiresAt.toISOString(), maxUses]);
        await appendAuditEvent(client, scoped, { actionType: 'organization.invite.created', canonicalTarget: { inviteId: String(r.rows[0].id) }, policyVersion: 'org-invites.v1', decision: 'ALLOW', privacySummary: 'Created a team invite link', result: { maxUses, expiresAt: expiresAt.toISOString() } });
        return { invite: { id: String(r.rows[0].id), url: `${origin}/join?token=${token}`, expiresAt: r.rows[0].expires_at, maxUses } };
      });
    },
    async list(actor) {
      if (!ADMIN.has(actor?.role)) throw err(403, 'INVITE_FORBIDDEN', 'owner or admin required');
      return withTenantTransaction(pool, ctx(actor), async (client, scoped) => {
        await requireActiveTenantMembership(client, scoped);
        const r = await client.query('select id, created_at, expires_at, max_uses, use_count, revoked_at from helmion.organization_invites where tenant_id=$1 order by created_at desc limit 50', [scoped.tenantId]);
        return { invites: r.rows.map((x) => ({ id: String(x.id), createdAt: x.created_at, expiresAt: x.expires_at, maxUses: x.max_uses, useCount: x.use_count, active: !x.revoked_at && new Date(x.expires_at) > now() && x.use_count < x.max_uses })) };
      });
    },
    async revoke(actor, id) {
      if (!ADMIN.has(actor?.role)) throw err(403, 'INVITE_FORBIDDEN', 'owner or admin required');
      if (!/^[0-9a-f-]{36}$/i.test(String(id ?? ''))) throw err(400, 'INVITE_INVALID', 'invite id is invalid');
      return withTenantTransaction(pool, ctx(actor), async (client, scoped) => {
        await requireActiveTenantMembership(client, scoped);
        const r = await client.query('update helmion.organization_invites set revoked_at=clock_timestamp() where tenant_id=$1 and id=$2 and revoked_at is null returning id', [scoped.tenantId, id]);
        if (r.rowCount === 1) await appendAuditEvent(client, scoped, { actionType: 'organization.invite.revoked', canonicalTarget: { inviteId: String(id) }, policyVersion: 'org-invites.v1', decision: 'ALLOW', privacySummary: 'Turned off a team invite link', result: { revoked: true } });
        return { revoked: r.rowCount === 1 };
      });
    },
    // Public preview for the /join page: never reveals the token or member list.
    async preview(token) {
      if (!INVITE_TOKEN.test(String(token ?? ''))) throw err(400, 'INVITE_INVALID', 'invite link is invalid');
      const client = await pool.connect();
      try {
        const r = await client.query('select i.expires_at, i.max_uses, i.use_count, i.revoked_at, t.display_name from helmion.organization_invites i join helmion.tenants t on t.tenant_id=i.tenant_id where i.token_hash=$1', [sha(token)]);
        const x = r.rows[0];
        if (!x || x.revoked_at || new Date(x.expires_at) <= now() || x.use_count >= x.max_uses) throw err(410, 'INVITE_EXPIRED', 'This invite link has expired');
        return { organization: String(x.display_name), role: 'member' };
      } finally { client.release(); }
    },
    async redeem(subject, token) {
      if (!subject) throw err(403, 'IDENTITY_REQUIRED', 'sign in first');
      if (!INVITE_TOKEN.test(String(token ?? ''))) throw err(400, 'INVITE_INVALID', 'invite link is invalid');
      const client0 = await pool.connect();
      let invite; let existing;
      try {
        invite = (await client0.query('select id, tenant_id, expires_at, max_uses, use_count, revoked_at from helmion.organization_invites where token_hash=$1', [sha(token)])).rows[0];
        existing = (await client0.query('select tenant_id, role from helmion.tenant_memberships where subject=$1 and active', [subject])).rows;
      } finally { client0.release(); }
      if (!invite || invite.revoked_at || new Date(invite.expires_at) <= now() || invite.use_count >= invite.max_uses) throw err(410, 'INVITE_EXPIRED', 'This invite link has expired');
      if (existing.some((m) => m.tenant_id === invite.tenant_id)) return { tenantId: invite.tenant_id, joined: false, role: existing.find((m) => m.tenant_id === invite.tenant_id).role };
      if (existing.length) throw err(409, 'ALREADY_IN_ORGANIZATION', 'This account already belongs to another organization');
      return withTenantTransaction(pool, { tenantId: invite.tenant_id, actorSubject: subject, actorRole: 'member', sessionId: randomUUID(), requestId: randomUUID() }, async (client, scoped) => {
        const used = await client.query('update helmion.organization_invites set use_count=use_count+1 where id=$1 and revoked_at is null and expires_at > clock_timestamp() and use_count < max_uses returning id', [invite.id]);
        if (used.rowCount !== 1) throw err(410, 'INVITE_EXPIRED', 'This invite link has expired');
        await client.query("insert into helmion.tenant_memberships(tenant_id, subject, role, active) values ($1,$2,'member',true) on conflict (tenant_id, subject) do nothing", [scoped.tenantId, subject]);
        await client.query('insert into helmion.organization_invite_redemptions(invite_id, tenant_id, subject) values ($1,$2,$3) on conflict do nothing', [invite.id, scoped.tenantId, subject]);
        await appendAuditEvent(client, scoped, { actionType: 'organization.member.joined', canonicalTarget: { inviteId: String(invite.id), subject }, policyVersion: 'org-invites.v1', decision: 'ALLOW', privacySummary: 'A new member joined with an invite link', result: { role: 'member' } });
        return { tenantId: scoped.tenantId, joined: true, role: 'member' };
      });
    },

    // ---- desktop links ----
    async startDesktopLink(actor, label = null) {
      const code = newDesktopCode();
      const l = label == null ? null : String(label).trim().slice(0, 80) || null;
      return withTenantTransaction(pool, ctx(actor), async (client, scoped) => {
        await requireActiveTenantMembership(client, scoped);
        await client.query('insert into helmion.desktop_links(tenant_id, subject, code_hash, code_expires_at, label) values ($1,$2,$3,$4,$5)', [scoped.tenantId, scoped.actorSubject, sha(code), new Date(now().getTime() + 10 * 60_000).toISOString(), l]);
        return { code, expiresInSeconds: 600 };
      });
    },
    async exchangeDesktopCode(code) {
      const c = String(code ?? '').trim().toUpperCase();
      if (!DESKTOP_CODE.test(c)) throw err(400, 'DESKTOP_CODE_INVALID', 'code is invalid');
      const token = newDesktopToken();
      const client = await pool.connect();
      try {
        await client.query('begin');
        const r = await client.query('update helmion.desktop_links set token_hash=$2, linked_at=clock_timestamp(), code_expires_at=clock_timestamp() where code_hash=$1 and token_hash is null and revoked_at is null and code_expires_at > clock_timestamp() returning tenant_id, subject', [sha(c), sha(token)]);
        await client.query('commit');
        if (r.rowCount !== 1) throw err(410, 'DESKTOP_CODE_EXPIRED', 'code expired or already used');
        return { token, tenantId: String(r.rows[0].tenant_id) };
      } catch (e) { try { await client.query('rollback'); } catch {} throw e; } finally { client.release(); }
    },
    async desktopIdentity(token) {
      if (!DESKTOP_TOKEN.test(String(token ?? ''))) return null;
      const client = await pool.connect();
      try {
        const r = await client.query('update helmion.desktop_links set last_used_at=clock_timestamp() where token_hash=$1 and revoked_at is null returning subject, tenant_id', [sha(token)]);
        return r.rowCount === 1 ? { subject: String(r.rows[0].subject), tenantId: String(r.rows[0].tenant_id) } : null;
      } finally { client.release(); }
    },
    async revokeDesktopToken(token) {
      if (!DESKTOP_TOKEN.test(String(token ?? ''))) return { revoked: false };
      const client = await pool.connect();
      try { const r = await client.query('update helmion.desktop_links set revoked_at=clock_timestamp() where token_hash=$1 and revoked_at is null', [sha(token)]); return { revoked: r.rowCount === 1 }; }
      finally { client.release(); }
    },
  });
}
