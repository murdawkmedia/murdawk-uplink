const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assertTransferStartAvailable,
  spawnTransferProcess,
} = require('../src/transfer-lock-core');

test('allows a transfer start when no child process is active', () => {
  assert.equal(assertTransferStartAvailable({ activeProcess: null, activeJobId: '' }), true);
});

test('rejects a concurrent transfer without replacing the active process association', () => {
  const activeProcess = { pid: 4242 };
  const state = { activeProcess, activeJobId: 'live-job' };

  assert.throws(
    () => assertTransferStartAvailable(state, { requestedJobId: 'second-job' }),
    (error) => error.code === 'TRANSFER_ALREADY_ACTIVE' && /live-job/.test(error.message),
  );
  assert.equal(state.activeProcess, activeProcess);
  assert.equal(state.activeJobId, 'live-job');
});

test('transfer spawn seam enforces the active lock before invoking the process spawner', () => {
  const activeProcess = { pid: 4242 };
  let spawnCalls = 0;
  const spawnProcess = () => {
    spawnCalls += 1;
    return { pid: 5252 };
  };

  assert.throws(
    () => spawnTransferProcess({
      spawnProcess,
      args: ['copy', 'source', 'remote:bucket/path'],
      activeProcess,
      activeJobId: 'live-job',
      requestedJobId: 'second-job',
    }),
    (error) => error.code === 'TRANSFER_ALREADY_ACTIVE',
  );
  assert.equal(spawnCalls, 0);

  const child = spawnTransferProcess({
    spawnProcess,
    args: ['copy', 'source', 'remote:bucket/path'],
    activeProcess: null,
    activeJobId: '',
    requestedJobId: 'allowed-job',
  });
  assert.equal(spawnCalls, 1);
  assert.equal(child.pid, 5252);
});
