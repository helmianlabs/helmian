// The status board — a browser tab Troy can glance at instead of reading the
// session.
//
// Troy's ask, 2026-07-30: "spin up a little web app with a minute-to-minute
// live update in HTML of everything you're doing, that way I don't get you
// talking to your agents and all that stuff — I just get pertinent info, and I
// can have it up in a separate browser tab and check on it."
//
// So the editorial rule is subtractive: this shows what he would ACT on, and
// nothing else. No agent chatter, no commit messages, no reasoning. Four
// buckets, in the order he cares about them:
//
//   BLOCKED ON YOU  — first, always. If this is empty, say so loudly.
//   IN FLIGHT       — what is moving right now.
//   DONE            — with how it was proven, because "done" is a claim.
//   AGENTS          — one line each, so the fleet is legible at a glance.
//
// It reads ONE file, .helmion/status.json, and renders it. It holds no state of
// its own, which means it cannot drift from what was written — a status board
// with its own memory is a status board that can lie.
//
// Same posture as the Herald: read-only, no write route exists, loopback by
// default, and an unreadable file says UNKNOWN rather than showing a calm empty
// page. An empty board and a broken board must never look the same.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { networkInterfaces } from 'node:os';

export const STATUS_FILE = join('.helmion', 'status.json');
export const REFRESH_SECONDS = 45;

const escape = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export async function readStatus(workspace) {
  try {
    const raw = await readFile(join(workspace, STATUS_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return { computed: false, reason: 'status.json is not an object' };
    }
    return { computed: true, ...parsed };
  } catch (err) {
    // A missing file is not the same as a broken one, and the difference is
    // worth a sentence: one means "nothing written yet", the other means
    // "something is wrong with the thing that writes it".
    return {
      computed: false,
      reason: err.code === 'ENOENT'
        ? `no status has been written yet (${STATUS_FILE} does not exist)`
        : `could not read ${STATUS_FILE}: ${err.message}`,
    };
  }
}

function ago(iso) {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins === 1) return '1 minute ago';
  if (mins < 60) return `${mins} minutes ago`;
  const hrs = Math.round(mins / 60);
  return hrs === 1 ? '1 hour ago' : `${hrs} hours ago`;
}

function section(title, items, opts = {}) {
  const { empty = 'Nothing here.', tone = '' } = opts;
  const rows = (Array.isArray(items) ? items : []).filter(Boolean);
  const body = rows.length
    ? rows.map((it) => {
      const text = typeof it === 'string' ? { what: it } : it;
      return `<li><span class="what">${escape(text.what)}</span>`
        + (text.detail ? `<span class="detail">${escape(text.detail)}</span>` : '')
        + (text.proof ? `<span class="proof">${escape(text.proof)}</span>` : '')
        + '</li>';
    }).join('')
    : `<li class="empty">${escape(empty)}</li>`;
  return `<section class="${tone}"><h2>${escape(title)} <span class="count">${rows.length}</span></h2><ul>${body}</ul></section>`;
}

export function renderPage(status) {
  if (!status.computed) {
    return page(`<section class="unknown"><h2>UNKNOWN</h2><ul><li class="empty">${escape(status.reason)}</li></ul>`
      + '<p class="note">This is not an all-clear. The board could not read its source, '
      + 'so it is showing nothing rather than pretending there is nothing.</p></section>');
  }

  const blocked = Array.isArray(status.blockedOnTroy) ? status.blockedOnTroy : [];
  const headline = blocked.length
    ? `${blocked.length} thing${blocked.length === 1 ? '' : 's'} waiting on you`
    : 'Nothing is waiting on you';

  return page(
    `<header><h1 class="${blocked.length ? 'needs' : 'clear'}">${escape(headline)}</h1>`
    + `<p class="stamp">updated ${escape(ago(status.updatedAt))}`
    + (status.note ? ` · ${escape(status.note)}` : '') + '</p></header>'
    + section('Blocked on you', blocked, { empty: 'Nothing — carry on.', tone: 'blocked' })
    + section('In flight', status.inFlight, { empty: 'Nothing running.', tone: 'flight' })
    + section('Done', status.done, { empty: 'Nothing finished yet.', tone: 'done' })
    + section('Agents', status.agents, { empty: 'No agents running.', tone: 'agents' }),
  );
}

function page(inner) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="${REFRESH_SECONDS}">
<title>Helmion — what I'm doing</title>
<style>
 :root{--bg:#0b0f0e;--fg:#e8f0ee;--dim:#8fa3a0;--line:#1d2725;--ok:#3ddc97;--warn:#f6c744;--stop:#ff5c5c}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--fg);
      font:17px/1.55 ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif;padding:28px 20px 60px}
 main{max-width:820px;margin:0 auto}
 header{border-bottom:1px solid var(--line);padding-bottom:18px;margin-bottom:8px}
 h1{font-size:30px;margin:0 0 6px;letter-spacing:-.02em}
 h1.needs{color:var(--warn)} h1.clear{color:var(--ok)}
 .stamp{color:var(--dim);font-size:15px;margin:0}
 section{margin:26px 0}
 h2{font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);
    margin:0 0 10px;font-weight:600}
 .count{background:var(--line);border-radius:10px;padding:1px 8px;margin-left:6px;letter-spacing:0}
 ul{list-style:none;margin:0;padding:0}
 li{border-left:3px solid var(--line);padding:9px 0 9px 14px;margin-bottom:9px}
 .blocked li{border-left-color:var(--warn)}
 .done li{border-left-color:var(--ok)}
 .unknown h2{color:var(--warn)}
 .what{display:block}
 .detail,.proof{display:block;color:var(--dim);font-size:15px;margin-top:2px}
 .proof{font-family:ui-monospace,Consolas,monospace;font-size:14px}
 li.empty{color:var(--dim);border-left-color:transparent;padding-left:0}
 .note{color:var(--dim);font-size:15px;max-width:60ch}
 footer{margin-top:40px;color:var(--dim);font-size:14px;border-top:1px solid var(--line);padding-top:14px}
 @media(max-width:560px){body{padding:18px 14px 50px}h1{font-size:25px}}
</style></head><body><main>${inner}
<footer>Refreshes itself every ${REFRESH_SECONDS} seconds. Read-only — this page cannot change anything.</footer>
</main></body></html>`;
}

export async function startBoard({ workspace = process.cwd(), port = 7421, host = '127.0.0.1' } = {}) {
  const server = createServer(async (req, res) => {
    // READ-ONLY BY CONSTRUCTION. Not a disabled write route — there is no write
    // route in this file at all.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain' });
      res.end('read-only');
      return;
    }
    const status = await readStatus(workspace);
    const body = req.url === '/status.json'
      ? JSON.stringify(status, null, 2)
      : renderPage(status);
    res.writeHead(200, {
      'content-type': req.url === '/status.json' ? 'application/json' : 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      // It loads nothing external, so say so and let the browser enforce it.
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  const actual = server.address().port;
  const urls = host === '127.0.0.1'
    ? [`http://127.0.0.1:${actual}/`]
    : Object.values(networkInterfaces()).flat()
      .filter((n) => n && n.family === 'IPv4' && !n.internal)
      .map((n) => `http://${n.address}:${actual}/`);

  return { port: actual, host, urls, close: () => new Promise((r) => server.close(r)) };
}
