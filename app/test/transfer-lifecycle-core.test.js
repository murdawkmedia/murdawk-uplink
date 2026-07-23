const assert = require('node:assert/strict');
const test = require('node:test');

const { runDurableLifecycle, TransferLifecycle } = require('../src/transfer-lifecycle-core');

const PROFILE = {
  remote: 'event-a',
  bucket: 'archive',
  endpointHost: 'a.example.test',
};

test('lifecycle remains active through childless verification and blocks a second start', () => {
  const lifecycle = new TransferLifecycle();
  lifecycle.begin({
    jobId: 'upload-a',
    intentId: 'intent-a',
    profile: PROFILE,
    phase: 'uploading',
  });
  lifecycle.update('upload-a', { phase: 'verifying' });

  assert.deepEqual(lifecycle.snapshot(), {
    isActive: true,
    jobId: 'upload-a',
    intentId: 'intent-a',
    profile: PROFILE,
    phase: 'verifying',
    terminalAction: '',
    cancelPending: false,
    cancelRequested: false,
    cancelMessage: '',
    pausePending: false,
    pauseRequested: false,
    pauseMessage: '',
  });
  assert.throws(
    () => lifecycle.begin({ jobId: 'upload-b', intentId: 'intent-b', profile: PROFILE }),
    (error) => error?.code === 'ETRANSFERACTIVE' && /upload-a/.test(error.message),
  );
});

test('only the owning job can update or clear a lifecycle', () => {
  const lifecycle = new TransferLifecycle();
  lifecycle.begin({ jobId: 'upload-a', intentId: 'intent-a', profile: PROFILE, phase: 'prechecking' });

  assert.equal(lifecycle.update('upload-b', { phase: 'verifying' }), false);
  assert.equal(lifecycle.finish('upload-b'), false);
  assert.equal(lifecycle.snapshot().phase, 'prechecking');
  assert.equal(lifecycle.finish('upload-a'), true);
  assert.deepEqual(lifecycle.snapshot(), {
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
  });
});

test('waitForIdle resolves only after the owning lifecycle settles', async () => {
  const lifecycle = new TransferLifecycle();
  let settled = false;
  lifecycle.begin({ jobId: 'upload-a', intentId: 'intent-a', phase: 'uploading' });

  const waiting = lifecycle.waitForIdle('upload-a').then(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  lifecycle.finish('upload-a');
  await waiting;
  assert.equal(settled, true);
});

test('cancellation stays associated with the owning lifecycle until terminal persistence finishes', () => {
  const lifecycle = new TransferLifecycle();
  lifecycle.begin({ jobId: 'upload-a', intentId: 'intent-a', profile: PROFILE, phase: 'verifying' });

  assert.equal(lifecycle.requestCancel('upload-b', 'wrong job'), false);
  assert.equal(lifecycle.requestCancel('upload-a', 'Cancelled after upload.'), true);
  assert.equal(lifecycle.snapshot().phase, 'cancelling');
  assert.equal(lifecycle.snapshot().cancelRequested, true);
  assert.equal(lifecycle.snapshot().cancelMessage, 'Cancelled after upload.');
});

test('initial persistence failure never exposes lifecycle ownership or starts planning', async () => {
  const calls = [];

  await assert.rejects(
    runDurableLifecycle({
      persistInitial: async () => {
        calls.push('persist-initial');
        throw new Error('disk unavailable');
      },
      begin: () => calls.push('begin'),
      prepare: async () => calls.push('prepare'),
      execute: async () => calls.push('execute'),
      persistTerminal: async () => calls.push('persist-terminal'),
      finish: () => calls.push('finish'),
    }),
    /disk unavailable/,
  );

  assert.deepEqual(calls, ['persist-initial']);
});

test('cancellation during delayed childless planning persists terminal state before lifecycle release', async () => {
  const calls = [];
  let releasePlanning;
  let cancellation = null;
  const planning = new Promise((resolve) => {
    releasePlanning = resolve;
  });

  const running = runDurableLifecycle({
    persistInitial: async () => calls.push('persist-initial'),
    begin: () => calls.push('begin'),
    prepare: async () => {
      calls.push('prepare');
      await planning;
      return 'planned';
    },
    cancellationError: () => cancellation,
    execute: async () => calls.push('execute'),
    persistTerminal: async (error) => calls.push(`persist-${error.cancelled ? 'cancelled' : 'failed'}`),
    finish: () => calls.push('finish'),
  });
  await new Promise((resolve) => setImmediate(resolve));
  cancellation = Object.assign(new Error('Cancelled during planning.'), { cancelled: true });
  calls.push('cancel-record-updated');
  releasePlanning();

  await assert.rejects(running, /Cancelled during planning/);
  assert.deepEqual(calls, [
    'persist-initial',
    'begin',
    'prepare',
    'cancel-record-updated',
    'persist-cancelled',
    'finish',
  ]);
});

test('planning failure persists the same lifecycle terminally before release', async () => {
  const calls = [];

  await assert.rejects(runDurableLifecycle({
    persistInitial: async () => calls.push('persist-initial'),
    begin: () => calls.push('begin'),
    prepare: async () => {
      calls.push('prepare');
      throw new Error('planning failed');
    },
    execute: async () => calls.push('execute'),
    persistTerminal: async () => calls.push('persist-failed'),
    finish: () => calls.push('finish'),
  }), /planning failed/);

  assert.deepEqual(calls, ['persist-initial', 'begin', 'prepare', 'persist-failed', 'finish']);
});
