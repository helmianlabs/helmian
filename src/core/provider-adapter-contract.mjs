const TRANSPORTS = new Set(['cli', 'api', 'local_endpoint']);
const DOCUMENTATION_STATUSES = new Set([
  'documentation_required',
  'verified_documented',
]);
const CAPABILITY_STATUSES = new Set(['supported', 'unsupported', 'unknown']);
const REQUIRED_CAPABILITIES = [
  'readOnly',
  'workspaceWrite',
  'toolUse',
  'streaming',
  'voice',
];
const FORBIDDEN_KEY = /(password|secret|token|connectionstring|credentialvalue)/i;
const STABLE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function defineProviderAdapterContract(input) {
  const contract = structuredClone(input);
  validateContract(contract);
  return deepFreeze(contract);
}

export function createProviderAdapterRegistry(contracts) {
  const byId = new Map();
  for (const candidate of contracts) {
    const contract = defineProviderAdapterContract(candidate);
    if (byId.has(contract.id)) {
      throw new Error(`duplicate provider adapter ID: ${contract.id}`);
    }
    byId.set(contract.id, contract);
  }

  return Object.freeze({
    list() {
      return Object.freeze([...byId.values()]);
    },
    get(id) {
      return byId.get(id) ?? null;
    },
    isActivationEligible(id) {
      const contract = byId.get(id);
      return contract !== undefined
        && contract.status === 'available'
        && contract.invocation.every(
          (item) => item.documentationStatus === 'verified_documented',
        );
    },
  });
}

function validateContract(contract) {
  rejectSecretBearingKeys(contract);
  requireStableId(contract.id, 'provider adapter ID');
  requireText(contract.displayName, 'displayName');
  requireText(contract.status, 'status');
  if (!['design_only', 'available', 'disabled'].includes(contract.status)) {
    throw new Error('status must be design_only, available, or disabled');
  }

  requireText(contract.identity?.kind, 'identity.kind');
  requireText(contract.identity?.verification, 'identity.verification');
  requireText(contract.auth?.type, 'auth.type');
  requireText(contract.auth?.custody, 'auth.custody');

  if (!Array.isArray(contract.invocation) || contract.invocation.length === 0) {
    throw new Error('invocation must declare at least one supported surface');
  }
  for (const item of contract.invocation) {
    if (!TRANSPORTS.has(item.transport)) {
      throw new Error(
        'invocation transport must be cli, api, or local_endpoint; consumer UI automation is forbidden',
      );
    }
    if (!DOCUMENTATION_STATUSES.has(item.documentationStatus)) {
      throw new Error('invocation documentation status is invalid');
    }
    requireText(item.documentationReference, 'invocation.documentationReference');
  }

  for (const name of REQUIRED_CAPABILITIES) {
    if (!CAPABILITY_STATUSES.has(contract.capabilities?.[name])) {
      throw new Error(`capabilities.${name} must be supported, unsupported, or unknown`);
    }
  }

  if (contract.evidence?.format !== 'helmion.adapter-evidence.v1') {
    throw new Error('evidence format must be helmion.adapter-evidence.v1');
  }
  if (!Array.isArray(contract.evidence.requiredFields)
    || contract.evidence.requiredFields.length === 0) {
    throw new Error('evidence.requiredFields must not be empty');
  }

  if (contract.safety?.authority !== 'helmion-maestro') {
    throw new Error('adapter authority must remain helmion-maestro');
  }
  if (contract.safety.consumerUiAutomation !== false) {
    throw new Error('consumer UI automation must be explicitly disabled');
  }
  if (contract.capabilities.workspaceWrite === 'supported'
    && contract.safety.requiresLeaseForWorkspaceWrite !== true) {
    throw new Error('workspace write capability requires a Maestro lease');
  }
  if (contract.safety.providerCanGrantApproval !== false) {
    throw new Error('a provider adapter cannot grant Maestro approval');
  }

  if (contract.healthCheck?.mutates !== false) {
    throw new Error('adapter health checks must be non-mutating');
  }
  requireText(contract.healthCheck?.method, 'healthCheck.method');
}

function rejectSecretBearingKeys(value, path = 'contract') {
  if (value === null || typeof value !== 'object') {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) {
      throw new Error(`secret-bearing contract field is forbidden: ${path}.${key}`);
    }
    rejectSecretBearingKeys(child, `${path}.${key}`);
  }
}

function requireStableId(value, label) {
  if (typeof value !== 'string' || !STABLE_ID.test(value)) {
    throw new Error(`${label} must be a stable lowercase ID`);
  }
}

function requireText(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} is required`);
  }
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

const sharedSafety = {
  authority: 'helmion-maestro',
  requiresLeaseForWorkspaceWrite: true,
  providerCanGrantApproval: false,
  consumerUiAutomation: false,
  restrictions: [
    'No provider may bypass Maestro risk, lease, confirmation, or audit rules',
    'No renderer, log, argument, fixture, or source-controlled secret material',
    'No activation before documented invocation and a read-only canary',
  ],
};

const sharedEvidence = {
  format: 'helmion.adapter-evidence.v1',
  requiredFields: [
    'adapterId',
    'providerIdentity',
    'target',
    'operationClass',
    'maestroDecision',
    'result',
    'observedAt',
  ],
};

const unknownCapabilities = {
  readOnly: 'unknown',
  workspaceWrite: 'unknown',
  toolUse: 'unknown',
  streaming: 'unknown',
  voice: 'unknown',
};

function designContract({
  id,
  displayName,
  authType,
  transports,
  documentationStatus = 'documentation_required',
  documentationReference = 'Activation-time review of current provider documentation required',
}) {
  return {
    id,
    displayName,
    status: 'design_only',
    identity: {
      kind: 'provider_account_or_local_profile',
      verification: 'Connection test must return a redacted, user-reviewable identity',
    },
    auth: {
      type: authType,
      custody: 'Provider-owned flow or Windows-protected Helmion local service',
    },
    invocation: transports.map((transport) => ({
      transport,
      documentationStatus,
      documentationReference,
    })),
    capabilities: { ...unknownCapabilities },
    evidence: { ...sharedEvidence, requiredFields: [...sharedEvidence.requiredFields] },
    safety: { ...sharedSafety, restrictions: [...sharedSafety.restrictions] },
    healthCheck: {
      method: 'Redacted identity, scope, target, and capability probe',
      mutates: false,
    },
  };
}

export const providerAdapterRegistry = createProviderAdapterRegistry([
  designContract({
    id: 'codex-cli',
    displayName: 'Codex CLI',
    authType: 'provider_owned_account_sign_in',
    transports: ['cli'],
    documentationStatus: 'verified_documented',
    documentationReference: 'https://learn.chatgpt.com/docs/auth',
  }),
  designContract({
    id: 'openai-api',
    displayName: 'OpenAI API',
    authType: 'service_protected_api_key',
    transports: ['api'],
    documentationStatus: 'verified_documented',
    documentationReference: 'https://developers.openai.com/api/reference/overview#authentication',
  }),
  designContract({
    id: 'claude-code-cli',
    displayName: 'Claude Code CLI',
    authType: 'explicit_isolated_local_profile',
    transports: ['cli'],
  }),
  designContract({
    id: 'gemini-cli',
    displayName: 'Gemini CLI',
    authType: 'provider_owned_google_sign_in',
    transports: ['cli'],
    documentationStatus: 'verified_documented',
    documentationReference: 'https://geminicli.com/docs/get-started/authentication/',
  }),
  designContract({
    id: 'gemini-api',
    displayName: 'Gemini API',
    authType: 'service_protected_authorization_key',
    transports: ['api'],
    documentationStatus: 'verified_documented',
    documentationReference: 'https://ai.google.dev/gemini-api/docs/api-key',
  }),
  designContract({
    id: 'grok',
    displayName: 'Grok API / CLI',
    authType: 'provider_flow_or_service_protected',
    transports: ['api', 'cli'],
  }),
]);
