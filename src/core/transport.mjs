export class As2TransportError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'As2TransportError';
    this.details = details;
  }
}

export function isValidMdn(mdn) {
  if (mdn?.valid === true) return true;
  const raw = String(mdn?.raw ?? mdn ?? '');
  return /disposition:\s*(?:automatic-action|manual-action)\/MDN-sent-(?:automatically|manually);\s*processed/i.test(raw);
}

function failureStatus(statusCode) {
  if (!statusCode || statusCode === 408 || statusCode === 429 || statusCode >= 500) {
    return 'PENDING_RETRY';
  }
  return 'FAILED';
}

export async function deliverAs2Outbound({ record, transport, repository }) {
  const pending = await repository.create({
    ...record,
    status: 'PENDING_RETRY',
    sent_at: null,
  });

  let response;
  try {
    response = await transport.send(record.payload, record.station);
  } catch (cause) {
    await repository.update(pending.id, {
      status: 'PENDING_RETRY',
      last_error: cause?.message ?? String(cause),
    });
    throw new As2TransportError('AS2 network transport failed', { cause, outboundId: pending.id });
  }

  if (response?.status !== 200 || !isValidMdn(response?.mdn)) {
    const status = failureStatus(response?.status);
    await repository.update(pending.id, {
      status,
      http_status: response?.status ?? null,
      last_error: response?.status !== 200 ? 'AS2 endpoint did not return HTTP 200' : 'Invalid or missing MDN',
    });
    throw new As2TransportError('AS2 delivery was not acknowledged', {
      outboundId: pending.id,
      httpStatus: response?.status,
      status,
    });
  }

  return repository.update(pending.id, {
    status: 'SENT',
    http_status: 200,
    mdn: response.mdn,
    sent_at: new Date().toISOString(),
    last_error: null,
  });
}

export function selectEffectiveWeight({ l3WeightLbs, at8WeightLbs }) {
  const l3 = Number(l3WeightLbs);
  if (l3WeightLbs != null && Number.isFinite(l3)) return l3;
  const at8 = Number(at8WeightLbs);
  if (at8WeightLbs != null && Number.isFinite(at8)) return at8;
  return null;
}
