// Local-vs-cloud compute routing policy (hub/spoke, spec 3.2 + 3.9 "hybrid vision").
//
// The phone and /app talk only to the cloud hub. Work runs on one of two spokes:
//   pc     - Troy's Windows PC via the PC bridge (Ollama, local files, PowerShell,
//            Unity, the signed-in desktop browser). Only when the PC is ON.
//   runner - the Hetzner runner (always on, PC can be off; cloud compute).
// This module is a pure decision function: no network, no credentials, no I/O.
// Provider keys never enter the cloud (019 contract); routing only ever sees
// presence booleans and capability names.

export const COMPUTE_TARGETS = Object.freeze(['pc', 'runner']);

// Capabilities that physically exist only on the PC. A job that needs one of
// these can never be silently moved to the runner.
export const PC_ONLY_CAPABILITIES = Object.freeze([
  'local-files', 'powershell', 'ollama', 'unity', 'pc-browser', 'pc-clipboard', 'phone',
]);

// Capabilities the runner provides and the PC may not (or must not be relied on for).
export const RUNNER_ONLY_CAPABILITIES = Object.freeze(['always-on', 'cloud-browser', 'scheduled']);

// Tool modes that change state. Anything not read-only crosses an Executive
// Guard approval before it runs, wherever it runs.
const SIDE_EFFECT_MODES = new Set(['ask', 'full', 'write']);

export const DEFAULT_ROUTING_POLICY = Object.freeze({
  prefer: 'auto',          // 'auto' | 'pc' | 'runner'
  presenceStaleMs: 90_000, // a spoke that has not checked in for this long is offline
  queueWhenPcOffline: true // PC-only work waits for the PC instead of failing
});

function isOnline(spoke, now, staleMs) {
  if (!spoke || spoke.online !== true) return false;
  const seen = Date.parse(spoke.lastSeenAt ?? '');
  return Number.isFinite(seen) && now - seen <= staleMs;
}

function has(spoke, capability) {
  return Array.isArray(spoke?.capabilities) && spoke.capabilities.includes(capability);
}

function normalizeNeeds(needs) {
  const list = Array.isArray(needs) ? needs : [];
  return [...new Set(list.map((n) => String(n).trim().toLowerCase()).filter(Boolean))];
}

/**
 * @param {object} input
 * @param {{ needs?: string[], toolsMode?: string, costSensitive?: boolean, pinned?: 'pc'|'runner' }} input.job
 * @param {{ pc?: {online:boolean,lastSeenAt:string,capabilities?:string[]}, runner?: {online:boolean,lastSeenAt:string,capabilities?:string[]} }} input.presence
 * @returns {{ outcome: 'route'|'queue'|'refuse', target: 'pc'|'runner'|null, reason: string, requiresGuardApproval: boolean }}
 */
export function decideComputeRoute({ job = {}, presence = {}, policy = DEFAULT_ROUTING_POLICY, now = Date.now() } = {}) {
  const p = { ...DEFAULT_ROUTING_POLICY, ...policy };
  const needs = normalizeNeeds(job.needs);
  const requiresGuardApproval = SIDE_EFFECT_MODES.has(String(job.toolsMode ?? 'read-only').toLowerCase());
  const pcUp = isOnline(presence.pc, now, p.presenceStaleMs);
  const runnerUp = isOnline(presence.runner, now, p.presenceStaleMs);
  const pcOnly = needs.filter((n) => PC_ONLY_CAPABILITIES.includes(n));
  const runnerOnly = needs.filter((n) => RUNNER_ONLY_CAPABILITIES.includes(n));
  const result = (outcome, target, reason) => Object.freeze({ outcome, target, reason, requiresGuardApproval });

  if (pcOnly.length && runnerOnly.length) {
    return result('refuse', null, `Job needs both PC-only (${pcOnly.join(', ')}) and runner-only (${runnerOnly.join(', ')}) capabilities; split it into two jobs.`);
  }
  if (job.pinned && !COMPUTE_TARGETS.includes(job.pinned)) {
    return result('refuse', null, `Unknown pinned target "${job.pinned}".`);
  }
  if (pcOnly.length || job.pinned === 'pc') {
    if (job.pinned === 'runner') return result('refuse', null, `Job is pinned to the runner but needs ${pcOnly.join(', ')}, which only the PC has.`);
    if (pcUp) {
      const missing = pcOnly.filter((n) => presence.pc?.capabilities && !has(presence.pc, n));
      if (missing.length) return result('refuse', null, `The PC is online but does not report ${missing.join(', ')}.`);
      return result('route', 'pc', pcOnly.length ? `Needs ${pcOnly.join(', ')}, which only the PC has.` : 'Pinned to the PC.');
    }
    return p.queueWhenPcOffline
      ? result('queue', 'pc', 'The PC is off or not checked in. The job waits for it; nothing is moved to the runner.')
      : result('refuse', null, 'The PC is off and this job cannot run anywhere else.');
  }
  if (runnerOnly.length || job.pinned === 'runner') {
    return runnerUp
      ? result('route', 'runner', runnerOnly.length ? `Needs ${runnerOnly.join(', ')}, which the runner provides.` : 'Pinned to the runner.')
      : result('refuse', null, 'The runner is offline and this job needs it.');
  }
  // Portable job (plain model turn, web research, summaries).
  const order = p.prefer === 'pc' ? ['pc', 'runner']
    : p.prefer === 'runner' ? ['runner', 'pc']
    // auto: free local compute first when the job is cost-sensitive and the PC has Ollama.
    : (job.costSensitive && pcUp && has(presence.pc, 'ollama')) ? ['pc', 'runner'] : ['runner', 'pc'];
  for (const target of order) {
    if (target === 'pc' && pcUp) return result('route', 'pc', p.prefer === 'auto' ? 'Cost-sensitive job: local Ollama on the PC is free.' : 'Policy prefers the PC.');
    if (target === 'runner' && runnerUp) return result('route', 'runner', pcUp ? 'Runner preferred for portable work.' : 'The PC is off; the runner handles portable work.');
  }
  return result('queue', null, 'Neither the PC nor the runner is online. The job waits for the first one to check in.');
}
