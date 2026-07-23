const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  buildDefaultEventManifest,
  buildMissingQueuePlan,
} = require('../src/cli-core');
const {
  buildCanonicalRecordingFolders,
  normalizeEventManifest,
} = require('../src/event-manifest-core');
const {
  buildLocalEventRecord,
  inferEventDestination,
} = require('../src/event-mapping-core');
const { isPlaceholderRecord, reconcileEventRecords } = require('../src/event-reconcile-core');
const {
  buildLocalEventManifestRecords,
  buildLocalEventManifestRecordsAsync,
  inspectUploadSourcesForCredentialLikePaths,
  listEventRemoteRecords,
  normalizeEventScanMaxFiles,
} = require('../src/event-workspace-runtime');

test('default event manifest is fictional and public safe', () => {
  const manifest = normalizeEventManifest({});

  assert.equal(manifest.client, 'Example Organization');
  assert.equal(manifest.eventName, 'sample-event');
  assert.equal(manifest.eventPrefix, 'sample-event');
  assert.equal(manifest.remote, 'media');
  assert.equal(manifest.bucket, 'media-archive');
  assert.equal(manifest.recordingsPrefix, 'sample-event/recordings');
  assert.deepEqual(manifest.stages, ['Main', 'Talk', 'Workshop']);
  assert.deepEqual(manifest.days, ['Day 1', 'Day 2', 'Day 3']);
  assert.equal(manifest.uploadDefaults.chunkSize, '64M');
  assert.equal(manifest.endpointHost, 'media-archive.nyc3.digitaloceanspaces.com');
  assert.throws(
    () => normalizeEventManifest({ accessKeyId: 'do-not-store' }),
    /secret-shaped/,
  );
});

test('retains the non-secret Event Workspace endpoint used for remote reconcile', () => {
  const manifest = normalizeEventManifest({
    remote: 'event-remote',
    bucket: 'event-bucket',
    endpointHost: 'objects.example.test',
  });

  assert.deepEqual(
    { remote: manifest.remote, bucket: manifest.bucket, endpointHost: manifest.endpointHost },
    { remote: 'event-remote', bucket: 'event-bucket', endpointHost: 'objects.example.test' },
  );
});

test('uses the frozen manifest profile for Event Workspace remote reconcile', async () => {
  let captured = null;
  const manifest = normalizeEventManifest({
    remote: 'event-remote',
    bucket: 'event-bucket',
    endpointHost: 'objects.example.test',
  });

  await listEventRemoteRecords({
    manifest,
    listRemoteFolder(prefix, profile) {
      captured = { prefix, profile };
      return Promise.resolve({ entries: [] });
    },
  });

  assert.equal(captured.prefix, manifest.recordingsPrefix);
  assert.deepEqual(captured.profile, {
    remote: 'event-remote',
    bucket: 'event-bucket',
    endpointHost: 'objects.example.test',
  });
});

test('builds canonical recordings folders under the event recordings prefix', () => {
  const folders = buildCanonicalRecordingFolders({
    eventName: 'second-event',
    eventPrefix: 'second-event',
    recordingsPrefix: 'second-event/recordings',
  });

  assert.equal(folders.includes('second-event/recordings/assets/Main'), true);
  assert.equal(folders.includes('second-event/recordings/raw/Main/Day 1/Cameras'), true);
  assert.equal(folders.includes('second-event/recordings/raw/Workshop/Day 3/Mix'), true);
  assert.equal(folders.includes('second-event/recordings/edits/Talk'), true);
  assert.equal(folders.every((folder) => folder.startsWith('second-event/recordings/')), true);
});

test('maps Second Event-style local paths to approved recordings destinations', () => {
  const manifest = normalizeEventManifest({
    eventName: 'second-event',
    eventPrefix: 'second-event',
    recordingsPrefix: 'second-event/recordings',
  });

  assert.equal(
    inferEventDestination({
      manifest,
      relativePath: 'assets/talk-slides/main-stage/day-1/title-card.png',
    }).destinationPath,
    'second-event/recordings/assets/Main/talk-slides/day-1/title-card.png',
  );
  assert.equal(
    inferEventDestination({
      manifest,
      relativePath: 'ISO-RAW-MIX/SECOND-EVENT-main-DAY1 - 00000.mp4',
    }).destinationPath,
    'second-event/recordings/raw/Main/Day 1/Mix/SECOND-EVENT-main-DAY1 - 00000.mp4',
  );
  assert.equal(
    inferEventDestination({
      manifest,
      sourceRoot: 'D:/Media/EVENT-MEDIA-SECOND-EVENT-ISOS',
      relativePath: 'DAY 3/MultiCorder1 - CAM 1.mp4',
    }).destinationPath,
    'second-event/recordings/raw/Main/Day 3/Cameras/MultiCorder1 - CAM 1.mp4',
  );
  assert.equal(
    inferEventDestination({
      manifest,
      relativePath: 'LIVE STREAM/Day2-edit.mp4',
    }).destinationPath,
    'second-event/recordings/edits/Main/Day2-edit.mp4',
  );
});

test('keeps generic Canon C100 filenames ambiguous until evidence exists', () => {
  const manifest = normalizeEventManifest({
    eventPrefix: 'second-event',
    recordingsPrefix: 'second-event/recordings',
  });
  const local = buildLocalEventRecord({
    manifest,
    sourceRoot: 'C:/event-media-second-event-c-drive',
    relativePath: 'Canon-c100-RAW/00000.MTS',
    fullPath: 'C:/event-media-second-event-c-drive/Canon-c100-RAW/00000.MTS',
    size: 2046394368,
  });

  assert.equal(local.destinationPath, null);
  assert.match(local.ambiguousReason, /generic filename/);

  const result = reconcileEventRecords({
    localRecords: [local],
    remoteRecords: [{
      path: 'second-event/recordings/raw/Main/Day 1/Canon C100/00000.MTS',
      fileName: '00000.MTS',
      size: 2046394368,
    }],
  });

  assert.equal(result.summary.ambiguousCount, 1);
  assert.equal(result.ambiguous[0].evidence.length, 1);
  assert.equal(result.ambiguous[0].evidence[0].path, 'second-event/recordings/raw/Main/Day 1/Canon C100/00000.MTS');
});

test('reconciles exact matches, missing files, and size mismatches', () => {
  const localRecords = [
    {
      fileName: 'matched.mp4',
      size: 100,
      destinationPath: 'sample-event/recordings/raw/Main/Day 1/Cameras/matched.mp4',
    },
    {
      fileName: 'missing.mp4',
      size: 200,
      destinationPath: 'sample-event/recordings/raw/Main/Day 1/Cameras/missing.mp4',
    },
    {
      fileName: 'changed.mp4',
      size: 300,
      destinationPath: 'sample-event/recordings/raw/Main/Day 1/Cameras/changed.mp4',
    },
  ];
  const remoteRecords = [
    {
      path: 'sample-event/recordings/raw/Main/Day 1/Cameras/matched.mp4',
      fileName: 'matched.mp4',
      size: 100,
    },
    {
      path: 'sample-event/recordings/raw/Main/Day 1/Cameras/changed.mp4',
      fileName: 'changed.mp4',
      size: 301,
    },
  ];

  const result = reconcileEventRecords({ localRecords, remoteRecords });

  assert.equal(result.summary.matchedCount, 1);
  assert.equal(result.summary.missingCount, 1);
  assert.equal(result.summary.missingBytes, 200);
  assert.equal(result.summary.sizeMismatchCount, 1);
});

test('ignores remote .keep placeholders during reconcile', () => {
  assert.equal(isPlaceholderRecord({ Path: 'edits/Main/.keep', Name: '.keep' }), true);

  const result = reconcileEventRecords({
    localRecords: [],
    remoteRecords: [{
      path: 'sample-event/recordings/edits/Main/.keep',
      fileName: '.keep',
      size: 0,
    }],
  });

  assert.equal(result.summary.remoteCount, 0);
});

test('builds guarded queue candidates for missing event workspace records', () => {
  const manifest = buildDefaultEventManifest();
  const reconcile = {
    missing: [
      {
        path: 'C:/event-media-sample-event/LIVE STREAM/Day1-edit.mp4',
        destinationPath: 'sample-event/recordings/edits/Main/Day1-edit.mp4',
        fileName: 'Day1-edit.mp4',
        size: 42,
      },
      {
        path: 'C:/event-media-sample-event/assets/talk-slides/main-stage/day-1/title-card.png',
        destinationPath: 'sample-event/recordings/assets/Main/talk-slides/day-1/title-card.png',
        fileName: 'title-card.png',
        size: 12,
      },
    ],
  };

  const plan = buildMissingQueuePlan({ manifest, reconcile });

  assert.equal(plan.length, 2);
  assert.equal(
    plan.every((candidate) => candidate.destinationPath.startsWith(`${manifest.recordingsPrefix}/`)),
    true,
  );
  assert.deepEqual(plan.map((candidate) => candidate.sourcePath), reconcile.missing.map((item) => item.path));
  assert.throws(
    () => buildMissingQueuePlan({
      manifest,
      reconcile: { missing: [{ destinationPath: 'sample-event/assets/oops.mp4' }] },
    }),
    /outside the recordings prefix/,
  );
});

test('scans local event workspace roots into manifest records without remote access', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'murdawk-event-workspace-'));
  const sourceFile = path.join(tempRoot, 'LIVE STREAM', 'Day1-edit.mp4');
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  fs.writeFileSync(sourceFile, 'sample-media');

  const manifest = buildDefaultEventManifest();
  const records = buildLocalEventManifestRecords({
    manifest,
    localRoots: [tempRoot],
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].sourceRoot, path.resolve(tempRoot));
  assert.equal(records[0].relativePath, 'LIVE STREAM/Day1-edit.mp4');
  assert.equal(records[0].destinationPath, 'sample-event/recordings/edits/Main/Day1-edit.mp4');
  assert.equal(records[0].size, 12);
});

test('skips credential-like local event workspace files before mapping records', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'murdawk-event-workspace-'));
  const safeFile = path.join(tempRoot, 'assets', 'sponsors', 'bitcoin-sponsor.mp4');
  const envFile = path.join(tempRoot, 'assets', '.env');
  const rcloneFile = path.join(tempRoot, 'assets', 'rclone.conf');
  fs.mkdirSync(path.dirname(safeFile), { recursive: true });
  fs.writeFileSync(safeFile, 'safe-media');
  fs.writeFileSync(envFile, 'SECRET_VALUE=do-not-read');
  fs.writeFileSync(rcloneFile, '[media]\nsecret_access_key = do-not-read');

  const result = buildLocalEventManifestRecords({
    manifest: buildDefaultEventManifest(),
    localRoots: [tempRoot],
    includeMeta: true,
  });

  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].fileName, 'bitcoin-sponsor.mp4');
  assert.equal(result.skipped.summary.credentialLikeCount, 2);
  assert.deepEqual(
    result.skipped.credentialLike.map((item) => item.relativePath).sort(),
    ['assets/.env', 'assets/rclone.conf'],
  );
  assert.equal(result.skipped.credentialLike.every((item) => !Object.hasOwn(item, 'contents')), true);
});

test('upload source guard allows normal media without reading file contents', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'murdawk-upload-guard-'));
  const mediaFile = path.join(tempRoot, 'public', 'camera-01.mp4');
  fs.mkdirSync(path.dirname(mediaFile), { recursive: true });
  fs.writeFileSync(mediaFile, 'ordinary-media-placeholder');

  const result = inspectUploadSourcesForCredentialLikePaths([tempRoot]);

  assert.equal(result.ok, true);
  assert.equal(result.blocked.length, 0);
  assert.equal(result.filesScanned, 1);
  assert.equal(Object.hasOwn(result, 'contents'), false);
});

test('upload source guard blocks credential-like files and folders for unrestricted uploads', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'murdawk-upload-guard-'));
  const sensitiveFiles = [
    path.join(tempRoot, '.env.production'),
    path.join(tempRoot, 'config', 'rclone.conf'),
    path.join(tempRoot, 'public-read', 'speaker-secret-token.txt'),
    path.join(tempRoot, 'public-read', 'production-key.txt'),
    path.join(tempRoot, 'keys', 'id_ed25519'),
    path.join(tempRoot, 'keys', 'production.pem'),
  ];
  for (const file of sensitiveFiles) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not-read-by-guard');
  }

  const folderResult = inspectUploadSourcesForCredentialLikePaths([tempRoot]);
  const directResult = inspectUploadSourcesForCredentialLikePaths([sensitiveFiles[0]]);

  assert.equal(folderResult.ok, false);
  assert.equal(folderResult.blocked.length >= sensitiveFiles.length, true);
  assert.equal(directResult.ok, false);
  assert.match(directResult.blocked[0].reason, /credential-like/i);
  assert.equal(folderResult.blocked.every((item) => !Object.hasOwn(item, 'contents')), true);
});

test('upload source guard blocks directly selected files beneath sensitive ancestors', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'murdawk-upload-guard-'));
  const selectedFiles = [
    path.join(tempRoot, 'secrets', 'public-name.mp4'),
    path.join(tempRoot, 'credentials', 'camera.mov'),
    path.join(tempRoot, '.ssh', 'poster.jpg'),
    path.join(tempRoot, 'keys', 'recording.wav'),
    path.join(tempRoot, 'speaker-token-cache', 'slides.pdf'),
  ];
  for (const file of selectedFiles) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not-read-by-guard');
  }

  for (const file of selectedFiles) {
    const result = inspectUploadSourcesForCredentialLikePaths([file]);
    assert.equal(result.ok, false, file);
    assert.equal(result.blocked.some((item) => item.path === path.resolve(file)), true, file);
    assert.equal(result.blocked.every((item) => !Object.hasOwn(item, 'contents')), true);
  }
});

test('upload source guard allows a directly selected file in a normal media tree', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'murdawk-upload-guard-'));
  const mediaFile = path.join(tempRoot, 'event-recordings', 'day-1', 'cameras', 'camera-a.mov');
  fs.mkdirSync(path.dirname(mediaFile), { recursive: true });
  fs.writeFileSync(mediaFile, 'ordinary-media-placeholder');

  const result = inspectUploadSourcesForCredentialLikePaths([mediaFile]);

  assert.equal(result.ok, true);
  assert.equal(result.blocked.length, 0);
  assert.equal(result.filesScanned, 1);
});

test('async local event workspace scan applies limits and reports warnings', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'murdawk-event-workspace-'));
  fs.mkdirSync(path.join(tempRoot, 'LIVE STREAM'), { recursive: true });
  fs.writeFileSync(path.join(tempRoot, 'LIVE STREAM', 'Day1-edit.mp4'), 'one');
  fs.writeFileSync(path.join(tempRoot, 'LIVE STREAM', 'Day2-edit.mp4'), 'two');

  const result = await buildLocalEventManifestRecordsAsync({
    manifest: buildDefaultEventManifest(),
    localRoots: [tempRoot],
    maxFiles: 1,
  });

  assert.equal(result.records.length, 1);
  assert.equal(result.scan.warnings.length, 1);
  assert.match(result.scan.warnings[0].message, /scan limit/i);
});

test('normalizes Event Workspace scan caps to a finite bounded positive integer', () => {
  assert.equal(normalizeEventScanMaxFiles('abc'), 200000);
  assert.equal(normalizeEventScanMaxFiles(Number.NaN), 200000);
  assert.equal(normalizeEventScanMaxFiles(Infinity), 200000);
  assert.equal(normalizeEventScanMaxFiles(0), 200000);
  assert.equal(normalizeEventScanMaxFiles(-12), 200000);
  assert.equal(normalizeEventScanMaxFiles(999999999), 200000);
  assert.equal(normalizeEventScanMaxFiles(42.9), 42);
});

test('blocks credential-like missing records from Event Workspace queue candidates', () => {
  const manifest = buildDefaultEventManifest();
  const plan = buildMissingQueuePlan({
    manifest,
    reconcile: {
      missing: [
        {
          path: 'C:/event/assets/.env',
          destinationPath: 'sample-event/recordings/assets/Main/misc/.env',
          fileName: '.env',
          size: 99,
        },
        {
          path: 'C:/event/assets/rclone.conf',
          destinationPath: 'sample-event/recordings/assets/Main/misc/rclone.conf',
          fileName: 'rclone.conf',
          size: 88,
        },
        {
          path: 'C:/event/assets/sponsors/bitcoin-sponsor.mp4',
          destinationPath: 'sample-event/recordings/assets/Main/15_sec_sponsor/bitcoin-sponsor.mp4',
          fileName: 'bitcoin-sponsor.mp4',
          size: 77,
        },
      ],
    },
  });

  assert.deepEqual(plan.map((candidate) => candidate.fileName), ['bitcoin-sponsor.mp4']);
});
