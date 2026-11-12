// Connector tenant-pair form — the panel-native face for the
// providers whose OAuth road runs on a client pair minted PER
// CUSTOMER (Troy's ruling, 2026-11-10; REGISTRATION-PACK §§9–10).
// Pure model + the exact wire shapes of the connector library's
// pair roads — no DOM, no fetch of its own — so it is unit tested
// like connector-panel.mjs; envoy-workspace.js renders it inside
// the channel connector panel and hands it the workspace's own
// post function. It mirrors connector-key-form.mjs's discipline
// throughout.
//
// WHY THIS FACE EXISTS. Box and Salesforce offer Helmian no
// registration of its own: their MCP roads run on integration
// credentials the CUSTOMER's admin mints in the provider's own
// console (the Box Admin Console; Salesforce Setup), with
// Helmian's callback as the redirect. The pair-entry form is
// therefore the provider's ONLY road in — there is no Helmian
// registration that could substitute for it, which is why this
// shape was put to Troy and approved. The server roads:
//
//   POST /api/admin/connector-library/connect        { seatId, entryId }
//     → with no pair stored, a tenant-pair entry answers
//       { status:'needs-tenant-pair', seatId, entryId, provider,
//         note } — the note names the provider, its console, and
//       the step — and connects nothing.
//   POST /api/admin/connector-library/tenant-pair/status { provider }
//     → { status:'pair-status', provider, pairConfigured } — the
//       ONE fact the form needs about the stored pair, answered
//       server-side; the pair's values never leave that hop.
//       Owner/admin only (the pair is a workspace credential).
//   POST /api/admin/connector-library/tenant-pair
//       { provider, clientId, clientSecret, serverPath? }
//     → { status:'pair-stored', provider, pairConfigured:true } —
//       the ONE action that ever receives pair values: they go
//       straight to the credential service as the tenant's
//       'client_pair' record and are never written to a library
//       record or echoed in an answer. Replacing a stored pair
//       routes through the vault's Guard replacement gate; a
//       refusal answers with the gate's standing in plain words.
//
// THE PAIR IS THE TENANT'S. The form names a provider, never a
// seat or a person: the pair the admin stores serves every
// connection of that provider in the workspace, on every agent.
//
// TRUTH RULES (flywheel R52 §3, restated for this face):
// - The form NEVER renders a secret back: the secret field
//   starts empty every time the form opens — first store and
//   Replace alike — and no model in this module carries a pair
//   value. A stored pair's presence is shown as state ("A client
//   pair is stored for Box"), never as a value.
// - The form's stored state comes from the server's own answers:
//   the status action when the form opens, and the store action's
//   answer after a submit (applyPairStored). The form declares
//   nothing stored from its own field values.
// - A refused write surfaces the server's answer in plain words
//   in the form, and the model stands unchanged.
// - An incomplete pair is refused HERE, before any road is
//   called, with the road's own refusal words (EMPTY_PAIR_MESSAGE,
//   the write route's tenant-pair refusal, mirrored).

// The server roads, named once.
export const PAIR_PATH = '/api/admin/connector-library/tenant-pair';
export const PAIR_STATUS_PATH = '/api/admin/connector-library/tenant-pair/status';

// The callback every provider console registration must carry —
// the form shows it because the admin needs it AT the console
// while minting the pair.
export const PAIR_CALLBACK_URL = 'https://helmian.cloud/api/admin/connector-library/oauth/callback';

// The road's own refusal for an incomplete pair (connector-
// library-write-route.mjs, the tenant-pair action): the client
// mirror refuses with the same words, so the person reads one
// answer either way.
export const EMPTY_PAIR_MESSAGE = 'the client pair itself is required on this one action — it is stored in the credential service and never written to the library record';

// Per-provider facts: the console the pair is minted in, the
// console's own names for the two values, and the minting steps
// in plain words. The fields are built from these facts, so a
// provider's form always speaks its own console's language.
const PROVIDER_FACTS = Object.freeze({
  box: Object.freeze({
    displayName: 'Box',
    consoleName: 'the Box Admin Console',
    idLabel: 'Client ID',
    secretLabel: 'Client Secret',
    mintWords: 'In the Box Admin Console, open Integrations, then the Box MCP server: enable it, choose Configure, then Additional Configuration, then Add Integration Credentials. Set the redirect URI to Helmian\u2019s callback address below, and select the access the connection may use.',
    serverPath: null,
  }),
  salesforce: Object.freeze({
    displayName: 'Salesforce',
    consoleName: 'Salesforce Setup',
    idLabel: 'Client ID',
    secretLabel: 'Client Secret',
    mintWords: 'In Salesforce Setup, turn on MCP Servers, then create an External Client App with OAuth enabled and Helmian\u2019s callback address below as its callback URL, with the mcp_api and refresh_token access selected. Setup shows the app\u2019s client pair, and the MCP Servers page shows your org\u2019s server path — the pair form takes both.',
    // Salesforce's endpoint is per org: the pair is incomplete
    // without the server path, which the write route composes
    // onto the provider's fixed host at the store.
    serverPath: Object.freeze({
      label: 'MCP server path (from Salesforce Setup, under MCP Servers)',
      placeholder: 'platform/sobject-reads',
    }),
  }),
});

/** The console facts for a pair provider, or null. */
export function pairProviderFacts(provider) {
  return PROVIDER_FACTS[String(provider ?? '').trim().toLowerCase()] ?? null;
}

/**
 * The fields the pair form carries for a provider, in road
 * order: the client id (plain text — the console shows it openly)
 * and the client secret (password semantics, write-only), plus
 * the provider's server-path field when its facts declare one.
 * The length caps mirror the write route's own, as field caps —
 * never as a silent edit of a secret.
 */
export function pairFormFields(provider) {
  const facts = pairProviderFacts(provider);
  if (!facts) return Object.freeze([]);
  const fields = [
    Object.freeze({ name: 'clientId', label: facts.idLabel, kind: 'text', type: 'text', autocomplete: 'off', placeholder: facts.idLabel, required: true, maxLength: 512 }),
    Object.freeze({ name: 'clientSecret', label: facts.secretLabel, kind: 'secret', type: 'password', autocomplete: 'off', placeholder: facts.secretLabel, required: true, maxLength: 8192 }),
  ];
  if (facts.serverPath) {
    fields.push(Object.freeze({
      name: 'serverPath', label: facts.serverPath.label, kind: 'text', type: 'text', autocomplete: 'off',
      placeholder: facts.serverPath.placeholder, required: true, maxLength: 256,
    }));
  }
  return Object.freeze(fields);
}

/** Is this connect-start answer the tenant-pair signal? */
export function isNeedsTenantPairAnswer(out) {
  return out?.status === 'needs-tenant-pair';
}

/**
 * The form's model. pairConfigured is tri-state: true / false
 * from the status answer, or null when no answer has landed
 * (the form opens in that state and the workspace fills it from
 * the status road before the fields enable). The model carries
 * the callback address the admin must enter at the console, and
 * never any pair value.
 */
export function pairFormModel({ provider, name, pairConfigured = null } = {}) {
  const facts = pairProviderFacts(provider);
  if (!facts || !name) return null;
  const configured = pairConfigured === true;
  return Object.freeze({
    provider: String(provider).trim().toLowerCase(),
    name,
    pairConfigured: pairConfigured ?? null,
    callbackUrl: PAIR_CALLBACK_URL,
    intro: `${name} connects under your own ${facts.displayName} client pair — the pair is your workspace\u2019s, stored once for every agent. ${facts.mintWords}`,
    stateLine: pairConfigured === null
      ? 'Checking whether a pair is stored\u2026'
      : configured
        ? `A client pair is stored for ${facts.displayName}.`
        : `No client pair is stored for ${facts.displayName} yet.`,
    fields: pairFormFields(provider),
    button: Object.freeze({
      label: configured ? 'Replace the stored pair' : 'Store the pair',
      pendingLabel: 'Storing\u2026',
    }),
    replace: configured,
  });
}

/**
 * The face's state after a pair store: the road answers
 * pairConfigured true, and that answer — not the form's field
 * values — is what the face shows next. Any other answer
 * changes nothing.
 */
export function applyPairStored(model, out) {
  if (!model || out?.status !== 'pair-stored' || out?.pairConfigured !== true) return model;
  return pairFormModel({ provider: model.provider, name: model.name, pairConfigured: true }) ?? model;
}

/** The face's state after a status answer: the boolean, applied. */
export function applyPairStatus(model, out) {
  if (!model || out?.status !== 'pair-status' || typeof out?.pairConfigured !== 'boolean') return model;
  return pairFormModel({ provider: model.provider, name: model.name, pairConfigured: out.pairConfigured }) ?? model;
}

// ------------------------------------------------------------ wire shapes
// The exact bodies the server contracts demand. Builders refuse
// (null) rather than send a shape the server would refuse.

export function pairStatusBody({ provider } = {}) {
  if (!pairProviderFacts(provider)) return null;
  return Object.freeze({ provider: String(provider).trim().toLowerCase() });
}

export function pairStoreBody({ provider, clientId, clientSecret, serverPath } = {}) {
  const facts = pairProviderFacts(provider);
  if (!facts) return null;
  if (typeof clientId !== 'string' || !clientId.trim()) return null;
  if (typeof clientSecret !== 'string' || clientSecret.length === 0) return null;
  const body = { provider: String(provider).trim().toLowerCase(), clientId: clientId.trim(), clientSecret };
  if (facts.serverPath) {
    if (typeof serverPath !== 'string' || !serverPath.trim()) return null;
    body.serverPath = serverPath.trim();
  }
  return Object.freeze(body);
}

// The server's answer in plain words, from a thrown road error:
// the error body's own error text first (the road's refusal
// words), then the error's message, then a plain fallback.
function refusalText(error, fallback) {
  const text = error?.body?.error ?? error?.error ?? error?.message ?? null;
  return typeof text === 'string' && text ? text : fallback;
}

// ------------------------------------------------------------ the round trip
// The form's two roads, driven through a transport the caller
// supplies ({ post } — the workspace's own, in the panel; shaped
// stubs, in tests). Each returns a plain result: on success the
// model re-derived from the road's own answer; on refusal the
// road's plain words and the model unchanged, so nothing the
// server did not store ever reads stored.

export async function fetchPairStatus({ post, model } = {}) {
  if (!model || typeof post !== 'function') return { ok: false, error: 'The pair state cannot be checked here.', model: model ?? null };
  const body = pairStatusBody({ provider: model.provider });
  if (!body) return { ok: false, error: 'The pair state cannot be checked here.', model };
  let out;
  try {
    out = await post(PAIR_STATUS_PATH, body);
  } catch (error) {
    return { ok: false, error: refusalText(error, 'Whether a pair is stored could not be checked. Try again.'), model };
  }
  const next = applyPairStatus(model, out);
  if (next === model) {
    return { ok: false, error: refusalText(out, 'Whether a pair is stored could not be checked. Try again.'), model };
  }
  return { ok: true, error: '', model: next, out };
}

export async function submitPairForm({ post, model, values = {} } = {}) {
  if (!model || typeof post !== 'function') return { ok: false, sent: false, error: 'This pair cannot be stored here.', model: model ?? null };
  const body = pairStoreBody({
    provider: model.provider,
    clientId: values?.clientId,
    clientSecret: values?.clientSecret,
    serverPath: values?.serverPath,
  });
  if (!body) {
    // The one client-side refusal, worded exactly as the road
    // words it (see EMPTY_PAIR_MESSAGE): an incomplete pair is
    // never sent.
    return { ok: false, sent: false, error: EMPTY_PAIR_MESSAGE, model };
  }
  let out;
  try {
    out = await post(PAIR_PATH, body);
  } catch (error) {
    return { ok: false, sent: true, error: refusalText(error, 'That pair could not be stored. Try again.'), model };
  }
  const next = applyPairStored(model, out);
  if (next === model) {
    return { ok: false, sent: true, error: refusalText(out, 'That pair could not be stored. Try again.'), model };
  }
  return { ok: true, sent: true, error: '', model: next, out };
}
