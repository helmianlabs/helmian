const API = 'https://console.neon.tech/api/v2';

function required(value, label) { const text = String(value ?? '').trim(); if (!text) throw new TypeError(`${label} is required`); return text; }
function object(value, label) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Neon ${label} response is malformed`); return value; }
function array(value, label) { if (!Array.isArray(value)) throw new Error(`Neon ${label} response is malformed`); return value; }
function safeId(value, label) { return required(value, label).replace(/[^a-zA-Z0-9._:-]/gu, ''); }

async function request(fetchImpl, key, path, init = {}) {
  const response = await fetchImpl(`${API}${path}`, { ...init, headers: { accept: 'application/json', authorization: `Bearer ${key}`, ...(init.headers ?? {}) } });
  let body; try { body = await response.json(); } catch { throw new Error(`Neon ${init.method ?? 'GET'} ${path} returned malformed JSON`); }
  if (!response.ok) throw new Error(`Neon ${init.method ?? 'GET'} ${path} failed with HTTP ${response.status}`);
  return object(body, path);
}

export async function createGuardedNeonSnapshot({ endpointId, snapshotName, apiKey, fetchImpl = globalThis.fetch, pollLimit = 20, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const expectedEndpoint = required(endpointId, 'expected Neon endpoint ID');
  const key = required(apiKey, 'NEON_API_KEY');
  const name = required(snapshotName, 'snapshot name');
  if (!/^ep-[a-z0-9-]+$/iu.test(expectedEndpoint)) throw new TypeError('expected Neon endpoint ID must start with ep-');
  if (typeof fetchImpl !== 'function') throw new TypeError('Neon snapshot preflight needs fetch');
  if (!Number.isInteger(pollLimit) || pollLimit < 1 || pollLimit > 100) throw new TypeError('pollLimit must be an integer from 1 through 100');
  const projects = array((await request(fetchImpl, key, '/projects')).projects, 'projects');
  const matches = [];
  for (const project of projects) {
    const projectId = required(project?.id, 'project id');
    const endpoints = array((await request(fetchImpl, key, `/projects/${encodeURIComponent(projectId)}/endpoints`)).endpoints, 'endpoints');
    for (const endpoint of endpoints) if (endpoint?.id === expectedEndpoint) matches.push({ projectId, endpoint });
  }
  if (matches.length !== 1) throw new Error(matches.length ? `Expected endpoint ${expectedEndpoint} matched multiple Neon projects` : `Expected endpoint ${expectedEndpoint} was not found in accessible Neon projects`);
  const { projectId, endpoint } = matches[0]; const branchId = required(endpoint.branch_id, 'endpoint branch id');
  const branches = array((await request(fetchImpl, key, `/projects/${encodeURIComponent(projectId)}/branches`)).branches, 'branches');
  const branch = branches.find((item) => item?.id === branchId);
  if (!branch) throw new Error(`Endpoint ${expectedEndpoint} branch was not returned by Neon`);
  if (branch.parent_id != null) throw new Error(`Endpoint ${expectedEndpoint} is not attached to a root branch; refusing snapshot`);
  const created = await request(fetchImpl, key, `/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branchId)}/snapshot?name=${encodeURIComponent(name)}`, { method: 'POST' });
  const snapshot = object(created.snapshot, 'snapshot creation'); const snapshotId = required(snapshot.id, 'snapshot id');
  const operations = array(created.operations, 'snapshot creation operations'); const operationId = required(operations[0]?.id, 'snapshot operation id');
  let operation;
  for (let attempt = 0; attempt < pollLimit; attempt += 1) {
    operation = object((await request(fetchImpl, key, `/projects/${encodeURIComponent(projectId)}/operations/${encodeURIComponent(operationId)}`)).operation, 'operation');
    if (operation.status === 'finished') break;
    if (['failed', 'error', 'cancelled'].includes(String(operation.status).toLowerCase())) throw new Error(`Neon snapshot operation ${operationId} ended ${operation.status}`);
    if (attempt === pollLimit - 1) throw new Error(`Neon snapshot operation ${operationId} did not finish within ${pollLimit} polls`);
    await sleep(250);
  }
  const snapshots = array((await request(fetchImpl, key, `/projects/${encodeURIComponent(projectId)}/snapshots`)).snapshots, 'snapshots');
  const persisted = snapshots.find((item) => item?.id === snapshotId);
  if (!persisted) throw new Error(`Neon snapshot ${snapshotId} was not returned by read-back`);
  return Object.freeze({ projectId: safeId(projectId, 'project id'), branchId: safeId(branchId, 'branch id'), endpointId: safeId(expectedEndpoint, 'endpoint id'), snapshot: Object.freeze({ id: safeId(persisted.id, 'snapshot id'), name: String(persisted.name ?? name), createdAt: persisted.created_at ?? null }), operation: Object.freeze({ id: safeId(operationId, 'operation id'), status: operation.status }) });
}
