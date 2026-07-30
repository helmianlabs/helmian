// The relay wire format — what crosses the public internet between Troy's phone
// and this machine, and more importantly what does NOT.
//
// THIS LANE CARRIES TEXT. It cannot run anything. There is no command kind, no
// path field, no shell string, and nothing here reaches the guard's execution
// path. A message arriving from the phone becomes a line Helmion *shows*, and
// that is the whole of its authority. When executing from the phone is built,
// it goes through the same governance gate as everything else and is a separate,
// deliberate change — not something this file quietly already allows.
//
// The parser's one job is the same as the advisory parser's: A MESS IS NEVER A
// MESSAGE. Anything malformed, oversized, unknown or mistyped is dropped with a
// stated reason. Nothing is inferred, repaired or guessed at, because the sender
// is reachable from the open internet and a lenient parser is an invitation.

export const PROTOCOL_VERSION = 1;

// Roles. Exactly two ends, named, and neither may claim to be the other.
export const ROLES = ['phone', 'desktop'];

// Frame kinds. A closed set — an unrecognised kind is dropped, never forwarded.
export const KINDS = [
  'hello', // server → client on connect: your cursor, your channel, the clock
  'say', // either → either: a line of text
  'ping', // server → client: liveness
  'pong', // client → server: liveness
  'error', // server → client: refused, with a reason
];

// A single frame's ceiling. The phone sends sentences, not payloads. Vercel's
// own default WebSocket maxPayload is 256 KiB; this sits far under it so an
// oversized frame is refused by OUR rule with OUR reason, rather than by the
// platform severing the socket with none.
export const MAX_FRAME_BYTES = 16 * 1024;

// The visible text inside a frame. Deliberately smaller than the frame so a
// caller cannot smuggle bulk through `body` by padding other fields.
export const MAX_BODY_CHARS = 4000;

// A channel is the pairing between one phone and one desktop. Kept to a boring
// alphabet because it reaches a SQL WHERE clause and a log line, and neither
// should ever have to think about what is in it.
const CHANNEL_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/;

export function isValidChannel(channel) {
  return typeof channel === 'string' && CHANNEL_RE.test(channel);
}

/**
 * Build a frame for sending. Throws on programmer error — a malformed frame
 * leaving this machine is a bug here, not something to negotiate at runtime.
 */
export function frame({ kind, from, body = '', cursor = null, at = null, id = null }) {
  if (!KINDS.includes(kind)) throw new TypeError(`unknown frame kind: ${String(kind)}`);
  if (!ROLES.includes(from)) throw new TypeError(`unknown sender role: ${String(from)}`);
  const out = { v: PROTOCOL_VERSION, kind, from, body: String(body) };
  if (cursor !== null) out.cursor = cursor;
  if (at !== null) out.at = at;
  if (id !== null) out.id = id;
  return out;
}

export function encode(obj) {
  return JSON.stringify(obj);
}

/**
 * Parse one inbound frame.
 *
 * Never throws and never returns a partially-trusted object. Either
 * { ok: true, frame } with every field validated, or { ok: false, reason }.
 * The reason is for OUR log; it is deliberately not echoed to the sender in a
 * form that would help someone map the parser.
 */
export function parseFrame(raw) {
  if (raw === null || raw === undefined) return { ok: false, reason: 'empty frame' };

  const text = typeof raw === 'string' ? raw : bufferToText(raw);
  if (text === null) return { ok: false, reason: 'frame was not text' };
  if (text.trim() === '') return { ok: false, reason: 'blank frame' };

  // Measured in BYTES, not characters. A length check on a UTF-16 string
  // undercounts every non-ASCII character and would let a frame three times the
  // intended size through.
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_FRAME_BYTES) {
    return { ok: false, reason: `frame is ${bytes} bytes, over the ${MAX_FRAME_BYTES} limit` };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not JSON' };
  }

  // An array parses as JSON and has properties. It is not a frame.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'not a JSON object' };
  }

  if (parsed.v !== PROTOCOL_VERSION) {
    return { ok: false, reason: `protocol version ${JSON.stringify(parsed.v)}, expected ${PROTOCOL_VERSION}` };
  }
  if (!KINDS.includes(parsed.kind)) {
    return { ok: false, reason: `unknown kind ${JSON.stringify(parsed.kind)}` };
  }
  if (!ROLES.includes(parsed.from)) {
    return { ok: false, reason: `unknown sender role ${JSON.stringify(parsed.from)}` };
  }

  // `body` must be a real string. A number, an object or a nested structure is
  // refused rather than coerced — String({}) is "[object Object]" and shipping
  // that as a message is how nonsense becomes a permanent log entry.
  const body = parsed.body === undefined ? '' : parsed.body;
  if (typeof body !== 'string') return { ok: false, reason: 'body must be a string' };
  if (body.length > MAX_BODY_CHARS) {
    return { ok: false, reason: `body is ${body.length} chars, over the ${MAX_BODY_CHARS} limit` };
  }

  // A cursor is a row id. Anything that is not a non-negative safe integer is a
  // refusal, not a rounding opportunity.
  let cursor = null;
  if (parsed.cursor !== undefined && parsed.cursor !== null) {
    if (!Number.isSafeInteger(parsed.cursor) || parsed.cursor < 0) {
      return { ok: false, reason: 'cursor must be a non-negative integer' };
    }
    cursor = parsed.cursor;
  }

  let id = null;
  if (parsed.id !== undefined && parsed.id !== null) {
    if (!Number.isSafeInteger(parsed.id) || parsed.id < 0) {
      return { ok: false, reason: 'id must be a non-negative integer' };
    }
    id = parsed.id;
  }

  // Only the fields above survive. Anything else the sender attached is
  // discarded here rather than travelling onward as an unexamined passenger.
  return {
    ok: true,
    frame: {
      v: PROTOCOL_VERSION,
      kind: parsed.kind,
      from: parsed.from,
      body,
      ...(cursor === null ? {} : { cursor }),
      ...(id === null ? {} : { id }),
      ...(typeof parsed.at === 'string' ? { at: parsed.at } : {}),
    },
  };
}

/**
 * Who a message from `role` should be delivered to. Two ends, so this is a
 * flip — but it is written down rather than implied, because "deliver to
 * everyone on the channel" is how a relay echoes a sender's own words back at
 * it and both sides conclude the other one said something.
 */
export function deliverTo(role) {
  if (role === 'phone') return 'desktop';
  if (role === 'desktop') return 'phone';
  return null;
}

function bufferToText(raw) {
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  if (ArrayBuffer.isView(raw)) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8');
  return null;
}
