const path = require('node:path');
const { Worker } = require('node:worker_threads');

function persistenceClosedError() {
  const error = new Error('Persistence worker is closed.');
  error.code = 'EPERSISTENCECLOSED';
  return error;
}

function jobTargetKey(jobsDir, jobId) {
  return `${path.resolve(jobsDir)}\0${jobId}`;
}

class SerializedPersistenceWorker {
  constructor({
    workerPath = path.join(__dirname, 'persistence-worker.js'),
    WorkerClass = Worker,
    maxCoalescedUpdates = 64,
  } = {}) {
    this.workerPath = workerPath;
    this.WorkerClass = WorkerClass;
    this.maxCoalescedUpdates = maxCoalescedUpdates;
    this.worker = null;
    this.inFlight = null;
    this.terminalPriority = [];
    this.settingsUpdates = new Map();
    this.heartbeatUpdates = new Map();
    this.outstanding = new Set();
    this.sequence = 0;
    this.closing = false;
    this.closed = false;
    this.closePromise = null;
  }

  start() {
    if (this.closing || this.closed) throw persistenceClosedError();
    if (this.worker) return this.worker;
    const worker = new this.WorkerClass(this.workerPath);
    this.worker = worker;
    worker.on('message', (message) => this.handleMessage(worker, message));
    worker.on('error', (error) => this.handleWorkerFailure(worker, error));
    worker.on('exit', (code) => {
      if (this.worker !== worker) return;
      this.worker = null;
      if (this.hasScheduledWork()) {
        const error = new Error(`Persistence worker exited with code ${code}.`);
        error.code = 'EPERSISTENCEWORKER';
        this.failScheduled(error);
      }
    });
    return worker;
  }

  hasScheduledWork() {
    return Boolean(
      this.inFlight
      || this.terminalPriority.length
      || this.settingsUpdates.size
      || this.heartbeatUpdates.size,
    );
  }

  createTask(operation, payload) {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const task = { operation, payload, promise, resolve, reject, followers: [] };
    this.outstanding.add(promise);
    promise.then(
      () => this.outstanding.delete(promise),
      () => this.outstanding.delete(promise),
    );
    return task;
  }

  settleTask(task, ok, value) {
    if (ok) task.resolve(value);
    else task.reject(value);
    for (const follower of task.followers) this.settleTask(follower, ok, value);
  }

  handleMessage(worker, message) {
    if (this.worker !== worker || !this.inFlight || this.inFlight.id !== message.id) return;
    const task = this.inFlight;
    this.inFlight = null;
    if (message.ok) {
      this.settleTask(task, true, message.value);
    } else {
      const error = new Error(message.error?.message || 'Persistence worker failed.');
      error.name = message.error?.name || 'Error';
      error.code = message.error?.code;
      error.stack = message.error?.stack || error.stack;
      this.settleTask(task, false, error);
    }
    this.pump();
  }

  handleWorkerFailure(worker, error) {
    if (this.worker !== worker) return;
    this.worker = null;
    this.failScheduled(error);
  }

  failScheduled(error) {
    if (this.inFlight) this.settleTask(this.inFlight, false, error);
    for (const task of this.terminalPriority) this.settleTask(task, false, error);
    for (const task of this.settingsUpdates.values()) this.settleTask(task, false, error);
    for (const task of this.heartbeatUpdates.values()) this.settleTask(task, false, error);
    this.inFlight = null;
    this.terminalPriority = [];
    this.settingsUpdates.clear();
    this.heartbeatUpdates.clear();
  }

  takeCoalesced(map) {
    const next = map.entries().next();
    if (next.done) return null;
    const [key, task] = next.value;
    map.delete(key);
    return task;
  }

  pump() {
    if (this.inFlight) return;
    const task = this.terminalPriority.shift()
      || this.takeCoalesced(this.settingsUpdates)
      || this.takeCoalesced(this.heartbeatUpdates);
    if (!task) return;

    this.sequence += 1;
    task.id = this.sequence;
    this.inFlight = task;
    try {
      this.worker.postMessage({
        id: task.id,
        operation: task.operation,
        payload: task.payload,
      });
    } catch (error) {
      this.inFlight = null;
      this.settleTask(task, false, error);
      queueMicrotask(() => this.pump());
    }
  }

  enqueueTerminal(operation, payload, { supersedesHeartbeatKey = '' } = {}) {
    this.start();
    const task = this.createTask(operation, payload);
    if (supersedesHeartbeatKey) {
      const superseded = this.heartbeatUpdates.get(supersedesHeartbeatKey);
      if (superseded) {
        this.heartbeatUpdates.delete(supersedesHeartbeatKey);
        task.followers.push(superseded);
      }
    }
    this.terminalPriority.push(task);
    this.pump();
    return task.promise;
  }

  enqueueCoalesced(operation, payload, key, map) {
    this.start();
    const pending = map.get(key);
    if (pending) {
      pending.payload = payload;
      return pending.promise;
    }
    if (this.settingsUpdates.size + this.heartbeatUpdates.size >= this.maxCoalescedUpdates) {
      const error = new Error('Persistence update backlog is full.');
      error.code = 'EPERSISTENCEBACKLOG';
      return Promise.reject(error);
    }
    const task = this.createTask(operation, payload);
    map.set(key, task);
    this.pump();
    return task.promise;
  }

  writeJson(target, value, options = {}) {
    return this.enqueueTerminal('write-json', { target, value, options });
  }

  writeJobRecord(jobsDir, record, options = {}) {
    return this.enqueueTerminal(
      'write-job',
      { jobsDir, record, options },
      { supersedesHeartbeatKey: jobTargetKey(jobsDir, record?.jobId || '') },
    );
  }

  updateRunningJob(jobsDir, jobId, transferState, diagnostics, options = {}) {
    return this.enqueueCoalesced('update-running-job', {
      jobsDir,
      jobId,
      transferState,
      diagnostics,
      options,
    }, jobTargetKey(jobsDir, jobId), this.heartbeatUpdates);
  }

  cancelJob(jobsDir, jobId, diagnostics, message, options = {}) {
    return this.enqueueTerminal(
      'cancel-job',
      { jobsDir, jobId, diagnostics, message, options },
      { supersedesHeartbeatKey: jobTargetKey(jobsDir, jobId) },
    );
  }

  pauseJob(jobsDir, jobId, transferState, diagnostics, options = {}) {
    return this.enqueueTerminal(
      'pause-job',
      { jobsDir, jobId, transferState, diagnostics, options },
      { supersedesHeartbeatKey: jobTargetKey(jobsDir, jobId) },
    );
  }

  writeSettings(settingsPath, settings, options = {}) {
    return this.enqueueCoalesced(
      'write-settings',
      { settingsPath, settings, options },
      path.resolve(settingsPath),
      this.settingsUpdates,
    );
  }

  async flush() {
    const writes = [...this.outstanding];
    await Promise.all(writes);
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      await Promise.allSettled([...this.outstanding]);
      const worker = this.worker;
      if (worker) await worker.terminate();
      if (this.worker === worker) this.worker = null;
      this.closed = true;
    })();
    return this.closePromise;
  }
}

module.exports = { SerializedPersistenceWorker };
