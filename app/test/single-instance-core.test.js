const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { coordinateSingleInstance } = require('../src/single-instance-core');

function createApp(hasLock) {
  const app = new EventEmitter();
  app.quitCalls = 0;
  app.requestSingleInstanceLock = () => hasLock;
  app.quit = () => {
    app.quitCalls += 1;
  };
  return app;
}

test('secondary instance quits before startup handlers are registered', () => {
  const app = createApp(false);
  let startupCalls = 0;

  const primary = coordinateSingleInstance({
    app,
    getWindow: () => null,
    startPrimary: () => {
      startupCalls += 1;
    },
  });

  assert.equal(primary, false);
  assert.equal(app.quitCalls, 1);
  assert.equal(startupCalls, 0);
  assert.equal(app.listenerCount('second-instance'), 0);
});

test('second instance restores and focuses the existing primary window', () => {
  const app = createApp(true);
  const calls = [];
  const window = {
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus'),
  };
  let startupCalls = 0;
  assert.equal(coordinateSingleInstance({
    app,
    getWindow: () => window,
    startPrimary: () => {
      startupCalls += 1;
    },
  }), true);

  app.emit('second-instance');

  assert.equal(startupCalls, 1);
  assert.deepEqual(calls, ['restore', 'show', 'focus']);
});
