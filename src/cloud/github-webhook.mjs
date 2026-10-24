// GitHub webhooks -> Envoy event cards: the events-in half of the GitHub
// wiring (working list G-2). GitHub POSTs deliveries to
// GITHUB_WEBHOOK_PATH; each delivery is HMAC-SHA256 verified against
// HELMION_GITHUB_WEBHOOK_SECRET (the same secret set on the GitHub side),
// formatted as one plain-text card, and inserted into the Envoy channel
// mapped from the repo full name by HELMION_GITHUB_REPO_CHANNEL_MAP
// (JSON: { "owner/repo": "channel-slug" }).
//
// Auth is the signature, not a session: this route hangs off
// handleEnvoyAblyRoute (live-admin.mjs is frozen) alongside the other
// pre-tenant delegates, and it runs before any tenant check. Inserts use
// the envoy-mesh insert statement verbatim, keyed
// `github:<delivery id>` under the system:github author, so a retried
// delivery can never double-post (same contract as bridgeInbound's
// `discord:<message id>`). Cards are author_kind 'system', so they render
// as notices and never route work to agents. Unmapped repos and
// unresolvable channels are an honest 200 no-op, logged server-side only:
// GitHub retrying would not change either answer.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Pool } from 'pg';
import { publishEnvoyMessage } from './envoy-ably.mjs';
import { messageOut } from './envoy-mesh.mjs';

export const GITHUB_WEBHOOK_PATH = '/api/admin/webhooks/github';
export const GITHUB_WEBHOOK_SECRET_ENV = 'HELMION_GITHUB_WEBHOOK_SECRET';
export const GITHUB_REPO_CHANNEL_MAP_ENV = 'HELMION_GITHUB_REPO_CHANNEL_MAP';
export const GITHUB_SUBJECT = 'system:github';
export const GITHUB_WEBHOOK_MAX_BODY_BYTES = 4 * 1024 * 1024; // Vercel function body ceiling is ~4.5 MB

const MSG_COLS = 'id, channel_id, author_subject, author_kind, body, idempotency_key, created_at';
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REPO_FULL_NAME = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

let sharedPool = null;
function getPool() {
  if (!sharedPool) {
    const connectionString = String(process.env.HELMION_DATABASE_URL ?? '').trim();
    if (!connectionString) throw Object.assign(new Error('database not configured'), { status: 503 });
    sharedPool = new Pool({ connectionString, ssl: connectionString.includes('sslmode=disable') ? false : undefined, max: 3 });
  }
  return sharedPool;
}

const fail = (status, code, message = code) => Object.assign(new Error(message), { status, code });

// The repo -> channel-slug mapping, from HELMION_GITHUB_REPO_CHANNEL_MAP.
// Bad JSON or bad entries degrade to "unmapped" (a logged no-op), never a
// crash: a typo in config must not turn every delivery into a 500 loop.
export function parseRepoChannelMap(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { map: {}, error: null };
  let parsed;
  try { parsed = JSON.parse(String(raw)); } catch { return { map: {}, error: 'invalid_json' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { map: {}, error: 'not_an_object' };
  const map = {};
  for (const [repo, slug] of Object.entries(parsed)) {
    const name = String(repo ?? '').trim();
    const target = String(slug ?? '').trim().toLowerCase();
    if (REPO_FULL_NAME.test(name) && SLUG.test(target)) map[name] = target;
  }
  return { map, error: null };
}

// GitHub signs the exact raw bytes: x-hub-signature-256: sha256=<hmac hex>.
// The secret is only ever fed to the HMAC; it is never logged or returned.
export function verifyGithubSignature({ rawBody, signatureHeader, secret } = {}) {
  const key = String(secret ?? '');
  if (!key || !Buffer.isBuffer(rawBody)) return false;
  const expected = `sha256=${createHmac('sha256', key).update(rawBody).digest('hex')}`;
  const got = String(signatureHeader ?? '');
  if (got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(got, 'utf8'), Buffer.from(expected, 'utf8'));
}

// Single-line, control-char-free text for titles and commit subjects (the
// workspace renders message bodies literally, so cards stay plain text).
function cleanLine(value, max = 300) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function loginOf(payload) {
  const login = String(payload?.sender?.login ?? '').trim();
  return /^[A-Za-z0-9-]{1,64}$/.test(login) ? login : 'someone';
}

function branchOf(ref) {
  const value = String(ref ?? '');
  if (value.startsWith('refs/heads/')) return value.slice('refs/heads/'.length);
  if (value.startsWith('refs/tags/')) return `tag ${value.slice('refs/tags/'.length)}`;
  return value || 'unknown ref';
}

// One event -> one card body, or null when the event/action is outside
// this slice (GitHub still gets its 200; nothing is posted).
export function formatGithubEvent(event, payload) {
  const repo = String(payload?.repository?.full_name ?? '').trim();
  if (!REPO_FULL_NAME.test(repo)) return null;
  const login = loginOf(payload);
  if (event === 'push') {
    const branch = branchOf(payload?.ref);
    const pusher = cleanLine(payload?.pusher?.name, 64) || login;
    if (payload?.deleted === true) return { text: `GitHub: ${pusher} deleted ${branch} in ${repo}` };
    const commits = Array.isArray(payload?.commits) ? payload.commits : [];
    if (commits.length) {
      const head = commits[commits.length - 1] ?? {};
      const subject = cleanLine(String(head?.message ?? '').split('\n')[0]) || 'commit';
      const short = String(head?.id ?? '').slice(0, 7);
      const noun = commits.length === 1 ? 'commit' : 'commits';
      const lines = [`GitHub: ${pusher} pushed ${commits.length} ${noun} to ${repo} (${branch}) — ${subject}${short ? ` (${short})` : ''}`];
      if (typeof payload?.compare === 'string' && /^https:\/\/github\.com\//.test(payload.compare)) lines.push(payload.compare);
      return { text: lines.join('\n').slice(0, 4000) };
    }
    if (payload?.created === true) return { text: `GitHub: ${pusher} created ${branch} in ${repo}` };
    return { text: `GitHub: ${pusher} pushed to ${repo} (${branch})` };
  }
  if (event === 'pull_request' || event === 'issues') {
    const isPr = event === 'pull_request';
    const item = isPr ? payload?.pull_request : payload?.issue;
    const action = String(payload?.action ?? '');
    let verb = null;
    if (action === 'opened' || action === 'reopened') verb = 'opened';
    else if (action === 'closed') verb = isPr && item?.merged === true ? 'merged' : 'closed';
    if (!verb) return null;
    const number = Number(payload?.number ?? item?.number);
    if (!Number.isSafeInteger(number) || number < 1) return null;
    const title = cleanLine(item?.title) || (isPr ? 'pull request' : 'issue');
    const url = typeof item?.html_url === 'string' && /^https:\/\/github\.com\//.test(item.html_url) ? item.html_url : null;
    const lines = [`GitHub: ${login} ${verb} ${isPr ? 'pull request' : 'issue'} #${number} in ${repo} — ${title}`];
    if (url) lines.push(url);
    return { text: lines.join('\n').slice(0, 4000) };
  }
  return null;
}

export function createGithubWebhookStore({ pool, publishImpl = null } = {}) {
  const raw = async (work) => {
    const client = await pool.connect();
    try { await client.query('begin'); const out = await work(client); await client.query('commit'); return out; }
    catch (error) { try { await client.query('rollback'); } catch {} throw error; }
    finally { client.release(); }
  };
  return Object.freeze({
    // Resolve a channel slug to its one channel row. Slugs are unique per
    // tenant, not globally: zero rows = not found, more than one = the map
    // is ambiguous, and both are no-ops at the route.
    async resolveChannelBySlug(slug) {
      const r = await pool.query('select id, tenant_id, slug, title from helmion.envoy_channels where slug=$1 order by id', [slug]);
      if (r.rowCount !== 1) return { channel: null, reason: r.rowCount === 0 ? 'channel_not_found' : 'channel_ambiguous' };
      const row = r.rows[0];
      return { channel: { id: String(row.id), tenantId: String(row.tenant_id), slug: String(row.slug), title: String(row.title) }, reason: null };
    },
    // The envoy-mesh insert, verbatim: same table, same ON CONFLICT key
    // (tenant, channel, author, idempotency key), same receipt shape.
    async postEventCard({ channel, deliveryId, text }) {
      const key = `github:${String(deliveryId ?? '').trim()}`;
      let out = null;
      const result = await raw(async (client) => {
        await client.query(`select set_config('helmion.tenant_id', $1, true)`, [channel.tenantId]);
        const r = await client.query(
          `insert into helmion.envoy_messages(tenant_id, channel_id, author_subject, author_kind, body, idempotency_key)
           values ($1,$2,$3,$4,$5,$6)
           on conflict (tenant_id, channel_id, author_subject, idempotency_key) do nothing
           returning ${MSG_COLS}`,
          [channel.tenantId, channel.id, GITHUB_SUBJECT, 'system', String(text ?? '').slice(0, 4000), key],
        );
        if (r.rowCount === 1) { out = r.rows[0]; return { durable: true, replayed: false, message: messageOut(r.rows[0]) }; }
        const again = await client.query(
          `select ${MSG_COLS} from helmion.envoy_messages where tenant_id=$1 and channel_id=$2 and author_subject=$3 and idempotency_key=$4`,
          [channel.tenantId, channel.id, GITHUB_SUBJECT, key],
        );
        if (!again.rows[0]) throw fail(500, 'GITHUB_RECEIPT_NOT_DURABLE');
        return { durable: true, replayed: true, message: messageOut(again.rows[0]) };
      });
      if (out) void (publishImpl ?? publishEnvoyMessage)({ tenantId: channel.tenantId, channelId: channel.id, message: messageOut(out) });
      return result;
    },
  });
}

// Same streaming cap shape as live-admin's readRawBody, returning the exact
// bytes the signature was computed over.
async function readRawBodyBuffer(request, maxBytes = GITHUB_WEBHOOK_MAX_BODY_BYTES) {
  const declared = Number(request?.headers?.['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) throw fail(413, 'GITHUB_BODY_TOO_LARGE');
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) throw fail(413, 'GITHUB_BODY_TOO_LARGE');
    chunks.push(buf);
  }
  return Buffer.concat(chunks, total);
}

// Route delegate, hung off handleEnvoyAblyRoute like the other pre-tenant
// delegates. Returns false when the path is not ours.
export async function handleGithubWebhookRoute({ request, response, requestUrl, send, env = process.env, store = null, log = (...args) => console.log(...args) } = {}) {
  if (requestUrl?.pathname !== GITHUB_WEBHOOK_PATH) return false;
  const reply = (status, body) => send(response, status, JSON.stringify(body));
  if (request?.method !== 'POST') { reply(405, { valid: false, code: 'GITHUB_METHOD_NOT_ALLOWED' }); return true; }
  const secret = String(env?.[GITHUB_WEBHOOK_SECRET_ENV] ?? '');
  if (!secret) { reply(503, { valid: false, code: 'GITHUB_WEBHOOK_NOT_CONFIGURED' }); return true; }
  let rawBody;
  try { rawBody = await readRawBodyBuffer(request); }
  catch (error) { reply(error?.status === 413 ? 413 : 400, { valid: false, code: error?.code ?? 'GITHUB_BODY_INVALID' }); return true; }
  if (!verifyGithubSignature({ rawBody, signatureHeader: request?.headers?.['x-hub-signature-256'], secret })) {
    reply(401, { valid: false, code: 'GITHUB_SIGNATURE_INVALID' });
    return true;
  }
  let payload;
  try { payload = JSON.parse(rawBody.toString('utf8')); } catch { reply(400, { valid: false, code: 'GITHUB_PAYLOAD_INVALID' }); return true; }
  const event = String(request?.headers?.['x-github-event'] ?? '').trim();
  const deliveryId = String(request?.headers?.['x-github-delivery'] ?? '').trim();
  if (event === 'ping') { reply(200, { valid: true, pong: true }); return true; }
  if (!deliveryId) { reply(400, { valid: false, code: 'GITHUB_DELIVERY_MISSING' }); return true; }
  const formatted = formatGithubEvent(event, payload);
  if (!formatted) { reply(200, { valid: true, posted: false, reason: 'event_ignored' }); return true; }
  const repoFullName = String(payload?.repository?.full_name ?? '').trim();
  const { map, error: mapError } = parseRepoChannelMap(env?.[GITHUB_REPO_CHANNEL_MAP_ENV]);
  if (mapError) log(`github webhook: ${GITHUB_REPO_CHANNEL_MAP_ENV} is unusable (${mapError}); treating every repo as unmapped`);
  const slug = map[repoFullName];
  if (!slug) {
    log(`github webhook: delivery ${deliveryId} for unmapped repo ${repoFullName} (${event}); no post`);
    reply(200, { valid: true, posted: false, reason: 'repo_not_mapped' });
    return true;
  }
  let storeImpl = store;
  if (!storeImpl) {
    try { storeImpl = createGithubWebhookStore({ pool: getPool() }); }
    catch { reply(503, { valid: false, code: 'GITHUB_WEBHOOK_STORE_UNAVAILABLE' }); return true; }
  }
  try {
    const { channel, reason } = await storeImpl.resolveChannelBySlug(slug);
    if (!channel) {
      log(`github webhook: delivery ${deliveryId} for ${repoFullName} maps to slug ${slug}, which did not resolve (${reason}); no post`);
      reply(200, { valid: true, posted: false, reason });
      return true;
    }
    const result = await storeImpl.postEventCard({ channel, deliveryId, text: formatted.text });
    reply(200, { valid: true, posted: true, replayed: result.replayed === true });
  } catch (error) {
    log(`github webhook: delivery ${deliveryId} for ${repoFullName} failed: ${error?.message ?? error}`);
    reply(500, { valid: false, code: 'GITHUB_WEBHOOK_FAILED' });
  }
  return true;
}
