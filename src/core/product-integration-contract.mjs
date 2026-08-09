// Helmian product-integration boundary.
//
// DairyForge, AimForge, and Helmian remain separate products. These declarations
// carry no endpoint, credential, product data, or network behavior. They become
// eligible only after a product-specific, versioned API/data contract and a
// tenant-scoped authentication contract have been reviewed and verified.

const STATUS = new Set(['design_only', 'available', 'disabled']);
const VERIFICATION = new Set(['required', 'verified']);
const CAPABILITY = new Set(['supported', 'unsupported', 'unknown']);
const STABLE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FORBIDDEN_KEY = /(password|secret|token|connectionstring|credentialvalue|api[_-]?key)/i;

const REQUIRED_CAPABILITIES = [
  'exceptionContextRead',
  'advisoryEvidenceReturn',
  'productionWrite',
  'remoteAction',
];

export function defineProductIntegrationContract(input) {
  const contract = structuredClone(input);
  validateContract(contract);
  return deepFreeze(contract);
}

export function createProductIntegrationRegistry(contracts) {
  const byId = new Map();
  for (const candidate of contracts) {
    const contract = defineProductIntegrationContract(candidate);
    if (byId.has(contract.id)) {
      throw new Error(`duplicate product integration ID: ${contract.id}`);
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
        && contract.api.contractStatus === 'verified'
        && contract.api.authenticationStatus === 'verified'
        && contract.data.schemaStatus === 'verified'
        && contract.data.retentionStatus === 'verified'
        && contract.tenantScope.status === 'verified'
        && contract.capabilities.exceptionContextRead === 'supported'
        && contract.capabilities.productionWrite === 'unsupported'
        && contract.capabilities.remoteAction === 'unsupported';
    },
  });
}

function validateContract(contract) {
  rejectSecretBearingKeys(contract);
  requireStableId(contract.id, 'product integration ID');
  requireText(contract.displayName, 'displayName');
  if (!STATUS.has(contract.status)) {
    throw new Error('status must be design_only, available, or disabled');
  }

  for (const field of ['codebase', 'dataStore', 'identity', 'permissionModel']) {
    if (contract.productBoundary?.[field] !== 'separate') {
      throw new Error(`productBoundary.${field} must remain separate`);
    }
  }
  if (contract.productBoundary?.crossProductAccess !== false) {
    throw new Error('cross-product access must be explicitly disabled');
  }

  for (const field of ['contractStatus', 'authenticationStatus']) {
    if (!VERIFICATION.has(contract.api?.[field])) {
      throw new Error(`api.${field} must be required or verified`);
    }
  }
  if (contract.api.contractStatus !== 'verified' && contract.api.endpointReference != null) {
    throw new Error('an endpoint cannot be declared before its API contract is verified');
  }
  if (contract.api.authenticationStatus !== 'verified'
    && contract.api.authenticationReference != null) {
    throw new Error('authentication details cannot be declared before review is verified');
  }

  for (const field of ['schemaStatus', 'retentionStatus']) {
    if (!VERIFICATION.has(contract.data?.[field])) {
      throw new Error(`data.${field} must be required or verified`);
    }
  }
  if (!VERIFICATION.has(contract.tenantScope?.status)) {
    throw new Error('tenantScope.status must be required or verified');
  }
  if (contract.tenantScope?.enforcedBy !== 'source-product-and-helmian') {
    throw new Error('tenant scope must be enforced independently on both sides');
  }

  for (const name of REQUIRED_CAPABILITIES) {
    if (!CAPABILITY.has(contract.capabilities?.[name])) {
      throw new Error(`capabilities.${name} must be supported, unsupported, or unknown`);
    }
  }
  if (contract.capabilities.productionWrite !== 'unsupported'
    || contract.capabilities.remoteAction !== 'unsupported') {
    throw new Error('this integration slice cannot write to production or initiate remote actions');
  }

  if (contract.ai?.mode !== 'advisory_exception_analysis_only') {
    throw new Error('AI mode must remain advisory exception analysis only');
  }
  if (contract.ai?.providerNeutral !== true) {
    throw new Error('the product boundary must remain AI-provider neutral');
  }
  if (contract.ai?.autonomousDecision !== false
    || contract.ai?.autonomousToolUse !== false) {
    throw new Error('the integration cannot grant autonomous decisions or tool use');
  }
  if (contract.prohibitedUses?.employmentDecisionAutomation !== true
    || contract.prohibitedUses?.opaqueDriverScoring !== true) {
    throw new Error('employment automation and opaque driver scoring must be prohibited');
  }
  if (contract.healthCheck?.mutates !== false) {
    throw new Error('product integration health checks must be non-mutating');
  }
  requireText(contract.healthCheck?.method, 'healthCheck.method');
}

function rejectSecretBearingKeys(value, path = 'contract') {
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) {
      throw new Error(`secret-bearing integration field is forbidden: ${path}.${key}`);
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
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function designOnlyProduct(id, displayName) {
  return {
    id,
    displayName,
    status: 'design_only',
    productBoundary: {
      codebase: 'separate',
      dataStore: 'separate',
      identity: 'separate',
      permissionModel: 'separate',
      crossProductAccess: false,
    },
    api: {
      contractStatus: 'required',
      authenticationStatus: 'required',
      endpointReference: null,
      authenticationReference: null,
    },
    data: {
      schemaStatus: 'required',
      retentionStatus: 'required',
      allowedFields: [],
    },
    tenantScope: {
      status: 'required',
      enforcedBy: 'source-product-and-helmian',
    },
    capabilities: {
      exceptionContextRead: 'unknown',
      advisoryEvidenceReturn: 'unknown',
      productionWrite: 'unsupported',
      remoteAction: 'unsupported',
    },
    ai: {
      mode: 'advisory_exception_analysis_only',
      providerNeutral: true,
      autonomousDecision: false,
      autonomousToolUse: false,
    },
    prohibitedUses: {
      employmentDecisionAutomation: true,
      opaqueDriverScoring: true,
    },
    healthCheck: {
      method: 'Version, redacted product identity, tenant scope, and capability probe',
      mutates: false,
    },
  };
}

export const productIntegrationRegistry = createProductIntegrationRegistry([
  designOnlyProduct('dairyforge', 'DairyForge'),
  designOnlyProduct('aimforge', 'AimForge'),
]);
