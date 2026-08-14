export const ORGANIZATION_DATABASE_ROUTING_FORMAT = 'helmion.organization-database-routing.v1';
const LIFECYCLES = new Set(['planned', 'provisioning', 'active', 'suspended', 'retired']);

function text(value, name, max) {
  const result = String(value ?? '').trim();
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/u.test(result)) throw new Error(`${name} is invalid`);
  return result;
}

function identifier(value, name, max) {
  const result = text(value, name, max);
  if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(result)) throw new Error(`${name} is invalid`);
  return result;
}

export function normalizeOrganizationDatabaseRecord(row, organizationId) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Organization database record is unavailable');
  const expected = identifier(organizationId, 'Organization id', 128);
  const rowOrganizationId = identifier(row.tenant_id ?? row.organization_id, 'registry Organization id', 128);
  if (rowOrganizationId !== expected) throw new Error('database registry Organization does not match verified membership');
  if (['plantId', 'plant_id', 'facilityId', 'facility_id'].some((key) => Object.hasOwn(row, key))) throw new Error('database routing cannot use Plant or facility authority');
  const lifecycle = text(row.lifecycle, 'database lifecycle', 32).toLowerCase();
  if (!LIFECYCLES.has(lifecycle)) throw new Error('database lifecycle is invalid');
  const logicalDatabaseLocator = identifier(row.logical_database_locator, 'logical database locator', 128);
  const secretReferenceName = text(row.secret_reference_name, 'secret reference name', 256);
  if (!/^[a-z0-9][a-z0-9._:/-]{0,255}$/u.test(secretReferenceName) || secretReferenceName.includes('://') || /(?:postgres|postgresql|mysql|redis):/iu.test(secretReferenceName)) throw new Error('secret reference name is invalid');
  const region = text(row.region, 'database region', 64).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/u.test(region)) throw new Error('database region is invalid');
  return Object.freeze({ format: ORGANIZATION_DATABASE_ROUTING_FORMAT, valid: true, organizationId: expected, logicalDatabaseLocator, secretReferenceName, region, lifecycle, customerDatabase: lifecycle === 'active' ? 'eligible_for_future_adapter_only' : 'not_available', connectionString: null });
}

export function resolveOrganizationDatabase({ verifiedMembership, registryRecord } = {}) {
  if (!verifiedMembership?.active || verifiedMembership.membershipVerified !== true || !verifiedMembership.organizationId) throw new Error('verified active Organization membership is required');
  if (Object.keys(verifiedMembership).some((key) => ['plantId', 'plant_id', 'facilityId', 'facility_id'].includes(key))) throw new Error('verified membership cannot use Plant or facility authority');
  return normalizeOrganizationDatabaseRecord(registryRecord, verifiedMembership.organizationId);
}
