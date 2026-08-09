// Current-user Windows named-pipe client for the running Helmian Desktop.
// The pipe is local IPC, not a network listener. Each request uses one bounded,
// length-prefixed JSON message and a closed action set implemented by Desktop.

import { createConnection } from 'node:net';
import { userInfo } from 'node:os';
import { randomUUID } from 'node:crypto';

export const MAX_PIPE_MESSAGE_BYTES = 64 * 1024;

export function heraldPipeNameForCurrentUser() {
  const user = userInfo().username.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/^-+|-+$/g, '') || 'user';
  return `helmion-herald-desktop-${user}`;
}

export function heraldPipePath(pipeName = heraldPipeNameForCurrentUser()) {
  return `\\\\.\\pipe\\${pipeName}`;
}

function frame(value) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  if (payload.length === 0 || payload.length > MAX_PIPE_MESSAGE_BYTES) {
    throw new TypeError('Herald desktop-pipe message exceeds the protocol limit');
  }
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeInt32LE(payload.length, 0);
  return Buffer.concat([prefix, payload]);
}

export function requestDesktopPipe({
  action,
  payload = {},
  pipeName,
  timeoutMs = 5_000,
  connect = createConnection,
  requestId = randomUUID(),
} = {}) {
  return new Promise((resolve, reject) => {
    const socket = connect(heraldPipePath(pipeName));
    const chunks = [];
    let expected = null;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy?.();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Helmian Desktop did not answer the local Herald pipe.')), timeoutMs);
    socket.on('connect', () => socket.write(frame({ id: requestId, action, payload })));
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      if (expected === null && buffer.length >= 4) expected = buffer.readInt32LE(0);
      if (!Number.isInteger(expected) || expected <= 0 || expected > MAX_PIPE_MESSAGE_BYTES) {
        if (expected !== null) finish(new Error('Helmian Desktop returned an invalid Herald pipe frame.'));
        return;
      }
      if (buffer.length < expected + 4) return;
      try {
        const response = JSON.parse(buffer.subarray(4, expected + 4).toString('utf8'));
        if (response?.id !== requestId || response?.ok !== true) {
          finish(new Error(response?.error ?? 'Helmian Desktop refused the Herald request.'));
          return;
        }
        finish(null, response.value);
      } catch {
        finish(new Error('Helmian Desktop returned invalid Herald pipe JSON.'));
      }
    });
    socket.on('error', () => finish(new Error('Helmian Desktop is not running or phone sharing is off.')));
    socket.on('close', () => {
      if (!settled) finish(new Error('Helmian Desktop closed the Herald pipe before answering.'));
    });
  });
}

export function createHeraldDesktopPipeBridge({ request = requestDesktopPipe, pipeName } = {}) {
  const call = (action, payload = {}) => request({ action, payload, pipeName });
  return {
    async isAvailable() {
      try { return (await call('presence'))?.available === true; } catch { return false; }
    },
    getSessionContext: () => call('session.read'),
    submitInstruction: (command) => call('instruction.submit', command),
    decideApproval: (decision) => call('approval.decide', decision),
  };
}
