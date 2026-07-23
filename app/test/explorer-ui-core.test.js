const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildRemoteMovePlan,
  buildFolderPlaceholderPath,
  buildNewFolderPlaceholderPath,
  createHistoryResumeQueueJob,
  createQueueJob,
  buildArchiveDestination,
  buildArchivePackageTarget,
  classifyRemotePath,
  dragHasLocalFiles,
  dragHasRemoteItems,
  formatInventoryReport,
  mergeRecentPrefixes,
  normalizeNewFolderName,
  normalizeRemotePrefix,
  queueCanUploadAll,
  appendUniqueQueueJobs,
  queueJobCountDetail,
  queueJobDestinationLabel,
  queueJobPlacementPreview,
  queueJobRequest,
  queueLifecycleGate,
  queueJobStatusHint,
  queueNextAutomaticAction,
  queueNextPrecheckJob,
  queueNextUploadJob,
  queueUploadRequests,
  reconcileQueueJobsWithRecords,
  queueWithJobStatus,
  resolveSelectionIndexes,
  resolveMoveTargets,
  appendBoundedLogText,
  summarizeActiveTransfer,
} = require('../src/renderer/explorer-ui-core');
const { INTERRUPTED_JOB_ERROR, resumeCandidate } = require('../src/queue-recovery-core');

test('normalizes remote prefixes for Explorer interactions', () => {
  assert.equal(normalizeRemotePrefix('/archive-event//recordings\\day1/'), 'archive-event/recordings/day1');
  assert.equal(normalizeRemotePrefix(''), '');
});

test('creates a direction-aware download queue job', () => {
  const job = createQueueJob({
    sources: ['sample-event/card.png', 'sample-event/assets'],
    settings: {
      direction: 'download',
      localDestination: 'C:\\Downloads\\Event',
      remoteItems: [
        { name: 'card.png', path: 'sample-event/card.png', isDir: false, size: 10, modified: '' },
        { name: 'assets', path: 'sample-event/assets', isDir: true, size: 0, modified: '' },
      ],
      prefix: 'sample-event',
    },
  });
  assert.equal(job.direction, 'download');
  assert.equal(job.localDestination, 'C:\\Downloads\\Event');
  assert.equal(queueJobRequest(job).direction, 'download');
  assert.equal(queueJobDestinationLabel(job), 'C:\\Downloads\\Event');
  assert.match(queueJobPlacementPreview(job).examples[0], /sample-event\/card\.png -> C:\\Downloads\\Event\\card\.png/);
});

test('queue identity keeps upload and download intents separate', () => {
  const upload = createQueueJob({ sources: ['sample-event/card.png'], settings: { prefix: 'sample-event' } });
  const download = createQueueJob({
    sources: ['sample-event/card.png'],
    settings: {
      direction: 'download',
      prefix: 'sample-event',
      localDestination: 'C:\\Downloads',
      remoteItems: [{ name: 'card.png', path: 'sample-event/card.png', isDir: false, size: 10, modified: '' }],
    },
  });
  const merged = appendUniqueQueueJobs([upload], [download]);
  assert.equal(merged.added.length, 1);
});

test('builds move targets when files are dropped onto a folder', () => {
  const plan = buildRemoteMovePlan({
    items: [
      {
        name: 'clip.mov',
        path: 'archive-event/recordings/raw/inbox/clip.mov',
        isDir: false,
      },
    ],
    targetFolderPath: 'archive-event/recordings/edits/livestream/main-stage/day1',
  });

  assert.deepEqual(plan.operations, [
    {
      action: 'move',
      item: {
        name: 'clip.mov',
        path: 'archive-event/recordings/raw/inbox/clip.mov',
        isDir: false,
      },
      targetPrefix: 'archive-event/recordings/edits/livestream/main-stage/day1/clip.mov',
    },
  ]);
  assert.deepEqual(plan.skipped, []);
});

test('builds move targets when folders are dropped onto another folder', () => {
  const plan = buildRemoteMovePlan({
    items: [
      {
        name: 'day1',
        path: 'archive-event/recordings/raw/main-stage/day1',
        isDir: true,
      },
    ],
    targetFolderPath: 'archive-event/recordings/raw/archive',
  });

  assert.equal(
    plan.operations[0].targetPrefix,
    'archive-event/recordings/raw/archive/day1',
  );
});

test('blocks moving folders into themselves or descendants', () => {
  const plan = buildRemoteMovePlan({
    items: [
      {
        name: 'raw',
        path: 'archive-event/recordings/raw',
        isDir: true,
      },
    ],
    targetFolderPath: 'archive-event/recordings/raw/main-stage',
  });

  assert.equal(plan.operations.length, 0);
  assert.equal(plan.skipped[0].reason, 'Cannot move a folder into itself.');
});

test('classifies archive folders for visible safety badges', () => {
  assert.equal(classifyRemotePath('archive-event/recordings/raw/main-stage/day1').label, 'Archive / Raw');
  assert.equal(classifyRemotePath('archive-event/recordings/edits/livestream/main-stage/day1').label, 'Livestream-ready');
  assert.equal(classifyRemotePath('archive-event/recordings/edits/youtube/main-stage/day1').label, 'YouTube-ready');
  assert.equal(classifyRemotePath('archive-event/recordings/stage-2').label, 'Stage 2');
  assert.equal(classifyRemotePath('archive-event/recordings/other').label, 'Unclassified');
});

test('resolves move into folder targets while preserving names', () => {
  const targets = resolveMoveTargets({
    items: [{ name: 'clip.mov', path: 'old/clip.mov', isDir: false }],
    target: 'archive-event/recordings/raw',
    mode: 'folder',
  });

  assert.equal(targets.operations[0].targetPrefix, 'archive-event/recordings/raw/clip.mov');
});

test('resolves exact single-item rename targets', () => {
  const targets = resolveMoveTargets({
    items: [{ name: 'clip.mov', path: 'old/clip.mov', isDir: false }],
    target: 'archive-event/recordings/raw/clip-renamed.mov',
    mode: 'exact',
  });

  assert.equal(targets.operations[0].targetPrefix, 'archive-event/recordings/raw/clip-renamed.mov');
});

test('keeps recent prefixes normalized, unique, and capped', () => {
  assert.deepEqual(
    mergeRecentPrefixes(['a/b', 'c/d', 'a/b'], 'x//y\\z', 3),
    ['x/y/z', 'a/b', 'c/d'],
  );
});

test('resolves explorer selection with shift ranges and ctrl toggles', () => {
  assert.deepEqual(
    resolveSelectionIndexes({
      currentIndexes: [],
      clickedIndex: 2,
      anchorIndex: -1,
      total: 8,
    }),
    { selectedIndexes: [2], selectedIndex: 2, anchorIndex: 2 },
  );

  assert.deepEqual(
    resolveSelectionIndexes({
      currentIndexes: [2],
      clickedIndex: 5,
      anchorIndex: 2,
      total: 8,
      range: true,
    }),
    { selectedIndexes: [2, 3, 4, 5], selectedIndex: 5, anchorIndex: 2 },
  );

  assert.deepEqual(
    resolveSelectionIndexes({
      currentIndexes: [2, 3, 4, 5],
      clickedIndex: 7,
      anchorIndex: 2,
      total: 8,
      additive: true,
    }),
    { selectedIndexes: [2, 3, 4, 5, 7], selectedIndex: 7, anchorIndex: 7 },
  );
});

test('recognizes Windows file drags before file paths are readable', () => {
  assert.equal(dragHasLocalFiles({ types: ['Files'], files: [] }), true);
  assert.equal(dragHasLocalFiles({ types: [], files: [{ name: 'clip.mov' }] }), true);
  assert.equal(dragHasLocalFiles({ types: ['text/plain'], files: [] }), false);
  assert.equal(dragHasRemoteItems({ types: ['application/x-murdawk-remote'] }), true);
});

test('normalizes new server folder names before creating .keep placeholders', () => {
  assert.equal(normalizeNewFolderName('test'), 'test');
  assert.equal(normalizeNewFolderName('/test-folder/'), 'test-folder');
  assert.equal(normalizeNewFolderName('nested\\folder'), 'nested/folder');
  assert.equal(normalizeNewFolderName('  '), '');
  assert.equal(normalizeNewFolderName('../escape'), 'escape');
});

test('builds the placeholder path for creating visible server folders', () => {
  assert.equal(
    buildNewFolderPlaceholderPath({
      currentPrefix: 'archive-event/recordings/raw/stage1',
      folderName: '/test-folder/',
    }),
    'archive-event/recordings/raw/stage1/test-folder/.keep',
  );
  assert.equal(
    buildFolderPlaceholderPath('archive-event/recordings/raw/stage1/day1'),
    'archive-event/recordings/raw/stage1/day1/.keep',
  );
  assert.equal(buildFolderPlaceholderPath('/'), '');
});

test('formats explorer inventory reports for copying handoff links', () => {
  const report = formatInventoryReport({
    prefix: 'archive-event/recordings/stage-2',
    entries: [
      {
        isDir: false,
        path: 'archive-event/recordings/stage-2/Y26E3R2D1S01-Michael.mov',
        displaySize: '1.8 GB',
        publicUrl: 'https://media.nyc3.digitaloceanspaces.com/archive-event/recordings/stage-2/Y26E3R2D1S01-Michael.mov',
      },
    ],
  });

  assert.match(report, /File location/);
  assert.match(report, /Y26E3R2D1S01-Michael\.mov/);
  assert.match(report, /1\.8 GB/);
  assert.match(report, /https:\/\/media\.nyc3/);
});

test('summarizes active rclone transfer state for close-or-wait decisions', () => {
  const now = Date.parse('2026-06-01T12:05:00.000Z');
  const running = summarizeActiveTransfer({
    isRunning: true,
    activeJobId: 'upload-123',
    pid: 4242,
    mode: 'upload',
    source: 'C:/Austria Mix/day-2/clip.mp4',
    currentFile: 'clip.mp4',
    startedAt: '2026-06-01T12:00:00.000Z',
    lastOutputAt: '2026-06-01T12:04:45.000Z',
  }, now);

  assert.equal(running.label, 'rclone running (PID 4242)');
  assert.equal(running.detail, 'clip.mp4');
  assert.equal(running.lastOutput, '15s ago');
  assert.equal(running.className, 'running');

  const idle = summarizeActiveTransfer({}, now);
  assert.equal(idle.label, 'No active rclone transfer');
  assert.equal(idle.className, 'idle');
});

test('summarizes quiet and stale active transfer states without implying completion', () => {
  const now = Date.parse('2026-06-01T12:05:00.000Z');
  const quiet = summarizeActiveTransfer({
    isRunning: true,
    activeJobId: 'upload-quiet',
    pid: 4343,
    mode: 'upload',
    source: 'C:/exports/day2',
    startedAt: '2026-06-01T12:00:00.000Z',
    lastOutputAt: '2026-06-01T12:03:30.000Z',
    currentFile: '',
  }, now);

  assert.equal(quiet.label, 'Still uploading (quiet)');
  assert.match(quiet.detail, /No recent output/);
  assert.equal(quiet.lastOutput, '1m 30s ago');
  assert.equal(quiet.className, 'quiet');

  const stale = summarizeActiveTransfer({
    isRunning: false,
    activeJobId: 'upload-stale',
    mode: 'upload',
    source: 'C:/exports/day2',
    startedAt: '2026-06-01T12:00:00.000Z',
    lastOutputAt: '2026-06-01T12:04:00.000Z',
  }, now);

  assert.equal(stale.label, 'Needs resume check');
  assert.match(stale.detail, /No live rclone process/);
  assert.equal(stale.className, 'stale');
});

test('summarizes diagnostic-rich active transfer state for live confidence UI', () => {
  const summary = summarizeActiveTransfer({
    isRunning: true,
    activeJobId: 'upload-slow',
    pid: 4242,
    mode: 'upload',
    diagnostics: {
      state: 'slow',
      isRunning: true,
      pid: 4242,
      mode: 'upload',
      currentFile: 'clip.mov',
      lastOutputAgeSeconds: 5,
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
      safeAction: 'Keep uploading; use this speed evidence to choose future tuning after verification completes.',
      recommendation: 'Observed speed is low for a sustained period.',
    },
  });

  assert.equal(summary.label, 'Uploading slowly');
  assert.equal(summary.className, 'slow');
  assert.match(summary.detail, /clip\.mov/);
  assert.match(summary.metrics, /avg 5\.0 MiB\/s/);
  assert.match(summary.tuning, /transfers 4/);
  assert.match(summary.safeAction, /Keep uploading/);
  assert.match(summary.recommendation, /Observed speed/);
});

test('keeps renderer log text bounded for long rclone progress streams', () => {
  const lines = Array.from({ length: 12 }, (_value, index) => `line ${index + 1}`).join('\n');
  const bounded = appendBoundedLogText('', lines, { maxLines: 5, maxChars: 1000 });

  assert.match(bounded.text, /\[trimmed 7 older log line\(s\)\]/);
  assert.doesNotMatch(bounded.text, /^line 1$/m);
  assert.match(bounded.text, /line 12/);
  assert.equal(bounded.trimmedLines, 7);

  const charBounded = appendBoundedLogText('', 'abcdefghi', { maxLines: 10, maxChars: 6 });
  assert.equal(charBounded.text, '[trimmed older log text]\nefghi\n');
  assert.equal(charBounded.trimmedChars, 4);
});

test('creates destination-specific queue jobs without mutating earlier jobs', () => {
  const first = createQueueJob({
    sources: ['C:/exports/day1.mov'],
    settings: {
      prefix: 'archive-event/recordings/raw/stage1/day1',
      filterMode: 'all',
      include: '',
      folderUploadMode: 'package',
      publicRead: true,
      checksum: 'size',
      notifyWebhook: 'https://secret.example/hook',
      notifyNtfy: 'murdawk-uplink-topic',
      notifyOn: 'success',
    },
  });
  const second = createQueueJob({
    sources: ['C:/exports/day2.mov'],
    settings: {
      prefix: 'archive-event/recordings/raw/stage1/day2',
      filterMode: 'videos-images',
      include: '*.mov',
      folderUploadMode: 'contents',
      publicRead: false,
      checksum: 'sha256',
      notifyOn: 'always',
    },
  });

  assert.equal(first.prefix, 'archive-event/recordings/raw/stage1/day1');
  assert.equal(second.prefix, 'archive-event/recordings/raw/stage1/day2');
  assert.equal(first.filterMode, 'all');
  assert.equal(second.filterMode, 'videos-images');
  assert.equal(first.notifications.webhook, 'https://secret.example/hook');
  assert.equal(first.persistable.notifications.webhook, '');
});

test('queue destination label stays on the frozen destination folder', () => {
  const job = createQueueJob({
    sources: [
      'C:/Austria Mix/day-2/logs',
      'C:/Austria Mix/day-2/austria-main - 28 May 2026 - 00000.mp4',
    ],
    settings: { prefix: 'archive-event/recordings/raw/stage1/day2/mix' },
  });

  assert.equal(
    queueJobDestinationLabel(job),
    'media:media/archive-event/recordings/raw/stage1/day2/mix/',
  );
});

test('queue destination label uses the job-specific server profile', () => {
  const job = createQueueJob({
    sources: ['C:/exports/missing.mov'],
    settings: {
      profile: {
        remote: 'frog-space',
        bucket: 'frog-bucket',
        endpointHost: 'sfo3.digitaloceanspaces.com',
      },
      prefix: 'archive/raw',
    },
  });

  assert.equal(queueJobDestinationLabel(job), 'frog-space:frog-bucket/archive/raw/');
});

test('queue placement preview separates destination from child folder placement', () => {
  const job = createQueueJob({
    sources: [
      'C:/Austria Mix/day-2/logs',
      'C:/Austria Mix/day-2/austria-main - 28 May 2026 - 00000.mp4',
    ],
    settings: { prefix: 'archive-event/recordings/raw/stage1/day2/mix' },
  });

  const preview = queueJobPlacementPreview(job);

  assert.equal(preview.folderCount, 1);
  assert.equal(preview.fileCount, 1);
  assert.deepEqual(preview.examples, [
    'logs -> archive-event/recordings/raw/stage1/day2/mix/logs/...',
    'austria-main - 28 May 2026 - 00000.mp4 -> archive-event/recordings/raw/stage1/day2/mix/austria-main - 28 May 2026 - 00000.mp4',
  ]);
});

test('queue count detail distinguishes selected sources from expanded files', () => {
  const job = createQueueJob({
    sources: [
      'C:/Event/Main/logs',
      ...Array.from({ length: 27 }, (_, index) => `C:/Event/Main/clip-${index + 1}.mp4`),
    ],
    settings: { prefix: 'sample-event/recordings/main/mix/day 1' },
  });

  assert.equal(queueJobCountDetail(job), '28 job sources');

  const verified = queueWithJobStatus([job], job.id, 'complete', {
    verification: {
      ok: false,
      verified: Array.from({ length: 30 }, (_, index) => ({ name: `verified-${index + 1}` })),
      missing: [{ name: 'missing-1' }, { name: 'missing-2' }],
      sizeMismatch: [{ name: 'mismatch-1' }],
    },
  })[0];

  assert.equal(queueJobCountDetail(verified), '28 job sources / 33 actual files');
});

test('queue upload-all requires ready jobs and stops on failed jobs', () => {
  const queued = createQueueJob({
    sources: ['C:/exports/day1.mov'],
    settings: { prefix: 'archive-event/recordings/raw/stage1/day1' },
  });
  const ready = queueWithJobStatus([queued], queued.id, 'ready')[0];
  const failed = queueWithJobStatus([ready], ready.id, 'failed', { error: 'network dropped' })[0];

  assert.equal(queueCanUploadAll([queued]).ok, false);
  assert.equal(queueCanUploadAll([ready]).ok, true);
  assert.equal(queueNextUploadJob([ready]).id, ready.id);
  assert.equal(queueCanUploadAll([failed]).ok, false);
  assert.equal(queueNextUploadJob([failed]), null);
});

test('queue hydration preserves durable identity aliases in requests and persistence', () => {
  const job = createQueueJob({
    id: 'renderer-row',
    intentId: 'durable-intent',
    clientJobId: 'legacy-client-alias',
    sources: ['C:/exports/identity.mov'],
    settings: { prefix: 'archive/identity' },
  });

  assert.equal(job.intentId, 'durable-intent');
  assert.equal(job.clientJobId, 'legacy-client-alias');
  assert.equal(job.persistable.intentId, 'durable-intent');
  assert.equal(job.persistable.clientJobId, 'legacy-client-alias');
  assert.equal(queueJobRequest(job).intentId, 'durable-intent');
});

test('queue jobs freeze connection identity and a non-secret historical profile snapshot', () => {
  const job = createQueueJob({
    id: 'connection-job',
    sources: ['C:/exports/clip.mov'],
    settings: {
      connectionId: 'archive',
      connections: [{
        id: 'archive',
        name: 'Archive',
        remote: 'archive',
        bucket: 'archive-media',
        endpointHost: 'sfo3.digitaloceanspaces.com',
      }],
      profile: {
        remote: 'archive',
        bucket: 'archive-media',
        endpointHost: 'sfo3.digitaloceanspaces.com',
        accessKeyId: 'MUST_NOT_STORE',
      },
      prefix: 'event/recordings',
    },
  });

  assert.equal(job.connectionId, 'archive');
  assert.deepEqual(job.profileSnapshot, {
    remote: 'archive',
    bucket: 'archive-media',
    endpointHost: 'sfo3.digitaloceanspaces.com',
  });
  assert.equal(queueJobRequest(job).connectionId, 'archive');
  assert.deepEqual(queueJobRequest(job).profileSnapshot, job.profileSnapshot);
  assert.equal(job.persistable.connectionId, 'archive');
  assert.deepEqual(job.persistable.profileSnapshot, job.profileSnapshot);
  assert.notStrictEqual(job.profile, job.profileSnapshot);
  assert.equal(Object.isFrozen(job.profile), true);
  assert.equal(Object.isFrozen(job.profileSnapshot), true);
  assert.equal(Reflect.set(job.profile, 'remote', 'changed'), false);
  assert.equal(job.profileSnapshot.remote, 'archive');
  assert.doesNotMatch(JSON.stringify(job.persistable), /MUST_NOT_STORE|accessKeyId/i);
});

test('queue jobs derive managed identity from the profile tuple and isolate unmatched profiles', () => {
  const connections = [{
    id: 'archive',
    name: 'Archive',
    remote: 'archive',
    bucket: 'archive-media',
    endpointHost: 'sfo3.digitaloceanspaces.com',
  }, {
    id: 'media',
    name: 'Media Archive',
    remote: 'media',
    bucket: 'media',
    endpointHost: 'nyc3.digitaloceanspaces.com',
  }];
  const corrected = createQueueJob({
    sources: ['C:/exports/clip.mov'],
    settings: {
      connections,
      connectionId: 'archive',
      profile: {
        remote: 'media',
        bucket: 'MEDIA',
        endpointHost: 'NYC3.DIGITALOCEANSPACES.COM.',
      },
    },
  });
  const unmanaged = createQueueJob({
    sources: ['C:/exports/other.mov'],
    settings: {
      connections,
      connectionId: 'archive',
      profile: {
        remote: 'other',
        bucket: 'other-media',
        endpointHost: 'fra1.digitaloceanspaces.com',
      },
    },
  });

  assert.equal(corrected.connectionId, 'media');
  assert.match(unmanaged.connectionId, /^unmanaged-[a-f0-9]{32}$/);
  assert.notEqual(unmanaged.connectionId, 'archive');
});

test('queue jobs discard unsafe connection ids before requests or persistence', () => {
  const job = createQueueJob({
    sources: ['C:/exports/clip.mov'],
    settings: {
      connectionId: '../access_key=DO_NOT_STORE',
      prefix: 'event/recordings',
    },
  });

  assert.match(job.connectionId, /^unmanaged-[a-f0-9]{32}$/);
  assert.equal(queueJobRequest(job).connectionId, job.connectionId);
  assert.doesNotMatch(JSON.stringify(job.persistable), /DO_NOT_STORE|access_key/i);
});

test('one external lifecycle gate holds every queue start entry point in a stable waiting state', () => {
  for (const operation of ['automatic', 'retry', 'resume', 'intake', 'dry-run', 'upload']) {
    const gate = queueLifecycleGate({ operation, externalLifecycle: true });

    assert.equal(gate.ok, false, operation);
    assert.equal(gate.externalLifecycle, true, operation);
    assert.equal(gate.waitingStatus, 'needs-resume-check', operation);
    assert.match(gate.message, /another transfer lifecycle/i, operation);
  }

  assert.equal(queueLifecycleGate({ isRunning: true, ownedLifecycle: true }).ok, true);
  assert.equal(queueLifecycleGate({ error: { code: 'ETRANSFERACTIVE' } }).externalLifecycle, true);
  assert.equal(queueLifecycleGate({ error: new Error('Transfer lifecycle upload-a is already active.') }).externalLifecycle, true);
});

test('selects the first queued automatic pre-check job in queue order', () => {
  const jobs = [
    createQueueJob({ id: 'first', sources: ['C:/first.mov'], status: 'queued' }),
    createQueueJob({ id: 'second', sources: ['C:/second.mov'], status: 'queued' }),
  ];

  assert.equal(queueNextPrecheckJob(jobs).id, 'first');
});

test('holds interrupted resume-check work and does not let later queued work leapfrog', () => {
  const jobs = [
    createQueueJob({ id: 'complete', sources: ['C:/done.mov'], status: 'complete' }),
    createQueueJob({ id: 'resume-first', sources: ['C:/first.mov'], status: 'needs-resume-check' }),
    createQueueJob({ id: 'queued-later', sources: ['C:/later.mov'], status: 'queued' }),
  ];

  assert.equal(queueNextPrecheckJob(jobs), null);
  assert.equal(queueNextAutomaticAction(jobs), null);
});

test('explicit resume schedules one fresh check before normal queued work continues', () => {
  const interrupted = createQueueJob({
    id: 'interrupted',
    sources: ['C:/interrupted.mov'],
    status: 'needs-resume-check',
    jobId: 'interrupted-upload',
  });
  const later = createQueueJob({ id: 'later', sources: ['C:/later.mov'], status: 'queued' });
  const resumed = resumeCandidate(interrupted);

  assert.deepEqual(queueNextAutomaticAction([resumed, later]), { type: 'precheck', job: resumed });
  assert.equal(resumeCandidate(resumed), resumed);

  const afterResume = queueWithJobStatus([resumed, later], resumed.id, 'complete');
  assert.deepEqual(queueNextAutomaticAction(afterResume), { type: 'precheck', job: afterResume[1] });
});

test('does not select automatic work after a failed or blocked job', () => {
  const queued = createQueueJob({ id: 'later', sources: ['C:/later.mov'], status: 'queued' });
  const failed = createQueueJob({ id: 'failed', sources: ['C:/bad.mov'], status: 'failed' });
  const blocked = createQueueJob({ id: 'blocked', sources: ['C:/blocked.mov'], status: 'blocked' });

  assert.equal(queueNextPrecheckJob([failed, queued]), null);
  assert.equal(queueNextPrecheckJob([blocked, queued]), null);
});

test('does not select automatic work while a lifecycle is active', () => {
  const queued = createQueueJob({ id: 'later', sources: ['C:/later.mov'], status: 'queued' });

  for (const status of ['prechecking', 'uploading', 'verifying', 'pausing']) {
    const active = createQueueJob({ id: status, sources: [`C:/${status}.mov`], status });
    assert.equal(queueNextPrecheckJob([active, queued]), null, status);
  }
});

test('selects upload for a restored ready job without pre-checking it again', () => {
  const ready = createQueueJob({ id: 'ready', sources: ['C:/ready.mov'], status: 'ready' });

  assert.deepEqual(queueNextAutomaticAction([ready]), { type: 'upload', job: ready });
  assert.deepEqual(
    queueNextAutomaticAction([
      ready,
      createQueueJob({ id: 'queued', sources: ['C:/queued.mov'], status: 'queued' }),
    ]),
    { type: 'upload', job: ready },
  );
});

test('does not let a later ready job leapfrog earlier queued work', () => {
  const queued = createQueueJob({ id: 'queued', sources: ['C:/queued.mov'], status: 'queued' });
  const ready = createQueueJob({ id: 'ready', sources: ['C:/ready.mov'], status: 'ready' });

  assert.deepEqual(queueNextAutomaticAction([queued, ready]), { type: 'precheck', job: queued });
});

test('deduplicates Event Workspace intake by sources, destination, and frozen profile', () => {
  const settings = {
    profile: {
      remote: 'event-remote',
      bucket: 'event-bucket',
      endpointHost: 'event.example.test',
    },
    prefix: 'sample-event/recordings/raw/Main/Day 1/Mix',
  };
  const existing = createQueueJob({ id: 'existing', sources: ['C:/Event/clip.mov'], settings });
  const duplicate = createQueueJob({ id: 'duplicate', sources: ['c:\\event\\CLIP.mov'], settings });
  const otherProfile = createQueueJob({
    id: 'other-profile',
    sources: ['C:/Event/clip.mov'],
    settings: {
      ...settings,
      profile: { ...settings.profile, bucket: 'other-bucket' },
    },
  });

  const result = appendUniqueQueueJobs([existing], [duplicate, otherProfile]);

  assert.deepEqual(result.jobs.map((job) => job.id), ['existing', 'other-profile']);
  assert.deepEqual(result.added.map((job) => job.id), ['other-profile']);
  assert.equal(result.duplicates.length, 1);
  assert.deepEqual(existing.profile, settings.profile);
});

test('deduplicates hydrated aliases by canonical intent instead of renderer row id', () => {
  const existing = createQueueJob({
    id: 'renderer-existing',
    intentId: 'durable-intent',
    sources: ['C:/Event/first.mov'],
    settings: { prefix: 'archive/first' },
  });
  const aliasDuplicate = createQueueJob({
    id: 'renderer-candidate',
    clientJobId: 'durable-intent',
    sources: ['C:/Event/renamed.mov'],
    settings: { prefix: 'archive/other' },
  });

  const result = appendUniqueQueueJobs([existing], [aliasDuplicate]);

  assert.deepEqual(result.jobs.map((job) => job.id), ['renderer-existing']);
  assert.deepEqual(result.duplicates.map((job) => job.id), ['renderer-candidate']);
});

test('builds upload-all requests only from ready jobs with queue ids', () => {
  const ready = createQueueJob({
    id: 'ready-job',
    sources: ['C:/exports/day1.mov'],
    settings: { prefix: 'archive-event/recordings/raw/stage1/day1' },
    status: 'ready',
  });
  const complete = createQueueJob({
    id: 'complete-job',
    sources: ['C:/exports/done.mov'],
    settings: { prefix: 'archive-event/recordings/done' },
    status: 'complete',
  });
  const blocked = createQueueJob({
    id: 'blocked-job',
    sources: ['C:/exports/stale.mov'],
    settings: { prefix: 'archive-event/recordings/stale' },
    status: 'needs-resume-check',
  });

  const requests = queueUploadRequests([ready, complete, blocked]);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].clientJobId, 'ready-job');
  assert.equal(requests[0].intentId, 'ready-job');
  assert.equal(requests[0].prefix, 'archive-event/recordings/raw/stage1/day1');
  assert.deepEqual(requests[0].sources, ['C:/exports/day1.mov']);
});

test('reconciles completed verified job records back into the queue', () => {
  const queued = createQueueJob({
    id: 'queue-day1-c100',
    sources: ['C:/Austria Mix/c100 RAW-day 1/00003.MTS'],
    settings: { prefix: 'archive-event/recordings/raw/stage1/day1/c100' },
    status: 'queued',
    jobId: 'dryrun-1',
  });

  const reconciled = reconcileQueueJobsWithRecords([queued], [
    {
      jobId: 'upload-1',
      intentId: queued.id,
      status: 'complete',
      prefix: 'archive-event/recordings/raw/stage1/day1/c100',
      sources: ['C:/Austria Mix/c100 RAW-day 1/00003.MTS'],
      verification: {
        ok: true,
        verified: [{ name: '00003.MTS' }],
        missing: [],
        sizeMismatch: [],
      },
      urls: ['https://media.nyc3.digitaloceanspaces.com/archive-event/recordings/raw/stage1/day1/c100/00003.MTS'],
    },
  ]);

  assert.equal(reconciled[0].status, 'complete');
  assert.equal(reconciled[0].jobId, 'upload-1');
  assert.equal(reconciled[0].urls.length, 1);
  assert.equal(queueCanUploadAll(reconciled).ok, false);
});

test('terminal records reconcile through canonical intent when the renderer row id differs', () => {
  const profile = { remote: 'event-a', bucket: 'archive', endpointHost: 'a.example.test' };
  const statuses = [
    ['complete', 'complete'],
    ['cancelled', 'cancelled'],
    ['failed', 'failed'],
    ['blocked', 'failed'],
  ];

  for (const [recordStatus, expectedStatus] of statuses) {
    const identityField = ['cancelled', 'blocked'].includes(recordStatus) ? 'clientJobId' : 'intentId';
    const durableIntent = `durable-${recordStatus}`;
    const job = createQueueJob({
      id: `renderer-${recordStatus}`,
      [identityField]: durableIntent,
      sources: [`C:/exports/${recordStatus}.mov`],
      settings: { prefix: `archive/${recordStatus}`, profile },
      status: 'uploading',
      jobId: `stale-${recordStatus}`,
    });
    const record = {
      jobId: `record-${recordStatus}`,
      [identityField]: durableIntent,
      status: recordStatus,
      sources: job.sources,
      prefix: job.prefix,
      profile,
      error: recordStatus === 'complete' ? '' : `${recordStatus} record`,
      verification: recordStatus === 'complete'
        ? { ok: true, verified: [{ name: `${recordStatus}.mov` }], missing: [], sizeMismatch: [] }
        : null,
    };

    const [reconciled] = reconcileQueueJobsWithRecords([job], [record], {
      activeTransfer: { isRunning: false, activeJobId: '', intentId: '' },
    });

    assert.equal(reconciled.status, expectedStatus, recordStatus);
    assert.equal(reconciled.jobId, record.jobId, recordStatus);
  }
});

test('reconciles complete running and failed records only to the matching frozen profile', () => {
  const profileA = { remote: 'event-a', bucket: 'archive', endpointHost: 'a.example.test' };
  const profileB = { remote: 'event-b', bucket: 'archive', endpointHost: 'b.example.test' };
  const source = 'C:/Event/shared.mov';
  const prefix = 'event/recordings/raw/Main';
  const recordBase = {
    sources: [source],
    prefix,
    profile: { remote: ' event-a ', bucket: 'ARCHIVE', endpointHost: 'A.EXAMPLE.TEST.' },
  };

  for (const record of [
    {
      ...recordBase,
      jobId: 'profile-complete',
      status: 'complete',
      verification: { ok: true, verified: [{ name: 'shared.mov' }], missing: [], sizeMismatch: [] },
    },
    { ...recordBase, jobId: 'profile-running', status: 'running' },
    { ...recordBase, jobId: 'profile-failed', status: 'failed', error: 'profile A failed' },
  ]) {
    const jobs = [
      createQueueJob({ id: 'profile-a', sources: [source], settings: { prefix, profile: profileA }, jobId: record.jobId }),
      createQueueJob({ id: 'profile-b', sources: [source], settings: { prefix, profile: profileB }, jobId: record.jobId }),
    ];
    const reconciled = reconcileQueueJobsWithRecords(jobs, [record], {
      activeJobId: record.status === 'running' ? record.jobId : '',
    });

    assert.notEqual(reconciled[0].status, 'queued', `${record.status} should match profile A`);
    assert.equal(reconciled[1].status, 'queued', `${record.status} must not cross-match profile B`);
  }
});

test('matches profile-less legacy records only to an attached exact job on the default profile', () => {
  const source = 'C:/Legacy/shared.mov';
  const prefix = 'legacy/recordings';
  const verification = { ok: true, verified: [{ name: 'shared.mov' }], missing: [], sizeMismatch: [] };
  const jobs = [
    createQueueJob({ id: 'legacy-fresh', sources: [source], settings: { prefix } }),
    createQueueJob({
      id: 'legacy-attached',
      sources: [source],
      settings: { prefix },
      jobId: 'legacy-complete',
    }),
    createQueueJob({
      id: 'legacy-custom',
      sources: [source],
      settings: {
        prefix,
        profile: { remote: 'other', bucket: 'other', endpointHost: 'other.example.test' },
      },
      jobId: 'legacy-complete',
    }),
  ];

  const reconciled = reconcileQueueJobsWithRecords(jobs, [{
    jobId: 'legacy-complete',
    status: 'complete',
    prefix,
    sources: [source],
    verification,
  }]);

  assert.equal(reconciled[0].status, 'queued');
  assert.equal(reconciled[1].status, 'complete');
  assert.equal(reconciled[2].status, 'queued');
});

test('does not reconcile a fresh intent to older modern complete running or failed records', () => {
  const profile = { remote: 'event', bucket: 'archive', endpointHost: 'event.example.test' };
  const source = 'C:/Repeated/camera.mov';
  const prefix = 'event/recordings/raw/Main/Cameras';
  const fresh = createQueueJob({ id: 'fresh-intent', sources: [source], settings: { prefix, profile } });

  for (const record of [
    {
      jobId: 'old-complete',
      intentId: 'old-intent',
      status: 'complete',
      verification: { ok: true, verified: [{ name: 'camera.mov' }], missing: [], sizeMismatch: [] },
    },
    { jobId: 'old-running', intentId: 'old-intent', status: 'running' },
    { jobId: 'old-failed', intentId: 'old-intent', status: 'failed', error: 'old failure' },
  ]) {
    const reconciled = reconcileQueueJobsWithRecords([fresh], [{
      ...record,
      sources: [source],
      prefix,
      profile,
    }], { activeJobId: record.jobId });
    assert.equal(reconciled[0].status, 'queued', record.status);
    assert.equal(reconciled[0].jobId, '', record.status);
  }
});

test('reconciles only the exact intent when the same upload is deliberately repeated', () => {
  const profile = { remote: 'event', bucket: 'archive', endpointHost: 'event.example.test' };
  const source = 'C:/Repeated/camera.mov';
  const prefix = 'event/recordings/raw/Main/Cameras';
  const first = createQueueJob({ id: 'repeat-one', sources: [source], settings: { prefix, profile } });
  const second = createQueueJob({ id: 'repeat-two', sources: [source], settings: { prefix, profile } });
  const reconciled = reconcileQueueJobsWithRecords([first, second], [{
    jobId: 'repeat-one-upload',
    intentId: 'repeat-one',
    status: 'complete',
    sources: [source],
    prefix,
    profile,
    verification: { ok: true, verified: [{ name: 'camera.mov' }], missing: [], sizeMismatch: [] },
  }]);

  assert.equal(reconciled[0].status, 'complete');
  assert.equal(reconciled[1].status, 'queued');
  assert.notEqual(first.id, second.id);
});

test('reconciles modern running and failed records only to their exact intent', () => {
  const profile = { remote: 'event', bucket: 'archive', endpointHost: 'event.example.test' };
  const source = 'C:/Repeated/camera.mov';
  const prefix = 'event/recordings/raw/Main/Cameras';

  for (const record of [
    { jobId: 'modern-running', intentId: 'running-intent', status: 'running' },
    { jobId: 'modern-failed', intentId: 'failed-intent', status: 'failed', error: 'current failure' },
  ]) {
    const matching = createQueueJob({ id: record.intentId, sources: [source], settings: { prefix, profile } });
    const repeated = createQueueJob({ id: `${record.intentId}-repeat`, sources: [source], settings: { prefix, profile } });
    const reconciled = reconcileQueueJobsWithRecords([matching, repeated], [{
      ...record,
      sources: [source],
      prefix,
      profile,
    }], { activeJobId: record.status === 'running' ? record.jobId : '' });

    assert.equal(reconciled[0].status, record.status === 'running' ? 'uploading' : 'failed');
    assert.equal(reconciled[0].jobId, record.jobId);
    assert.equal(reconciled[1].status, 'queued');
    assert.equal(reconciled[1].jobId, '');
  }
});

test('history resume creates a fresh schedulable intent without inheriting modern failure association', () => {
  const record = {
    jobId: 'failed-upload-1',
    intentId: 'original-intent',
    status: 'failed',
    sources: ['C:/Repeated/camera.mov'],
    prefix: 'event/recordings/raw/Main/Cameras',
    filterMode: 'all',
    checksumMode: 'sha256',
    profile: { remote: 'event', bucket: 'archive', endpointHost: 'event.example.test' },
    error: 'original failure',
  };

  const resumed = createHistoryResumeQueueJob(record);
  const reconciled = reconcileQueueJobsWithRecords([resumed], [record]);

  assert.notEqual(resumed.id, record.intentId);
  assert.notEqual(resumed.id, record.jobId);
  assert.equal(resumed.jobId, '');
  assert.equal(resumed.resumeFromJobId, record.jobId);
  assert.equal(resumed.persistable.resumeFromJobId, record.jobId);
  assert.equal(queueJobRequest(resumed).resumeFromJobId, record.jobId);
  assert.equal(queueNextAutomaticAction([resumed]).type, 'precheck');
  assert.equal(resumed.status, 'queued');
  assert.equal(reconciled[0].status, 'queued');
  assert.equal(reconciled[0].jobId, '');
});

test('modern intent mismatch cannot be overridden by an attached matching job id', () => {
  const profile = { remote: 'event', bucket: 'archive', endpointHost: 'event.example.test' };
  const source = 'C:/Repeated/camera.mov';
  const prefix = 'event/recordings/raw/Main/Cameras';
  const queueJob = createQueueJob({
    id: 'new-intent',
    sources: [source],
    settings: { prefix, profile },
    status: 'needs-resume-check',
    jobId: 'old-upload',
    resumeFromJobId: 'old-upload',
  });
  const record = {
    jobId: 'old-upload',
    intentId: 'old-intent',
    status: 'failed',
    sources: [source],
    prefix,
    profile,
    error: 'old failure',
  };

  const [reconciled] = reconcileQueueJobsWithRecords([queueJob], [record]);

  assert.equal(reconciled.status, 'needs-resume-check');
  assert.equal(reconciled.error, '');
});

test('reattaches a restored Event Workspace job using its persisted manifest profile', () => {
  const manifestProfile = {
    remote: 'event-remote',
    bucket: 'event-bucket',
    endpointHost: 'event.example.test',
  };
  const original = createQueueJob({
    id: 'event-job',
    sources: ['C:/Event/camera.mov'],
    settings: { prefix: 'event/recordings/raw/Main/Cameras', profile: manifestProfile },
  });
  const restored = createQueueJob({
    id: original.persistable.id,
    sources: original.persistable.sources,
    settings: original.persistable,
    status: original.persistable.status,
  });
  const reconciled = reconcileQueueJobsWithRecords([restored], [{
    jobId: 'event-upload',
    intentId: restored.id,
    status: 'complete',
    sources: restored.sources,
    prefix: restored.prefix,
    profile: manifestProfile,
    verification: { ok: true, verified: [{ name: 'camera.mov' }], missing: [], sizeMismatch: [] },
  }]);

  assert.deepEqual(restored.profile, manifestProfile);
  assert.equal(reconciled[0].status, 'complete');
  assert.equal(reconciled[0].jobId, 'event-upload');
});

test('marks stale running jobs as needing a resume check', () => {
  const uploading = createQueueJob({
    id: 'queue-stale',
    sources: ['C:/exports/day2.mov'],
    settings: { prefix: 'archive-event/recordings/raw/stage1/day2' },
    status: 'uploading',
    jobId: 'upload-stale',
  });

  const reconciled = reconcileQueueJobsWithRecords([uploading], [
    {
      jobId: 'upload-stale',
      status: 'running',
      prefix: 'archive-event/recordings/raw/stage1/day2',
      sources: ['C:/exports/day2.mov'],
    },
  ], { activeJobId: '' });

  assert.equal(reconciled[0].status, 'needs-resume-check');
  assert.equal(queueCanUploadAll(reconciled).ok, false);
  assert.match(queueCanUploadAll(reconciled).reason, /Check and resume/);
  assert.match(queueJobStatusHint(reconciled[0]), /Check and resume.*skip matching files/);
  assert.equal(queueNextUploadJob(reconciled), null);
});

test('recovers orphaned active work while settling pausing to paused', () => {
  const jobs = ['prechecking', 'uploading', 'verifying', 'pausing'].map((status) => createQueueJob({
    id: `orphaned-${status}`,
    sources: [`C:/exports/${status}.mov`],
    settings: { prefix: `archive/${status}` },
    status,
    jobId: `job-${status}`,
  }));

  const reconciled = reconcileQueueJobsWithRecords(jobs, [], {
    activeTransfer: { isRunning: false, activeJobId: '', intentId: '' },
  });

  assert.deepEqual(reconciled.map((job) => job.status), [
    'needs-resume-check',
    'needs-resume-check',
    'needs-resume-check',
    'paused',
  ]);
  assert.deepEqual(reconciled.map((job) => job.error), [
    INTERRUPTED_JOB_ERROR,
    INTERRUPTED_JOB_ERROR,
    INTERRUPTED_JOB_ERROR,
    '',
  ]);
});

test('durable cancellation overrides a stale uploading queue snapshot', () => {
  const profile = { remote: 'event-a', bucket: 'archive', endpointHost: 'a.example.test' };
  const uploading = createQueueJob({
    id: 'cancelled-intent',
    sources: ['C:/exports/cancelled.mov'],
    settings: { prefix: 'archive/cancelled', profile },
    status: 'uploading',
    jobId: 'upload-cancelled',
  });

  const [reconciled] = reconcileQueueJobsWithRecords([uploading], [{
    jobId: 'upload-cancelled',
    intentId: 'cancelled-intent',
    status: 'cancelled',
    sources: uploading.sources,
    prefix: uploading.prefix,
    profile,
    error: 'Cancelled by user.',
  }], {
    activeTransfer: { isRunning: false, activeJobId: '', intentId: '' },
  });

  assert.equal(reconciled.status, 'cancelled');
  assert.equal(reconciled.jobId, 'upload-cancelled');
  assert.equal(reconciled.error, 'Cancelled by user.');
  assert.equal(queueNextUploadJob([reconciled]), null);
});

test('modern live reconciliation adopts the active upload id by exact intent and profile', () => {
  const profile = { remote: 'event-a', bucket: 'archive', endpointHost: 'a.example.test' };
  for (const status of ['ready', 'uploading']) {
    const job = createQueueJob({
      id: 'live-intent',
      sources: ['C:/exports/live.mov'],
      settings: { prefix: 'archive/live', profile },
      status,
      jobId: 'dryrun-a',
    });
    const record = {
      jobId: 'upload-b',
      intentId: 'live-intent',
      status: 'running',
      sources: job.sources,
      prefix: job.prefix,
      profile,
    };
    const [attached] = reconcileQueueJobsWithRecords([job], [record], {
      activeTransfer: {
        isRunning: true,
        activeJobId: 'upload-b',
        intentId: 'live-intent',
        profile,
      },
    });

    assert.equal(attached.status, 'uploading', status);
    assert.equal(attached.jobId, 'upload-b', status);
    assert.equal(attached.persistable.jobId, 'upload-b', status);
  }
});

test('live lifecycle phase reattaches childless verification instead of stale uploading state', () => {
  const profile = { remote: 'event-a', bucket: 'archive', endpointHost: 'a.example.test' };
  const job = createQueueJob({
    id: 'verifying-intent',
    sources: ['C:/exports/verifying.mov'],
    settings: { prefix: 'archive/verifying', profile },
    status: 'uploading',
    jobId: 'dryrun-a',
  });
  const [reconciled] = reconcileQueueJobsWithRecords([job], [{
    jobId: 'upload-b',
    intentId: 'verifying-intent',
    status: 'running',
    sources: job.sources,
    prefix: job.prefix,
    profile,
  }], {
    activeTransfer: {
      isRunning: true,
      isLifecycleActive: true,
      hasChildProcess: false,
      pid: 0,
      phase: 'verifying',
      activeJobId: 'upload-b',
      intentId: 'verifying-intent',
      profile,
    },
  });

  assert.equal(reconciled.status, 'verifying');
  assert.equal(reconciled.jobId, 'upload-b');
});

test('live retry precheck takes precedence over active and provenance record statuses', () => {
  const profile = { remote: 'event-a', bucket: 'archive', endpointHost: 'a.example.test' };
  for (const activeRecordStatus of ['dry-run', 'prechecking', 'running', 'verifying']) {
    for (const provenanceStatus of ['failed', 'cancelled']) {
      const job = createQueueJob({
        id: `renderer-${activeRecordStatus}-${provenanceStatus}`,
        intentId: `fresh-${activeRecordStatus}-${provenanceStatus}`,
        sources: ['C:/exports/retry.mov'],
        settings: { prefix: 'archive/retry', profile },
        status: 'needs-resume-check',
        resumeFromJobId: `old-${provenanceStatus}`,
      });
      const activeJobId = `fresh-job-${activeRecordStatus}-${provenanceStatus}`;
      const records = [
        {
          jobId: activeJobId,
          intentId: job.intentId,
          status: activeRecordStatus,
          sources: job.sources,
          prefix: job.prefix,
          profile,
        },
        {
          jobId: `old-${provenanceStatus}`,
          intentId: `old-intent-${provenanceStatus}`,
          status: provenanceStatus,
          sources: job.sources,
          prefix: job.prefix,
          profile,
          error: `old ${provenanceStatus}`,
        },
      ];

      const [reconciled] = reconcileQueueJobsWithRecords([job], records, {
        activeTransfer: {
          isRunning: true,
          isLifecycleActive: true,
          phase: 'prechecking',
          activeJobId,
          intentId: job.intentId,
          profile,
        },
      });

      assert.equal(reconciled.status, 'prechecking', `${activeRecordStatus}/${provenanceStatus}`);
      assert.equal(reconciled.jobId, activeJobId, `${activeRecordStatus}/${provenanceStatus}`);
      assert.equal(reconciled.error, '', `${activeRecordStatus}/${provenanceStatus}`);
      assert.equal(reconciled.resumeFromJobId, `old-${provenanceStatus}`);
    }
  }
});

test('modern live reconciliation rejects a different intent or frozen profile', () => {
  const profile = { remote: 'event-a', bucket: 'archive', endpointHost: 'a.example.test' };
  const job = createQueueJob({
    id: 'live-intent',
    sources: ['C:/exports/live.mov'],
    settings: { prefix: 'archive/live', profile },
    status: 'uploading',
    jobId: 'dryrun-a',
  });
  const record = {
    jobId: 'upload-b',
    intentId: 'live-intent',
    status: 'running',
    sources: job.sources,
    prefix: job.prefix,
    profile,
  };
  const [wrongIntent] = reconcileQueueJobsWithRecords([job], [record], {
    activeTransfer: {
      isRunning: true,
      activeJobId: 'upload-b',
      intentId: 'other-intent',
      profile,
    },
  });
  const [wrongProfile] = reconcileQueueJobsWithRecords([job], [record], {
    activeTransfer: {
      isRunning: true,
      activeJobId: 'upload-b',
      intentId: 'live-intent',
      profile: { remote: 'event-b', bucket: 'archive', endpointHost: 'b.example.test' },
    },
  });

  assert.equal(wrongIntent.status, 'needs-resume-check');
  assert.equal(wrongProfile.status, 'needs-resume-check');
});

test('explicit resume candidate is not replaced by the failed record it resumes from', () => {
  const profile = { remote: 'event-a', bucket: 'archive', endpointHost: 'a.example.test' };
  const failed = createQueueJob({
    id: 'failed-intent',
    sources: ['C:/exports/failed.mov'],
    settings: { prefix: 'archive/failed', profile },
    status: 'failed',
    jobId: 'failed-upload',
    error: 'network failed',
  });
  const resumed = resumeCandidate(failed);
  const [reconciled] = reconcileQueueJobsWithRecords([resumed], [{
    jobId: 'failed-upload',
    intentId: 'failed-intent',
    status: 'failed',
    sources: failed.sources,
    prefix: failed.prefix,
    profile,
    error: 'network failed',
  }]);

  assert.equal(reconciled.status, 'queued');
  assert.equal(reconciled.resumeFromJobId, 'failed-upload');
  assert.equal(reconciled.error, '');
});

test('durable paused records keep their queue row stable until explicit resume', () => {
  const paused = createQueueJob({
    id: 'paused-intent',
    sources: ['C:/exports/paused.mov'],
    settings: { prefix: 'archive/paused' },
    status: 'pausing',
    jobId: 'paused-upload',
  });
  const records = [{
    jobId: 'paused-upload',
    intentId: 'paused-intent',
    status: 'paused',
    sources: paused.sources,
    prefix: paused.prefix,
    profile: paused.profile,
    error: '',
  }];

  const [reconciled] = reconcileQueueJobsWithRecords([paused], records, {
    activeTransfer: { isRunning: false, activeJobId: '', intentId: '' },
  });

  assert.equal(reconciled.status, 'paused');
  assert.equal(reconciled.jobId, 'paused-upload');
  assert.equal(queueNextAutomaticAction([reconciled, createQueueJob({
    id: 'later',
    sources: ['C:/exports/later.mov'],
    settings: { prefix: 'archive/later' },
    status: 'queued',
  })]), null);

  const resumed = resumeCandidate(reconciled);
  assert.equal(resumed.status, 'queued');
  assert.equal(queueNextAutomaticAction([resumed]).type, 'precheck');
});

test('reattaches live running job records to the active upload row', () => {
  const restored = createQueueJob({
    id: 'queue-live',
    sources: ['C:/exports/day2.mov'],
    settings: { prefix: 'archive-event/recordings/raw/stage1/day2' },
    status: 'queued',
    jobId: 'upload-live',
  });

  const reconciled = reconcileQueueJobsWithRecords([restored], [
    {
      jobId: 'upload-live',
      status: 'running',
      prefix: 'archive-event/recordings/raw/stage1/day2',
      sources: ['C:/exports/day2.mov'],
    },
  ], { activeJobId: 'upload-live' });

  assert.equal(reconciled[0].status, 'uploading');
  assert.equal(reconciled[0].jobId, 'upload-live');
  assert.match(queueJobStatusHint(reconciled[0]), /Live rclone process/);
  assert.equal(queueCanUploadAll(reconciled).ok, false);
});

test('treats verified warning job records as complete and failed records as failed', () => {
  const warningJob = createQueueJob({
    id: 'warning-job',
    sources: ['C:/exports/warning.mov'],
    settings: { prefix: 'archive-event/recordings/warning' },
    status: 'ready',
  });
  const failedJob = createQueueJob({
    id: 'failed-job',
    sources: ['C:/exports/failed.mov'],
    settings: { prefix: 'archive-event/recordings/failed' },
    status: 'ready',
  });

  const reconciled = reconcileQueueJobsWithRecords([warningJob, failedJob], [
    {
      jobId: 'upload-warning',
      intentId: warningJob.id,
      status: 'warning',
      prefix: 'archive-event/recordings/warning',
      sources: ['C:/exports/warning.mov'],
      verification: { ok: true, verified: [{ name: 'warning.mov' }], missing: [], sizeMismatch: [] },
      urls: ['https://example.test/warning.mov'],
    },
    {
      jobId: 'upload-failed',
      intentId: failedJob.id,
      status: 'failed',
      prefix: 'archive-event/recordings/failed',
      sources: ['C:/exports/failed.mov'],
      error: 'network dropped',
    },
  ]);

  assert.equal(reconciled[0].status, 'complete');
  assert.equal(reconciled[1].status, 'failed');
  assert.equal(reconciled[1].error, 'network dropped');
});

test('builds new event archive destinations with stage and talks convention', () => {
  assert.equal(
    buildArchiveDestination({
      event: 'archive-event',
      category: 'raw',
      stage: 'stage1',
      day: 'day1',
    }),
    'archive-event/recordings/raw/stage1/day1',
  );
  assert.equal(
    buildArchiveDestination({
      event: 'archive-event',
      category: 'talks',
      stage: 'stage2',
      day: 'day2',
    }),
    'archive-event/recordings/edits/talks/stage2/day2',
  );
});

test('normalizes custom archive stage and day values', () => {
  assert.equal(
    buildArchiveDestination({
      event: 'Archive Event 2026',
      category: 'livestream',
      stage: 'Stage 10',
      day: 'Day 03',
    }),
    'archive-event-2026/recordings/edits/livestream/stage10/day03',
  );
});

test('builds archive package target with friendly server-side package name', () => {
  assert.equal(
    buildArchivePackageTarget({
      event: 'archive-event',
      category: 'raw',
      stage: 'stage1',
      day: 'day1',
      packageName: 'mix',
    }),
    'archive-event/recordings/raw/stage1/day1/mix',
  );
});
