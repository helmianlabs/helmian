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
  const issue = (verdict, hash, nonce, extra = {}) => {
    const iat = Math.floor(Date.now() / 1000);
    return signClaims({ decisionId: randomUUID(), verdict, ruleId: 'r', actionHash: hash, deviceId: 'hands-mcp', nonce, iat, exp: iat + 300, ...extra });
  };
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
          out.decision = issue(a.status === 'approved' ? 'allow' : 'deny', a.hash, a.nonce, { approvalId: m[1], decidedBy: 'troy' });
          out.decidedBy = 'troy';
        }
        return send(200, out);
      }
      return send(404, { error: 'not-found' });
    });
  };
  return {
    handler, x, deviceToken, approvals, calls,
    decide(id, approve) { approvals.get(id).status = approve ? 'approved' : 'denied'; },
    forge(claims) { return signClaims(claims); },
  };
}

export const pkce = () => {
  const verifier = `v-${randomUUID()}-${randomUUID()}`;
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};
