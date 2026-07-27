export const OPERATION_CLASS = Object.freeze({
  TELEMETRY: 'telemetry',
  SHARED_READ: 'shared-read',
  GOVERNANCE_WRITE: 'governance-write',
});

const VALID_OPERATION_CLASSES = new Set(Object.values(OPERATION_CLASS));

export class DurabilityConfirmationError extends Error {
  constructor(message = 'Shared governance write did not return a durable commit confirmation') {
    super(message);
    this.name = 'DurabilityConfirmationError';
  }
}

export async function executeClassifiedOperation({ operationClass, execute }) {
  if (!VALID_OPERATION_CLASSES.has(operationClass)) {
    throw new TypeError(`Unknown operation class: ${operationClass}`);
  }
  if (typeof execute !== 'function') throw new TypeError('execute must be a function');

  try {
    const result = await execute();
    if (
      operationClass === OPERATION_CLASS.GOVERNANCE_WRITE
      && result?.durability !== 'committed'
    ) {
      throw new DurabilityConfirmationError();
    }
    return result;
  } catch (error) {
    if (operationClass !== OPERATION_CLASS.TELEMETRY) throw error;
    return {
      ok: false,
      recorded: false,
      failed_open: true,
      error: error?.message ?? String(error),
    };
  }
}
