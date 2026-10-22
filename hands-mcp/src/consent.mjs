// The OAuth consent / passphrase screen (same human gate as the memory server).

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function renderConsentPage({ pendingId, clientName, error, scopes = [] }) {
  const wantsAct = scopes.includes('hands.act');
  const sub = wantsAct
    ? 'An application is asking to use Helmian hands on your PC: read files in your workspace, ask local Ollama, and REQUEST actions (PowerShell, opening pages, writing files). Every action still needs a separate Executive Guard approval; nothing runs on approval of this page alone.'
    : 'An application is asking for read-only Helmian hands on your PC: list and read files in your workspace roots and ask local Ollama. It cannot change anything.';
  const errorBlock = error ? `<p class="error">${escapeHtml(error)}</p>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Authorize Helmian hands</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; background:#0b0d10; color:#e9eef3;
         display:flex; min-height:100vh; align-items:center; justify-content:center; margin:0; }
  .card { background:#15191e; border:1px solid #262b31; border-radius:14px; padding:32px 28px;
          width:min(440px, 92vw); box-shadow:0 10px 40px rgba(0,0,0,.5); }
  h1 { font-size:20px; margin:0 0 6px; }
  p.sub { color:#9aa6b2; margin:0 0 22px; font-size:14px; line-height:1.5; }
  .client { background:#1d2329; border:1px solid #2b323a; border-radius:8px; padding:10px 12px;
            font-size:13px; color:#c7d0d9; margin-bottom:20px; }
  label { display:block; font-size:13px; margin-bottom:6px; color:#c7d0d9; }
  input[type=password] { width:100%; box-sizing:border-box; padding:11px 12px; border-radius:8px;
            border:1px solid #2b323a; background:#0e1216; color:#e9eef3; font-size:15px; }
  button { width:100%; margin-top:18px; padding:12px; border:0; border-radius:8px;
           background:#3b82f6; color:#fff; font-size:15px; font-weight:600; cursor:pointer; }
  button.deny { background:transparent; color:#9aa6b2; border:1px solid #2b323a; margin-top:10px; }
  .error { color:#ff6b6b; font-size:13px; margin:0 0 14px; }
  .foot { margin-top:18px; font-size:12px; color:#6b7682; line-height:1.5; }
</style>
</head>
<body>
  <div class="card">
    <h1>Authorize Helmian hands</h1>
    <p class="sub">${sub}</p>
    <div class="client">Requesting app: <strong>${escapeHtml(clientName)}</strong></div>
    ${errorBlock}
    <form method="POST" action="/consent">
      <input type="hidden" name="pending_id" value="${escapeHtml(pendingId)}" />
      <label for="passphrase">Passphrase</label>
      <input id="passphrase" name="passphrase" type="password" autocomplete="off" autofocus required />
      <button type="submit" name="action" value="approve">Approve</button>
      <button type="submit" name="action" value="deny" class="deny">Deny</button>
    </form>
    <p class="foot">Revoke any time by disconnecting the connector, or turn all hands off with HANDS_ENABLED=false on the server.</p>
  </div>
</body>
</html>`;
}
