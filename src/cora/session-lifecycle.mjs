const SERVER_ROLE_BY_SIGNED_ROLE = Object.freeze({ owner: 'owner', admin: 'admin', member: 'member', auditor: 'auditor', driver: 'member' });

function bounded(value, field, max = 256, optional = false) {
  if (optional && (value == null || value === '')) return null;
  const result = String(value ?? '').trim();
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/u.test(result)) throw new Error(`${field} is invalid`);
  return result;
}

export async function recordCoraSessionLifecycle({ append, bridgeContext, sessionConfig = null, phase, failureReason = null, providerEvidence = null } = {}) {
  if (typeof append !== 'function') return Object.freeze({ recorded: false, reason: 'session lifecycle append adapter unavailable' });
  if (!bridgeContext?.tenantId || !bridgeContext.subjectId || !bridgeContext.role || !bridgeContext.sessionId || !bridgeContext.receiptId) throw new Error('verified signed Organization session context is required');
  const role = SERVER_ROLE_BY_SIGNED_ROLE[String(bridgeContext.role).toLowerCase()];
  if (!role) throw new Error('signed session role is invalid');
  const actor = { tenantId: bounded(bridgeContext.tenantId, 'session Organization'), subject: bounded(bridgeContext.subjectId, 'session subject'), role, sessionId: bounded(bridgeContext.sessionId, 'session id'), requestId: bounded(bridgeContext.receiptId, 'session receipt') };
  const result = await append(actor, { phase, bridgeContext, sessionConfig, failureReason, providerEvidence, startedAt: phase === 'started' ? new Date().toISOString() : null, endedAt: phase === 'ended' || phase === 'failed' ? new Date().toISOString() : null });
  return Object.freeze({ recorded: true, ...result });
}
