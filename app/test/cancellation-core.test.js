const assert = require('node:assert/strict');
const test = require('node:test');

const { CancellationLifecycle } = require('../src/cancellation-core');
const { TransferLifecycle } = require('../src/transfer-lifecycle-core');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function childProcess(name) {
  return {
    name,
    kills: 0,
    kill() {
      this.kills += 1;
    },
  };
}

test('failed durable cancellation leaves the current child running and completion unmarked', async () => {
  const lifecycle = new CancellationLifecycle();
  const child = childProcess('current');

  await assert.rejects(
    lifecycle.requestCancellation({
      jobId: 'natural-completion-job',
      message: 'Cancel requested.',
      persistCancellation: async () => {
        throw new Error('disk unavailable');
      },
      getActiveProcess: () => child,
      getActiveJobId: () => 'natural-completion-job',
    }),
    /disk unavailable/,
  );

  assert.equal(child.kills, 0);
  assert.equal(lifecycle.isPending('natural-completion-job'), false);
  assert.deepEqual(
    await lifecycle.classifyChildResult('natural-completion-job', { code: 0 }),
    { cancelled: false, code: 0 },
  );
});

test('successful cancellation marks after persistence and terminates the current matching child', async () => {
  const lifecycle = new CancellationLifecycle();
  const child = childProcess('current');
  const order = [];

  await lifecycle.requestCancellation({
    jobId: 'cancelled-job',
    message: 'Cancel requested.',
    persistCancellation: async () => {
      order.push('persist');
      assert.equal(lifecycle.takeCancellationMarker('cancelled-job'), '');
    },
    getActiveProcess: () => child,
    getActiveJobId: () => 'cancelled-job',
    onTerminate: () => order.push('terminate'),
  });

  assert.equal(child.kills, 1);
  assert.deepEqual(order, ['persist', 'terminate']);
  assert.deepEqual(
    await lifecycle.classifyChildResult('cancelled-job', { code: 1 }),
    { cancelled: true, message: 'Cancel requested.', code: 1 },
  );
  assert.equal(lifecycle.takeCancellationMarker('cancelled-job'), '');
});

test('child close during pending durability blocks the next source and becomes cancelled on success', async () => {
  const lifecycle = new CancellationLifecycle();
  const durability = deferred();
  const firstChild = childProcess('first');
  let activeProcess = firstChild;
  let activeJobId = 'race-job';
  let secondSourceStarts = 0;
  const cancellation = lifecycle.requestCancellation({
    jobId: 'race-job',
    message: 'Cancel during close.',
    persistCancellation: () => durability.promise,
    getActiveProcess: () => activeProcess,
    getActiveJobId: () => activeJobId,
  });

  activeProcess = null;
  activeJobId = '';
  const sourceLoop = lifecycle.classifyChildResult('race-job', { code: 0 }).then((result) => {
    if (!result.cancelled) secondSourceStarts += 1;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(lifecycle.isPending('race-job'), true);
  assert.throws(
    () => lifecycle.assertProcessStartAllowed(),
    (error) => error.code === 'ECANCELLATIONPENDING',
  );
  assert.equal(secondSourceStarts, 0);
  assert.equal(firstChild.kills, 0);

  durability.resolve();
  await cancellation;
  assert.throws(
    () => lifecycle.assertProcessStartAllowed(),
    (error) => error.code === 'ECANCELLATIONPENDING',
  );
  const result = await sourceLoop;

  assert.equal(result.cancelled, true);
  assert.doesNotThrow(() => lifecycle.assertProcessStartAllowed());
  assert.equal(secondSourceStarts, 0);
  assert.equal(firstChild.kills, 0);
});

test('child close during failed durability resumes normal classification and allows next source', async () => {
  const lifecycle = new CancellationLifecycle();
  const durability = deferred();
  const firstChild = childProcess('first');
  let activeProcess = firstChild;
  let activeJobId = 'race-failure-job';
  let secondSourceStarts = 0;
  const cancellation = lifecycle.requestCancellation({
    jobId: 'race-failure-job',
    message: 'Cancel during close.',
    persistCancellation: () => durability.promise,
    getActiveProcess: () => activeProcess,
    getActiveJobId: () => activeJobId,
  });
  const cancellationResult = cancellation.then(
    () => null,
    (error) => error,
  );

  activeProcess = null;
  activeJobId = '';
  const sourceLoop = lifecycle.classifyChildResult('race-failure-job', { code: 0 }).then((result) => {
    if (!result.cancelled && result.code === 0) secondSourceStarts += 1;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(secondSourceStarts, 0);
  durability.reject(new Error('disk unavailable'));

  assert.match((await cancellationResult).message, /disk unavailable/);
  assert.deepEqual(await sourceLoop, { cancelled: false, code: 0 });
  assert.doesNotThrow(() => lifecycle.assertProcessStartAllowed());
  assert.equal(secondSourceStarts, 1);
  assert.equal(firstChild.kills, 0);
  assert.equal(lifecycle.isPending('race-failure-job'), false);
});

test('durable cancellation never terminates a process belonging to another job', async () => {
  const lifecycle = new CancellationLifecycle();
  const capturedChild = childProcess('captured');
  const otherChild = childProcess('other');
  let activeProcess = capturedChild;
  let activeJobId = 'captured-job';
  const durability = deferred();
  const cancellation = lifecycle.requestCancellation({
    jobId: 'captured-job',
    message: 'Cancel captured job.',
    persistCancellation: () => durability.promise,
    getActiveProcess: () => activeProcess,
    getActiveJobId: () => activeJobId,
  });

  activeProcess = otherChild;
  activeJobId = 'other-job';
  durability.resolve();
  await cancellation;

  assert.equal(capturedChild.kills, 0);
  assert.equal(otherChild.kills, 0);
});

test('reentrant same-job cancellation observes one canonical pending promise', async () => {
  const lifecycle = new CancellationLifecycle();
  const durability = deferred();
  const child = childProcess('current');
  let reentrantPromise;
  let persistenceCalls = 0;
  const request = {
    jobId: 'reentrant-job',
    message: 'Cancel once.',
    persistCancellation: () => {
      persistenceCalls += 1;
      reentrantPromise = lifecycle.requestCancellation({
        ...request,
        persistCancellation: async () => {
          throw new Error('duplicate persistence must not run');
        },
      });
      return durability.promise;
    },
    getActiveProcess: () => child,
    getActiveJobId: () => 'reentrant-job',
  };

  const firstPromise = lifecycle.requestCancellation(request);

  assert.equal(reentrantPromise, firstPromise);
  assert.equal(persistenceCalls, 1);
  durability.resolve();
  await firstPromise;
  assert.equal(child.kills, 1);
});

test('childless planning waits for durable cancellation and never starts after success', async () => {
  const cancellations = new CancellationLifecycle();
  const transfers = new TransferLifecycle();
  const durability = deferred();
  let starts = 0;
  transfers.begin({
    jobId: 'planning-cancel-job',
    intentId: 'planning-intent',
    phase: 'prechecking',
  });

  const cancellation = cancellations.requestLifecycleCancellation({
    transferLifecycle: transfers,
    jobId: 'planning-cancel-job',
    message: 'Cancelled during planning.',
    persistCancellation: () => {
      assert.equal(transfers.snapshot().cancelPending, true);
      return durability.promise;
    },
    getActiveProcess: () => null,
    getActiveJobId: () => '',
  });
  const wouldStart = cancellations.waitForLifecycleContinuation({
    transferLifecycle: transfers,
    jobId: 'planning-cancel-job',
  }).then(() => {
    starts += 1;
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(transfers.snapshot().cancelPending, true);
  assert.equal(starts, 0);
  durability.resolve();
  await cancellation;
  await assert.rejects(wouldStart, (error) => error.cancelled === true);
  assert.equal(starts, 0);
  assert.equal(transfers.snapshot().cancelPending, false);
  assert.equal(transfers.snapshot().cancelRequested, true);
});

test('childless planning waits for failed cancellation persistence then starts once after rollback', async () => {
  const cancellations = new CancellationLifecycle();
  const transfers = new TransferLifecycle();
  const durability = deferred();
  let starts = 0;
  transfers.begin({
    jobId: 'planning-rollback-job',
    intentId: 'rollback-intent',
    phase: 'prechecking',
  });

  const cancellation = cancellations.requestLifecycleCancellation({
    transferLifecycle: transfers,
    jobId: 'planning-rollback-job',
    message: 'Cancellation will fail.',
    persistCancellation: () => durability.promise,
    getActiveProcess: () => null,
    getActiveJobId: () => '',
  });
  const cancellationResult = cancellation.catch((error) => error);
  const wouldStart = cancellations.waitForLifecycleContinuation({
    transferLifecycle: transfers,
    jobId: 'planning-rollback-job',
  }).then(() => {
    starts += 1;
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(starts, 0);
  durability.reject(new Error('cancel record unavailable'));
  assert.match((await cancellationResult).message, /record unavailable/);
  await wouldStart;
  assert.equal(starts, 1);
  assert.equal(transfers.snapshot().phase, 'prechecking');
  assert.equal(transfers.snapshot().cancelPending, false);
  assert.equal(transfers.snapshot().cancelRequested, false);
});
