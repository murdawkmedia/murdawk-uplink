const test = require('node:test');
const assert = require('node:assert/strict');
const { ProfileMutationInterlock } = require('../src/profile-mutation-interlock');

test('profile mutation cannot begin while a transfer claim is active', async () => {
  const lock = new ProfileMutationInterlock();
  const release = lock.beginTransfer();
  await assert.rejects(() => lock.runExclusive('profile removal', async () => {}), /transfer is active/i);
  release();
  assert.equal(await lock.runExclusive('profile removal', async () => 'removed'), 'removed');
});

test('transfer cannot begin during the full asynchronous mutation window', async () => {
  const lock = new ProfileMutationInterlock();
  let finish;
  const pending = lock.runExclusive('profile removal', () => new Promise((resolve) => { finish = resolve; }));
  assert.throws(() => lock.beginTransfer(), (error) => error.code === 'EPROFILEMUTATION');
  finish('done');
  assert.equal(await pending, 'done');
  const release = lock.beginTransfer();
  release();
});

test('claims and mutations release after failures and only once', async () => {
  const lock = new ProfileMutationInterlock();
  const release = lock.beginTransfer();
  release();
  release();
  await assert.rejects(() => lock.runExclusive('profile setup', async () => { throw new Error('failed'); }), /failed/);
  assert.deepEqual(lock.snapshot(), { mutation: '', transferClaims: 0 });
});
