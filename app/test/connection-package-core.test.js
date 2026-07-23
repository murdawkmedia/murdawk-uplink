const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildPublicConnectionPackage,
  decryptConnectionPackage,
  encryptConnectionPackage,
  inspectConnectionPackage,
  parsePublicConnectionPackage,
} = require('../src/connection-package-core');

const connection = {
  id: 'media',
  name: 'Media Archive',
  remote: 'media',
  bucket: 'media',
  endpointHost: 'nyc3.digitaloceanspaces.com',
  accessKeyId: 'must-not-export',
  secretAccessKey: 'must-not-export',
  recentPrefixes: ['private/recent/path'],
  pinnedPrefixes: ['private/pinned/path'],
};

test('exports a versioned public package without secrets or workstation navigation', () => {
  const packed = buildPublicConnectionPackage(connection);
  const json = JSON.stringify(packed);
  assert.doesNotMatch(json, /must-not-export|private\/recent|private\/pinned/);
  assert.equal(packed.encrypted, false);
  assert.equal(parsePublicConnectionPackage(json).name, 'Media Archive');
  assert.deepEqual(parsePublicConnectionPackage(json).recentPrefixes, []);
});

test('round-trips credentials only through an encrypted package', () => {
  const packed = encryptConnectionPackage({
    connection,
    accessKeyId: 'DOACCESS1',
    secretAccessKey: 'secret-1',
  }, 'a long export password');
  const serialized = JSON.stringify(packed);
  assert.doesNotMatch(serialized, /DOACCESS1|secret-1|Media Archive|media/);
  assert.equal(inspectConnectionPackage(serialized).encrypted, true);
  const unpacked = decryptConnectionPackage(serialized, 'a long export password');
  assert.equal(unpacked.connection.name, 'Media Archive');
  assert.equal(unpacked.secretAccessKey, 'secret-1');
});

test('rejects short and wrong passwords and modified ciphertext', () => {
  assert.throws(() => encryptConnectionPackage({
    connection,
    accessKeyId: 'DOACCESS1',
    secretAccessKey: 'secret-1',
  }, 'too short'), /at least 12/i);
  const packed = encryptConnectionPackage({
    connection,
    accessKeyId: 'DOACCESS1',
    secretAccessKey: 'secret-1',
  }, 'the correct password');
  assert.throws(() => decryptConnectionPackage(packed, 'the wrong password'), /wrong|changed/i);
  packed.ciphertext = `${packed.ciphertext.slice(0, -4)}AAAA`;
  assert.throws(() => decryptConnectionPackage(packed, 'the correct password'), /wrong|changed/i);
});

test('rejects legacy raw descriptors instead of silently treating them as packages', () => {
  assert.throws(() => inspectConnectionPackage(JSON.stringify(connection)), /not a valid|unsupported/i);
});
