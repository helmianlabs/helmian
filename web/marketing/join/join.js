import { joinModel } from './join-model.mjs';
const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const show = (id) => { for (const s of ['loading', 'ready', 'problem']) $(`#${s}`).hidden = s !== id; };
function problem(model) { $('#problem-title').textContent = model.title; $('#problem-text').textContent = model.text; show('problem'); }
async function run() {
  const token = params.get('token') ?? '';
  const pre = joinModel({ token, error: params.get('error') });
  if (pre.state !== 'check') { problem(pre); return; }
  try {
    const res = await fetch(`/api/admin/join/preview?token=${encodeURIComponent(token)}`, { credentials: 'same-origin' });
    const body = await res.json().catch(() => ({}));
    const model = joinModel({ token, preview: res.ok ? body : null, status: res.status });
    if (model.state !== 'ready') { problem(model); return; }
    $('#org-name').textContent = model.organization;
    $('#signup').href = model.signupUrl; $('#signin').href = model.signinUrl;
    show('ready');
  } catch { problem(joinModel({ token, status: 503 })); }
}
run();
