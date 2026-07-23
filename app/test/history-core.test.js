const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCancelledJobRecord,
  buildJobRecord,
  buildPausedJobRecord,
  buildResumeQueueSettings,
  jobRecordCanResume,
  jobRecordHasVerifiedCompletion,
  summarizeJobRecord,
} = require('../src/job-core');

test('failed and stale job records can become safe resume queue settings', () => {
  const record = {
    jobId: 'upload-stale',
    status: 'failed',
    sources: ['C:/Austria Mix/day-2/logs', 'C:/Austria Mix/day-2/clip.mov'],
    prefix: 'archive-event/recordings/raw/stage1/day2/mix',
    filterMode: 'all',
    include: '',
    checksumMode: 'sha256',
    error: 'network dropped',
  };

  assert.equal(jobRecordCanResume(record), true);
  const settings = buildResumeQueueSettings(record);
  assert.notEqual(settings.intentId, record.jobId);
  assert.match(settings.intentId, /^queue-/);
  delete settings.intentId;
  assert.deepEqual(settings, {
    sources: record.sources,
    prefix: record.prefix,
    filterMode: 'all',
    include: '',
    checksum: 'sha256',
    folderUploadMode: 'package',
    publicRead: true,
    resumeFromJobId: 'upload-stale',
    direction: 'upload',
  });
});

test('job records remember upload mode needed for accurate resume', () => {
  const record = buildJobRecord({
    jobId: 'upload-private-contents',
    status: 'failed',
    sources: ['C:/exports/day1'],
    prefix: 'archive-event/recordings/raw/stage1/day1/mix',
    filterMode: 'all',
    folderUploadMode: 'contents',
    publicRead: false,
  });

  assert.equal(record.folderUploadMode, 'contents');
  assert.equal(record.publicRead, false);
  assert.equal(buildResumeQueueSettings(record).folderUploadMode, 'contents');
  assert.equal(buildResumeQueueSettings(record).publicRead, false);
});

test('job records preserve download direction and resumable selection', () => {
  const remoteItems = [
    { name: 'card.png', path: 'sample-event/card.png', isDir: false, size: 10, modified: '' },
  ];
  const record = buildJobRecord({
    jobId: 'download-failed',
    status: 'failed',
    direction: 'download',
    sources: ['sample-event/card.png'],
    remoteItems,
    localDestination: 'C:\\Downloads\\Event',
    prefix: 'sample-event',
  });
  assert.equal(record.direction, 'download');
  assert.equal(record.localDestination, 'C:\\Downloads\\Event');
  assert.deepEqual(record.remoteItems, remoteItems);
  const resumed = buildResumeQueueSettings(record);
  assert.equal(resumed.direction, 'download');
  assert.equal(resumed.localDestination, 'C:\\Downloads\\Event');
  assert.deepEqual(resumed.remoteItems, remoteItems);
});

test('legacy job records default to upload direction', () => {
  assert.equal(buildJobRecord({ sources: ['C:/media/card.png'], prefix: 'sample-event' }).direction, 'upload');
});

test('running job records can retain the latest transfer activity snapshot', () => {
  const record = buildJobRecord({
    jobId: 'upload-active',
    status: 'running',
    sources: ['C:/exports/day2'],
    prefix: 'archive-event/recordings/raw/stage1/day2',
    transferState: {
      pid: 4242,
      currentFile: 'clip.mp4',
      percent: 42,
      transferred: '4.2 GiB',
      total: '10 GiB',
      speed: '2 MiB/s',
      eta: '49m',
      lastOutputAt: '2026-06-02T12:00:00.000Z',
    },
  });

  assert.equal(record.transferState.activeJobId, 'upload-active');
  assert.equal(record.transferState.pid, 4242);
  assert.equal(record.transferState.currentFile, 'clip.mp4');
  assert.equal(record.transferState.percent, 42);
  assert.equal(record.transferState.transferred, '4.2 GiB');
  assert.equal(record.transferState.total, '10 GiB');
  assert.equal(record.transferState.speed, '2 MiB/s');
  assert.equal(record.transferState.eta, '49m');
  assert.equal(record.transferState.lastOutputAt, '2026-06-02T12:00:00.000Z');
});

test('job records retain sanitized transfer diagnostics without secret-shaped fields', () => {
  const record = buildJobRecord({
    jobId: 'upload-diagnostics',
    status: 'running',
    sources: ['C:/exports/day2'],
    prefix: 'archive-event/recordings/raw/stage1/day2',
    notifications: {
      webhook: 'https://example.test/hook?token=secret',
      ntfy: 'private-topic',
    },
    diagnostics: {
      state: 'slow',
      recommendation: 'Observed speed is low for a sustained period.',
      safeAction: 'Keep uploading.',
      speed: {
        currentBytesPerSecond: 5242880,
        current: '5.0 MiB/s',
        rollingAverageBytesPerSecond: 5242880,
        rollingAverage: '5.0 MiB/s',
        peakBytesPerSecond: 10485760,
        peak: '10.0 MiB/s',
      },
      tuning: {
        transfers: 4,
        chunkSize: '64M',
        uploadConcurrency: 4,
        secretAccessKey: 'DO_NOT_STORE',
      },
      samples: [
        { at: '2026-06-02T12:00:00.000Z', bytesPerSecond: 5242880 },
      ],
      webhook: 'https://example.test/hook?token=secret',
    },
  });

  assert.equal(record.diagnostics.state, 'slow');
  assert.equal(record.diagnostics.speed.current, '5.0 MiB/s');
  assert.equal(record.diagnostics.tuning.transfers, 4);
  assert.equal(record.diagnostics.samples.length, 1);
  assert.doesNotMatch(JSON.stringify(record.diagnostics), /secret|webhook|token|private-topic/i);
});

test('complete job records summarize as history but do not resume', () => {
  const record = {
    jobId: 'upload-complete',
    status: 'complete',
    sources: ['C:/exports/day1.mov'],
    prefix: 'archive-event/recordings/raw/stage1/day1',
    verification: { verified: [{ name: 'day1.mov' }], missing: [], sizeMismatch: [], ok: true },
    urls: ['https://media.nyc3.digitaloceanspaces.com/archive-event/recordings/raw/stage1/day1/day1.mov'],
  };

  assert.equal(jobRecordCanResume(record), false);
  assert.deepEqual(summarizeJobRecord(record), {
    jobId: 'upload-complete',
    status: 'complete',
    prefix: 'archive-event/recordings/raw/stage1/day1',
    sourceCount: 1,
    verifiedCount: 1,
    missingCount: 0,
    urlCount: 1,
    canResume: false,
    error: '',
    direction: 'upload',
    localDestination: '',
  });
});

test('verified warning records stay history-only when only notification delivery failed', () => {
  const record = {
    jobId: 'upload-warning-notify',
    status: 'warning',
    sources: ['C:/exports/day1.mov'],
    prefix: 'archive-event/recordings/raw/stage1/day1',
    verification: { verified: [{ name: 'day1.mov' }], missing: [], sizeMismatch: [], ok: true },
    checksum: { ok: true, verified: [{ name: 'day1.mov' }], mismatched: [] },
    urls: ['https://media.nyc3.digitaloceanspaces.com/archive-event/recordings/raw/stage1/day1/day1.mov'],
    notificationAttempts: [{ type: 'webhook', ok: false, error: 'timeout' }],
  };

  assert.equal(jobRecordHasVerifiedCompletion(record), true);
  assert.equal(jobRecordCanResume(record), false);
  assert.equal(summarizeJobRecord(record).canResume, false);
});

test('warning records with incomplete verification remain resumable', () => {
  const record = {
    jobId: 'upload-warning-missing',
    status: 'warning',
    sources: ['C:/exports/day1.mov'],
    prefix: 'archive-event/recordings/raw/stage1/day1',
    verification: { verified: [], missing: [{ name: 'day1.mov' }], sizeMismatch: [], ok: false },
    error: 'remote object missing after upload',
  };

  assert.equal(jobRecordHasVerifiedCompletion(record), false);
  assert.equal(jobRecordCanResume(record), true);
  assert.equal(buildResumeQueueSettings(record).resumeFromJobId, 'upload-warning-missing');
});

test('cancelled job records are durable resumable history', () => {
  const base = buildJobRecord({
    jobId: 'upload-cancelled',
    status: 'running',
    sources: ['C:/exports/day1.mov'],
    prefix: 'archive-event/recordings/raw/stage1/day1',
    filterMode: 'all',
    folderUploadMode: 'package',
    publicRead: true,
  });
  const record = buildCancelledJobRecord(base, 'Transfer cancelled by user.');

  assert.equal(record.status, 'cancelled');
  assert.equal(record.error, 'Transfer cancelled by user.');
  assert.equal(jobRecordCanResume(record), true);
  assert.equal(buildResumeQueueSettings(record).resumeFromJobId, 'upload-cancelled');
  assert.equal(summarizeJobRecord(record).canResume, true);
});

test('paused records preserve intent options and progress and remain resumable', () => {
  const profile = {
    remote: 'event-a',
    bucket: 'archive',
    endpointHost: 'a.example.test',
  };
  const base = buildJobRecord({
    jobId: 'upload-paused',
    intentId: 'intent-paused',
    resumeFromJobId: 'upload-earlier',
    sources: ['C:/exports/clip.mov'],
    prefix: 'event/recordings',
    filterMode: 'media-docs',
    folderUploadMode: 'contents',
    publicRead: false,
    checksumMode: 'size',
    profile,
    status: 'running',
  });
  const record = buildPausedJobRecord({
    ...base,
    transferState: {
      activeJobId: 'upload-paused',
      source: 'C:/exports/clip.mov',
      sourceIndex: 1,
      sourceTotal: 2,
      transferred: '4 GiB',
      total: '10 GiB',
      percent: 40,
    },
  });

  assert.equal(record.status, 'paused');
  assert.equal(record.completedAt, '');
  assert.equal(record.intentId, 'intent-paused');
  assert.equal(record.resumeFromJobId, 'upload-earlier');
  assert.deepEqual(record.sources, base.sources);
  assert.equal(record.prefix, base.prefix);
  assert.equal(record.filterMode, 'media-docs');
  assert.equal(record.folderUploadMode, 'contents');
  assert.equal(record.publicRead, false);
  assert.equal(record.checksumMode, 'size');
  assert.deepEqual(record.profile, profile);
  assert.equal(record.transferState.percent, 40);
  assert.equal(jobRecordCanResume(record), true);
});

test('only interrupted dry-run records can resume through another pre-check', () => {
  const interrupted = buildJobRecord({
    jobId: 'dry-run-interrupted',
    status: 'dry-run',
    source: 'C:/exports/precheck.mov',
    prefix: 'sample-event/recordings',
  });
  const completed = buildJobRecord({
    ...interrupted,
    jobId: 'dry-run-complete',
    completedAt: '2026-07-19T10:02:00.000Z',
  });

  assert.equal(jobRecordCanResume(interrupted), true);
  assert.equal(buildResumeQueueSettings(interrupted).resumeFromJobId, 'dry-run-interrupted');
  assert.equal(jobRecordCanResume(completed), false);
  assert.throws(() => buildResumeQueueSettings(completed), /Only failed|resumed/i);
});
