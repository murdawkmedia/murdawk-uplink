const assert = require('node:assert/strict');
const test = require('node:test');

const {
  cancelEligibility,
  PauseLifecycle,
  pauseEligibility,
} = require('../src/pause-core');
const { CancellationLifecycle } = require('../src/cancellation-core');
const { TransferLifecycle } = require('../src/transfer-lifecycle-core');

const PROFILE = {
  remote: 'event-a',
  bucket: 'archive',
  endpointHost: 'a.example.test',
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function childProcess() {
  return {
    kills: 0,
    kill() {
      this.kills += 1;
    },
  };
}

function activeTransfer(overrides = {}) {
  return {
    isRunning: true,
    isLifecycleActive: true,
    activeJobId: 'upload-a',
    intentId: 'intent-a',
    profile: PROFILE,
    phase: 'uploading',
    ...overrides,
  };
}

function activeJob(overrides = {}) {
  return {
    id: 'intent-a',
    intentId: 'intent-a',
    jobId: 'upload-a',
    profile: PROFILE,
    status: 'uploading',
    ...overrides,
  };
}

test('renderer enables pause only for its pausable active lifecycle', () => {
  for (const phase of ['prechecking', 'uploading']) {
    const result = pauseEligibility({
      activeTransfer: activeTransfer({ phase }),
      activeJob: activeJob({ status: phase }),
    });
    assert.equal(result.enabled, true, phase);
    assert.deepEqual(result.association, {
      clientJobId: 'intent-a',
      intentId: 'intent-a',
      jobId: 'upload-a',
    });
  }
});

test('renderer explains idle verifying terminal and external-owner pause boundaries', () => {
  const cases = [
    [{ activeTransfer: {}, activeJob: null }, /No active upload/i],
    [{ activeTransfer: activeTransfer({ phase: 'verifying' }), activeJob: activeJob({ status: 'verifying' }) }, /verification/i],
    [{ activeTransfer: activeTransfer({ phase: 'persisting' }), activeJob: activeJob({ status: 'verifying' }) }, /finishing/i],
    [{ activeTransfer: activeTransfer(), activeJob: activeJob({ intentId: 'other' }) }, /another window/i],
    [{ activeTransfer: activeTransfer(), activeJob: activeJob(), externalLifecycle: true }, /another window/i],
  ];

  for (const [input, pattern] of cases) {
    const result = pauseEligibility(input);
    assert.equal(result.enabled, false);
    assert.match(result.reason, pattern);
  }
});

test('renderer disables Cancel while pause owns terminalization and restores it after rollback', () => {
  assert.equal(typeof cancelEligibility, 'function');
  const pausing = cancelEligibility({
    isRunning: true,
    activeTransfer: activeTransfer({ phase: 'pausing', terminalAction: 'pause-pending', pausePending: true }),
    activeJob: activeJob({ status: 'pausing' }),
  });
  const rolledBack = cancelEligibility({
    isRunning: true,
    activeTransfer: activeTransfer({ phase: 'uploading', terminalAction: '', pausePending: false }),
    activeJob: activeJob({ status: 'uploading' }),
  });

  assert.equal(pausing.enabled, false);
  assert.match(pausing.reason, /pause/i);
  assert.deepEqual(rolledBack, { enabled: true, reason: 'Cancel upload' });
});

test('pause success orders durable record before same-job termination', async () => {
  const pauses = new PauseLifecycle();
  const transfers = new TransferLifecycle();
  const child = childProcess();
  const order = ['renderer-persisted-pausing'];
  transfers.begin({ jobId: 'upload-a', intentId: 'intent-a', profile: PROFILE, phase: 'uploading' });

  await pauses.requestLifecyclePause({
    transferLifecycle: transfers,
    association: { clientJobId: 'intent-a', intentId: 'intent-a', jobId: 'upload-a' },
    persistPaused: async () => order.push('main-paused-record'),
    getActiveProcess: () => child,
    getActiveJobId: () => 'upload-a',
    onTerminate: () => order.push('process-terminated'),
  });
  transfers.finish('upload-a');
  await transfers.waitForIdle('upload-a');
  order.push('paused-event');

  assert.deepEqual(order, [
    'renderer-persisted-pausing',
    'main-paused-record',
    'process-terminated',
    'paused-event',
  ]);
  assert.equal(child.kills, 1);
});

test('pause persistence failure rolls back pending state and leaves transfer running', async () => {
  const pauses = new PauseLifecycle();
  const transfers = new TransferLifecycle();
  const child = childProcess();
  transfers.begin({ jobId: 'upload-a', intentId: 'intent-a', profile: PROFILE, phase: 'uploading' });

  await assert.rejects(pauses.requestLifecyclePause({
    transferLifecycle: transfers,
    association: { clientJobId: 'intent-a', intentId: 'intent-a', jobId: 'upload-a' },
    persistPaused: async () => {
      throw new Error('disk unavailable');
    },
    getActiveProcess: () => child,
    getActiveJobId: () => 'upload-a',
  }), /disk unavailable/);

  assert.equal(child.kills, 0);
  assert.equal(transfers.snapshot().phase, 'uploading');
  assert.equal(transfers.snapshot().pausePending, false);
  assert.equal(transfers.snapshot().pauseRequested, false);
  assert.equal(transfers.snapshot().terminalAction, '');
  assert.equal(await pauses.lifecyclePauseError({ transferLifecycle: transfers, jobId: 'upload-a' }), null);

  const cancellations = new CancellationLifecycle();
  await cancellations.requestLifecycleCancellation({
    transferLifecycle: transfers,
    jobId: 'upload-a',
    message: 'Cancel after pause rollback.',
    persistCancellation: async () => {},
    getActiveProcess: () => child,
    getActiveJobId: () => 'upload-a',
  });
  assert.equal(child.kills, 1);
});

test('pause claim rejects cancellation before either upload child or childless planning can terminalize twice', async () => {
  for (const phase of ['uploading', 'prechecking']) {
    const pauses = new PauseLifecycle();
    const cancellations = new CancellationLifecycle();
    const transfers = new TransferLifecycle();
    const durability = deferred();
    const child = phase === 'uploading' ? childProcess() : null;
    let cancellationPersistenceCalls = 0;
    transfers.begin({ jobId: 'upload-a', intentId: 'intent-a', profile: PROFILE, phase });

    const pause = pauses.requestLifecyclePause({
      transferLifecycle: transfers,
      association: { clientJobId: 'intent-a', intentId: 'intent-a', jobId: 'upload-a' },
      persistPaused: () => durability.promise,
      getActiveProcess: () => child,
      getActiveJobId: () => child ? 'upload-a' : '',
    });
    const cancellationResult = await cancellations.requestLifecycleCancellation({
      transferLifecycle: transfers,
      jobId: 'upload-a',
      message: 'Competing cancellation.',
      persistCancellation: async () => {
        cancellationPersistenceCalls += 1;
      },
      getActiveProcess: () => child,
      getActiveJobId: () => child ? 'upload-a' : '',
    }).then(
      () => ({ error: null }),
      (error) => ({ error }),
    );

    durability.resolve();
    await pause;

    assert.equal(cancellationResult.error?.code, 'ETRANSFERTERMINALCLAIM', phase);
    assert.equal(cancellationPersistenceCalls, 0, phase);
    assert.equal(child?.kills || 0, phase === 'uploading' ? 1 : 0, phase);
    assert.equal(transfers.snapshot().terminalAction, 'paused', phase);
  }
});

test('cancellation claim rejects pause before either upload child or childless planning can terminalize twice', async () => {
  for (const phase of ['uploading', 'prechecking']) {
    const pauses = new PauseLifecycle();
    const cancellations = new CancellationLifecycle();
    const transfers = new TransferLifecycle();
    const durability = deferred();
    const child = phase === 'uploading' ? childProcess() : null;
    let pausePersistenceCalls = 0;
    transfers.begin({ jobId: 'upload-a', intentId: 'intent-a', profile: PROFILE, phase });

    const cancellation = cancellations.requestLifecycleCancellation({
      transferLifecycle: transfers,
      jobId: 'upload-a',
      message: 'Cancellation owns terminalization.',
      persistCancellation: () => durability.promise,
      getActiveProcess: () => child,
      getActiveJobId: () => child ? 'upload-a' : '',
    });
    const pauseResult = await pauses.requestLifecyclePause({
      transferLifecycle: transfers,
      association: { clientJobId: 'intent-a', intentId: 'intent-a', jobId: 'upload-a' },
      persistPaused: async () => {
        pausePersistenceCalls += 1;
      },
      getActiveProcess: () => child,
      getActiveJobId: () => child ? 'upload-a' : '',
    }).then(
      () => ({ error: null }),
      (error) => ({ error }),
    );

    durability.resolve();
    await cancellation;

    assert.equal(pauseResult.error?.code, 'ETRANSFERTERMINALCLAIM', phase);
    assert.equal(pausePersistenceCalls, 0, phase);
    assert.equal(child?.kills || 0, phase === 'uploading' ? 1 : 0, phase);
    assert.equal(transfers.snapshot().terminalAction, 'cancelled', phase);
  }
});

test('synchronous pause persistence failure clears reentrancy state for retry', async () => {
  const pauses = new PauseLifecycle();
  const transfers = new TransferLifecycle();
  const child = childProcess();
  const request = {
    transferLifecycle: transfers,
    association: { clientJobId: 'intent-a', intentId: 'intent-a', jobId: 'upload-a' },
    getActiveProcess: () => child,
    getActiveJobId: () => 'upload-a',
  };
  transfers.begin({ jobId: 'upload-a', intentId: 'intent-a', profile: PROFILE, phase: 'uploading' });

  await assert.rejects(pauses.requestLifecyclePause({
    ...request,
    persistPaused() {
      throw new Error('persistence worker closed');
    },
  }), /persistence worker closed/);

  assert.equal(pauses.isPending('upload-a'), false);
  await pauses.requestLifecyclePause({ ...request, persistPaused: async () => {} });
  assert.equal(child.kills, 1);
});

test('child completion during pause durability cannot advance to the next child', async () => {
  const pauses = new PauseLifecycle();
  const transfers = new TransferLifecycle();
  const durability = deferred();
  const firstChild = childProcess();
  let activeProcess = firstChild;
  let activeJobId = 'upload-a';
  let nextChildStarts = 0;
  transfers.begin({ jobId: 'upload-a', intentId: 'intent-a', phase: 'uploading' });

  const request = pauses.requestLifecyclePause({
    transferLifecycle: transfers,
    association: { clientJobId: 'intent-a', intentId: 'intent-a', jobId: 'upload-a' },
    persistPaused: () => durability.promise,
    getActiveProcess: () => activeProcess,
    getActiveJobId: () => activeJobId,
  });
  activeProcess = null;
  activeJobId = '';
  const classification = pauses.classifyChildResult('upload-a', { code: 0 }).then((result) => {
    if (!result.paused) nextChildStarts += 1;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(transfers.snapshot().pausePending, true);
  assert.equal(nextChildStarts, 0);
  durability.resolve();
  await request;
  assert.equal((await classification).paused, true);
  assert.equal(nextChildStarts, 0);
  assert.equal(firstChild.kills, 0);
});

test('childless planning pauses after durability and never spawns', async () => {
  const pauses = new PauseLifecycle();
  const transfers = new TransferLifecycle();
  const durability = deferred();
  let starts = 0;
  transfers.begin({ jobId: 'upload-a', intentId: 'intent-a', phase: 'prechecking' });

  const request = pauses.requestLifecyclePause({
    transferLifecycle: transfers,
    association: { clientJobId: 'intent-a', intentId: 'intent-a', jobId: 'upload-a' },
    persistPaused: () => durability.promise,
    getActiveProcess: () => null,
    getActiveJobId: () => '',
  });
  const planning = pauses.waitForLifecycleContinuation({
    transferLifecycle: transfers,
    jobId: 'upload-a',
  }).then(() => {
    starts += 1;
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(starts, 0);
  durability.resolve();
  await request;
  await assert.rejects(planning, (error) => error.paused === true && error.terminalPersisted === true);
  assert.equal(starts, 0);
});

test('pause rejects verification and mismatched canonical ownership without mutation', async () => {
  for (const [phase, association] of [
    ['verifying', { clientJobId: 'intent-a', intentId: 'intent-a', jobId: 'upload-a' }],
    ['uploading', { clientJobId: 'other', intentId: 'other', jobId: 'upload-a' }],
  ]) {
    const pauses = new PauseLifecycle();
    const transfers = new TransferLifecycle();
    transfers.begin({ jobId: 'upload-a', intentId: 'intent-a', phase });

    await assert.rejects(pauses.requestLifecyclePause({
      transferLifecycle: transfers,
      association,
      persistPaused: async () => assert.fail('must not persist'),
      getActiveProcess: () => null,
      getActiveJobId: () => '',
    }), (error) => ['ETRANSFERPHASE', 'ETRANSFEROWNER'].includes(error.code));
    assert.equal(transfers.snapshot().phase, phase);
    assert.equal(transfers.snapshot().pausePending, false);
  }
});

test('reentrant same-job pause persists and terminates once', async () => {
  const pauses = new PauseLifecycle();
  const transfers = new TransferLifecycle();
  const durability = deferred();
  const child = childProcess();
  let persistenceCalls = 0;
  const request = {
    transferLifecycle: transfers,
    association: { clientJobId: 'intent-a', intentId: 'intent-a', jobId: 'upload-a' },
    persistPaused: () => {
      persistenceCalls += 1;
      return durability.promise;
    },
    getActiveProcess: () => child,
    getActiveJobId: () => 'upload-a',
  };
  transfers.begin({ jobId: 'upload-a', intentId: 'intent-a', phase: 'uploading' });

  const first = pauses.requestLifecyclePause(request);
  const second = pauses.requestLifecyclePause(request);
  assert.equal(first, second);
  durability.resolve();
  await Promise.all([first, second]);

  assert.equal(persistenceCalls, 1);
  assert.equal(child.kills, 1);
});
