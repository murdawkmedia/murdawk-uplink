class TransferLifecycle {
  constructor() {
    this.active = null;
    this.phaseBeforeTerminalAction = '';
    this.idleWaiters = new Map();
  }

  begin({ jobId, intentId = '', profile = null, phase = 'prechecking' } = {}) {
    if (this.active) {
      const error = new Error(`Transfer lifecycle ${this.active.jobId} is already active.`);
      error.code = 'ETRANSFERACTIVE';
      throw error;
    }
    if (!jobId) throw new Error('A transfer lifecycle requires a job id.');
    this.active = {
      jobId,
      intentId,
      profile,
      phase,
      terminalAction: '',
      cancelPending: false,
      cancelRequested: false,
      cancelMessage: '',
      pausePending: false,
      pauseRequested: false,
      pauseMessage: '',
    };
    return this.snapshot();
  }

  update(jobId, patch = {}) {
    if (!this.active || this.active.jobId !== jobId) return false;
    this.active = { ...this.active, ...patch, jobId: this.active.jobId };
    return true;
  }

  requestCancel(jobId, message = 'Upload cancelled.') {
    if (!this.active || this.active.jobId !== jobId) return false;
    if (this.active.terminalAction && this.active.terminalAction !== 'cancel-pending') return false;
    this.phaseBeforeTerminalAction = '';
    return this.update(jobId, {
      phase: 'cancelling',
      terminalAction: 'cancelled',
      cancelPending: false,
      cancelRequested: true,
      cancelMessage: message,
    });
  }

  requestCancelPending(jobId, message = 'Upload cancelled.') {
    if (!this.active || this.active.jobId !== jobId) return false;
    if (this.active.terminalAction === 'cancel-pending') return true;
    if (this.active.terminalAction) return false;
    this.phaseBeforeTerminalAction = this.active.phase;
    return this.update(jobId, {
      phase: 'cancelling',
      terminalAction: 'cancel-pending',
      cancelPending: true,
      cancelMessage: message,
    });
  }

  commitCancel(jobId, message = 'Upload cancelled.') {
    return this.requestCancel(jobId, message);
  }

  rollbackCancel(jobId) {
    if (!this.active || this.active.jobId !== jobId || this.active.terminalAction !== 'cancel-pending') return false;
    const phase = this.phaseBeforeTerminalAction || 'prechecking';
    this.phaseBeforeTerminalAction = '';
    return this.update(jobId, {
      phase,
      terminalAction: '',
      cancelPending: false,
      cancelRequested: false,
      cancelMessage: '',
    });
  }

  requestPausePending(jobId, message = 'Upload paused by user.') {
    if (!this.active || this.active.jobId !== jobId) return false;
    if (this.active.terminalAction === 'pause-pending') return true;
    if (this.active.terminalAction) return false;
    this.phaseBeforeTerminalAction = this.active.phase;
    return this.update(jobId, {
      phase: 'pausing',
      terminalAction: 'pause-pending',
      pausePending: true,
      pauseMessage: message,
    });
  }

  commitPause(jobId, message = 'Upload paused by user.') {
    if (!this.active || this.active.jobId !== jobId || this.active.terminalAction !== 'pause-pending') return false;
    this.phaseBeforeTerminalAction = '';
    return this.update(jobId, {
      phase: 'pausing',
      terminalAction: 'paused',
      pausePending: false,
      pauseRequested: true,
      pauseMessage: message,
    });
  }

  rollbackPause(jobId) {
    if (!this.active || this.active.jobId !== jobId || this.active.terminalAction !== 'pause-pending') return false;
    const phase = this.phaseBeforeTerminalAction || 'prechecking';
    this.phaseBeforeTerminalAction = '';
    return this.update(jobId, {
      phase,
      terminalAction: '',
      pausePending: false,
      pauseRequested: false,
      pauseMessage: '',
    });
  }

  finish(jobId) {
    if (!this.active || this.active.jobId !== jobId) return false;
    this.active = null;
    this.phaseBeforeTerminalAction = '';
    const waiters = this.idleWaiters.get(jobId) || [];
    this.idleWaiters.delete(jobId);
    for (const resolve of waiters) resolve(true);
    return true;
  }

  waitForIdle(jobId) {
    if (!this.active || this.active.jobId !== jobId) return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiters = this.idleWaiters.get(jobId) || [];
      waiters.push(resolve);
      this.idleWaiters.set(jobId, waiters);
    });
  }

  terminalActionClaimError(jobId, requestedAction) {
    if (!this.active || this.active.jobId !== jobId || !this.active.terminalAction) return null;
    const owner = this.active.terminalAction.startsWith('pause') ? 'pause' : 'cancellation';
    const error = new Error(`Transfer terminalization is already claimed by ${owner}.`);
    error.code = 'ETRANSFERTERMINALCLAIM';
    error.terminalAction = this.active.terminalAction;
    error.requestedAction = requestedAction;
    return error;
  }

  snapshot() {
    if (!this.active) {
      return {
        isActive: false,
        jobId: '',
        intentId: '',
        profile: null,
        phase: 'idle',
        terminalAction: '',
        cancelPending: false,
        cancelRequested: false,
        cancelMessage: '',
        pausePending: false,
        pauseRequested: false,
        pauseMessage: '',
      };
    }
    return { isActive: true, ...this.active };
  }
}

async function runDurableLifecycle({
  persistInitial,
  begin,
  prepare,
  execute,
  persistTerminal,
  finish,
  cancellationError = () => null,
} = {}) {
  await persistInitial();
  let active = false;
  try {
    begin();
    active = true;
    const prepared = await prepare();
    const cancelled = await cancellationError();
    if (cancelled) throw cancelled;
    const result = await execute(prepared);
    const cancelledAfterExecution = await cancellationError();
    if (cancelledAfterExecution) throw cancelledAfterExecution;
    return result;
  } catch (error) {
    const settledCancellation = await cancellationError();
    if (settledCancellation) error = settledCancellation;
    if (!error.terminalPersisted) {
      await persistTerminal(error);
      error.terminalPersisted = true;
    }
    throw error;
  } finally {
    if (active) finish();
  }
}

module.exports = { runDurableLifecycle, TransferLifecycle };
