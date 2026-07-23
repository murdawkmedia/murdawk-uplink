const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildAutomationCredential, publicAutomationCredential } = require('../src/automation-auth-core');
const { AutomationAuthStore } = require('../src/automation-auth-store');

const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`protected:${value}`, 'utf8'),
  decryptString: (value) => value.toString('utf8').replace(/^protected:/, ''),
};

test('public API key metadata never returns protected or raw key material', () => {
  const value = buildAutomationCredential({
    id: 'credential-1234',
    name: 'Editing laptop',
    encryptedToken: 'protected-value',
    createdAt: '2026-07-21T12:00:00.000Z',
  });
  const publicValue = publicAutomationCredential(value);
  assert.equal(publicValue.name, 'Editing laptop');
  assert.equal(Object.hasOwn(publicValue, 'encryptedToken'), false);
  assert.equal(Object.hasOwn(publicValue, 'token'), false);
});

test('creates authenticates and revokes protected API keys', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'uplink-auth-'));
  const filePath = path.join(directory, 'automation-access.json');
  let now = new Date('2026-07-21T12:00:00.000Z');
  const store = new AutomationAuthStore({ filePath, safeStorage: fakeSafeStorage, now: () => now });
  const created = store.create('Editing laptop');
  const rawFile = fs.readFileSync(filePath, 'utf8');
  assert.doesNotMatch(rawFile, new RegExp(created.token));
  assert.equal(store.authenticate(created.token).id, created.credential.id);
  assert.equal(store.authenticate('wrong-key'), null);
  now = new Date('2026-07-21T12:02:00.000Z');
  assert.equal(store.authenticate(created.token).lastUsedAt, now.toISOString());
  store.revoke(created.credential.id);
  assert.equal(store.authenticate(created.token), null);
  fs.rmSync(directory, { recursive: true, force: true });
});
