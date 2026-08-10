import assert from 'node:assert/strict'; import test from 'node:test';
import { startHelmianCloudAdmin } from '../src/cloud/admin-server.mjs';
test('sample admin website serves tenant-scoped working controls locally', async (t) => {
  const app = await startHelmianCloudAdmin({ port: 0 }); t.after(() => app.close());
  assert.equal((await fetch(`${app.url}/`)).status, 200);
  const control = await fetch(`${app.url}/api/control-surface?tenant_id=acme-operations&actor_role=admin`); assert.equal(control.status, 200); assert.equal((await control.json()).result.tenant_id, 'acme-operations');
  const loads = await fetch(`${app.url}/api/sample-loads?tenant_id=acme-operations&actor_role=admin&provider_id=dat&origin=Dallas%2C%20TX&equipment=dry_van`); assert.equal(loads.status, 200); assert.equal((await loads.json()).result.loads[0].load_id, 'load-301');
});
