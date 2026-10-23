// Express app: OAuth 2.1 AS (DCR + PKCE + passphrase consent) + MCP resource
// server over Streamable HTTP + the outbound-only PC spoke channel.
// Same shape as claude-memory-mcp on this box.

import { createHash, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { renderConsentPage } from './consent.mjs';
import { POWERSHELL_COMMANDS, TOOLS } from './shared/protocol.mjs';

function safeEqual(a, b) {
  const x = createHash('sha256').update(String(a)).digest();
  const y = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(x, y);
}

// Combine the HTTP-disconnect signal with the MCP request's own abort signal
// (whichever fires first). Used only to stop a held-open call waiting on a
// Guard decision whose caller has gone away; the pending action itself is
// never cancelled by a disconnect and stays resumable via resume_action.
function pickSignal(...signals) {
  const live = signals.filter((s) => s && typeof s.addEventListener === 'function');
  if (!live.length) return undefined;
  if (live.length === 1) return live[0];
  try { return AbortSignal.any(live); } catch { return live[0]; }
}

export function buildMcpServer(hands, auth, hooks = {}) {
  const server = new McpServer({ name: 'helmian-hands', version: '0.1.0' });
  const ro = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const act = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
  server.registerTool('hands_status', { description: 'Is the PC online, are hands on, and is Executive Guard live? Read-only.', inputSchema: {}, annotations: ro },
    async () => ({ content: [{ type: 'text', text: JSON.stringify(hands.status(), null, 2) }] }));
  server.registerTool('list_files', { description: TOOLS.list_files.description, inputSchema: { path: z.string(), glob: z.string().optional() }, annotations: ro },
    (args, extra) => hands.call('list_files', args, auth, { signal: pickSignal(hooks.signal, extra?.signal) }));
  server.registerTool('read_file', { description: TOOLS.read_file.description, inputSchema: { path: z.string(), maxBytes: z.number().int().optional() }, annotations: ro },
    (args, extra) => hands.call('read_file', args, auth, { signal: pickSignal(hooks.signal, extra?.signal) }));
  server.registerTool('search_files', { description: TOOLS.search_files.description, inputSchema: { path: z.string(), query: z.string().optional(), glob: z.string().optional(), maxResults: z.number().int().optional() }, annotations: ro },
    (args, extra) => hands.call('search_files', args, auth, { signal: pickSignal(hooks.signal, extra?.signal) }));
  server.registerTool('ollama_generate', { description: TOOLS.ollama_generate.description, inputSchema: { model: z.string(), prompt: z.string() }, annotations: ro },
    (args, extra) => hands.call('ollama_generate', args, auth, { signal: pickSignal(hooks.signal, extra?.signal) }));
  server.registerTool('run_powershell', {
    description: `${TOOLS.run_powershell.description} Commands: ${Object.entries(POWERSHELL_COMMANDS).map(([id, s]) => `${id} (${s.summary}${Object.keys(s.args).length ? `; args: ${Object.keys(s.args).join(', ')}` : ''})`).join('; ')}.`,
    inputSchema: { commandId: z.enum(Object.keys(POWERSHELL_COMMANDS)), args: z.record(z.any()).optional() }, annotations: act,
  }, (args, extra) => hands.call('run_powershell', args, auth, { signal: pickSignal(hooks.signal, extra?.signal) }));
  server.registerTool('open_url', { description: TOOLS.open_url.description, inputSchema: { url: z.string() }, annotations: act },
    (args, extra) => hands.call('open_url', args, auth, { signal: pickSignal(hooks.signal, extra?.signal) }));
  server.registerTool('write_file', { description: TOOLS.write_file.description, inputSchema: { path: z.string(), content: z.string() }, annotations: act },
    (args, extra) => hands.call('write_file', args, auth, { signal: pickSignal(hooks.signal, extra?.signal) }));
  server.registerTool('move_file', { description: TOOLS.move_file.description, inputSchema: { path: z.string(), destination: z.string() }, annotations: act },
    (args, extra) => hands.call('move_file', args, auth, { signal: pickSignal(hooks.signal, extra?.signal) }));
  server.registerTool('copy_file', { description: TOOLS.copy_file.description, inputSchema: { path: z.string(), destination: z.string() }, annotations: act },
    (args, extra) => hands.call('copy_file', args, auth, { signal: pickSignal(hooks.signal, extra?.signal) }));
  server.registerTool('delete_file', { description: TOOLS.delete_file.description, inputSchema: { path: z.string(), recursive: z.boolean().optional() }, annotations: act },
    (args, extra) => hands.call('delete_file', args, auth, { signal: pickSignal(hooks.signal, extra?.signal) }));
  server.registerTool('make_dir', { description: TOOLS.make_dir.description, inputSchema: { path: z.string() }, annotations: act },
    (args, extra) => hands.call('make_dir', args, auth, { signal: pickSignal(hooks.signal, extra?.signal) }));
  server.registerTool('edit_file', { description: TOOLS.edit_file.description, inputSchema: { path: z.string(), find: z.string(), replace: z.string(), all: z.boolean().optional() }, annotations: act },
    (args, extra) => hands.call('edit_file', args, auth, { signal: pickSignal(hooks.signal, extra?.signal) }));
  server.registerTool('resume_action', { description: 'Run a mutating action that was waiting for a Guard approval, once a human approved it.', inputSchema: { requestId: z.string() }, annotations: act },
    ({ requestId }) => hands.resume(requestId, auth));
  return server;
}

export function createApp({ config, oauth, hands, hub, spokeTokens }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  const ISSUER = new URL(config.publicUrl);
  const RESOURCE_URL = new URL(`${config.publicUrl}${config.mcpPath}`);
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(RESOURCE_URL);

  app.get('/', (_req, res) => res.json({
    name: 'helmian-hands-mcp', status: 'ok', mcp_endpoint: RESOURCE_URL.toString(), transport: 'streamable-http', auth: 'oauth2.1+pkce+dcr',
    hands: hands.status().handsEnabled ? 'on' : 'off', guard: hands.status().guardLive ? 'live' : 'not live (mutating tools denied)',
  }));
  app.get('/healthz', (_req, res) => res.status(200).send('ok'));

  app.use(mcpAuthRouter({ provider: oauth.provider, issuerUrl: ISSUER, baseUrl: ISSUER, resourceServerUrl: RESOURCE_URL, resourceName: 'Helmian hands', scopesSupported: ['hands.read', 'hands.act'] }));

  app.post('/consent', express.urlencoded({ extended: false }), (req, res) => {
    const pendingId = String(req.body?.pending_id || '');
    const action = String(req.body?.action || '');
    const pending = oauth.getPending(pendingId);
    if (!pending) return res.status(400).send('This authorization request has expired or is invalid. Please retry from your AI client.');
    if (action === 'deny') return res.redirect(302, oauth.deny(pendingId));
    const check = spokeTokens.checkPassphrase(String(req.body?.passphrase || ''));
    if (!check.ok) {
      return res.status(check.status).set('Content-Type', 'text/html; charset=utf-8')
        .send(renderConsentPage({ pendingId, clientName: oauth.clientName(pending.clientId), error: check.status === 429 ? check.error : 'Incorrect passphrase. Please try again.', scopes: pending.scopes }));
    }
    const url = oauth.approve(pendingId);
    if (!url) return res.status(400).send('This authorization request has expired.');
    return res.redirect(302, url);
  });

  const bearer = requireBearerAuth({ verifier: oauth.provider, resourceMetadataUrl });
  app.post(config.mcpPath, bearer, express.json({ limit: '256kb' }), async (req, res) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const disconnect = new AbortController();
    const server = buildMcpServer(hands, req.auth || {}, { signal: disconnect.signal });
    res.on('close', () => { disconnect.abort(); transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      // A caller that hung up mid-call (e.g. during a held-open Guard wait) must
      // not turn into a write-after-destroy error here.
      try { if (!res.headersSent && !res.writableEnded && !res.destroyed) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }); } catch { /* socket already gone */ }
    }
  });
  app.get(config.mcpPath, bearer, (_req, res) => res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. Use POST.' }, id: null }));
  app.delete(config.mcpPath, bearer, (_req, res) => res.status(405).end());

  // ─── PC spoke channel (outbound from the PC; bearer SPOKE_TOKEN) ───────────
  const spokeAuth = (req, res, next) => {
    const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
    const deviceId = m ? spokeTokens.verify(m[1]) : null;
    if (!deviceId) return res.status(401).json({ error: 'unauthorized' });
    req.spokeDevice = deviceId;
    return next();
  };
  app.post('/spoke/v1/pair', express.json({ limit: '4kb' }), (req, res) => {
    const r = spokeTokens.pair({ passphrase: String(req.body?.passphrase || ''), deviceId: req.body?.deviceId });
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    return res.json({ token: r.token, deviceId: r.deviceId });
  });
  app.post('/spoke/v1/poll', spokeAuth, express.json({ limit: '16kb' }), async (req, res) => {
    const ctrl = new AbortController();
    res.on('close', () => ctrl.abort());
    const job = await hub.nextJob({ deviceId: req.spokeDevice, capabilities: req.body?.capabilities, signal: ctrl.signal });
    if (res.writableEnded || res.destroyed) {
      if (job) hub._queue.unshift(job); // the spoke went away; give the job to the next poll
      return;
    }
    res.json({ job });
  });
  app.post('/spoke/v1/result', spokeAuth, express.json({ limit: '256kb' }), (req, res) => {
    const ok = hub.complete(String(req.body?.jobId || ''), { ok: req.body?.ok === true, output: req.body?.output, error: req.body?.error, execution: req.body?.execution });
    res.status(ok ? 200 : 404).json({ accepted: ok });
  });

  return app;
}
