import {
  ADAPTER_MODE,
  ReadOnlyAdapterError,
  handoffOperationStatus,
  normalizeCoordinatorId,
  normalizeInstanceId,
} from '../core/maestro.mjs';
import {
  OPERATION_CLASS,
  executeClassifiedOperation,
} from '../core/operation-policy.mjs';

export function createMaestroAdapter({
  store,
  coordinatorId,
  instanceId = null,
  mode = ADAPTER_MODE.READ_ONLY,
}) {
  if (!store) throw new TypeError('store is required');
  const normalizedCoordinatorId = normalizeCoordinatorId(coordinatorId);
  if (!Object.values(ADAPTER_MODE).includes(mode)) {
    throw new TypeError(`Unknown adapter mode: ${mode}`);
  }
  const normalizedInstanceId = mode === ADAPTER_MODE.READ_WRITE
    ? normalizeInstanceId(instanceId)
    : instanceId == null ? null : normalizeInstanceId(instanceId);

  function requireWriteMode() {
    if (mode !== ADAPTER_MODE.READ_WRITE) {
      throw new ReadOnlyAdapterError(normalizedCoordinatorId);
    }
  }

  return Object.freeze({
    coordinatorId: normalizedCoordinatorId,
    instanceId: normalizedInstanceId,
    mode,

    async getProjectState(projectSlug) {
      return executeClassifiedOperation({
        operationClass: OPERATION_CLASS.SHARED_READ,
        execute: () => store.getMaestroProjectState(projectSlug),
      });
    },

    async getLatestHandoff(projectSlug) {
      return executeClassifiedOperation({
        operationClass: OPERATION_CLASS.SHARED_READ,
        execute: () => store.getLatestMaestroHandoff(projectSlug),
      });
    },

    async acquireWriteLease(input) {
      requireWriteMode();
      return executeClassifiedOperation({
        operationClass: OPERATION_CLASS.GOVERNANCE_WRITE,
        execute: () => store.acquireMaestroLease({
          ...input,
          coordinatorId: normalizedCoordinatorId,
          holderInstanceId: normalizedInstanceId,
        }),
      });
    },

    async createCheckpoint(input) {
      requireWriteMode();
      return executeClassifiedOperation({
        operationClass: OPERATION_CLASS.GOVERNANCE_WRITE,
        execute: () => store.createProjectCheckpoint({
          ...input,
          coordinatorId: normalizedCoordinatorId,
          holderInstanceId: normalizedInstanceId,
        }),
      });
    },

    async releaseWriteLease(input) {
      requireWriteMode();
      return executeClassifiedOperation({
        operationClass: OPERATION_CLASS.GOVERNANCE_WRITE,
        execute: () => store.releaseMaestroLease({
          ...input,
          coordinatorId: normalizedCoordinatorId,
          holderInstanceId: normalizedInstanceId,
        }),
      });
    },

    async transferWriteLease(input) {
      requireWriteMode();
      return executeClassifiedOperation({
        operationClass: OPERATION_CLASS.GOVERNANCE_WRITE,
        execute: () => store.transferMaestroLease({
          ...input,
          coordinatorId: normalizedCoordinatorId,
          holderInstanceId: normalizedInstanceId,
        }),
      });
    },

    async recordHumanConfirmation(input) {
      requireWriteMode();
      return executeClassifiedOperation({
        operationClass: OPERATION_CLASS.GOVERNANCE_WRITE,
        execute: () => store.recordHumanConfirmation(input),
      });
    },

    async authorizeHandoffOperation(input) {
      requireWriteMode();
      return executeClassifiedOperation({
        operationClass: OPERATION_CLASS.GOVERNANCE_WRITE,
        execute: () => store.consumeHumanConfirmation({
          ...input,
          coordinatorId: normalizedCoordinatorId,
          holderInstanceId: normalizedInstanceId,
        }),
      });
    },

    async recordTelemetry(event) {
      return executeClassifiedOperation({
        operationClass: OPERATION_CLASS.TELEMETRY,
        execute: () => store.recordTelemetry({
          ...event,
          coordinatorId: normalizedCoordinatorId,
          holderInstanceId: normalizedInstanceId,
        }),
      });
    },

    evaluateHandoffOperation(input) {
      return handoffOperationStatus(input);
    },
  });
}
