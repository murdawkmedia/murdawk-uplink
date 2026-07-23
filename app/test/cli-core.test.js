const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildHelp,
  buildDefaultEventManifest,
  buildMissingQueuePlan,
  buildStatusSummary,
  formatEventReconcileReport,
  formatExplorerTable,
  formatInventoryReport,
  formatUrls,
  findMatchingStatusRecord,
  normalizeEventCliOptions,
  normalizeUploadOptions,
  parseCliArgs,
  statusDiagnosticsFromRecord,
  summarizeProfile,
} = require('../src/cli-core');

test('parses safe CLI commands and repeated source flags', () => {
  const parsed = parseCliArgs([
    'upload',
    '--source',
    'C:\\video one.mp4',
    '--source',
    'C:\\video two.mp4',
    '--prefix',
    'archive-event/recordings/day3',
    '--include',
    '*.mp4',
    '--json',
    '--private',
    '--remote',
    'frog-space',
    '--bucket',
    'frog-bucket',
    '--endpoint',
    'sfo3.digitaloceanspaces.com',
  ]);

  assert.deepEqual(parsed, {
    command: 'upload',
    options: {
      sources: ['C:\\video one.mp4', 'C:\\video two.mp4'],
      prefix: 'archive-event/recordings/day3',
      include: '*.mp4',
      filterMode: 'custom',
      publicRead: false,
      folderUploadMode: 'package',
      json: true,
      checksum: 'sha256',
      profile: {
        remote: 'frog-space',
        bucket: 'frog-bucket',
        endpointHost: 'sfo3.digitaloceanspaces.com',
      },
      job: '',
      notifications: {
        webhook: '',
        ntfy: '',
        notifyOn: 'success',
      },
    },
    positionals: [],
  });
});

test('rejects destructive or unknown CLI commands', () => {
  assert.throws(() => parseCliArgs(['delete', 'archive-event/recordings/day1']), /Unsupported command/);
  assert.throws(() => parseCliArgs(['upload', '--secret-access-key', 'nope']), /Unknown option/);
});

test('parses event manifest reconcile and queue-missing commands', () => {
  const manifest = parseCliArgs(['event', 'manifest', '--output', 'event.json']);
  assert.equal(manifest.options.event.preset, 'sample-event');
  assert.match(buildHelp(), /event manifest \[--output <path>\]/);
  assert.doesNotMatch(buildHelp(), /client-event|second-event/i);

  const reconcile = parseCliArgs([
    'event',
    'reconcile',
    '--manifest',
    'sample-event.json',
    '--local-root',
    'C:\\event-media-sample-event-c-drive',
    '--local-root',
    'D:\\EVENT-MEDIA-SAMPLE-EVENT-ISOS',
    '--output',
    'runs\\sample-event',
    '--json',
  ]);

  assert.equal(reconcile.command, 'event');
  assert.deepEqual(normalizeEventCliOptions(reconcile.options), {
    action: 'reconcile',
    manifestPath: 'sample-event.json',
    outputPath: 'runs\\sample-event',
    outputDirectory: 'runs\\sample-event',
    reconcilePath: '',
    preset: 'sample-event',
    localRoots: ['C:\\event-media-sample-event-c-drive', 'D:\\EVENT-MEDIA-SAMPLE-EVENT-ISOS'],
    dryRun: false,
    json: true,
  });

  const queue = parseCliArgs([
    'event',
    'queue-missing',
    '--manifest',
    'sample-event.json',
    '--reconcile',
    'runs\\sample-event\\reconcile.json',
    '--dry-run',
  ]);

  assert.equal(normalizeEventCliOptions(queue.options).action, 'queue-missing');
  assert.equal(normalizeEventCliOptions(queue.options).dryRun, true);
});

test('normalizes upload options without adding secret-shaped fields', () => {
  const options = normalizeUploadOptions({
    sources: ['C:\\Austria Mix\\day-1'],
    prefix: '\\archive-event\\recordings\\day1\\',
    include: '*.mp4',
    publicRead: true,
    secret_access_key: 'DO_NOT_STORE',
  });

  assert.deepEqual(options, {
    sources: ['C:\\Austria Mix\\day-1'],
    prefix: 'archive-event/recordings/day1',
    include: '*.mp4',
    filterMode: 'custom',
    publicRead: true,
    folderUploadMode: 'package',
    profile: {
      remote: 'media',
      bucket: 'media',
      endpointHost: 'media.nyc3.digitaloceanspaces.com',
    },
  });
  assert.equal(Object.hasOwn(options, 'secret_access_key'), false);
});

test('formats agent-friendly list output and public URLs', () => {
  const table = formatExplorerTable([
    { isDir: true, displaySize: '-', modified: '', name: 'day1' },
    { isDir: false, displaySize: '19.1 GB', modified: '2026-05-30T12:00:00Z', name: 'clip.mp4' },
  ]);

  assert.match(table, /DIR/);
  assert.match(table, /FILE/);
  assert.match(table, /clip\.mp4/);
  assert.deepEqual(formatUrls({
    prefix: 'archive-event/recordings/day1',
    names: ['clip 01.mp4'],
  }), ['https://media.nyc3.digitaloceanspaces.com/archive-event/recordings/day1/clip%2001.mp4']);
  assert.deepEqual(formatUrls({
    prefix: 'archive',
    names: ['frog.mov'],
    profile: {
      remote: 'frog-space',
      bucket: 'frog-bucket',
      endpointHost: 'sfo3.digitaloceanspaces.com',
    },
  }), ['https://sfo3.digitaloceanspaces.com/archive/frog.mov']);
});

test('formats inventory reports with file locations sizes and URLs', () => {
  const report = formatInventoryReport({
    prefix: 'archive-event/recordings/day1',
    entries: [
      { isDir: true, path: 'archive-event/recordings/day1/subdir', displaySize: '-', publicUrl: '' },
      {
        isDir: false,
        path: 'archive-event/recordings/day1/clip 01.mp4',
        displaySize: '19.1 GB',
        publicUrl: 'https://media.nyc3.digitaloceanspaces.com/archive-event/recordings/day1/clip%2001.mp4',
      },
    ],
  });

  assert.match(report, /Remote folder: archive-event\/recordings\/day1/);
  assert.match(report, /\| File location \| Size \| Public URL \|/);
  assert.match(report, /clip 01\.mp4/);
  assert.match(report, /19\.1 GB/);
  assert.match(report, /https:\/\/media\.nyc3/);
  assert.doesNotMatch(report, /subdir.*https/);
});

test('help and profile summary expose no credentials', () => {
  const help = buildHelp();
  const profile = summarizeProfile();

  assert.match(help, /does not read or print keys/);
  assert.match(help, /event reconcile/);
  assert.equal(Object.hasOwn(profile, 'secret_access_key'), false);
  assert.equal(Object.hasOwn(profile, 'access_key_id'), false);
});

test('builds default event manifest and guarded missing-file queue plans', () => {
  const manifest = buildDefaultEventManifest('sample-event');
  const reconcile = {
    missing: [{
      path: 'C:\\event-media-sample-event-c-drive\\LIVE STREAM\\Day1-edit.mp4',
      destinationPath: 'sample-event/recordings/edits/Main/Day1-edit.mp4',
      fileName: 'Day1-edit.mp4',
      size: 42,
    }],
  };

  assert.equal(manifest.eventPrefix, 'sample-event');
  assert.deepEqual(buildMissingQueuePlan({ manifest, reconcile }), [{
    sourcePath: 'C:\\event-media-sample-event-c-drive\\LIVE STREAM\\Day1-edit.mp4',
    destinationPath: 'sample-event/recordings/edits/Main/Day1-edit.mp4',
    fileName: 'Day1-edit.mp4',
    size: 42,
    remote: 'media',
    bucket: 'media-archive',
    rcloneDestination: 'media:media-archive/sample-event/recordings/edits/Main/Day1-edit.mp4',
  }]);
  assert.equal(buildMissingQueuePlan({
    manifest: { ...manifest, remote: 'Archive+Media@Sample Event' },
    reconcile,
  })[0].rcloneDestination, 'Archive+Media@Sample Event:media-archive/sample-event/recordings/edits/Main/Day1-edit.mp4');
  assert.throws(
    () => buildMissingQueuePlan({ manifest: { ...manifest, remote: 'archive:other' }, reconcile }),
    /remote.*invalid/i,
  );
  assert.throws(
    () => buildMissingQueuePlan({
      manifest,
      reconcile: { missing: [{ destinationPath: 'sample-event/assets/oops.mp4' }] },
    }),
    /outside the recordings prefix/,
  );
});

test('formats event reconcile reports for humans', () => {
  const text = formatEventReconcileReport({
    summary: {
      localCount: 10,
      remoteCount: 12,
      matchedCount: 8,
      missingCount: 1,
      sizeMismatchCount: 1,
      ambiguousCount: 2,
      missingBytes: 2048,
    },
  });

  assert.match(text, /Local files: 10/);
  assert.match(text, /Missing: 1/);
  assert.match(text, /Needs decision: 2/);
  assert.match(text, /Missing bytes: 2.0 KB/);
});

test('parses notification and checksum CLI options safely', () => {
  const parsed = parseCliArgs([
    'upload',
    '--source',
    'C:\\video.mp4',
    '--checksum',
    'sha256',
    '--notify-webhook',
    'https://example.test/hook?token=secret',
    '--notify-ntfy',
    'murdawk-uplink-test',
    '--notify-on',
    'always',
  ]);

  assert.equal(parsed.options.checksum, 'sha256');
  assert.deepEqual(parsed.options.notifications, {
    webhook: 'https://example.test/hook?token=secret',
    ntfy: 'murdawk-uplink-test',
    notifyOn: 'always',
  });
});

test('parses alternate non-secret profile flags for agent workflows', () => {
  const parsed = parseCliArgs([
    'inventory',
    'archive/raw',
    '--remote',
    'frog-space',
    '--bucket',
    'frog-bucket',
    '--endpoint',
    'sfo3.digitaloceanspaces.com',
    '--json',
  ]);

  assert.deepEqual(parsed.options.profile, {
    remote: 'frog-space',
    bucket: 'frog-bucket',
    endpointHost: 'sfo3.digitaloceanspaces.com',
  });
  assert.equal(parsed.options.prefix, 'archive/raw');
  assert.equal(parsed.options.json, true);
});

test('parses broad filter modes for non-mp4 archive uploads', () => {
  const parsed = parseCliArgs([
    'upload',
    '--source',
    'C:\\stage two',
    '--filter',
    'videos-images',
  ]);

  assert.equal(parsed.options.filterMode, 'videos-images');
  assert.equal(parsed.options.include, '');

  const normalized = normalizeUploadOptions(parsed.options);
  assert.equal(normalized.filterMode, 'videos-images');
  assert.equal(normalized.include, '');
});

test('rejects unsupported checksum and notification modes', () => {
  assert.throws(() => parseCliArgs(['upload', '--checksum', 'md5']), /Unsupported checksum/);
  assert.throws(() => parseCliArgs(['upload', '--notify-on', 'sometimes']), /Unsupported notify-on/);
});

test('builds a human status summary from verification and URLs', () => {
  const summary = buildStatusSummary({
    prefix: 'archive-event/recordings/day2',
    entries: [{ isDir: false }, { isDir: true }],
    verification: {
      ok: true,
      verified: [{ name: 'clip.mp4', size: 7 }],
      missing: [],
      sizeMismatch: [],
    },
    urls: ['https://media.nyc3.digitaloceanspaces.com/archive-event/recordings/day2/clip.mp4'],
  });

  assert.match(summary, /Remote files: 1/);
  assert.match(summary, /Verification OK/);
  assert.match(summary, /https:\/\/media/);
});

test('builds status diagnostics from modern and old job records', () => {
  const modern = statusDiagnosticsFromRecord({
    jobId: 'upload-123',
    status: 'running',
    diagnostics: {
      state: 'slow',
      currentFile: 'clip.mov',
      speed: {
        current: '5.0 MiB/s',
        currentBytesPerSecond: 5242880,
        rollingAverage: '5.0 MiB/s',
        rollingAverageBytesPerSecond: 5242880,
        peak: '5.0 MiB/s',
        peakBytesPerSecond: 5242880,
      },
      tuning: {
        transfers: 4,
        chunkSize: '64M',
        uploadConcurrency: 4,
      },
      samples: [{ at: '2026-06-01T12:00:00.000Z', bytesPerSecond: 5242880 }],
      webhook: 'https://example.test/hook?token=secret',
    },
  }, Date.parse('2026-06-01T12:01:00.000Z'));

  assert.equal(modern.state, 'slow');
  assert.equal(modern.speed.current, '5.0 MiB/s');
  assert.doesNotMatch(JSON.stringify(modern), /webhook|secret|token/i);

  const legacy = statusDiagnosticsFromRecord({
    jobId: 'upload-old',
    status: 'running',
    transferState: {
      activeJobId: 'upload-old',
      isRunning: false,
      currentFile: 'legacy.mov',
      lastOutputAt: '2026-06-01T12:00:00.000Z',
      speed: '2 MiB/s',
    },
  }, Date.parse('2026-06-01T12:10:00.000Z'));

  assert.equal(legacy.state, 'stalled');
  assert.equal(legacy.currentFile, 'legacy.mov');
});

test('finds matching status records by source and prefix without requiring GUI state', () => {
  const match = findMatchingStatusRecord([
    {
      jobId: 'upload-newest',
      startedAt: '2026-06-01T12:00:00.000Z',
      sources: ['C:/exports/day2'],
      prefix: 'archive-event/recordings/raw/stage1/day2',
    },
    {
      jobId: 'upload-other',
      startedAt: '2026-06-01T13:00:00.000Z',
      sources: ['C:/exports/day1'],
      prefix: 'archive-event/recordings/raw/stage1/day1',
    },
  ], {
    sources: ['C:/exports/day2'],
    prefix: 'archive-event/recordings/raw/stage1/day2',
  });

  assert.equal(match.jobId, 'upload-newest');
  assert.equal(findMatchingStatusRecord([], { sources: ['C:/none'], prefix: 'missing' }), null);
});
