// Runs PR #3's REAL courier code (unreadSummary, sendMessage, markRead, migrations
// incl. 006) on an in-memory PGlite, behind a copy of single.ts's
// GET /mailbox/unread handler (single.ts itself starts a real Postgres pool at
// import, so it cannot be loaded in-process). Local only; no network beyond 127.0.0.1.
//   SCRIBE_PR3_APP=/path/to/shared-memory-mcp/server.src/app node --import tsx scribe-pr3-harness.ts
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
const APP = process.env.SCRIBE_PR3_APP!;
const { freshDb, sql } = await import(`${APP}/test/helpers.ts`);
const store = await import(`${APP}/src/courier/store.ts`);
const { PGlite } = await import(`${APP}/node_modules/@electric-sql/pglite/dist/index.js`);
const TOKEN = process.env.HARNESS_TOKEN!;
const installed = process.env.HARNESS_INSTALLED !== "0";
let pg: any;
if (installed) pg = await freshDb({ saas: false });
else { pg = await freshDb({ saas: false }); await pg.exec(sql("006_courier.down.sql")); }
const q = { query: (s: string, p?: unknown[]) => pg.query(s, p as any[]) } as any;
const eq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const srv = createServer(async (req, res) => {
  const url = new URL(req.url!, "http://x");
  const json = (code: number, body: unknown, h: Record<string, string> = {}) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8", ...h }); res.end(JSON.stringify(body)); };
  if (req.method === "POST" && url.pathname === "/__seed") { // harness-only
    let raw = ""; for await (const c of req) raw += c;
    const b = JSON.parse(raw);
    if (b.op === "send") return json(200, await store.sendMessage(q, "self", b.msg, { clientName: "harness" }));
    if (b.op === "read") return json(200, await store.markRead(q, "self", { message_ids: b.ids, agent_name: b.agent }, { clientName: "harness" }));
    return json(400, {});
  }
  if (req.method !== "GET" || url.pathname !== "/mailbox/unread") return json(404, { error: "not found" });
  // ---- copied from PR #3 single.ts app.get("/mailbox/unread") ----
  const expected = TOKEN;
  if (!expected) { json(404, { error: "not found" }); return; }
  const header = String(req.headers.authorization ?? "");
  const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!presented || !eq(presented, expected)) { json(401, { error: "unauthorized" }); return; }
  const agent = String(url.searchParams.get("agent") ?? "");
  const since = Number(url.searchParams.get("since_id") ?? 0);
  const h = { "Cache-Control": "no-store" };
  try {
    const out = { generated_at: new Date().toISOString(), poll_after_seconds: 60, ...(await store.unreadSummary(q, "self", agent, Number.isFinite(since) ? since : 0)) };
    json(200, out, h);
  } catch (e: any) {
    if (e instanceof store.PostOfficeError) { json(400, { error: "bad_request", error_description: e.message }, h); return; }
    if (e?.code === "42P01") { json(503, { error: "courier_not_installed" }, h); return; }
    json(500, { error: "mailbox status unavailable" }, h);
  }
});
srv.listen(0, "127.0.0.1", () => { console.log(`READY http://127.0.0.1:${(srv.address() as any).port}`); });
void PGlite;
