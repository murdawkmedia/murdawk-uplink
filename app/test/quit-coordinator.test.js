const assert = require('node:assert/strict');
const test = require('node:test');

const { createQuitCoordinator } = require('../src/quit-coordinator');

function eventSpy() {
  return {
    prevented: 0,
    preventDefault() {
      this.prevented += 1;
    },
  };
}

function createHarness({ active = true, decisions = ['keep'], pauseActiveTransfer } = {}) {
  const calls = [];
  let decisionIndex = 0;
  const app = {
    quitCalls: 0,
    quit() {
      calls.push('quit');
      this.quitCalls += 1;
    },
  };
  const persistence = {
    flushCalls: 0,
    closeCalls: 0,
    async flush() {
      calls.push('flush');
      this.flushCalls += 1;
    },
    async close() {
      calls.push('close');
      this.closeCalls += 1;
    },
  };
  const coordinator = createQuitCoordinator({
    app,
    persistence,
    getActiveTransfer: () => active ? { isRunning: true, activeJobId: 'active-job' } : {},
    confirmActiveQuit: async () => {
      calls.push('confirm');
      const decision = decisions[Math.min(decisionIndex, decisions.length - 1)];
      decisionIndex += 1;
      return decision;
    },
    pauseActiveTransfer: pauseActiveTransfer || (async () => {
      calls.push('pause');
    }),
    onError: (error) => calls.push(`error:${error.message}`),
  });
  return { app, calls, coordinator, persistence };
}

test('keep uploading and cancel close both leave the app open without state changes', async () => {
  const harness = createHarness({ decisions: ['keep', 'cancel'] });
  const firstClose = eventSpy();

  await harness.coordinator.handleWindowClose(firstClose);

  assert.equal(firstClose.prevented, 1);
  assert.deepEqual(harness.calls, ['confirm']);
  assert.equal(harness.persistence.closeCalls, 0);

  const secondClose = eventSpy();
  await harness.coordinator.handleWindowClose(secondClose);

  assert.equal(secondClose.prevented, 1);
  assert.deepEqual(harness.calls, ['confirm', 'confirm']);
  assert.equal(harness.persistence.closeCalls, 0);
  assert.equal(harness.app.quitCalls, 0);
});

test('pause and close waits for pause settlement then flushes and closes once', async () => {
  let releasePause;
  const pause = new Promise((resolve) => {
    releasePause = resolve;
  });
  const harness = createHarness({
    decisions: ['pause'],
    pauseActiveTransfer: async () => {
      harness.calls.push('pause:start');
      await pause;
      harness.calls.push('pause:settled');
    },
  });
  const firstQuit = eventSpy();
  const secondQuit = eventSpy();

  const firstAttempt = harness.coordinator.handleBeforeQuit(firstQuit);
  const secondAttempt = harness.coordinator.handleBeforeQuit(secondQuit);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(firstQuit.prevented, 1);
  assert.equal(secondQuit.prevented, 1);
  assert.deepEqual(harness.calls, ['confirm', 'pause:start']);
  assert.equal(harness.persistence.closeCalls, 0);

  releasePause();
  await Promise.all([firstAttempt, secondAttempt]);

  assert.deepEqual(harness.calls, [
    'confirm',
    'pause:start',
    'pause:settled',
    'flush',
    'close',
    'quit',
  ]);
  assert.equal(harness.persistence.flushCalls, 1);
  assert.equal(harness.persistence.closeCalls, 1);

  const finalQuit = eventSpy();
  await harness.coordinator.handleBeforeQuit(finalQuit);
  assert.equal(finalQuit.prevented, 0);
  assert.equal(harness.persistence.closeCalls, 1);
});

test('inactive taskbar quit flushes and closes persistence idempotently', async () => {
  const harness = createHarness({ active: false });
  const firstQuit = eventSpy();
  const secondQuit = eventSpy();

  await Promise.all([
    harness.coordinator.handleBeforeQuit(firstQuit),
    harness.coordinator.handleBeforeQuit(secondQuit),
  ]);

  assert.equal(firstQuit.prevented, 1);
  assert.equal(secondQuit.prevented, 1);
  assert.deepEqual(harness.calls, ['flush', 'close', 'quit']);
  assert.equal(harness.persistence.closeCalls, 1);
});

test('failed active pause leaves persistence open and permits retry', async () => {
  let attempts = 0;
  const harness = createHarness({
    decisions: ['pause', 'pause'],
    pauseActiveTransfer: async () => {
      attempts += 1;
      harness.calls.push(`pause:${attempts}`);
      if (attempts === 1) throw new Error('terminal write failed');
    },
  });

  await harness.coordinator.handleBeforeQuit(eventSpy());
  assert.equal(harness.persistence.closeCalls, 0);
  assert.equal(harness.app.quitCalls, 0);

  await harness.coordinator.handleBeforeQuit(eventSpy());
  assert.equal(harness.persistence.closeCalls, 1);
  assert.equal(harness.app.quitCalls, 1);
});
