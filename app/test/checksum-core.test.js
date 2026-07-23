const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  compareChecksumEntries,
  computeFileSha256,
  normalizeChecksumMode,
} = require('../src/checksum-core');

test('normalizes checksum modes', () => {
  assert.equal(normalizeChecksumMode(undefined), 'size');
  assert.equal(normalizeChecksumMode('sha256'), 'sha256');
  assert.equal(normalizeChecksumMode('full'), 'sha256');
  assert.throws(() => normalizeChecksumMode('md5'), /Unsupported checksum/);
});

test('computes local SHA-256 for a file', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'uplink-checksum-'));
  const file = path.join(folder, 'sample.txt');
  fs.writeFileSync(file, 'hello');

  assert.equal(
    await computeFileSha256(file),
    '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  );
});

test('compares checksum entries and reports mismatches', () => {
  const report = compareChecksumEntries([
    { name: 'good.mp4', localSha256: 'aaa', remoteSha256: 'aaa' },
    { name: 'bad.mp4', localSha256: 'bbb', remoteSha256: 'ccc' },
  ]);

  assert.equal(report.ok, false);
  assert.deepEqual(report.verified, [{ name: 'good.mp4', sha256: 'aaa' }]);
  assert.deepEqual(report.mismatched, [
    { name: 'bad.mp4', localSha256: 'bbb', remoteSha256: 'ccc' },
  ]);
});
