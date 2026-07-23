class CancellationLifecycle {
  constructor() {
    this.pendingByJobId = new Map();
    this.cancelledByJobId = new Map();
  }

  isPending(jobId) {
    return this.pendingByJobId.has(jobId);
  }

  assertProcessStartAllowed() {
    if (!this.pendingByJobId.size && !this.cancelledByJobId.size) return true;
    const error = new Error('A transfer cancellation is still being finalized.');
    error.code = 'ECANCELLATIONPENDING';
    throw error;
  }

  requestCancellation({
    jobId,
    message,
    persistCancellation,
    getActiveProcess,
    getActiveJobId,
    onTerminate = () => {},
    onPersisted = () => {},
    onPersistenceFailure = () => {},
  }) {
    const existing = this.pendingByJobId.get(jobId);
    if (existing) return existing.promise;

    let resolveRequest;
    let rejectRequest;
    const promise = new Promise((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    });
    const state = { promise };
    this.pendingByJobId.set(jobId, state);
    const persistAndPromote = (async () => {
      try {
        await persistCancellation();
        onPersisted();
        this.cancelledByJobId.set(jobId, message);
        const activeProcess = getActiveProcess();
        if (activeProcess && getActiveJobId() === jobId) {
          activeProcess.kill();
          onTerminate(activeProcess);
        }
        return { ok: true, jobId };
      } catch (error) {
        onPersistenceFailure(error);
        throw error;
      } finally {
        if (this.pendingByJobId.get(jobId) === state) {
          this.pendingByJobId.delete(jobId);
        }
      }
    })();
    persistAndPromote.then(resolveRequest, rejectRequest);
    return promise;
  }

  requestLifecycleCancellation({ transferLifecycle, ...request }) {
    const { jobId, message } = request;
    if (!transferLifecycle.requestCancelPending(jobId, message)) {
      const error = transferLifecycle.terminalActionClaimError(jobId, 'cancellation')
        || new Error('The requested transfer lifecycle is not active.');
      error.code ||= 'ETRANSFERIDLE';
      return Promise.reject(error);
    }
    try {
      return this.requestCancellation({
        ...request,
        onPersisted: () => transferLifecycle.commitCancel(jobId, message),
        onPersistenceFailure: () => transferLifecycle.rollbackCancel(jobId),
      });
    } catch (error) {
      transferLifecycle.rollbackCancel(jobId);
      throw error;
    }
  }

  async waitForLifecycleContinuation({ transferLifecycle, jobId }) {
    const error = await this.lifecycleCancellationError({ transferLifecycle, jobId });
    if (error) throw error;
    return true;
  }

  async lifecycleCancellationError({ transferLifecycle, jobId }) {
    await this.waitForPending(jobId);
    const marker = this.takeCancellationMarker(jobId);
    const lifecycle = transferLifecycle.snapshot();
    if (marker || (lifecycle.isActive && lifecycle.jobId === jobId && lifecycle.cancelRequested)) {
      const error = new Error(lifecycle.cancelMessage || marker || 'Upload cancelled.');
      error.cancelled = true;
      return error;
    }
    return null;
  }

  async waitForPending(jobId) {
    const state = this.pendingByJobId.get(jobId);
    if (!state) return;
    try {
      await state.promise;
    } catch {
      // The cancellation requester reports persistence failures. Child classification resumes normally.
    }
  }

  takeCancellationMarker(jobId) {
    if (!jobId) return '';
    const message = this.cancelledByJobId.get(jobId) || '';
    if (message) this.cancelledByJobId.delete(jobId);
    return message;
  }

  async classifyChildResult(jobId, result = {}) {
    await this.waitForPending(jobId);
    const message = this.takeCancellationMarker(jobId);
    return message
      ? { ...result, cancelled: true, message }
      : { ...result, cancelled: false };
  }
}

module.exports = { CancellationLifecycle };
