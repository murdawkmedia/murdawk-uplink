(function attachQueueRecoveryCore(root, factory) {
  const connectionCore = root?.connectionCore
    || (typeof require === 'function' ? require('./connection-core') : null);
  const core = factory(connectionCore);
  if (typeof module === 'object' && module.exports) {
    module.exports = core;
  }
  if (root && !root.queueRecoveryCore) {
    root.queueRecoveryCore = core;
  }
})(typeof window !== 'undefined' ? window : undefined, function createQueueRecoveryCore(connectionCore) {
  const IN_FLIGHT_STATUSES = new Set(['prechecking', 'uploading', 'verifying', 'pausing']);
  const RESUMABLE_STATUSES = new Set([
    'paused',
    'cancelled',
    'failed',
    'needs-resume-check',
    'blocked',
  ]);
  const INTERRUPTED_JOB_ERROR = 'Transfer was interrupted. Check remote files before resuming.';

  function canonicalQueueIntent(job) {
    return String(job?.intentId || job?.clientJobId || job?.id || '').trim();
  }

  function profileIdentity(profile) {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return '';
    const normalized = connectionCore.normalizeConnectionProfile(profile);
    return normalized.remote && normalized.bucket && normalized.endpointHost
      ? connectionCore.canonicalConnectionTuple(normalized)
      : '';
  }

  function transition(job, patch) {
    if (!job || typeof job !== 'object' || Array.isArray(job)) return job;
    const next = { ...job, ...patch };
    if (job.persistable && typeof job.persistable === 'object' && !Array.isArray(job.persistable)) {
      next.persistable = {
        ...job.persistable,
        ...patch,
        persistable: undefined,
      };
    }
    return next;
  }

  function normalizeActiveTransfer(activeJobId) {
    if (typeof activeJobId === 'string') {
      return {
        isRunning: Boolean(activeJobId),
        activeJobId,
        intentId: '',
        profile: null,
        legacyReference: true,
      };
    }
    if (!activeJobId || typeof activeJobId !== 'object' || Array.isArray(activeJobId)) return null;
    return {
      isRunning: activeJobId.isRunning === true,
      activeJobId: String(activeJobId.activeJobId || activeJobId.jobId || '').trim(),
      intentId: String(activeJobId.intentId || activeJobId.clientJobId || '').trim(),
      profile: activeJobId.profile || activeJobId.tuning || null,
      legacyReference: false,
    };
  }

  function activeTransferMatchesJob(job, activeJobId) {
    const active = normalizeActiveTransfer(activeJobId);
    if (!active?.isRunning) return false;

    const jobId = String(job?.jobId || '').trim();
    const explicitJobIntent = String(job?.intentId || job?.clientJobId || '').trim();
    const queueIntent = canonicalQueueIntent(job);
    const jobProfile = profileIdentity(job?.profile);
    const activeProfile = profileIdentity(active.profile);

    if (active.intentId || explicitJobIntent) {
      return Boolean(
        active.intentId
        && queueIntent
        && active.intentId === queueIntent
        && jobProfile
        && activeProfile
        && jobProfile === activeProfile,
      );
    }

    if (!jobId || !active.activeJobId || jobId !== active.activeJobId) return false;
    if (active.legacyReference) return true;
    return Boolean(jobProfile && activeProfile && jobProfile === activeProfile);
  }

  function recoverPersistedJob(job, activeJobId) {
    if (!IN_FLIGHT_STATUSES.has(job?.status)) return job;
    if (activeTransferMatchesJob(job, activeJobId)) {
      const active = normalizeActiveTransfer(activeJobId);
      return active?.activeJobId && job.jobId !== active.activeJobId
        ? transition(job, { jobId: active.activeJobId })
        : job;
    }
    if (job.status === 'pausing') {
      return transition(job, { status: 'paused', error: '' });
    }
    return transition(job, {
      status: 'needs-resume-check',
      error: INTERRUPTED_JOB_ERROR,
    });
  }

  function requestPause(job) {
    return ['prechecking', 'uploading'].includes(job?.status)
      ? transition(job, { status: 'pausing' })
      : job;
  }

  function finishPause(job) {
    return job?.status === 'pausing' ? transition(job, { status: 'paused' }) : job;
  }

  function resumeCandidate(job) {
    if (!RESUMABLE_STATUSES.has(job?.status)) return job;
    return transition(job, {
      status: 'queued',
      jobId: '',
      resumeFromJobId: job.resumeFromJobId || job.jobId || '',
      error: '',
    });
  }

  function createResumeSourceClaims() {
    const claimed = new Set();
    const normalize = (jobId) => String(jobId || '').trim();
    return {
      claim(jobId) {
        const id = normalize(jobId);
        if (!id || claimed.has(id)) return false;
        claimed.add(id);
        return true;
      },
      has(jobId) {
        const id = normalize(jobId);
        return Boolean(id && claimed.has(id));
      },
      release(jobId) {
        const id = normalize(jobId);
        return Boolean(id && claimed.delete(id));
      },
    };
  }

  function queueClaimsResumeSource(queueJobs, sourceJobId) {
    const source = String(sourceJobId || '').trim();
    if (!source || !Array.isArray(queueJobs)) return false;
    return queueJobs.some((job) => (
      String(job?.resumeFromJobId || '').trim() === source
      && !['complete', 'failed'].includes(job?.status)
    ));
  }

  return {
    INTERRUPTED_JOB_ERROR,
    activeTransferMatchesJob,
    canonicalQueueIntent,
    createResumeSourceClaims,
    finishPause,
    recoverPersistedJob,
    requestPause,
    resumeCandidate,
    queueClaimsResumeSource,
  };
});
