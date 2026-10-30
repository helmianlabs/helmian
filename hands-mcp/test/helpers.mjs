import http from 'node:http';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { canonicalJson, DECISION_AUDIENCE, guardActionHash } from '../src/shared/protocol.mjs';

export function listen(handlerOrApp) {
  const server = http.createServer(handlerOrApp);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) })));
}

/** A stand-in for Executive Guard (executive-guard/src/server.mjs, PR #53): same routes, same envelope. */
export function mockGuard({ deviceToken = 'guard-device-token-0123456789abcdef', mode = 'ask' } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const x = publicKey.export({ format: 'jwk' }).x;
  const approvals = new Map();
  const signClaims = (claims) => {
    const payload = Buffer.from(canonicalJson({ aud: DECISION_AUDIENCE, ...claims }), 'utf8').toString('base64url');
    return { payload, signature: sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64url'), keyId: 'test' };
  };
  const issued = new Map(); // decisionId -> { verdict, nonce }
  const outcomes = [];
  const issue = (verdict, hash, nonce, extra = {}) => {
    const iat = Math.floor(Date.now() / 1000);
    const decisionId = randomUUID();
    if (verdict !== 'ask') issued.set(decisionId, { verdict, nonce });
    return signClaims({ decisionId, verdict, ruleId: 'r', actionHash: hash, deviceId: 'hands-mcp', nonce, iat, exp: iat + 300, ...extra });
  };
  // POST /v1/audit/outcomes, validated like executive-guard/docs/OUTCOMES.md.
  const OUTCOME_FIELDS = new Set(['decisionId', 'nonce', 'status', 'startedAt', 'finishedAt', 'resultHash', 'error']);
  const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
  function outcome(b) {
    if (Object.keys(b).some((k) => !OUTCOME_FIELDS.has(k))) return [400, { error: 'unknown-field' }];
    if (!['succeeded', 'failed', 'refused'].includes(b.status)) return [400, { error: 'invalid-status' }];
    if (!ISO.test(b.finishedAt || '') || (b.status !== 'refused' && !ISO.test(b.startedAt || ''))) return [400, { error: 'invalid-time' }];
    if (b.resultHash !== undefined && !/^[0-9a-f]{64}$/.test(b.resultHash)) return [400, { error: 'invalid-result-hash' }];
    if (b.error !== undefined && b.status === 'succeeded') return [400, { error: 'invalid-error' }];
    const d = issued.get(b.decisionId);
    if (!d) return [404, { error: 'unknown-decision' }];
    if (d.nonce !== b.nonce) return [403, { error: 'nonce-mismatch' }];
    if (d.verdict === 'deny' && b.status !== 'refused') return [409, { error: 'verdict-mismatch' }];
    if (outcomes.some((o) => o.decisionId === b.decisionId)) return [409, { error: 'duplicate-outcome' }];
    outcomes.push({ ...b, verdict: d.verdict });
    return [201, { recorded: true, decisionId: b.decisionId, status: b.status, auditSeq: outcomes.length }];
  }
  const calls = [];
  const handler = (req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const send = (s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
      if (req.headers.authorization !== `Bearer ${deviceToken}`) return send(401, { error: 'unauthorized' });
      calls.push({ method: req.method, url: req.url });
      if (req.method === 'POST' && req.url === '/v1/decisions') {
        const { nonce, action } = JSON.parse(body);
        const hash = guardActionHash(action);
        if (mode === 'allow') return send(200, { verdict: 'allow', reason: 'ok', decision: issue('allow', hash, nonce) });
        if (mode === 'deny') return send(200, { verdict: 'deny', reason: 'policy says no', decision: issue('deny', hash, nonce) });
        const id = randomUUID();
        approvals.set(id, { status: 'pending', hash, nonce });
        return send(202, { verdict: 'ask', approvalId: id, reason: 'needs a human', decision: issue('ask', hash, nonce, { approvalId: id }) });
      }
      const m = /^\/v1\/approvals\/([^/]+)$/.exec(req.url);
      if (req.method === 'GET' && m) {
        const a = approvals.get(m[1]);
        if (!a) return send(404, { error: 'not-found' });
        const out = { approvalId: m[1], status: a.status, reason: 'needs a human' };
        if (a.status === 'approved' || a.status === 'denied') {
          // One decision per approval, returned unchanged on every poll (like the real Guard).
          a.decision ??= issue(a.status === 'approved' ? 'allow' : 'deny', a.hash, a.nonce, { approvalId: m[1], decidedBy: 'troy' });
          out.decision = a.decision;
          out.decidedBy = 'troy';
        }
        return send(200, out);
      }
      if (req.method === 'POST' && req.url === '/v1/audit/outcomes') { const [st, b] = outcome(JSON.parse(body)); return send(st, b); }
      return send(404, { error: 'not-found' });
    });
  };
  return {
    handler, x, deviceToken, approvals, calls, outcomes,
    decide(id, approve) { approvals.get(id).status = approve ? 'approved' : 'denied'; },
    expire(id) { approvals.get(id).status = 'expired'; },
    forge(claims) { return signClaims(claims); },
  };
}

export const pkce = () => {
  const verifier = `v-${randomUUID()}-${randomUUID()}`;
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};
