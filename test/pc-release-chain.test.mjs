// PC release chain guards: the pipeline must live where GitHub Actions looks,
// and the installer payload must contain the bridge an installed PC runs.
// Structural (file-content) tests, matching this repo's guard style — the real
// Windows build itself runs on the windows-latest release runner.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

test('release workflow lives under .github/workflows, not the installer folder', () => {
  assert.ok(existsSync(new URL('../.github/workflows/desktop-release.yml', import.meta.url)));
  assert.ok(!existsSync(new URL('../desktop/installer/desktop-release.workflow.yml', import.meta.url)));
  const yml = read('.github/workflows/desktop-release.yml');
  assert.ok(!yml.includes('\t'), 'workflow YAML must not contain tabs');
  assert.match(yml, /name: desktop-release/u);
  assert.match(yml, /tags: \[ 'v\*\.\*\.\*' \]/u);
  assert.match(yml, /workflow_dispatch/u);
  assert.match(yml, /runs-on: windows-latest/u);
  assert.match(yml, /desktop\/scripts\/publish\.ps1/u);
  assert.match(yml, /Publish GitHub Release \(tags only\)/u);
  assert.match(yml, /gh release create/u);
});

test('publish.ps1 ships the bridge service and the Node bridge app', () => {
  const ps1 = read('desktop/scripts/publish.ps1');
  assert.match(ps1, /Helmion\.BridgeService\\Helmion\.BridgeService\.csproj/u);
  assert.match(ps1, /Publish-HelmionProject -Project \$bridgeProject/u);
  assert.match(ps1, /Helmian Bridge Service\.exe/u);
  // The Node app the service supervises: scripts staged beside the exes,
  // production dependencies installed, and a node.exe bundled from the
  // build machine so an installed PC needs no pre-installed Node.js.
  assert.match(ps1, /bin\\pc-bridge\.mjs/u);
  assert.match(ps1, /bin\\hands-spoke\.mjs/u);
  assert.match(ps1, /'hands-mcp'/u);
  assert.match(ps1, /npm ci --omit=dev/u);
  assert.match(ps1, /'node\.exe'\)/u);
});

test('bridge service finds the bundled node.exe next to its own exe', () => {
  const cs = read('desktop/Helmion.BridgeService/BridgeSupervisor.cs');
  assert.match(cs, /AppContext\.BaseDirectory, "node\.exe"/u);
});
