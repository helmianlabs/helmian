export function parseExplicitMigrationVersions(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.trim() !== raw) {
    throw new TypeError('--versions requires a non-empty comma-separated ordered list with no whitespace');
  }
  const versions = raw.split(',');
  if (versions.some((version) => !/^\d+$/u.test(version))) {
    throw new TypeError('--versions accepts only numeric migration versions separated by commas, with no whitespace');
  }
  if (new Set(versions).size !== versions.length) {
    throw new TypeError('--versions must not contain duplicate migration versions');
  }
  return Object.freeze(versions);
}

export async function runExplicitMigrationCommand({ rawVersions, createStore, write }) {
  const versions = parseExplicitMigrationVersions(rawVersions);
  const store = await createStore();
  try {
    const result = await store.migrateExplicitlyAllowedSet(versions);
    write(`${JSON.stringify({
      target: result.target,
      requestedVersions: result.requestedVersions,
      receipts: result.receipts,
      durability: result.results.map((entry) => ({ migration: entry.migration, applied: entry.applied, durability: entry.durability })),
    }, null, 2)}\n`);
    return result;
  } finally {
    await store.close();
  }
}
