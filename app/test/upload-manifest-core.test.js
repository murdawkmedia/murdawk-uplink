const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  redactRuntimePaths,
  scavengeAbandonedManifests,
  withFrozenDirectoryManifest,
} = require('../src/upload-manifest-core');

function manifestFsMock() {
  const calls = [];
  return {
    calls,
    mkdirSync(directory, options) {
      calls.push({ type: 'mkdir', directory, options });
    },
    writeFileSync(filePath, contents, options) {
      calls.push({ type: 'write', filePath, contents, options });
    },
    rmSync(filePath, options) {
      calls.push({ type: 'remove', filePath, options });
    },
  };
}

test('writes only frozen relative paths and cleans the manifest after the process resolves', async () => {
  const fsApi = manifestFsMock();
  let spawnedWith = '';

  const result = await withFrozenDirectoryManifest({
    manifestDirectory: 'C:/AppRuns/manifests',
    relativePaths: ['day1/camera-a.mov', 'slides/title.pdf'],
    fsApi,
    uniqueId: () => 'fixed-id',
  }, async (manifestPath) => {
    spawnedWith = manifestPath;
    return { code: 0 };
  });

  const write = fsApi.calls.find((call) => call.type === 'write');
  const remove = fsApi.calls.find((call) => call.type === 'remove');
  assert.equal(result.code, 0);
  assert.equal(spawnedWith, write.filePath);
  assert.equal(write.contents, 'day1/camera-a.mov\nslides/title.pdf\n');
  assert.equal(write.contents.includes('C:/'), false);
  assert.equal(path.dirname(write.filePath), path.resolve('C:/AppRuns/manifests'));
  assert.equal(remove.filePath, write.filePath);
  assert.deepEqual(write.options, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
});

test('cleans the frozen manifest when the process rejects', async () => {
  const fsApi = manifestFsMock();
  let rejectedManifestPath = '';
  let rejectedError = null;

  await assert.rejects(
    withFrozenDirectoryManifest({
      manifestDirectory: 'C:/AppRuns/manifests',
      relativePaths: ['day1/camera-a.mov'],
      fsApi,
      uniqueId: () => 'failed-id',
    }, async (manifestPath) => {
      rejectedManifestPath = manifestPath;
      throw new Error(`mocked spawn failure at ${manifestPath}`);
    }),
    (error) => {
      rejectedError = error;
      return true;
    },
  );

  const write = fsApi.calls.find((call) => call.type === 'write');
  const remove = fsApi.calls.find((call) => call.type === 'remove');
  assert.equal(remove.filePath, write.filePath);
  assert.equal(fsApi.calls.filter((call) => call.type === 'remove').length, 1);
  assert.match(rejectedError.message, /mocked spawn failure at \[frozen-upload-manifest\]/);
  assert.equal(rejectedError.message.includes(rejectedManifestPath), false);
});

test('cleans the frozen manifest when the process is cancelled', async () => {
  const fsApi = manifestFsMock();
  const cancelled = new Error('mocked cancellation');
  cancelled.cancelled = true;

  await assert.rejects(
    withFrozenDirectoryManifest({
      manifestDirectory: 'C:/AppRuns/manifests',
      relativePaths: ['day1/camera-a.mov'],
      fsApi,
      uniqueId: () => 'cancelled-id',
    }, async () => {
      throw cancelled;
    }),
    (error) => error === cancelled && error.cancelled === true,
  );

  assert.equal(fsApi.calls.filter((call) => call.type === 'remove').length, 1);
  assert.equal(
    fsApi.calls.find((call) => call.type === 'remove').filePath,
    fsApi.calls.find((call) => call.type === 'write').filePath,
  );
});

test('redacts temporary manifest paths from process output before logging', () => {
  const manifestPath = 'C:\\AppRuns\\manifests\\upload-private.files-from-raw';
  const output = redactRuntimePaths(
    `Failed to read ${manifestPath} or C:/AppRuns/manifests/upload-private.files-from-raw`,
    [manifestPath],
  );

  assert.equal(output, 'Failed to read [frozen-upload-manifest] or [frozen-upload-manifest]');
  assert.equal(output.includes('upload-private'), false);
});

test('startup scavenger removes only stale generated manifests', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'uplink-manifest-scavenge-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const nowMs = Date.parse('2026-07-19T12:00:00.000Z');
  const stale = path.join(directory, 'upload-11111111-1111-4111-8111-111111111111.files-from-raw');
  const recent = path.join(directory, 'upload-22222222-2222-4222-8222-222222222222.files-from-raw');
  const unrelated = path.join(directory, 'keep-this.txt');
  const lookalike = path.join(directory, 'upload-not-a-uuid.files-from-raw');
  const matchingDirectory = path.join(directory, 'upload-33333333-3333-4333-8333-333333333333.files-from-raw');
  for (const filePath of [stale, recent, unrelated, lookalike]) {
    fs.writeFileSync(filePath, 'relative/path-only\n');
  }
  fs.mkdirSync(matchingDirectory);
  const staleTime = new Date(nowMs - (48 * 60 * 60 * 1000));
  const recentTime = new Date(nowMs - (5 * 60 * 1000));
  fs.utimesSync(stale, staleTime, staleTime);
  fs.utimesSync(recent, recentTime, recentTime);

  const result = scavengeAbandonedManifests({
    manifestDirectory: directory,
    nowMs,
    maxAgeMs: 24 * 60 * 60 * 1000,
  });

  assert.deepEqual(result.removed, [stale]);
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(recent), true);
  assert.equal(fs.existsSync(unrelated), true);
  assert.equal(fs.existsSync(lookalike), true);
  assert.equal(fs.statSync(matchingDirectory).isDirectory(), true);
});

test('startup scavenger honors its bounded inspection limit', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'uplink-manifest-bounded-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const nowMs = Date.parse('2026-07-19T12:00:00.000Z');
  const staleTime = new Date(nowMs - (48 * 60 * 60 * 1000));
  for (const id of [
    '41111111-1111-4111-8111-111111111111',
    '42222222-2222-4222-8222-222222222222',
    '43333333-3333-4333-8333-333333333333',
  ]) {
    const filePath = path.join(directory, `upload-${id}.files-from-raw`);
    fs.writeFileSync(filePath, 'relative/path-only\n');
    fs.utimesSync(filePath, staleTime, staleTime);
  }

  const result = scavengeAbandonedManifests({
    manifestDirectory: directory,
    nowMs,
    maxAgeMs: 24 * 60 * 60 * 1000,
    maxEntries: 1,
  });

  assert.equal(result.inspected, 1);
  assert.equal(result.removed.length, 1);
  assert.equal(fs.readdirSync(directory).length, 2);
});
