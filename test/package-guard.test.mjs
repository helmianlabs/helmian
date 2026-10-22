// The packager produces Chrome, Edge and Firefox zips that carry exactly the
// shipped files and the right manifest, and never anything from test/.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import test from 'node:test';
import { crc32, packageGuard } from '../tools/package-guard.mjs';

// Reads a zip produced by zipFiles (no zip64, no data descriptors).
function readZip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const files = new Map();
  for (let i = 0; i < count; i += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
    const crc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const localNameLength = buffer.readUInt16LE(local + 26);
    const data = inflateRawSync(buffer.subarray(local + 30 + localNameLength, local + 30 + localNameLength + compressedSize));
    assert.equal(crc32(data), crc, `crc mismatch for ${name}`);
    files.set(name, data);
    offset += 46 + nameLength;
  }
  return files;
}

const dir = mkdtempSync(join(tmpdir(), 'guard-pkg-'));

for (const target of ['chrome', 'edge', 'firefox']) {
  test(`${target}: zip holds the manifest, the seven content scripts and no test files`, async () => {
    const result = await packageGuard({ target, out: join(dir, target), zip: join(dir, `${target}.zip`) });
    const files = readZip(readFileSync(result.zip));
    const manifest = JSON.parse(files.get('manifest.json').toString('utf8'));
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.version, result.version);
    for (const script of manifest.content_scripts[0].js) assert.ok(files.has(script), `${script} missing from the ${target} zip`);
    for (const required of ['background/worker.js', 'background/executive.js', 'background/flags-client.js', 'background/verify.js', 'popup/popup.html', 'content/guard.css', 'STAGING-MANIFEST.json']) {
      assert.ok(files.has(required), `${required} missing from the ${target} zip`);
    }
    assert.ok(![...files.keys()].some((name) => name.startsWith('test') || name.includes('test-support')), 'test files shipped');
    if (target === 'firefox') {
      assert.deepEqual(manifest.background.scripts, ['background/worker.js']);
      assert.ok(manifest.browser_specific_settings.gecko.id);
    } else {
      assert.equal(manifest.background.service_worker, 'background/worker.js');
    }
    const staging = JSON.parse(files.get('STAGING-MANIFEST.json').toString('utf8'));
    assert.equal(staging.signed, false);
    assert.equal(staging.public, false);
  });
}

test('unknown targets are refused', async () => {
  await assert.rejects(packageGuard({ target: 'safari', out: join(dir, 'x') }), /Unknown target/);
});
