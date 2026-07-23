const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { SerializedPersistenceWorker } = require('../src/persistence-queue');
const { buildJobRecord, readJobRecord } = require('../src/job-core');
const { readSettings } = require('../src/settings');

function createRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uplink-persistence-worker-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function createSlowWorkerClass({ delayMs = 20, failOperations = [] } = {}) {
  const failures = [...failOperations];
  return class SlowWorker extends EventEmitter {
    static instances = [];

    constructor() {
      super();
      this.messages = [];
      this.completed = [];
      this.terminated = 0;
      this.constructor.instances.push(this);
    }

    postMessage(message) {
      this.messages.push(message);
      setTimeout(() => {
        this.completed.push(message);
        const shouldFail = failures[0] === message.operation;
        if (shouldFail) failures.shift();
        this.emit('message', shouldFail
          ? { id: message.id, ok: false, error: { message: `${message.operation} failed` } }
          : { id: message.id, ok: true, value: message.payload });
      }, delayMs);
    }

    async terminate() {
      this.terminated += 1;
      this.emit('exit', 0);
    }
  };
}

test('serialized persistence worker preserves write ordering and flushes', async (t) => {
  const root = createRoot(t);
  const settingsPath = path.join(root, 'settings.json');
  const queue = new SerializedPersistenceWorker();
  t.after(() => queue.close());

  const first = queue.writeSettings(settingsPath, { source: 'C:/first' });
  const second = queue.writeSettings(settingsPath, { source: 'C:/second' });
  await queue.flush();
  await Promise.all([first, second]);

  assert.equal(readSettings(settingsPath).source, 'C:/second');
});

test('worker-backed busy persistence does not block main event-loop timers', async (t) => {
  const root = createRoot(t);
  const target = path.join(root, 'busy.json');
  const quarantinePath = `${target}.lock.stale`;
  fs.writeFileSync(quarantinePath, JSON.stringify({
    pid: process.pid,
    token: 'live-owner',
    createdAt: Date.now(),
  }), 'utf8');
  const queue = new SerializedPersistenceWorker();
  t.after(() => queue.close());
  let heartbeats = 0;
  const timer = setInterval(() => {
    heartbeats += 1;
  }, 10);

  await assert.rejects(
    queue.writeJson(target, { blocked: true }, {
      lockTimeoutMs: 80,
      lockRetryMs: 5,
      staleLockMs: 1_000,
    }),
    (error) => error.code === 'ELOCKED',
  );
  clearInterval(timer);

  assert.ok(heartbeats >= 3, `Expected timer heartbeats while worker waited, got ${heartbeats}`);
});

test('slow worker coalesces many same-job heartbeats to one in-flight and one latest snapshot', async () => {
  const WorkerClass = createSlowWorkerClass({ delayMs: 20 });
  const queue = new SerializedPersistenceWorker({ WorkerClass });
  const writes = Array.from({ length: 100 }, (_, sequence) => queue.updateRunningJob(
    'C:/jobs',
    'coalesced-job',
    { sequence },
    { sequence },
  ));
  const worker = WorkerClass.instances[0];

  assert.equal(worker.messages.length, 1);
  assert.equal(new Set(writes).size, 2);
  await Promise.all(writes);

  assert.equal(worker.messages.length, 2);
  assert.equal(worker.completed.at(-1).payload.transferState.sequence, 99);
  await queue.close();
});

test('slow worker coalesces 200 settings saves by target to the latest snapshot', async () => {
  const WorkerClass = createSlowWorkerClass({ delayMs: 20 });
  const queue = new SerializedPersistenceWorker({ WorkerClass });
  const writes = Array.from({ length: 200 }, (_, sequence) => queue.writeSettings(
    'C:/settings.json',
    { source: `C:/${sequence}` },
  ));
  const worker = WorkerClass.instances[0];

  assert.equal(worker.messages.length, 1);
  assert.equal(new Set(writes).size, 2);
  await Promise.all(writes);

  assert.equal(worker.messages.length, 2);
  assert.equal(worker.completed.at(-1).payload.settings.source, 'C:/199');
  await queue.close();
});

test('terminal writes dispatch before pending settings and heartbeat snapshots', async () => {
  const WorkerClass = createSlowWorkerClass({ delayMs: 15 });
  const queue = new SerializedPersistenceWorker({ WorkerClass });
  const firstSettings = queue.writeSettings('C:/settings.json', { source: 'C:/first' });
  const latestSettings = queue.writeSettings('C:/settings.json', { source: 'C:/latest' });
  const heartbeat = queue.updateRunningJob('C:/jobs', 'priority-job', { sequence: 1 }, null);
  const terminal = queue.writeJobRecord('C:/jobs', {
    jobId: 'priority-job',
    status: 'complete',
    source: 'C:/source.mov',
  });
  const worker = WorkerClass.instances[0];

  await Promise.all([firstSettings, latestSettings, heartbeat, terminal]);

  assert.deepEqual(worker.messages.map((message) => message.operation), [
    'write-settings',
    'write-job',
    'write-settings',
  ]);
  assert.equal(worker.messages.at(-1).payload.settings.source, 'C:/latest');
  await queue.close();
});

test('coalesced settings failures reject shared callers and do not poison a later save', async () => {
  const WorkerClass = createSlowWorkerClass({
    delayMs: 10,
    failOperations: ['write-settings'],
  });
  const queue = new SerializedPersistenceWorker({ WorkerClass });
  const blocker = queue.writeJobRecord('C:/jobs', {
    jobId: 'settings-blocker',
    status: 'running',
    source: 'C:/source.mov',
  });
  const writes = Array.from({ length: 20 }, (_, sequence) => queue.writeSettings(
    'C:/settings.json',
    { source: `C:/${sequence}` },
  ));

  await blocker;
  const results = await Promise.allSettled(writes);
  assert.equal(new Set(writes).size, 1);
  assert.equal(results.every((result) => result.status === 'rejected'), true);

  const recovered = await queue.writeSettings('C:/settings.json', { source: 'C:/recovered' });
  assert.equal(recovered.settings.source, 'C:/recovered');
  await queue.close();
});

test('close flushes the latest settings snapshot and terminal writes', async () => {
  const WorkerClass = createSlowWorkerClass({ delayMs: 15 });
  const queue = new SerializedPersistenceWorker({ WorkerClass });
  const settingsWrites = Array.from({ length: 50 }, (_, sequence) => queue.writeSettings(
    'C:/settings.json',
    { source: `C:/${sequence}` },
  ));
  const terminal = queue.writeJobRecord('C:/jobs', {
    jobId: 'closing-priority-job',
    status: 'complete',
    source: 'C:/source.mov',
  });

  await queue.close();
  await Promise.all([...settingsWrites, terminal]);

  const worker = WorkerClass.instances[0];
  assert.equal(worker.messages.filter((message) => message.operation === 'write-settings').length, 2);
  assert.equal(worker.completed.findLast((message) => message.operation === 'write-settings').payload.settings.source, 'C:/49');
  assert.equal(worker.messages.some((message) => message.operation === 'write-job'), true);
  assert.equal(worker.terminated, 1);
});

test('unique coalesced targets are bounded without blocking terminal work', async () => {
  const WorkerClass = createSlowWorkerClass({ delayMs: 15 });
  const queue = new SerializedPersistenceWorker({ WorkerClass, maxCoalescedUpdates: 2 });
  const inFlight = queue.updateRunningJob('C:/jobs', 'in-flight-job', { sequence: 1 }, null);
  const settings = queue.writeSettings('C:/one/settings.json', { source: 'C:/one' });
  const heartbeat = queue.updateRunningJob('C:/jobs', 'pending-job', { sequence: 2 }, null);

  await assert.rejects(
    queue.writeSettings('C:/two/settings.json', { source: 'C:/two' }),
    (error) => error.code === 'EPERSISTENCEBACKLOG',
  );
  const terminal = queue.writeJobRecord('C:/jobs', {
    jobId: 'terminal-through-cap',
    status: 'complete',
    source: 'C:/source.mov',
  });

  await Promise.all([inFlight, settings, heartbeat, terminal]);
  assert.equal(
    WorkerClass.instances[0].messages.some((message) => message.payload.record?.jobId === 'terminal-through-cap'),
    true,
  );
  await queue.close();
});

test('terminal job writes supersede queued heartbeats and retain per-target ordering', async () => {
  const WorkerClass = createSlowWorkerClass({ delayMs: 20 });
  const queue = new SerializedPersistenceWorker({ WorkerClass });
  const firstHeartbeat = queue.updateRunningJob('C:/jobs', 'terminal-job', { sequence: 1 }, null);
  const replacedHeartbeat = queue.updateRunningJob('C:/jobs', 'terminal-job', { sequence: 2 }, null);
  const terminal = queue.writeJobRecord('C:/jobs', {
    jobId: 'terminal-job',
    status: 'complete',
    source: 'C:/source.mov',
  });
  const worker = WorkerClass.instances[0];

  await Promise.all([firstHeartbeat, replacedHeartbeat, terminal]);

  assert.deepEqual(worker.messages.map((message) => message.operation), [
    'update-running-job',
    'write-job',
  ]);
  assert.equal(worker.messages[1].payload.record.status, 'complete');
  await queue.close();
});

test('persistence errors reject the affected write without poisoning later work', async () => {
  const WorkerClass = createSlowWorkerClass({
    delayMs: 5,
    failOperations: ['write-settings'],
  });
  const queue = new SerializedPersistenceWorker({ WorkerClass });
  const failed = queue.writeSettings('C:/settings.json', { source: 'first' });
  const recovered = queue.writeSettings('C:/settings.json', { source: 'second' });

  await assert.rejects(failed, /write-settings failed/);
  assert.equal((await recovered).settings.source, 'second');
  assert.equal(WorkerClass.instances[0].messages.length, 2);
  await queue.close();
});

test('close drains only actual unique coalesced work and persists the latest heartbeat', async () => {
  const WorkerClass = createSlowWorkerClass({ delayMs: 25 });
  const queue = new SerializedPersistenceWorker({ WorkerClass });
  const writes = Array.from({ length: 80 }, (_, sequence) => queue.updateRunningJob(
    'C:/jobs',
    'closing-job',
    { sequence },
    null,
  ));
  const startedAt = Date.now();

  await queue.close();
  await Promise.all(writes);

  const elapsed = Date.now() - startedAt;
  const worker = WorkerClass.instances[0];
  assert.equal(worker.messages.length, 2);
  assert.equal(worker.completed.at(-1).payload.transferState.sequence, 79);
  assert.equal(worker.terminated, 1);
  assert.ok(elapsed < 500, `Expected coalesced close below 500ms, got ${elapsed}ms`);
});

test('worker serializes heartbeat updates before terminal job state', async (t) => {
  const root = createRoot(t);
  const jobsDir = path.join(root, 'jobs');
  const queue = new SerializedPersistenceWorker();
  t.after(() => queue.close());
  const running = buildJobRecord({
    jobId: 'ordered-job',
    status: 'running',
    source: 'C:/exports/ordered.mov',
    prefix: 'archive/ordered',
  });
  await queue.writeJobRecord(jobsDir, running);

  const heartbeat = queue.updateRunningJob(jobsDir, running.jobId, {
    activeJobId: running.jobId,
    currentFile: 'ordered.mov',
  }, null);
  const terminal = queue.writeJobRecord(jobsDir, buildJobRecord({
    ...running,
    status: 'complete',
    completedAt: new Date().toISOString(),
  }));
  await Promise.all([heartbeat, terminal]);

  assert.equal(readJobRecord(jobsDir, running.jobId).status, 'complete');
});

test('worker cancellation preserves job identity and fails safely when missing', async (t) => {
  const root = createRoot(t);
  const jobsDir = path.join(root, 'jobs');
  const queue = new SerializedPersistenceWorker();
  t.after(() => queue.close());
  const running = buildJobRecord({
    jobId: 'cancel-identity',
    status: 'running',
    source: 'C:/exports/cancel.mov',
    prefix: 'archive/cancel',
  });
  await queue.writeJobRecord(jobsDir, running);

  const cancelled = await queue.cancelJob(jobsDir, running.jobId, null, 'Cancelled in test.');

  assert.equal(cancelled.jobId, running.jobId);
  assert.deepEqual(cancelled.sources, running.sources);
  assert.equal(readJobRecord(jobsDir, running.jobId).status, 'cancelled');
  await assert.rejects(
    queue.cancelJob(jobsDir, 'missing-cancel-job', null, 'Do not invent a record.'),
    (error) => error.code === 'EJOBNOTFOUND',
  );
});

test('worker pause preserves the running record and latest progress without cancellation', async (t) => {
  const root = createRoot(t);
  const jobsDir = path.join(root, 'jobs');
  const queue = new SerializedPersistenceWorker();
  t.after(() => queue.close());
  const running = buildJobRecord({
    jobId: 'pause-identity',
    intentId: 'pause-intent',
    status: 'running',
    source: 'C:/exports/pause.mov',
    prefix: 'archive/pause',
    filterMode: 'media-docs',
  });
  await queue.writeJobRecord(jobsDir, running);

  const paused = await queue.pauseJob(jobsDir, running.jobId, {
    activeJobId: running.jobId,
    source: running.sources[0],
    percent: 55,
  }, null);

  assert.equal(paused.status, 'paused');
  assert.equal(paused.intentId, 'pause-intent');
  assert.deepEqual(paused.sources, running.sources);
  assert.equal(paused.filterMode, 'media-docs');
  assert.equal(paused.transferState.percent, 55);
  assert.equal(readJobRecord(jobsDir, running.jobId).status, 'paused');
});
