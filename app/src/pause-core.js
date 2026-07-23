(function attachPauseCore(root, factory) {
  const core = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = core;
  }
  if (root && !root.pauseCore) {
    root.pauseCore = core;
  }
})(typeof window !== 'undefined' ? window : undefined, function createPauseCore() {
  const PAUSABLE_PHASES = new Set(['prechecking', 'uploading']);

  function canonicalIntent(value = {}) {
    return String(value.intentId || value.clientJobId || value.id || '').trim();
  }

  function pauseAssociation(activeTransfer = {}, activeJob = {}) {
    return {
      clientJobId: String(activeJob.id || activeJob.clientJobId || '').trim(),
      intentId: canonicalIntent(activeTransfer) || canonicalIntent(activeJob),
      jobId: String(activeTransfer.activeJobId || activeTransfer.jobId || '').trim(),
    };
  }

  function pauseEligibility({ activeTransfer = {}, activeJob = null, externalLifecycle = false } = {}) {
    const phase = String(activeTransfer.phase || '').trim().toLowerCase();
    if (!activeTransfer.isRunning || !activeTransfer.isLifecycleActive) {
      return { enabled: false, reason: 'No active upload in this window can be paused.', association: null };
    }
    if (externalLifecycle || !activeJob || canonicalIntent(activeJob) !== canonicalIntent(activeTransfer)) {
      return { enabled: false, reason: 'This upload belongs to another window and cannot be paused here.', association: null };
    }
    if (phase === 'verifying') {
      return { enabled: false, reason: 'Verification is finishing. Keep the app open until it completes.', association: null };
    }
    if (!PAUSABLE_PHASES.has(phase)) {
      return { enabled: false, reason: 'The upload is finishing and cannot be paused safely.', association: null };
    }
    if (!['prechecking', 'uploading'].includes(activeJob.status)) {
      return { enabled: false, reason: 'Pause is already in progress or this row is not pausable.', association: null };
    }
    const association = pauseAssociation(activeTransfer, activeJob);
    if (!association.intentId || !association.jobId || !association.clientJobId) {
      return { enabled: false, reason: 'The active upload association is not ready yet.', association: null };
    }
    return { enabled: true, reason: 'Pause active transfer', association };
  }

  function cancelEligibility({ isRunning = false, activeTransfer = {}, activeJob = null } = {}) {
    if (!isRunning) return { enabled: false, reason: 'No active upload can be cancelled.' };
    const terminalAction = String(activeTransfer.terminalAction || '');
    const pauseOwnsTerminalization = terminalAction.startsWith('pause')
      || activeTransfer.pausePending
      || activeTransfer.pauseRequested
      || activeTransfer.phase === 'pausing'
      || activeJob?.status === 'pausing';
    if (pauseOwnsTerminalization) {
      return { enabled: false, reason: 'Pause is being finalized; cancellation is unavailable.' };
    }
    if (terminalAction.startsWith('cancel')) {
      return { enabled: false, reason: 'Cancellation is already being finalized.' };
    }
    return { enabled: true, reason: 'Cancel upload' };
  }

  function pauseError(message = 'Upload paused by user.') {
    const error = new Error(message);
    error.paused = true;
    error.terminalPersisted = true;
    return error;
  }

  class PauseLifecycle {
    constructor() {
      this.pendingByJobId = new Map();
      this.pausedByJobId = new Map();
    }

    isPending(jobId) {
      return this.pendingByJobId.has(jobId);
    }

    assertProcessStartAllowed() {
      if (!this.pendingByJobId.size && !this.pausedByJobId.size) return true;
      const error = new Error('A transfer pause is still being finalized.');
      error.code = 'EPAUSEPENDING';
      throw error;
    }

    requestLifecyclePause({
      transferLifecycle,
      association = {},
      message = 'Upload paused by user.',
      persistPaused,
      getActiveProcess,
      getActiveJobId,
      onTerminate = () => {},
    }) {
      const jobId = String(association.jobId || '').trim();
      const existing = this.pendingByJobId.get(jobId);
      if (existing) return existing.promise;

      const active = transferLifecycle.snapshot();
      if (!active.isActive) {
        const error = new Error('There is no active transfer lifecycle to pause.');
        error.code = 'ETRANSFERIDLE';
        return Promise.reject(error);
      }
      if (
        !jobId
        || active.jobId !== jobId
        || !association.intentId
        || active.intentId !== association.intentId
      ) {
        const error = new Error('The pause request does not own the active transfer lifecycle.');
        error.code = 'ETRANSFEROWNER';
        return Promise.reject(error);
      }
      const terminalClaimError = transferLifecycle.terminalActionClaimError(jobId, 'pause');
      if (terminalClaimError) return Promise.reject(terminalClaimError);
      if (!PAUSABLE_PHASES.has(active.phase)) {
        const error = new Error(`Transfer phase ${active.phase} cannot be paused safely.`);
        error.code = 'ETRANSFERPHASE';
        return Promise.reject(error);
      }
      if (!transferLifecycle.requestPausePending(jobId, message)) {
        const error = transferLifecycle.terminalActionClaimError(jobId, 'pause')
          || new Error('The requested transfer lifecycle is not active.');
        error.code ||= 'ETRANSFERIDLE';
        return Promise.reject(error);
      }

      const state = {};
      const promise = Promise.resolve().then(async () => {
        try {
          await persistPaused();
          transferLifecycle.commitPause(jobId, message);
          this.pausedByJobId.set(jobId, message);
          const activeProcess = getActiveProcess();
          if (activeProcess && getActiveJobId() === jobId) {
            activeProcess.kill();
            onTerminate(activeProcess);
          }
          return { ok: true, ...association };
        } catch (error) {
          transferLifecycle.rollbackPause(jobId);
          throw error;
        } finally {
          if (this.pendingByJobId.get(jobId) === state) {
            this.pendingByJobId.delete(jobId);
          }
        }
      });
      state.promise = promise;
      this.pendingByJobId.set(jobId, state);
      return promise;
    }

    async waitForPending(jobId) {
      const state = this.pendingByJobId.get(jobId);
      if (!state) return;
      try {
        await state.promise;
      } catch {
        // The pause requester reports persistence failures. Transfer execution resumes normally.
      }
    }

    takePauseMarker(jobId) {
      const message = this.pausedByJobId.get(jobId) || '';
      if (message) this.pausedByJobId.delete(jobId);
      return message;
    }

    async lifecyclePauseError({ transferLifecycle, jobId }) {
      await this.waitForPending(jobId);
      const marker = this.takePauseMarker(jobId);
      const active = transferLifecycle.snapshot();
      if (marker || (active.isActive && active.jobId === jobId && active.pauseRequested)) {
        return pauseError(active.pauseMessage || marker);
      }
      return null;
    }

    async waitForLifecycleContinuation({ transferLifecycle, jobId }) {
      const error = await this.lifecyclePauseError({ transferLifecycle, jobId });
      if (error) throw error;
      return true;
    }

    async classifyChildResult(jobId, result = {}) {
      await this.waitForPending(jobId);
      const message = this.takePauseMarker(jobId);
      return message
        ? { ...result, paused: true, message }
        : { ...result, paused: false };
    }
  }

  return {
    PAUSABLE_PHASES,
    PauseLifecycle,
    cancelEligibility,
    canonicalIntent,
    pauseAssociation,
    pauseEligibility,
  };
});
