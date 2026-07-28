/**
 * Minimal OpenAI-compatible server used to prove the custom-endpoint path end to end
 * without a live provider. Serves POST /v1/chat/completions in both plain and SSE
 * streaming form, and logs every request it receives so the proof is observable.
 *
 *   node test-support/openai-compatible-stub.mjs [port]
 *
 * Prints "STUB_LISTENING <port>" once bound; port 0 picks a free port.
 */
import { createServer } from 'node:http';

const REPLY = 'Hello from the Helmion custom endpoint stub.';

export function createStubServer({ onRequest } = {}) {
  return createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (!req.url.startsWith('/v1/chat/completions') || req.method !== 'POST') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `no route for ${req.method} ${req.url}` } }));
        return;
      }

      let parsed = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'invalid JSON body' } }));
        return;
      }

      onRequest?.({
        model: parsed.model,
        stream: Boolean(parsed.stream),
        authorization: req.headers.authorization || null,
        messageCount: Array.isArray(parsed.messages) ? parsed.messages.length : 0,
        lastUserMessage: Array.isArray(parsed.messages)
          ? parsed.messages.filter((m) => m.role === 'user').pop()?.content ?? null
          : null,
        body: parsed,
      });

      if (parsed.stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        for (const piece of REPLY.split(' ')) {
          res.write(`data: ${JSON.stringify({
            choices: [{ delta: { content: `${piece} ` } }],
          })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-helmion-stub',
        object: 'chat.completion',
        model: parsed.model || 'stub-model',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: REPLY },
          finish_reason: 'stop',
        }],
      }));
    });
  });
}

const isDirectRun = process.argv[1]
  && process.argv[1].replace(/\\/g, '/').endsWith('test-support/openai-compatible-stub.mjs');

if (isDirectRun) {
  const port = Number(process.argv[2] || 0);
  const server = createStubServer({
    onRequest: (info) => {
      process.stdout.write(
        `STUB_REQUEST model=${info.model} stream=${info.stream} `
        + `messages=${info.messageCount} auth=${info.authorization ? 'present' : 'none'} `
        + `lastUser=${JSON.stringify(info.lastUserMessage)}\n`,
      );
    },
  });
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`STUB_LISTENING ${server.address().port}\n`);
  });
}
