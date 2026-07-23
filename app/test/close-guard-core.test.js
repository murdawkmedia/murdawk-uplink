const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCloseGuardMessage,
  shouldGuardClose,
} = require('../src/close-guard-core');

test('guards close when a transfer is active', () => {
  assert.equal(shouldGuardClose({ isRunning: true, pid: 4321 }), true);
  assert.equal(shouldGuardClose({ activeJobId: 'upload-123' }), true);
  assert.equal(shouldGuardClose({}), false);
});

test('offers keep uploading pause and close and cancel close for pausable uploads', () => {
  const message = buildCloseGuardMessage({
    isRunning: true,
    phase: 'uploading',
    pid: 4321,
    currentFile: 'clip.mov',
  });

  assert.equal(message.type, 'warning');
  assert.deepEqual(message.buttons, ['Keep uploading', 'Pause and close', 'Cancel close']);
  assert.equal(message.defaultId, 0);
  assert.equal(message.cancelId, 2);
  assert.match(message.detail, /PID 4321/);
  assert.match(message.detail, /clip\.mov/);
  assert.match(message.detail, /checks remote files before continuing/i);
});

test('asks the user to keep the app open while verification is committing', () => {
  const message = buildCloseGuardMessage({
    isRunning: true,
    phase: 'verifying',
    activeJobId: 'upload-verify',
  });

  assert.deepEqual(message.buttons, ['Keep open', 'Cancel close']);
  assert.equal(message.defaultId, 0);
  assert.equal(message.cancelId, 1);
  assert.match(message.detail, /verification/i);
  assert.match(message.detail, /wait/i);
});
