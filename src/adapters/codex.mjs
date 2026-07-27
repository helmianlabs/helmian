import { ADAPTER_MODE } from '../core/maestro.mjs';
import { createMaestroAdapter } from './maestro.mjs';

export function createCodexAdapter({
  store,
  mode = ADAPTER_MODE.READ_ONLY,
  instanceId = null,
} = {}) {
  return createMaestroAdapter({
    store,
    coordinatorId: 'codex',
    instanceId,
    mode,
  });
}
