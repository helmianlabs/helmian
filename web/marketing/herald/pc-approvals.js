// Herald: PC actions waiting in Executive Guard (hands connector). Same-origin call to
// /api/admin/guard/pc-approvals with the Clerk session Bearer. Owner-only on the server;
// hidden when not configured or not allowed. Nothing runs until Troy taps Approve.

export function mountPcApprovals({ container, token, fetchImpl = fetch, confirmImpl = (m) => confirm(m) }) {
  if (!container) return { refresh: async () => {} };
  const section = document.createElement('div');
  section.className = 'guard-section';
  section.hidden = true;
  const h = document.createElement('h3');
  h.textContent = 'PC actions ';
  const count = document.createElement('span');
  count.textContent = '0';
  h.append(count);
  const note = document.createElement('p');
  const list = document.createElement('div');
  list.className = 'choice-list';
  section.append(h, note, list);
  container.prepend(section);

  async function call(path, init = {}) {
    const t = await token();
    if (!t) return { status: 401, body: {} };
    const res = await fetchImpl(path, { credentials: 'same-origin', ...init, headers: { authorization: `Bearer ${t}`, ...(init.body ? { 'content-type': 'application/json' } : {}) } });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  async function refresh() {
    let r;
    try { r = await call('/api/admin/guard/pc-approvals'); }
    catch { section.hidden = false; note.textContent = 'Guard is unreachable. Nothing will run until it answers.'; return; }
    if ([401, 403, 503].includes(r.status)) { section.hidden = true; return; }
    section.hidden = false;
    const items = Array.isArray(r.body.approvals) ? r.body.approvals : [];
    count.textContent = String(items.length);
    note.textContent = r.status !== 200 ? 'Guard is unreachable. Nothing will run until it answers.'
      : items.length ? 'An AI asked to run these on your PC. Nothing runs until you approve.' : 'No PC actions waiting.';
    list.replaceChildren(...items.map((a) => {
      const row = document.createElement('div');
      row.className = 'local-card';
      const title = document.createElement('strong');
      title.textContent = a.summary || a.tool || 'PC action';
      const why = document.createElement('p');
      why.textContent = a.reason || '';
      row.append(title, why);
      for (const approve of [true, false]) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = approve ? 'primary-button' : 'text-button';
        b.textContent = approve ? 'Approve' : 'Deny';
        b.onclick = async () => {
          if (approve && !confirmImpl(`Approve on your PC: ${a.summary || a.tool}?`)) return;
          b.disabled = true;
          await call('/api/admin/guard/pc-approvals/decide', { method: 'POST', body: JSON.stringify({ approvalId: a.approvalId, approve }) }).catch(() => {});
          await refresh();
        };
        row.append(b);
      }
      return row;
    }));
  }
  return { refresh };
}
