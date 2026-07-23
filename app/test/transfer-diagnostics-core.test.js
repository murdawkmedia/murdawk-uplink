const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildTransferDiagnostics,
  formatBytesPerSecond,
  parseSpeedToBytesPerSecond,
  summarizeDiagnosticsForDisplay,
} = require('../src/transfer-diagnostics-core');

test('parses rclone speed units into bytes per second', () => {
  assert.equal(parseSpeedToBytesPerSecond('5.463 MiB/s'), 5728371);
  assert.equal(parseSpeedToBytesPerSecond('20 MB/s'), 20000000);
  assert.equal(parseSpeedToBytesPerSecond('632.346 KiB/s'), 647522);
  assert.equal(parseSpeedToBytesPerSecond(''), 0);
  assert.equal(formatBytesPerSecond(5728371), '5.5 MiB/s');
});

test('builds bounded rolling throughput diagnostics without secret fields', () => {
  const previous = {
    samples: Array.from({ length: 12 }, (_value, index) => ({
      at: `2026-06-01T12:00:${String(index).padStart(2, '0')}.000Z`,
      bytesPerSecond: (index + 1) * 1024,
    })),
  };
  const diagnostics = buildTransferDiagnostics({
    previous,
    status: 'running',
    transfer: {
      isRunning: true,
      activeJobId: 'upload-123',
      pid: 4242,
      mode: 'upload',
      currentFile: 'clip.mov',
      lastOutputAt: '2026-06-01T12:01:00.000Z',
      lastProgressAt: '2026-06-01T12:01:00.000Z',
      speed: '20 MB/s',
      notifications: {
        webhook: 'https://example.test/hook?secret=NOPE',
      },
    },
    profile: {
      remote: 'media',
      bucket: 'media',
      endpointHost: 'media.nyc3.digitaloceanspaces.com',
      transfers: 4,
      chunkSize: '64M',
      uploadConcurrency: 4,
      secretAccessKey: 'DO_NOT_STORE',
    },
    now: Date.parse('2026-06-01T12:01:05.000Z'),
  });

  assert.equal(diagnostics.state, 'healthy');
  assert.equal(diagnostics.currentFile, 'clip.mov');
  assert.equal(diagnostics.speed.currentBytesPerSecond, 20000000);
  assert.equal(diagnostics.speed.peakBytesPerSecond, 20000000);
  assert.equal(diagnostics.samples.length, 12);
  assert.equal(diagnostics.samples.at(-1).bytesPerSecond, 20000000);
  assert.deepEqual(diagnostics.tuning, {
    transfers: 4,
    chunkSize: '64M',
    uploadConcurrency: 4,
  });
  assert.doesNotMatch(JSON.stringify(diagnostics), /secret|webhook|access/i);
});

test('classifies quiet slow stalled terminal states and safe next actions', () => {
  const now = Date.parse('2026-06-01T12:10:00.000Z');
  const quiet = buildTransferDiagnostics({
    status: 'running',
    transfer: {
      isRunning: true,
      pid: 4242,
      lastOutputAt: '2026-06-01T12:08:30.000Z',
      lastProgressAt: '2026-06-01T12:08:30.000Z',
    },
    now,
  });
  assert.equal(quiet.state, 'quiet');
  assert.match(quiet.safeAction, /Keep uploading/);

  const slow = buildTransferDiagnostics({
    status: 'running',
    transfer: {
      isRunning: true,
      pid: 4242,
      lastOutputAt: '2026-06-01T12:09:55.000Z',
      lastProgressAt: '2026-06-01T12:09:55.000Z',
      speed: '5 MiB/s',
    },
    now,
  });
  assert.equal(slow.state, 'slow');
  assert.match(slow.recommendation, /future fast preset/);

  const stalled = buildTransferDiagnostics({
    status: 'running',
    transfer: {
      isRunning: true,
      pid: 4242,
      lastOutputAt: '2026-06-01T12:03:00.000Z',
      lastProgressAt: '2026-06-01T12:03:00.000Z',
    },
    now,
  });
  assert.equal(stalled.state, 'stalled');
  assert.match(stalled.safeAction, /Check activity/);

  assert.equal(buildTransferDiagnostics({ status: 'complete', now }).state, 'complete');
  assert.equal(buildTransferDiagnostics({ status: 'failed', now }).state, 'failed');
  assert.equal(buildTransferDiagnostics({ status: 'cancelled', now }).state, 'cancelled');
});

test('summarizes diagnostics for renderer display', () => {
  const summary = summarizeDiagnosticsForDisplay({
    state: 'slow',
    isRunning: true,
    pid: 4242,
    currentFile: 'clip.mov',
    lastOutputAgeSeconds: 5,
    lastProgressAgeSeconds: 5,
    speed: {
      current: '5.0 MiB/s',
      rollingAverage: '5.0 MiB/s',
      peak: '12.0 MiB/s',
    },
    tuning: {
      transfers: 4,
      chunkSize: '64M',
      uploadConcurrency: 4,
    },
    safeAction: 'Keep uploading; verification is still the source of truth.',
    recommendation: 'Observed speed is low for a sustained period.',
  });

  assert.equal(summary.label, 'Uploading slowly');
  assert.equal(summary.className, 'slow');
  assert.match(summary.detail, /clip\.mov/);
  assert.match(summary.metrics, /avg 5\.0 MiB\/s/);
  assert.match(summary.tuning, /transfers 4/);
});
