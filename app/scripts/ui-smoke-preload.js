const { contextBridge } = require('electron');
const { sha256Hex } = require('../src/connection-digest-core');
const {
  inspectUploadSourcesForCredentialLikePaths,
} = require('../src/event-workspace-runtime');
const {
  findSuccessfulResumeSupersessions,
  summarizeActivityRecords,
} = require('../src/activity-core');

const defaultSettings = {
  settingsVersion: 2,
  activeConnectionId: 'media',
  connections: [
    {
      id: 'media', name: 'Media Archive', remote: 'media', bucket: 'media',
      endpointHost: 'media.nyc3.digitaloceanspaces.com', publicRead: true, checksum: 'size',
      recentPrefixes: ['archive-event/recordings/raw/stage1/day2/mix'], pinnedPrefixes: [],
      lastTestedAt: '2026-07-19T12:00:00.000Z',
    },
    {
      id: 'archive', name: 'Archive Space', remote: 'archive', bucket: 'archive-media',
      endpointHost: 'sfo3.digitaloceanspaces.com', publicRead: false, checksum: 'sha256',
      recentPrefixes: ['completed/exports'], pinnedPrefixes: ['reviewed'],
      lastTestedAt: '',
    },
  ],
  source: '',
  prefix: 'archive-event/recordings/raw/stage1/day2/mix',
  include: '',
  filterMode: 'all',
  publicRead: true,
  checksum: 'size',
  notifyWebhook: '',
  notifyNtfy: '',
  notifyOn: 'success',
  folderUploadMode: 'package',
  profile: {
    remote: 'media',
    bucket: 'media',
    endpointHost: 'media.nyc3.digitaloceanspaces.com',
  },
  recentPrefixes: ['archive-event/recordings/raw/stage1/day2/mix'],
  recentPrefixesByConnection: {
    media: ['archive-event/recordings/raw/stage1/day2/mix'],
    archive: ['completed/exports'],
    'legacy-profile:media:media:media.nyc3.digitaloceanspaces.com': [
      'archive-event/recordings/raw/stage1/day2/mix',
    ],
    'legacy-profile:other:other:other.sfo3.digitaloceanspaces.com': [
      'other-connection/private-recent',
    ],
  },
  pinnedPrefixes: [],
  archiveEvent: 'archive-event',
  archiveCategory: 'raw',
  archiveStage: 'stage1',
  archiveDay: 'day1',
  archivePackageName: 'mix',
  queueJobs: [],
};

const smokeScenario = new URLSearchParams(globalThis.location?.search || '').get('smokeScenario') || '';
let uploadEventCallback = null;
let beforePauseCloseCallback = null;
let automationStatusCallback = null;
let automationQueueUpdatedCallback = null;
let activityRecordsOverride = null;
const pendingProfileSetups = new Map();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function restoredJob(id, status, prefix) {
  return {
    id,
    sources: [`C:/Restored/${id}.mov`],
    profile: defaultSettings.profile,
    prefix,
    filterMode: 'all',
    include: '',
    folderUploadMode: 'package',
    publicRead: true,
    checksum: 'size',
    notifications: { webhook: '', ntfy: '', notifyOn: 'success' },
    status,
    jobId: '',
    urls: [],
    error: status === 'failed' || status === 'blocked' ? `Restored ${status}` : '',
    verification: null,
  };
}

function scenarioSettings() {
  const settings = clone(defaultSettings);
  if (smokeScenario === 'fresh-connections') {
    settings.connections = [];
    settings.activeConnectionId = '';
    settings.profile = { remote: '', bucket: '', endpointHost: '' };
    settings.prefix = '';
    settings.recentPrefixes = [];
    settings.recentPrefixesByConnection = {};
    settings.pinnedPrefixes = [];
  } else if (smokeScenario === 'restored-automatic') {
    settings.queueJobs = [
      restoredJob('restored-resume', 'needs-resume-check', 'restored/resume'),
      restoredJob('restored-queued', 'queued', 'restored/queued'),
    ];
  } else if (smokeScenario === 'resume-persistence-retry') {
    settings.queueJobs = [
      restoredJob('resume-persistence-row', 'needs-resume-check', 'restored/resume-persistence'),
    ];
  } else if (smokeScenario === 'restored-attention') {
    settings.queueJobs = [
      restoredJob('restored-failed', 'failed', 'restored/failed'),
      restoredJob('restored-blocked', 'blocked', 'restored/blocked'),
      restoredJob('restored-needs-resume', 'needs-resume-check', 'restored/needs-resume'),
      restoredJob('restored-later', 'queued', 'restored/later'),
    ];
  } else if (smokeScenario === 'restored-precheck-failure') {
    settings.queueJobs = [
      restoredJob('precheck-failure', 'queued', 'restored/precheck-failure'),
      restoredJob('precheck-later', 'queued', 'restored/precheck-later'),
    ];
  } else if (smokeScenario === 'restored-ready') {
    settings.queueJobs = [
      restoredJob('restored-ready', 'ready', 'restored/ready'),
      restoredJob('restored-after-ready', 'queued', 'restored/after-ready'),
    ];
  } else if (smokeScenario === 'live-reattachment') {
    const live = restoredJob('live-queue-row', 'uploading', 'restored/live');
    live.jobId = 'mock-live-dryrun';
    settings.queueJobs = [live, restoredJob('live-later', 'queued', 'restored/live-later')];
  } else if (smokeScenario === 'orphaned-inflight') {
    settings.queueJobs = ['prechecking', 'uploading', 'verifying', 'pausing'].map((status) => {
      const job = restoredJob(`orphaned-${status}`, status, `restored/${status}`);
      job.jobId = `mock-${status}`;
      return job;
    });
  } else if (['paused-stable', 'paused-explicit-resume'].includes(smokeScenario)) {
    const paused = restoredJob('restored-paused', 'paused', 'restored/paused');
    paused.jobId = 'paused-upload';
    settings.queueJobs = smokeScenario === 'paused-stable'
      ? [paused, restoredJob('paused-later', 'queued', 'restored/paused-later')]
      : [paused];
  } else if (smokeScenario === 'cross-profile-live') {
    const live = restoredJob('cross-profile-row', 'uploading', 'restored/cross-profile');
    live.jobId = 'mock-cross-profile-transfer';
    settings.queueJobs = [live];
  } else if (smokeScenario === 'verifying-no-child') {
    const verifying = restoredJob('verifying-row', 'uploading', 'restored/verifying');
    verifying.jobId = 'verifying-dryrun';
    settings.queueJobs = [verifying];
  } else if (smokeScenario === 'cancelled-stale') {
    const cancelled = restoredJob('cancelled-row', 'uploading', 'restored/cancelled');
    cancelled.jobId = 'cancelled-upload';
    settings.queueJobs = [cancelled, restoredJob('cancelled-later', 'queued', 'restored/cancelled-later')];
  } else if (smokeScenario === 'active-completes-between-reads') {
    const finishing = restoredJob('finishing-row', 'uploading', 'restored/finishing');
    finishing.jobId = 'finishing-upload';
    const paused = restoredJob('finishing-paused', 'paused', 'restored/finishing-paused');
    paused.jobId = 'finishing-paused-upload';
    settings.queueJobs = [finishing, paused];
  } else if (smokeScenario === 'recovery-read-failure') {
    settings.queueJobs = [restoredJob('recovery-disabled-row', 'queued', 'restored/recovery-disabled')];
  } else if (smokeScenario === 'external-releases') {
    settings.queueJobs = [restoredJob('external-release-row', 'queued', 'restored/external-release')];
  }
  return settings;
}

const queueMock = {
  settings: scenarioSettings(),
  calls: [],
  precheckOutcomes: smokeScenario === 'restored-precheck-failure'
    ? [{ ok: false, error: 'Mocked pre-check failure' }]
    : [],
  uploadOutcomes: [],
  pauseOutcomes: [],
  cancelOutcomes: [],
  saveOutcomes: [],
  checkSystemOutcomes: [],
  connectionImport: null,
  connectionImportError: '',
  eventManifestResult: null,
  eventManifestError: '',
  connectionRemovalBlockers: [],
  profileRemovalBlockersOnDelete: [],
  profileSetupOutcomes: [],
  activeTransfer: null,
};
let recoverySnapshotReads = 0;

function scenarioActiveTransfer() {
  if (smokeScenario === 'live-reattachment') {
    return {
      activeJobId: 'mock-live-upload', intentId: 'live-queue-row', profile: defaultSettings.profile,
      activePid: 4242, pid: 4242, isRunning: true, isLifecycleActive: true,
      phase: 'uploading', mode: 'upload', source: 'C:/Restored/live-queue-row.mov',
    };
  }
  if (smokeScenario === 'cross-profile-live') {
    return {
      activeJobId: 'mock-cross-profile-transfer', intentId: 'cross-profile-row',
      profile: { remote: 'other', bucket: 'other', endpointHost: 'other.sfo3.digitaloceanspaces.com' },
      activePid: 4343, pid: 4343, isRunning: true, isLifecycleActive: true,
      phase: 'uploading', mode: 'upload', source: 'C:/Restored/cross-profile-row.mov',
    };
  }
  if (smokeScenario === 'verifying-no-child') {
    return {
      activeJobId: 'verifying-upload', intentId: 'verifying-row', profile: defaultSettings.profile,
      activePid: 0, pid: 0, isRunning: true, isLifecycleActive: true,
      hasChildProcess: false, phase: 'verifying', mode: 'upload',
    };
  }
  if (smokeScenario === 'active-completes-between-reads' && recoverySnapshotReads <= 1) {
    return {
      activeJobId: 'finishing-upload', intentId: 'finishing-row', profile: defaultSettings.profile,
      activePid: 0, pid: 0, isRunning: true, isLifecycleActive: true,
      hasChildProcess: false, phase: 'verifying', mode: 'upload',
    };
  }
  if (smokeScenario === 'external-releases' && recoverySnapshotReads <= 2) {
    return {
      activeJobId: 'other-owner-upload', intentId: 'other-owner-intent',
      profile: { remote: 'other', bucket: 'other', endpointHost: 'other.sfo3.digitaloceanspaces.com' },
      activePid: 4545, pid: 4545, isRunning: true, isLifecycleActive: true,
      phase: 'uploading', mode: 'upload',
    };
  }
  return { activeJobId: '', intentId: '', activePid: 0, pid: 0, isRunning: false, phase: 'idle' };
}

const durableMockRecords = [];

function scenarioJobRecords() {
  const records = [
    {
      jobId: 'dry-run-interrupted', status: 'dry-run', prefix: 'sample-event/recordings/raw/Main',
      sources: ['C:/Sample Event/interrupted-precheck.mov'],
      startedAt: '2026-07-19T11:00:00.000Z', profile: defaultSettings.profile,
    },
    {
      jobId: 'dry-run-complete', status: 'dry-run', prefix: 'sample-event/recordings/raw/Main',
      sources: ['C:/Sample Event/completed-precheck.mov'],
      startedAt: '2026-07-19T10:20:00.000Z', completedAt: '2026-07-19T10:22:00.000Z',
      profile: defaultSettings.profile,
    },
    {
      jobId: 'upload-stale', status: 'failed', prefix: 'archive-event/recordings/raw/stage1/day2/mix',
      sources: ['C:/Austria Mix/day-2/logs'],
      startedAt: '2026-07-19T09:00:00.000Z', completedAt: '2026-07-19T09:05:00.000Z',
      verification: { verified: [], missing: [{ name: 'logs/out.log' }], sizeMismatch: [], ok: false },
      error: 'network dropped; Authorization: Bearer renderer-secret', profile: defaultSettings.profile,
    },
    {
      jobId: 'upload-notify-warning', status: 'warning', prefix: 'archive-event/recordings/raw/stage1/day2/mix',
      sources: ['C:/Austria Mix/day-2/austria-main - 28 May 2026 - 01-08-26 PM - 00000.mp4'],
      startedAt: '2026-07-19T10:00:00.000Z', completedAt: '2026-07-19T10:10:00.000Z',
      verification: {
        verified: [{ name: 'austria-main - 28 May 2026 - 01-08-26 PM - 00000.mp4' }],
        missing: [], sizeMismatch: [], ok: true,
      },
      checksum: { ok: true, verified: [{ name: 'austria-main - 28 May 2026 - 01-08-26 PM - 00000.mp4' }], mismatched: [] },
      notificationAttempts: [{ type: 'webhook', ok: false, error: 'timeout' }], profile: defaultSettings.profile,
    },
    {
      jobId: 'upload-superseded', status: 'failed', prefix: 'sample-event/recordings/edits/Main',
      sources: ['C:/Sample Event/original-resume.mov'], startedAt: '2026-07-19T08:00:00.000Z',
      completedAt: '2026-07-19T08:05:00.000Z', error: 'network dropped', profile: defaultSettings.profile,
    },
    {
      jobId: 'upload-superseding-complete', resumeFromJobId: 'upload-superseded', status: 'complete',
      prefix: 'sample-event/recordings/edits/Main', sources: ['C:/Sample Event/original-resume.mov'],
      startedAt: '2026-07-19T08:10:00.000Z', completedAt: '2026-07-19T08:20:00.000Z',
      verification: { ok: true, verified: [{ name: 'original-resume.mov' }], missing: [], sizeMismatch: [] },
      checksum: { ok: true }, profile: defaultSettings.profile,
    },
  ];
  if (smokeScenario === 'live-reattachment') records.push({
    jobId: 'mock-live-upload', intentId: 'live-queue-row', status: 'running', prefix: 'restored/live',
    sources: ['C:/Restored/live-queue-row.mov'], profile: defaultSettings.profile,
  });
  if (smokeScenario === 'cross-profile-live') records.push({
    jobId: 'mock-cross-profile-transfer', intentId: 'cross-profile-row', status: 'running',
    prefix: 'restored/cross-profile', sources: ['C:/Restored/cross-profile-row.mov'], profile: defaultSettings.profile,
  });
  if (smokeScenario === 'verifying-no-child') records.push({
    jobId: 'verifying-upload', intentId: 'verifying-row', status: 'running', prefix: 'restored/verifying',
    sources: ['C:/Restored/verifying-row.mov'], profile: defaultSettings.profile,
  });
  if (smokeScenario === 'cancelled-stale') records.push({
    jobId: 'cancelled-upload', intentId: 'cancelled-row', status: 'cancelled', prefix: 'restored/cancelled',
    sources: ['C:/Restored/cancelled-row.mov'], profile: defaultSettings.profile, error: 'Cancelled by user.',
  });
  if (smokeScenario === 'active-completes-between-reads') records.push({
    jobId: 'finishing-upload', intentId: 'finishing-row',
    status: recoverySnapshotReads <= 1 ? 'running' : 'complete', prefix: 'restored/finishing',
    sources: ['C:/Restored/finishing-row.mov'], profile: defaultSettings.profile,
    verification: recoverySnapshotReads <= 1
      ? null
      : { ok: true, verified: [{ name: 'finishing-row.mov', size: 1024 }], missing: [], sizeMismatch: [] },
    urls: recoverySnapshotReads <= 1 ? [] : ['https://example.test/finishing-row.mov'],
  });
  return [...records, ...durableMockRecords];
}

function emitUploadEvent(channel, payload = {}) {
  uploadEventCallback?.(channel, payload);
}

function successfulVerification(source = '') {
  const name = String(source || 'mock.mov').replace(/\\/g, '/').split('/').at(-1);
  return {
    ok: true,
    verified: [{ name, size: 1024 }],
    missing: [],
    sizeMismatch: [],
  };
}

async function runMockPrecheck(request = {}) {
  queueMock.calls.push({
    type: 'precheck',
    prefix: request.prefix,
    sources: request.sources || [],
    intentId: request.intentId || '',
    resumeFromJobId: request.resumeFromJobId || '',
  });
  const credentialScan = inspectUploadSourcesForCredentialLikePaths(request.sources || []);
  if (!credentialScan.ok) {
    const error = new Error(`Blocked credential-like local path: ${credentialScan.blocked[0]?.path || 'unknown path'}`);
    error.blocked = true;
    emitUploadEvent('upload:error', { message: error.message });
    throw error;
  }
  const outcome = queueMock.precheckOutcomes.shift() || { ok: true };
  const jobId = `mock-dryrun-${queueMock.calls.filter((call) => call.type === 'precheck').length}`;
  emitUploadEvent('upload:start', { jobId, mode: 'dry-run' });
  emitUploadEvent('upload:source-start', {
    jobId,
    mode: 'dry-run',
    source: request.sources?.[0] || '',
    sourceIndex: 1,
    sourceTotal: request.sources?.length || 1,
  });
  if (outcome.ok === false) {
    emitUploadEvent('upload:error', { jobId, message: outcome.error || 'Mocked pre-check failure.' });
    const error = new Error(outcome.error || 'Mocked pre-check failure.');
    error.blocked = outcome.blocked === true;
    throw error;
  }
  emitUploadEvent('upload:source-complete', {
    jobId,
    mode: 'dry-run',
    sourceIndex: request.sources?.length || 1,
    sourceTotal: request.sources?.length || 1,
  });
  emitUploadEvent('upload:complete', {
    jobId,
    dryRun: true,
    urls: [],
    verification: null,
    checksum: { ok: true, skipped: true },
    uploadedRoots: [],
  });
  return { ok: true, jobId, dryRun: true, verification: null };
}

async function runMockQueueUpload(requests = []) {
  queueMock.calls.push({
    type: 'upload',
    prefixes: requests.map((request) => request.prefix),
    clientJobIds: requests.map((request) => request.clientJobId),
  });
  const outcome = queueMock.uploadOutcomes.shift() || { ok: true };
  emitUploadEvent('upload:queue-start', { total: requests.length });
  if (outcome.ok === false) {
    const request = requests[0] || {};
    const jobId = 'mock-upload-failed';
    emitUploadEvent('upload:queue-job-start', {
      clientJobId: request.clientJobId,
      index: 1,
      total: requests.length,
      prefix: request.prefix,
    });
    emitUploadEvent('upload:start', { jobId, mode: 'upload' });
    emitUploadEvent('upload:source-start', {
      jobId,
      mode: 'upload',
      source: request.sources?.[0] || '',
      sourceIndex: 1,
      sourceTotal: request.sources?.length || 1,
    });
    const failure = {
      ok: false,
      clientJobId: request.clientJobId || '',
      error: outcome.error || 'Mocked upload failure.',
      results: [],
    };
    emitUploadEvent('upload:error', { jobId, message: failure.error });
    emitUploadEvent('upload:queue-stopped', failure);
    return failure;
  }

  const results = [];
  for (let index = 0; index < requests.length; index += 1) {
    const request = requests[index];
    const jobId = `mock-upload-${queueMock.calls.filter((call) => call.type === 'upload').length}-${index + 1}`;
    const verification = outcome.verificationMismatch
      ? {
        ok: false,
        verified: [],
        missing: [{ name: String(request.sources?.[0] || 'mock.mov').replace(/\\/g, '/').split('/').at(-1) }],
        sizeMismatch: [],
      }
      : successfulVerification(request.sources?.[0]);
    const checksum = { ok: true, skipped: true, verified: [], mismatched: [] };
    const urls = [`https://mock.invalid/${request.prefix}/mock.mov`];
    emitUploadEvent('upload:queue-job-start', {
      clientJobId: request.clientJobId,
      index: index + 1,
      total: requests.length,
      prefix: request.prefix,
    });
    emitUploadEvent('upload:start', { jobId, mode: 'upload' });
    emitUploadEvent('upload:source-start', {
      jobId,
      mode: 'upload',
      source: request.sources?.[0] || '',
      sourceIndex: 1,
      sourceTotal: request.sources?.length || 1,
    });
    emitUploadEvent('upload:progress', {
      jobId,
      mode: 'upload',
      source: request.sources?.[0] || '',
      currentFile: request.sources?.[0] || '',
      sourceIndex: 1,
      sourceTotal: request.sources?.length || 1,
      percent: 100,
      transferred: '1 KiB',
      total: '1 KiB',
      speed: '1 MiB/s',
      eta: '0s',
    });
    emitUploadEvent('upload:source-complete', {
      jobId,
      mode: 'upload',
      sourceIndex: request.sources?.length || 1,
      sourceTotal: request.sources?.length || 1,
    });
    emitUploadEvent('upload:verified', { jobId, verification });
    emitUploadEvent('upload:checksum', { jobId, checksum });
    if (!verification.ok) {
      const failure = {
        ok: false,
        clientJobId: request.clientJobId,
        error: 'Mocked upload verification mismatch.',
        verification,
        checksum,
        results: [],
      };
      emitUploadEvent('upload:error', {
        jobId,
        message: failure.error,
        verification,
        checksum,
      });
      emitUploadEvent('upload:queue-stopped', failure);
      return failure;
    }
    const result = {
      ok: true,
      clientJobId: request.clientJobId,
      jobId,
      urls,
      verification,
      checksum,
      uploadedRoots: [],
    };
    durableMockRecords.push({
      jobId,
      resumeFromJobId: request.resumeFromJobId || '',
      status: 'complete',
      prefix: request.prefix || '',
      sources: clone(request.sources || []),
      startedAt: new Date(Date.now() - 1000).toISOString(),
      completedAt: new Date().toISOString(),
      verification,
      checksum,
      profile: clone(request.profile || defaultSettings.profile),
    });
    emitUploadEvent('upload:complete', {
      ...result,
      dryRun: false,
    });
    emitUploadEvent('upload:queue-job-complete', result);
    results.push(result);
  }
  const complete = { ok: true, results };
  emitUploadEvent('upload:queue-complete', complete);
  return complete;
}

async function runMockDownloadPrecheck(request = {}) {
  const remoteItems = clone(request.remoteItems || []);
  queueMock.calls.push({
    type: 'download-precheck',
    clientJobId: request.clientJobId || '',
    localDestination: request.localDestination || '',
    remoteItems,
  });
  const jobId = `mock-download-check-${queueMock.calls.filter((call) => call.type === 'download-precheck').length}`;
  emitUploadEvent('upload:start', { jobId, mode: 'download-check', direction: 'download' });
  emitUploadEvent('upload:preflight', {
    jobId,
    mode: 'download-check',
    direction: 'download',
    selectedCount: remoteItems.length,
    existingCount: 0,
    pendingCount: remoteItems.length,
    mismatchCount: 0,
  });
  emitUploadEvent('upload:source-start', {
    jobId,
    mode: 'download-check',
    direction: 'download',
    source: remoteItems[0]?.path || '',
    sourceIndex: 1,
    sourceTotal: remoteItems.length || 1,
  });
  emitUploadEvent('upload:source-complete', {
    jobId,
    mode: 'download-check',
    direction: 'download',
    sourceIndex: remoteItems.length || 1,
    sourceTotal: remoteItems.length || 1,
  });
  emitUploadEvent('upload:complete', { jobId, mode: 'download-check', direction: 'download', dryRun: true });
  return { ok: true, jobId, dryRun: true, verification: null };
}

async function runMockQueueDownload(requests = []) {
  queueMock.calls.push({
    type: 'download',
    clientJobIds: requests.map((request) => request.clientJobId),
    localDestinations: requests.map((request) => request.localDestination),
    remoteItems: requests.map((request) => clone(request.remoteItems || [])),
  });
  emitUploadEvent('upload:queue-start', { total: requests.length, direction: 'download' });
  const results = [];
  for (let index = 0; index < requests.length; index += 1) {
    const request = requests[index];
    const remoteItems = clone(request.remoteItems || []);
    const jobId = `mock-download-${index + 1}`;
    const verification = {
      ok: true,
      verified: remoteItems.map((item) => ({ name: item.name, path: item.path, size: item.size || 0 })),
      missing: [],
      sizeMismatch: [],
    };
    emitUploadEvent('upload:queue-job-start', {
      clientJobId: request.clientJobId,
      index: index + 1,
      total: requests.length,
      direction: 'download',
      localDestination: request.localDestination,
    });
    emitUploadEvent('upload:start', { jobId, mode: 'download', direction: 'download' });
    emitUploadEvent('upload:source-start', {
      jobId,
      mode: 'download',
      direction: 'download',
      source: remoteItems[0]?.path || '',
      sourceIndex: 1,
      sourceTotal: remoteItems.length || 1,
    });
    emitUploadEvent('upload:progress', {
      jobId,
      mode: 'download',
      direction: 'download',
      source: remoteItems[0]?.path || '',
      currentFile: remoteItems[0]?.name || '',
      sourceIndex: 1,
      sourceTotal: remoteItems.length || 1,
      percent: 100,
      transferred: '6 KiB',
      total: '6 KiB',
      speed: '2 MiB/s',
      eta: '0s',
    });
    emitUploadEvent('upload:source-complete', {
      jobId,
      mode: 'download',
      direction: 'download',
      sourceIndex: remoteItems.length || 1,
      sourceTotal: remoteItems.length || 1,
    });
    emitUploadEvent('upload:verified', { jobId, direction: 'download', verification });
    const result = {
      ok: true,
      clientJobId: request.clientJobId,
      jobId,
      direction: 'download',
      localDestination: request.localDestination,
      verification,
      urls: [],
    };
    durableMockRecords.push({
      jobId,
      status: 'complete',
      direction: 'download',
      localDestination: request.localDestination,
      sources: remoteItems.map((item) => item.path),
      remoteItems,
      startedAt: new Date(Date.now() - 1000).toISOString(),
      completedAt: new Date().toISOString(),
      verification,
      profile: clone(request.profile || defaultSettings.profile),
    });
    emitUploadEvent('upload:complete', { ...result, dryRun: false });
    emitUploadEvent('upload:queue-job-complete', result);
    results.push(result);
  }
  const complete = { ok: true, direction: 'download', results };
  emitUploadEvent('upload:queue-complete', complete);
  return complete;
}

function genericEventManifest() {
  return {
    client: 'Example Organization',
    eventName: 'sample-event',
    eventPrefix: 'sample-event',
    year: 2026,
    eventNumber: 1,
    remote: 'media',
    bucket: 'media-archive',
    endpointHost: 'media-archive.nyc3.digitaloceanspaces.com',
    recordingsPrefix: 'sample-event/recordings',
    stages: ['Main', 'Talk', 'Workshop'],
    days: ['Day 1', 'Day 2', 'Day 3'],
    localRoots: [],
    uploadDefaults: {
      publicRead: true,
      sizeOnly: true,
    },
  };
}

queueMock.eventManifestResult = {
  ok: true,
  label: 'sample-event.json',
  manifest: genericEventManifest(),
};

contextBridge.exposeInMainWorld('spacesUploader', {
  smokeMode: true,
  connectionIdentityDigest(value) {
    return sha256Hex(value);
  },
  getPathForFile() {
    return '';
  },
  chooseFiles() {
    return Promise.resolve([]);
  },
  chooseFolder() {
    return Promise.resolve([]);
  },
  chooseDownloadFolder() {
    queueMock.calls.push({ type: 'choose-download-folder' });
    return Promise.resolve('C:\\Downloads\\Murdawk Smoke');
  },
  loadSettings() {
    queueMock.calls.push({ type: 'load-settings' });
    return Promise.resolve(clone(queueMock.settings));
  },
  async saveSettings(settings) {
    queueMock.calls.push({
      type: 'save-settings',
      activeConnectionId: settings.activeConnectionId || '',
      connections: clone(settings.connections || []),
      prefix: settings.prefix || '',
      publicRead: settings.publicRead,
      checksum: settings.checksum,
      recentPrefixesByConnection: clone(settings.recentPrefixesByConnection || {}),
      pinnedPrefixes: clone(settings.pinnedPrefixes || []),
      queueJobs: settings.queueJobs?.map((job) => ({
        id: job.id,
        direction: job.direction || 'upload',
        status: job.status,
        jobId: job.jobId || '',
        resumeFromJobId: job.resumeFromJobId || '',
        localDestination: job.localDestination || '',
        remoteItems: clone(job.remoteItems || []),
        error: job.error || '',
      })) || [],
    });
    const outcome = queueMock.saveOutcomes.shift() || { ok: true };
    if (Number(outcome.delayMs) > 0) {
      await new Promise((resolve) => setTimeout(resolve, Number(outcome.delayMs)));
    }
    if (outcome.ok === false) {
      throw new Error(outcome.error || 'Mocked settings persistence failure.');
    }
    queueMock.settings = clone(settings);
    return clone(queueMock.settings);
  },
  async checkSystem(profile = defaultSettings.profile) {
    queueMock.calls.push({ type: 'check-system', profile: clone(profile) });
    const outcome = queueMock.checkSystemOutcomes.shift() || { ok: true };
    if (Number(outcome.delayMs) > 0) {
      await new Promise((resolve) => setTimeout(resolve, Number(outcome.delayMs)));
    }
    if (outcome.ok === false) throw new Error(outcome.error || 'Mocked connection test failure.');
    queueMock.calls.push({ type: 'check-system-complete', profile: clone(profile) });
    return { ok: true, ...clone(profile) };
  },
  activeTransfer() {
    queueMock.calls.push({ type: 'active-transfer' });
    return Promise.resolve(clone(queueMock.activeTransfer || scenarioActiveTransfer()));
  },
  recoverySnapshot() {
    queueMock.calls.push({ type: 'recovery-snapshot' });
    recoverySnapshotReads += 1;
    if (smokeScenario === 'recovery-read-failure') {
      return Promise.reject(new Error('Mocked recovery snapshot read failure.'));
    }
    return Promise.resolve({
      activeTransfer: clone(queueMock.activeTransfer || scenarioActiveTransfer()),
      records: clone(scenarioJobRecords()),
    });
  },
  listJobRecords() {
    const records = summarizeActivityRecords(scenarioJobRecords().map((record) => ({
      ...record,
      hasLog: record.jobId === 'upload-stale',
    })));
    return Promise.resolve(clone(activityRecordsOverride === null ? records : activityRecordsOverride));
  },
  resumeJobRecord(jobId) {
    queueMock.calls.push({ type: 'resume-job-record', jobId });
    const records = scenarioJobRecords();
    if (findSuccessfulResumeSupersessions(records).has(jobId)) {
      return Promise.reject(new Error('Mock activity record was completed by a resumed run.'));
    }
    const record = records.find((item) => item.jobId === jobId);
    if (!record) return Promise.reject(new Error('Mock activity record not found.'));
    return Promise.resolve({
      intentId: `queue-${jobId}`,
      sources: clone(record.sources),
      prefix: record.prefix,
      filterMode: record.filterMode || 'all',
      include: record.include || '',
      checksum: record.checksumMode || 'sha256',
      folderUploadMode: record.folderUploadMode || 'package',
      publicRead: record.publicRead !== false,
      resumeFromJobId: record.jobId,
      profile: clone(record.profile || defaultSettings.profile),
    });
  },
  automationStatus() {
    return Promise.resolve({
      enabled: false,
      url: '',
      error: '',
      credentials: [],
      boundary: 'Local browsing and queueing only. Real uploads and server changes are not exposed.',
    });
  },
  createAutomationKey(request = {}) {
    queueMock.calls.push({ type: 'create-automation-key', request: clone(request) });
    const status = {
      enabled: true,
      url: 'http://127.0.0.1:47819',
      error: '',
      credentials: [{ id: 'smoke-api-key', name: request.name, createdAt: new Date().toISOString(), lastUsedAt: '' }],
      boundary: 'Local browsing and queueing only. Real uploads and server changes are not exposed.',
    };
    automationStatusCallback?.(clone(status));
    return Promise.resolve({ ok: true, token: 'smoke-api-key-value', credential: status.credentials[0], status });
  },
  createMcpConfiguration(request = {}) {
    queueMock.calls.push({ type: 'create-mcp-configuration', request: clone(request) });
    return Promise.resolve({
      ok: true,
      configuration: '{"mcpServers":{"murdawk-uplink":{}}}',
      status: {
        enabled: true,
        url: 'http://127.0.0.1:47819',
        error: '',
        credentials: [{ id: 'smoke-mcp-key', name: request.name, createdAt: new Date().toISOString(), lastUsedAt: '' }],
        boundary: 'Local browsing and queueing only. Real uploads and server changes are not exposed.',
      },
    });
  },
  revokeAutomationKey(request = {}) {
    queueMock.calls.push({ type: 'revoke-automation-key', request: clone(request) });
    return Promise.resolve({ ok: true, status: { enabled: false, url: '', error: '', credentials: [], boundary: '' } });
  },
  setupDigitalOceanProfile(request = {}) {
    queueMock.calls.push({ type: 'setup-profile', request: clone(request) });
    const outcome = queueMock.profileSetupOutcomes.shift();
    if (outcome?.ok === false) return Promise.reject(new Error(outcome.error || 'Mocked profile setup failure.'));
    const setupToken = `smoke-profile-${pendingProfileSetups.size + 1}`;
    pendingProfileSetups.set(setupToken, request.name);
    return Promise.resolve({
      ok: true,
      created: true,
      setupToken,
      profile: { remote: request.name, bucket: request.bucket, endpointHost: request.endpoint },
      summary: `${request.name} -> ${request.bucket}`,
    });
  },
  commitDigitalOceanProfileSetup(request = {}) {
    queueMock.calls.push({ type: 'commit-profile-setup', request: clone(request) });
    if (!pendingProfileSetups.has(request.setupToken)) return Promise.reject(new Error('Unknown profile setup token.'));
    pendingProfileSetups.delete(request.setupToken);
    return Promise.resolve({ ok: true });
  },
  rollbackDigitalOceanProfileSetup(request = {}) {
    queueMock.calls.push({ type: 'rollback-profile-setup', request: clone(request) });
    if (!pendingProfileSetups.has(request.setupToken)) return Promise.reject(new Error('Unknown profile setup token.'));
    pendingProfileSetups.delete(request.setupToken);
    return Promise.resolve({ ok: true, name: request.name });
  },
  removeRcloneProfile(request = {}) {
    queueMock.calls.push({ type: 'remove-profile-request', request: clone(request) });
    if (queueMock.profileRemovalBlockersOnDelete.length) {
      queueMock.connectionRemovalBlockers = clone(queueMock.profileRemovalBlockersOnDelete);
      return Promise.reject(new Error('The rclone profile has unfinished uploads or checks and cannot be removed.'));
    }
    queueMock.calls.push({ type: 'remove-profile', request: clone(request) });
    return Promise.resolve({ ok: true, name: request.name });
  },
  exportConnection(request = {}) {
    queueMock.calls.push({ type: 'export-connection', request: clone(request) });
    return Promise.resolve({ ok: true, encrypted: request.includeKeys === true });
  },
  importConnection() {
    queueMock.calls.push({ type: 'import-connection' });
    if (queueMock.connectionImportError) {
      return Promise.reject(new Error(queueMock.connectionImportError));
    }
    return Promise.resolve(queueMock.connectionImport
      ? { ok: true, encrypted: false, connection: clone(queueMock.connectionImport) }
      : { ok: false, cancelled: true });
  },
  unlockConnectionImport(request = {}) {
    queueMock.calls.push({ type: 'unlock-connection-import', request: { importToken: request.importToken } });
    return Promise.reject(new Error('No encrypted smoke package is configured.'));
  },
  createProfileFromConnectionImport(request = {}) {
    queueMock.calls.push({ type: 'create-import-profile', request: clone(request) });
    return Promise.reject(new Error('No encrypted smoke package is configured.'));
  },
  cancelConnectionImport(request = {}) {
    queueMock.calls.push({ type: 'cancel-connection-import', request: clone(request) });
    return Promise.resolve({ ok: true });
  },
  connectionRemovalBlockers(request = {}) {
    queueMock.calls.push({ type: 'connection-removal-blockers', request: clone(request) });
    return Promise.resolve(clone(queueMock.connectionRemovalBlockers));
  },
  chooseEventManifest() {
    queueMock.calls.push({ type: 'choose-event-manifest' });
    if (queueMock.eventManifestError) return Promise.reject(new Error(queueMock.eventManifestError));
    return Promise.resolve(clone(queueMock.eventManifestResult));
  },
  eventReconcileLocal(request = {}) {
    return Promise.resolve({
      manifest: clone(request.manifest || genericEventManifest()),
      localRecords: [],
      remoteRecords: [],
      reconcile: {
        summary: {
          localCount: 0,
          remoteCount: 0,
          matchedCount: 0,
          missingCount: 0,
          sizeMismatchCount: 0,
          ambiguousCount: 0,
        },
        matched: [],
        missing: [],
        sizeMismatch: [],
        ambiguous: [],
      },
    });
  },
  eventQueueMissingPreview() {
    return Promise.resolve([]);
  },
  listRemote(prefix = '', profile = defaultSettings.profile) {
    queueMock.calls.push({ type: 'list-remote', prefix, profile: clone(profile) });
    return Promise.resolve({
      prefix,
      entries: [
        {
          name: 'logs',
          path: `${prefix}/logs`.replace(/^\/+/, ''),
          type: 'folder',
          isDir: true,
          displaySize: '-',
          modified: '2000-01-01 00:00:00',
        },
        {
          name: 'Long Production Archive Folder',
          path: `${prefix}/Long Production Archive Folder`.replace(/^\/+/, ''),
          type: 'folder',
          isDir: true,
          displaySize: '-',
          modified: '2000-01-01 00:00:00',
        },
        {
          name: 'range-alpha.txt',
          path: `${prefix}/range-alpha.txt`.replace(/^\/+/, ''),
          type: 'file',
          isDir: false,
          displaySize: '1 KB',
          modified: '2026-01-01 00:00:00',
          publicUrl: 'https://media.nyc3.digitaloceanspaces.com/range-alpha.txt',
        },
        {
          name: 'hidden-gap.txt',
          path: `${prefix}/hidden-gap.txt`.replace(/^\/+/, ''),
          type: 'file',
          isDir: false,
          displaySize: '2 KB',
          modified: '2026-01-02 00:00:00',
          publicUrl: 'https://media.nyc3.digitaloceanspaces.com/hidden-gap.txt',
        },
        {
          name: 'range-omega.txt',
          path: `${prefix}/range-omega.txt`.replace(/^\/+/, ''),
          type: 'file',
          isDir: false,
          displaySize: '3 KB',
          modified: '2026-01-03 00:00:00',
          publicUrl: 'https://media.nyc3.digitaloceanspaces.com/range-omega.txt',
        },
        {
          name: 'speaker-card.png',
          path: `${prefix}/speaker-card.png`.replace(/^\/+/, ''),
          type: 'PNG',
          isDir: false,
          size: 2048,
          displaySize: '2 KB',
          modified: '2026-01-04T00:00:00Z',
          publicUrl: 'https://media.nyc3.digitaloceanspaces.com/speaker-card.png',
        },
        {
          name: 'event-mark.avif',
          path: `${prefix}/event-mark.avif`.replace(/^\/+/, ''),
          type: 'AVIF',
          isDir: false,
          size: 4096,
          displaySize: '4 KB',
          modified: '2026-01-05T00:00:00Z',
          publicUrl: 'https://media.nyc3.digitaloceanspaces.com/event-mark.avif',
        },
        {
          name: 'austria-main - 28 May 2026 - 01-08-26 PM - 00000.mp4',
          path: `${prefix}/austria-main - 28 May 2026 - 01-08-26 PM - 00000.mp4`.replace(/^\/+/, ''),
          type: 'file',
          isDir: false,
          displaySize: '544.2 MB',
          modified: '2026-05-28 07:18:27',
          publicUrl: 'https://media.nyc3.digitaloceanspaces.com/example.mp4',
        },
      ],
    });
  },
  preparePreview(request = {}) {
    queueMock.calls.push({ type: 'prepare-preview', item: clone(request.item || {}) });
    return Promise.resolve({
      ok: true,
      cached: true,
      name: request.item?.name || 'preview.png',
      format: String(request.item?.name || '').toLowerCase().endsWith('.avif') ? 'AVIF' : 'PNG',
      size: request.item?.size || 0,
      url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    });
  },
  clearPreviewCache() {
    return Promise.resolve({ ok: true, removedCount: 0 });
  },
  runRemoteOperation(request) {
    queueMock.calls.push({ type: 'remote-operation', request: clone(request || {}) });
    return Promise.resolve({ ok: true });
  },
  runRemoteOperations() {
    return Promise.resolve({ ok: true });
  },
  verifyUpload() {
    return Promise.resolve({ ok: true });
  },
  dryRunUpload(request) {
    return runMockPrecheck(request);
  },
  dryRunDownload(request) {
    return runMockDownloadPrecheck(request);
  },
  startUpload() {
    return Promise.resolve({ ok: true });
  },
  startQueueUpload(requests) {
    return runMockQueueUpload(requests);
  },
  startQueueDownload(requests) {
    return runMockQueueDownload(requests);
  },
  async cancelUpload() {
    queueMock.calls.push({ type: 'cancel' });
    const outcome = queueMock.cancelOutcomes.shift() || { ok: true };
    const eventDelayMs = Math.max(0, Number(outcome.eventDelayMs) || 0);
    const resolveDelayMs = Math.max(eventDelayMs, Number(outcome.resolveDelayMs) || 0);
    if (eventDelayMs) await new Promise((resolve) => setTimeout(resolve, eventDelayMs));
    if (outcome.emitCancelled) {
      emitUploadEvent('upload:cancelled', {
        jobId: outcome.jobId || 'pause-upload',
        intentId: outcome.intentId || 'pause-row',
        message: 'Transfer cancelled by user.',
      });
    }
    if (resolveDelayMs > eventDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, resolveDelayMs - eventDelayMs));
    }
    if (outcome.ok === false) throw new Error(outcome.error || 'Mocked cancellation failure.');
    return { ok: true };
  },
  async pauseUpload(request = {}) {
    queueMock.calls.push({ type: 'pause', ...request });
    const outcome = queueMock.pauseOutcomes.shift() || { ok: true };
    if (Number(outcome.delayMs) > 0) {
      await new Promise((resolve) => setTimeout(resolve, Number(outcome.delayMs)));
    }
    if (outcome.ok === false) {
      throw new Error(outcome.error || 'Mocked paused-record persistence failure.');
    }
    emitUploadEvent('upload:paused', {
      clientJobId: request.clientJobId,
      intentId: request.intentId,
      jobId: request.jobId,
      message: 'Upload paused by user.',
    });
    return { ok: true, ...request };
  },
  acknowledgeQueuePause(acknowledgement = {}) {
    queueMock.calls.push({ type: 'queue-persist-ack', ...acknowledgement });
    return Promise.resolve({ ok: acknowledgement.ok === true });
  },
  copyUrls() {
    return Promise.resolve({ ok: true });
  },
  copyText() {
    return Promise.resolve({ ok: true });
  },
  copyDiagnostics() {
    return Promise.resolve({ ok: true });
  },
  openLogFolder() {
    return Promise.resolve({ ok: true });
  },
  openJobLog(jobId) {
    queueMock.calls.push({ type: 'open-job-log', jobId });
    return Promise.resolve({ ok: jobId === 'upload-stale', message: '' });
  },
  onUploadEvent(callback) {
    uploadEventCallback = callback;
    return () => {
      if (uploadEventCallback === callback) uploadEventCallback = null;
    };
  },
  onBeforePauseClose(callback) {
    beforePauseCloseCallback = callback;
    return () => {
      if (beforePauseCloseCallback === callback) beforePauseCloseCallback = null;
    };
  },
  onAutomationStatus(callback) {
    automationStatusCallback = callback;
    return () => {
      if (automationStatusCallback === callback) automationStatusCallback = null;
    };
  },
  onAutomationQueueUpdated(callback) {
    automationQueueUpdatedCallback = callback;
    return () => {
      if (automationQueueUpdatedCallback === callback) automationQueueUpdatedCallback = null;
    };
  },
  triggerBeforePauseClose(payload = {}) {
    return Promise.resolve(beforePauseCloseCallback?.(payload));
  },
  configureQueueMock({
    precheckOutcomes = [], uploadOutcomes = [], pauseOutcomes = [], cancelOutcomes = [],
    saveOutcomes = [], checkSystemOutcomes = [], profileSetupOutcomes = [], connectionImport = null, connectionImportError = '',
    eventManifestResult = undefined, eventManifestError = undefined,
    connectionRemovalBlockers = [], profileRemovalBlockersOnDelete = [], resetCalls = true,
  } = {}) {
    queueMock.precheckOutcomes = clone(precheckOutcomes);
    queueMock.uploadOutcomes = clone(uploadOutcomes);
    queueMock.pauseOutcomes = clone(pauseOutcomes);
    queueMock.cancelOutcomes = clone(cancelOutcomes);
    queueMock.saveOutcomes = clone(saveOutcomes);
    queueMock.checkSystemOutcomes = clone(checkSystemOutcomes);
    queueMock.profileSetupOutcomes = clone(profileSetupOutcomes);
    queueMock.connectionImport = connectionImport === null ? null : clone(connectionImport);
    queueMock.connectionImportError = String(connectionImportError || '');
    if (eventManifestResult !== undefined) {
      queueMock.eventManifestResult = clone(eventManifestResult);
    }
    if (eventManifestError !== undefined) {
      queueMock.eventManifestError = String(eventManifestError || '');
    }
    queueMock.connectionRemovalBlockers = clone(connectionRemovalBlockers);
    queueMock.profileRemovalBlockersOnDelete = clone(profileRemovalBlockersOnDelete);
    if (resetCalls) queueMock.calls = [];
    return true;
  },
  queueMockSnapshot() {
    return clone({ calls: queueMock.calls, settings: queueMock.settings });
  },
  setActivityRecordsMock(records = null) {
    activityRecordsOverride = records === null ? null : clone(records);
    return true;
  },
  setActiveTransferMock(transfer = {}) {
    queueMock.activeTransfer = clone(transfer);
    return true;
  },
});
