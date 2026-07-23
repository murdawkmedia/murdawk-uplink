const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { loadEventManifestFile } = require('../src/event-manifest-file-core');

function withTempDirectory(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'murdawk-event-manifest-'));
  return Promise.resolve(run(root)).finally(() => fs.rmSync(root, { recursive: true, force: true }));
}

test('loads a bounded event manifest without returning its local path', () => withTempDirectory(async (root) => {
  const filePath = path.join(root, 'sample-event.json');
  fs.writeFileSync(filePath, JSON.stringify({
    eventName: 'sample-event',
    eventPrefix: 'sample-event',
    recordingsPrefix: 'sample-event/recordings',
  }));

  const result = await loadEventManifestFile(filePath);
  assert.equal(result.label, 'sample-event.json');
  assert.equal(result.manifest.eventPrefix, 'sample-event');
  assert.equal(Object.hasOwn(result, 'path'), false);
  assert.equal(JSON.stringify(result).includes(root), false);
}));

test('rejects malformed oversized secret-shaped and escaping manifests', async () => {
  await withTempDirectory(async (root) => {
    const malformed = path.join(root, 'malformed.json');
    fs.writeFileSync(malformed, '{');
    await assert.rejects(loadEventManifestFile(malformed), /valid JSON/i);

    const oversized = path.join(root, 'oversized.json');
    fs.writeFileSync(oversized, 'x'.repeat(257 * 1024));
    await assert.rejects(loadEventManifestFile(oversized), /too large/i);

    const secret = path.join(root, 'secret.json');
    fs.writeFileSync(secret, JSON.stringify({ accessKeyId: 'not-a-real-key' }));
    await assert.rejects(loadEventManifestFile(secret), /secret-shaped/i);

    const escaping = path.join(root, 'escaping.json');
    fs.writeFileSync(escaping, JSON.stringify({ eventPrefix: '../escape' }));
    await assert.rejects(loadEventManifestFile(escaping), /safe non-empty relative path/i);
  });
});
