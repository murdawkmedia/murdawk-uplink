const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  MAX_PREVIEW_BYTES,
  buildPreviewCacheTarget,
  buildPreviewCopyArgs,
  cleanupPreviewCache,
  normalizePreviewRequest,
} = require('../src/preview-cache-core');

const profile = {
  remote: 'media',
  bucket: 'media',
  endpointHost: 'nyc3.digitaloceanspaces.com',
};

function request(name = 'card.png', overrides = {}) {
  return {
    connectionId: 'media',
    profile,
    item: {
      name,
      path: `sample-event/recordings/${name}`,
      isDir: false,
      size: 2048,
      modified: '2026-07-21T00:00:00Z',
      ...overrides,
    },
  };
}

test('accepts only supported bounded image objects with canonical formats', () => {
  const formats = new Map([
    ['card.png', 'PNG'],
    ['photo.jpg', 'JPEG'],
    ['photo.jpeg', 'JPEG'],
    ['image.webp', 'WEBP'],
    ['motion.gif', 'GIF'],
    ['poster.avif', 'AVIF'],
  ]);
  for (const [name, expected] of formats) {
    assert.equal(normalizePreviewRequest(request(name)).format, expected);
  }

  assert.throws(() => normalizePreviewRequest(request('clip.mp4')), /supported image/i);
  assert.throws(() => normalizePreviewRequest(request('folder.png', { isDir: true })), /file/i);
  assert.throws(() => normalizePreviewRequest(request('huge.png', { size: MAX_PREVIEW_BYTES + 1 })), /50 MB/i);
  assert.throws(() => normalizePreviewRequest(request('escape.png', { path: '../escape.png' })), /safe remote path/i);
});

test('builds deterministic contained cache paths from connection and object metadata', () => {
  const cacheDir = path.join(os.tmpdir(), 'murdawk-preview-cache-test');
  const first = buildPreviewCacheTarget(cacheDir, request('poster.AVIF'));
  const repeat = buildPreviewCacheTarget(cacheDir, request('poster.AVIF'));
  const changed = buildPreviewCacheTarget(cacheDir, request('poster.AVIF', {
    modified: '2026-07-22T00:00:00Z',
  }));
  const otherConnection = buildPreviewCacheTarget(cacheDir, {
    ...request('poster.AVIF'),
    connectionId: 'archive',
  });

  assert.equal(first.cachePath, repeat.cachePath);
  assert.notEqual(first.cachePath, changed.cachePath);
  assert.notEqual(first.cachePath, otherConnection.cachePath);
  assert.match(path.basename(first.cachePath), /^preview-[a-f0-9]{64}\.avif$/);
  assert.equal(path.relative(path.resolve(cacheDir), first.cachePath).startsWith('..'), false);
  assert.equal(first.remotePath, 'media:media/sample-event/recordings/poster.AVIF');
});

test('builds a read-only preview copy command', () => {
  const target = buildPreviewCacheTarget('C:\\Temp\\Murdawk Uplink\\previews', request());
  const args = buildPreviewCopyArgs(target);

  assert.deepEqual(args, [
    'copyto',
    'media:media/sample-event/recordings/card.png',
    target.cachePath,
    '--size-only',
  ]);
  assert.doesNotMatch(args.join(' '), /--s3-acl|delete|purge|moveto/i);
});

test('cleanup removes only expired or excess generated cache files', (t) => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'murdawk-preview-cleanup-'));
  t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
  const now = Date.parse('2026-07-21T12:00:00Z');
  const names = [
    `preview-${'a'.repeat(64)}.png`,
    `preview-${'b'.repeat(64)}.jpg`,
    `preview-${'c'.repeat(64)}.avif`,
  ];
  for (const [index, name] of names.entries()) {
    const target = path.join(cacheDir, name);
    fs.writeFileSync(target, name);
    const at = new Date(now - ((index + 1) * 60_000));
    fs.utimesSync(target, at, at);
  }
  fs.writeFileSync(path.join(cacheDir, 'keep-me.txt'), 'not preview cache data');

  const result = cleanupPreviewCache(cacheDir, {
    maxAgeMs: 90_000,
    maxFiles: 1,
    now,
  });

  assert.deepEqual(result.removed.sort(), names.slice(1).sort());
  assert.deepEqual(result.kept, [names[0]]);
  assert.equal(fs.existsSync(path.join(cacheDir, 'keep-me.txt')), true);
});
