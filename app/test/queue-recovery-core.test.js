const assert = require('node:assert/strict');
const test = require('node:test');

const {
  INTERRUPTED_JOB_ERROR,
  canonicalQueueIntent,
  createResumeSourceClaims,
  finishPause,
  queueClaimsResumeSource,
  recoverPersistedJob,
  requestPause,
  resumeCandidate,
} = require('../src/queue-recovery-core');

const PROFILE_A = {
  remote: 'event-a',
  bucket: 'archive',
  endpointHost: 'a.example.test',
};

test('canonical queue intent prefers modern aliases before the renderer row id', () => {
  assert.equal(canonicalQueueIntent({ id: 'row-id', intentId: 'intent-id', clientJobId: 'client-id' }), 'intent-id');
  assert.equal(canonicalQueueIntent({ id: 'row-id', clientJobId: 'client-id' }), 'client-id');
  assert.equal(canonicalQueueIntent({ id: 'row-id' }), 'row-id');
  assert.equal(canonicalQueueIntent(null), '');
});

test('resume source claims reject rapid duplicate activation and support truthful rollback', () => {
  const claims = createResumeSourceClaims();

  assert.equal(claims.claim('durable-run-1'), true);
  assert.equal(claims.claim('durable-run-1'), false);
  assert.equal(claims.has('durable-run-1'), true);
  assert.equal(claims.release('other-run'), false);
  assert.equal(claims.has('durable-run-1'), true);
  assert.equal(claims.release('durable-run-1'), true);
  assert.equal(claims.has('durable-run-1'), false);
  assert.equal(claims.claim('durable-run-1'), true);
});

test('queued or active resume work owns its durable source until terminal release', () => {
  const sourceJobId = 'durable-run-1';
  const activeStatuses = ['queued', 'needs-resume-check', 'ready', 'prechecking', 'uploading', 'verifying', 'pausing', 'paused', 'cancelled'];

  for (const status of activeStatuses) {
    assert.equal(queueClaimsResumeSource([
      queueJob(status, { resumeFromJobId: sourceJobId }),
    ], sourceJobId), true, status);
  }
  for (const status of ['complete', 'failed']) {
    assert.equal(queueClaimsResumeSource([
      queueJob(status, { resumeFromJobId: sourceJobId }),
    ], sourceJobId), false, status);
  }
  assert.equal(queueClaimsResumeSource([
    queueJob('uploading', { resumeFromJobId: 'different-run' }),
  ], sourceJobId), false);
});

function queueJob(status, overrides = {}) {
  const job = {
    id: 'intent-1',
    intentId: 'intent-1',
    sources: ['C:/Event/camera.mov'],
    profile: PROFILE_A,
    prefix: 'event/recordings/raw/Main/Cameras',
    filterMode: 'all',
    folderUploadMode: 'package',
    publicRead: true,
    status,
    jobId: 'upload-1',
    resumeFromJobId: 'upload-previous',
    error: 'transient failure',
    ...overrides,
  };
  return {
    ...job,
    persistable: { ...job },
  };
}

function activeTransfer(overrides = {}) {
  return {
    isRunning: true,
    activeJobId: 'upload-1',
    intentId: 'intent-1',
    profile: PROFILE_A,
    ...overrides,
  };
}

test('orphaned persisted active work becomes a resume check with a clear interrupted error', () => {
  for (const status of ['prechecking', 'uploading', 'verifying']) {
    const recovered = recoverPersistedJob(queueJob(status), null);

    assert.equal(recovered.status, 'needs-resume-check', status);
    assert.equal(recovered.error, INTERRUPTED_JOB_ERROR, status);
    assert.equal(recovered.persistable.status, 'needs-resume-check', status);
    assert.equal(recovered.persistable.error, INTERRUPTED_JOB_ERROR, status);
  }
});

test('orphaned pausing work settles to paused without becoming automatic work', () => {
  const recovered = recoverPersistedJob(queueJob('pausing'), null);

  assert.equal(recovered.status, 'paused');
  assert.equal(recovered.error, '');
  assert.equal(recovered.persistable.status, 'paused');
  assert.equal(recovered.persistable.error, '');
});

test('genuinely active work keeps its persisted in-flight status', () => {
  for (const status of ['prechecking', 'uploading', 'verifying', 'pausing']) {
    const recovered = recoverPersistedJob(queueJob(status), activeTransfer());

    assert.equal(recovered.status, status);
    assert.equal(recovered.jobId, 'upload-1');
  }
});

test('modern live identity ignores a stale dry-run job id and adopts the active upload id', () => {
  const recovered = recoverPersistedJob(
    queueJob('uploading', { jobId: 'dryrun-a' }),
    activeTransfer({ activeJobId: 'upload-b' }),
  );

  assert.equal(recovered.status, 'uploading');
  assert.equal(recovered.jobId, 'upload-b');
  assert.equal(recovered.persistable.jobId, 'upload-b');
});

test('client job alias is canonical when the renderer row id differs', () => {
  const recovered = recoverPersistedJob(
    queueJob('uploading', { id: 'renderer-row', intentId: '', clientJobId: 'client-intent', jobId: 'dryrun-a' }),
    activeTransfer({ activeJobId: 'upload-b', intentId: 'client-intent' }),
  );

  assert.equal(recovered.status, 'uploading');
  assert.equal(recovered.jobId, 'upload-b');
});

test('live attachment requires every available job intent and frozen profile identity', () => {
  const mismatches = [
    activeTransfer({ intentId: 'intent-other' }),
    activeTransfer({
      profile: { remote: 'event-b', bucket: 'archive', endpointHost: 'b.example.test' },
    }),
    activeTransfer({ isRunning: false }),
  ];

  for (const active of mismatches) {
    const recovered = recoverPersistedJob(queueJob('uploading'), active);
    assert.equal(recovered.status, 'needs-resume-check');
    assert.equal(recovered.error, INTERRUPTED_JOB_ERROR);
  }
});

test('same job id cannot override a conflicting modern intent', () => {
  const recovered = recoverPersistedJob(
    queueJob('uploading'),
    activeTransfer({ intentId: 'intent-other' }),
  );

  assert.equal(recovered.status, 'needs-resume-check');
});

test('active association can use an exact legacy job id when newer identity fields are unavailable', () => {
  const recovered = recoverPersistedJob(
    queueJob('uploading', { intentId: undefined }),
    activeTransfer({ intentId: '' }),
  );

  assert.equal(recovered.status, 'uploading');
});

test('legacy association rejects a different job id', () => {
  const recovered = recoverPersistedJob(
    queueJob('uploading', { intentId: undefined }),
    activeTransfer({ activeJobId: 'upload-other', intentId: '' }),
  );

  assert.equal(recovered.status, 'needs-resume-check');
});

test('legacy association rejects a conflicting frozen profile', () => {
  const recovered = recoverPersistedJob(
    queueJob('uploading', { intentId: undefined }),
    activeTransfer({
      intentId: '',
      profile: { remote: 'event-b', bucket: 'archive', endpointHost: 'b.example.test' },
    }),
  );

  assert.equal(recovered.status, 'needs-resume-check');
});

test('pause transitions are explicit and conservative', () => {
  for (const status of ['prechecking', 'uploading']) {
    const pausing = requestPause(queueJob(status));
    const paused = finishPause(pausing);

    assert.equal(pausing.status, 'pausing', status);
    assert.equal(pausing.persistable.status, 'pausing', status);
    assert.equal(paused.status, 'paused', status);
    assert.equal(paused.persistable.status, 'paused', status);
  }
  assert.deepEqual(requestPause(queueJob('queued')), queueJob('queued'));
  assert.deepEqual(requestPause(queueJob('verifying')), queueJob('verifying'));
  assert.deepEqual(finishPause(queueJob('failed')), queueJob('failed'));
});

test('explicit resume creates a queued safe check while preserving frozen intent and provenance', () => {
  for (const status of ['paused', 'cancelled', 'failed', 'needs-resume-check', 'blocked']) {
    const candidate = queueJob(status);
    const resumed = resumeCandidate(candidate);

    assert.equal(resumed.status, 'queued', status);
    assert.equal(resumed.error, '', status);
    assert.equal(resumed.id, candidate.id, status);
    assert.equal(resumed.intentId, candidate.intentId, status);
    assert.equal(resumed.jobId, '', status);
    assert.deepEqual(resumed.profile, candidate.profile, status);
    assert.equal(resumed.prefix, candidate.prefix, status);
    assert.deepEqual(resumed.sources, candidate.sources, status);
    assert.equal(resumed.resumeFromJobId, 'upload-previous', status);
    assert.equal(resumed.persistable.status, 'queued', status);
    assert.equal(resumed.persistable.error, '', status);
  }
});

test('resume candidate records the latest durable job when no earlier provenance exists', () => {
  const resumed = resumeCandidate(queueJob('failed', { resumeFromJobId: '' }));

  assert.equal(resumed.resumeFromJobId, 'upload-1');
  assert.equal(resumed.persistable.resumeFromJobId, 'upload-1');
});

test('terminal complete and unknown states remain unchanged', () => {
  const complete = queueJob('complete');
  const unknown = queueJob('future-state');

  assert.deepEqual(recoverPersistedJob(complete, null), complete);
  assert.deepEqual(resumeCandidate(complete), complete);
  assert.deepEqual(recoverPersistedJob(unknown, null), unknown);
  assert.deepEqual(requestPause(unknown), unknown);
  assert.deepEqual(finishPause(unknown), unknown);
  assert.deepEqual(resumeCandidate(unknown), unknown);
});
