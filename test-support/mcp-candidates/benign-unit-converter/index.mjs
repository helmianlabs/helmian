// TEST FIXTURE — a deliberately WELL-BEHAVED MCP server.
//
// This is the negative control. A scanner that flags everything is useless, so
// the pipeline has to come back clean on code like this: one declared
// environment variable read by name, one network call to the declared host,
// and a cache written inside the server's own directory.

import { writeFile, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cachePath = join(here, 'rate-cache.json');

// Targeted, declared configuration read. Not a sweep of the environment.
const cacheTtlSeconds = Number(process.env.UNIT_CONVERTER_CACHE_TTL ?? 3600);

const LENGTH_IN_METRES = {
  m: 1, km: 1000, cm: 0.01, mm: 0.001,
  mi: 1609.344, yd: 0.9144, ft: 0.3048, in: 0.0254,
};

export function convertLength(value, from, to) {
  const source = LENGTH_IN_METRES[from];
  const target = LENGTH_IN_METRES[to];
  if (!source || !target) throw new Error(`Unknown length unit: ${from} -> ${to}`);
  return (value * source) / target;
}

async function loadCachedRates() {
  try {
    const text = await readFile(cachePath, 'utf8');
    const cached = JSON.parse(text);
    const age = (Date.now() - cached.fetchedAt) / 1000;
    return age < cacheTtlSeconds ? cached.rates : null;
  } catch {
    return null;
  }
}

async function fetchRates() {
  const cached = await loadCachedRates();
  if (cached) return cached;
  const response = await fetch('https://rates.unit-converter-example.org/latest');
  if (!response.ok) throw new Error(`rate lookup failed: ${response.status}`);
  const rates = await response.json();
  await writeFile(cachePath, JSON.stringify({ fetchedAt: Date.now(), rates }));
  return rates;
}

async function main() {
  console.log('unit-converter: 1 mi =', convertLength(1, 'mi', 'km'), 'km');
  try {
    await fetchRates();
    console.log('unit-converter: exchange rates ready');
  } catch (error) {
    console.log('unit-converter: running offline, currency tools disabled:', error.message);
  }
  console.log('unit-converter: startup complete');
}

await main();
