const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  buildDownloadArgs,
  buildDownloadCheckArgs,
  buildDownloadOperations,
  normalizeDownloadSelection,
  precheckDownloadTargets,
  verifyDownloadedTargets,
} = require('../src/download-core');

const profile = {
  remote: 'media',
  bucket: 'media',
  endpointHost: 'media.nyc3.digitaloceanspaces.com',
  transfers: 4,
  retries: 20,
  retriesSleep: '30s',
  lowLevelRetries: 60,
};

test('normalizes a frozen mixed remote selection', () => {
  assert.deepEqual(normalizeDownloadSelection([
    { path: 'sample-event/card.png', name: 'card.png', isDir: false, size: 10, modified: '2026-07-21T00:00:00Z' },
    { path: 'sample-event/assets', name: 'assets', isDir: true, size: 0, modified: '' },
  ]), [
    { path: 'sample-event/card.png', name: 'card.png', isDir: false, size: 10, modified: '2026-07-21T00:00:00Z' },
    { path: 'sample-event/assets', name: 'assets', isDir: true, size: 0, modified: '' },
  ]);
});

test('builds contained local targets while preserving selected names', () => {
  const operations = buildDownloadOperations({
    destination: 'C:\\Downloads\\Event',
    items: [
      { path: 'sample-event/card.png', name: 'card.png', isDir: false, size: 10 },
      { path: 'sample-event/assets', name: 'assets', isDir: true, size: 0 },
    ],
    profile,
  });

  assert.equal(operations[0].localPath, path.win32.join('C:\\Downloads\\Event', 'card.png'));
  assert.equal(operations[0].remotePath, 'media:media/sample-event/card.png');
  assert.equal(operations[1].localPath, path.win32.join('C:\\Downloads\\Event', 'assets'));
  assert.equal(operations[1].remotePath, 'media:media/sample-event/assets/');
});

test('builds read-only rclone download and verification arguments', () => {
  const [file, folder] = buildDownloadOperations({
    destination: 'C:\\Downloads\\Event',
    items: [
      { path: 'sample-event/card.png', name: 'card.png', isDir: false, size: 10 },
      { path: 'sample-event/assets', name: 'assets', isDir: true, size: 0 },
    ],
    profile,
  });

  assert.deepEqual(buildDownloadArgs(file, { dryRun: true }), [
    'copyto',
    'media:media/sample-event/card.png',
    'C:\\Downloads\\Event\\card.png',
    '--progress',
    '--transfers',
    '4',
    '--retries',
    '20',
    '--retries-sleep',
    '30s',
    '--low-level-retries',
    '60',
    '--size-only',
    '--dry-run',
  ]);
  assert.equal(buildDownloadArgs(folder)[0], 'copy');
  assert.deepEqual(buildDownloadCheckArgs(folder), [
    'check',
    'media:media/sample-event/assets/',
    'C:\\Downloads\\Event\\assets',
    '--size-only',
    '--one-way',
  ]);
  assert.equal(buildDownloadArgs(file).some((arg) => /delete|purge|moveto|s3-acl/i.test(arg)), false);
});

test('prechecks same-size files and leaves folders or mismatches pending', () => {
  const operations = buildDownloadOperations({
    destination: 'C:\\Downloads\\Event',
    items: [
      { path: 'sample-event/card.png', name: 'card.png', isDir: false, size: 10 },
      { path: 'sample-event/logo.avif', name: 'logo.avif', isDir: false, size: 20 },
      { path: 'sample-event/assets', name: 'assets', isDir: true, size: 0 },
    ],
    profile,
  });
  const sizes = new Map([
    [operations[0].localPath, 10],
    [operations[1].localPath, 19],
  ]);
  const result = precheckDownloadTargets(operations, {
    statSync(localPath) {
      if (!sizes.has(localPath)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return { isFile: () => true, size: sizes.get(localPath) };
    },
  });

  assert.deepEqual(result.existing.map((item) => item.name), ['card.png']);
  assert.deepEqual(result.mismatched.map((item) => item.name), ['logo.avif']);
  assert.deepEqual(result.pending.map((item) => item.name), ['logo.avif', 'assets']);
});

test('verifies files by size and folders by completed check result', () => {
  const operations = buildDownloadOperations({
    destination: 'C:\\Downloads\\Event',
    items: [
      { path: 'sample-event/card.png', name: 'card.png', isDir: false, size: 10 },
      { path: 'sample-event/assets', name: 'assets', isDir: true, size: 0 },
    ],
    profile,
  });
  const report = verifyDownloadedTargets(operations, {
    statSync: () => ({ isFile: () => true, size: 10 }),
    checkedFolders: new Set([operations[1].localPath]),
  });

  assert.equal(report.ok, true);
  assert.deepEqual(report.verified.map((item) => item.name), ['card.png', 'assets']);
});

test('rejects remote traversal and local escape names', () => {
  assert.throws(() => normalizeDownloadSelection([
    { path: 'sample-event/../secret.txt', name: 'secret.txt', isDir: false, size: 1 },
  ]), /safe remote path/i);
  assert.throws(() => buildDownloadOperations({
    destination: 'C:\\Downloads\\Event',
    items: [{ path: 'sample-event/secret.txt', name: '..\\secret.txt', isDir: false, size: 1 }],
    profile,
  }), /plain file or folder name/i);
  assert.throws(() => buildDownloadOperations({
    destination: 'relative\\folder',
    items: [{ path: 'sample-event/card.png', name: 'card.png', isDir: false, size: 1 }],
    profile,
  }), /absolute local destination/i);
});
