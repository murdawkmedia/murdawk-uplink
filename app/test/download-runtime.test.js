const assert = require('node:assert/strict');
const test = require('node:test');

const { buildJobRecord, buildResumeQueueSettings } = require('../src/job-core');
const { runDownloadLifecycle } = require('../src/download-runtime');

const profile = {
  remote: 'media',
  bucket: 'media',
  endpointHost: 'nyc3.digitaloceanspaces.com',
  transfers: 4,
  retries: 20,
  retriesSleep: '30s',
  lowLevelRetries: 60,
};

function downloadFixture(items = [{
  path: 'sample-event/recordings/card.png',
  name: 'card.png',
  isDir: false,
  size: 10,
  modified: '2026-07-21T00:00:00Z',
}]) {
  const normalized = {
    intentId: 'download-intent',
    remoteItems: items,
    localDestination: 'C:\\Downloads\\Sample Event',
    prefix: 'sample-event/recordings',
    connectionId: 'media',
    profile,
    profileSnapshot: profile,
  };
  const job = buildJobRecord({
    jobId: 'download-job',
    intentId: normalized.intentId,
    sources: items.map((item) => item.path),
    prefix: normalized.prefix,
    connectionId: normalized.connectionId,
    profile,
    profileSnapshot: profile,
    direction: 'download',
    localDestination: normalized.localDestination,
    remoteItems: items,
    status: 'created',
  });
  return { job, normalized };
}

function missingStat(localPath) {
  throw Object.assign(new Error(`missing: ${localPath}`), { code: 'ENOENT' });
}

test('dry-run prechecks a download and never writes local files', async () => {
  const { job, normalized } = downloadFixture();
  const records = [];
  const events = [];
  const calls = [];

  const result = await runDownloadLifecycle(normalized, {
    dryRun: true,
    jobId: job.jobId,
    job,
  }, {
    assertReady: async () => ({ remote: 'media' }),
    emit: (channel, payload) => events.push({ channel, payload }),
    runRclone: async (args) => calls.push(args),
    statSync: missingStat,
    writeJobRecord: async (record) => records.push(record),
  });

  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(records.at(-1).status, 'ready');
  assert.equal(records.at(-1).direction, 'download');
  assert.equal(events.find((event) => event.channel === 'upload:preflight').payload.pendingCount, 1);
  assert.equal(events.find((event) => event.channel === 'upload:start').payload.mode, 'download-check');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].includes('--dry-run'), true);
});

test('mixed downloads preserve frozen order, skip matching files, and verify before completion', async () => {
  const items = [
    { path: 'sample-event/recordings/card.png', name: 'card.png', isDir: false, size: 10 },
    { path: 'sample-event/recordings/logo.avif', name: 'logo.avif', isDir: false, size: 20 },
    { path: 'sample-event/recordings/assets', name: 'assets', isDir: true, size: 0 },
  ];
  const { job, normalized } = downloadFixture(items);
  const localSizes = new Map([['C:\\Downloads\\Sample Event\\card.png', 10]]);
  const records = [];
  const events = [];
  const calls = [];
  const statSync = (localPath) => {
    if (!localSizes.has(localPath)) return missingStat(localPath);
    return { isFile: () => true, size: localSizes.get(localPath) };
  };

  const result = await runDownloadLifecycle(normalized, {
    dryRun: false,
    jobId: job.jobId,
    job,
  }, {
    assertReady: async () => ({ remote: 'media' }),
    emit: (channel, payload) => events.push({ channel, payload }),
    runRclone: async (args) => {
      calls.push(args);
      if (args[0] === 'copyto') localSizes.set(args[2], 20);
      return { stdout: '', stderr: '' };
    },
    statSync,
    writeJobRecord: async (record) => records.push(record),
  });

  assert.deepEqual(calls.map((args) => [args[0], args[1], args[2]]), [
    ['copyto', 'media:media/sample-event/recordings/logo.avif', 'C:\\Downloads\\Sample Event\\logo.avif'],
    ['copy', 'media:media/sample-event/recordings/assets/', 'C:\\Downloads\\Sample Event\\assets'],
    ['check', 'media:media/sample-event/recordings/assets/', 'C:\\Downloads\\Sample Event\\assets'],
  ]);
  assert.equal(result.verification.ok, true);
  assert.deepEqual(result.verification.verified.map((item) => item.name), ['card.png', 'logo.avif', 'assets']);
  assert.equal(records.at(-1).status, 'complete');
  assert.equal(events.some((event) => event.channel === 'upload:verified'), true);
  assert.equal(events.at(-1).channel, 'upload:complete');

  const flatArgs = calls.flat().join(' ');
  assert.doesNotMatch(flatArgs, /--s3-acl|delete|purge|moveto|copyurl/i);
});

test('paused download state remains resumable with its frozen selection', async () => {
  const { job, normalized } = downloadFixture();
  job.prefix = '';
  normalized.prefix = '';
  const records = [];
  const paused = Object.assign(new Error('Download paused by user.'), { paused: true });

  await assert.rejects(runDownloadLifecycle(normalized, {
    dryRun: false,
    jobId: job.jobId,
    job,
  }, {
    assertReady: async () => ({ remote: 'media' }),
    emit: () => {},
    runRclone: async () => { throw paused; },
    statSync: missingStat,
    writeJobRecord: async (record) => records.push(record),
  }), (error) => error.paused === true && error.terminalPersisted === true);

  assert.equal(records.at(-1).status, 'paused');
  const resume = buildResumeQueueSettings(records.at(-1));
  assert.equal(resume.direction, 'download');
  assert.equal(resume.localDestination, 'C:\\Downloads\\Sample Event');
  assert.deepEqual(resume.remoteItems, normalized.remoteItems);
});
