const assert = require('node:assert/strict');
const test = require('node:test');

const { bindMainTransferIdentity, bindMainUploadIdentity } = require('../src/main-request-core');

const CONNECTIONS = [{
  id: 'archive',
  name: 'Archive',
  remote: 'Archive',
  bucket: 'archive-media',
  endpointHost: 'sfo3.digitaloceanspaces.com',
}, {
  id: 'media',
  name: 'Media Archive',
  remote: 'media',
  bucket: 'media',
  endpointHost: 'nyc3.digitaloceanspaces.com',
}];

test('main upload binding corrects a renderer-spoofed managed connection id', () => {
  const binding = bindMainUploadIdentity({
    connectionId: 'archive',
    profileSnapshot: {
      remote: 'media',
      bucket: 'MEDIA',
      endpointHost: 'NYC3.DIGITALOCEANSPACES.COM.',
    },
  }, CONNECTIONS);

  assert.equal(binding.connectionId, 'media');
  assert.deepEqual(binding.profileSnapshot, {
    remote: 'media',
    bucket: 'media',
    endpointHost: 'nyc3.digitaloceanspaces.com',
  });
});

test('main upload binding gives unknown profiles a canonical unmanaged identity', () => {
  const binding = bindMainUploadIdentity({
    connectionId: 'archive',
    profile: {
      remote: 'unmanaged-event',
      bucket: 'EVENT-MEDIA',
      endpointHost: 'FRA1.DIGITALOCEANSPACES.COM.',
    },
  }, CONNECTIONS);

  assert.match(binding.connectionId, /^unmanaged-[a-f0-9]{32}$/);
  assert.notEqual(binding.connectionId, 'archive');
  assert.notStrictEqual(binding.profile, binding.profileSnapshot);
  assert.equal(Object.isFrozen(binding.profile), true);
  assert.equal(Object.isFrozen(binding.profileSnapshot), true);
});

test('main upload binding preserves rclone remote case and rejects malformed profiles', () => {
  const caseMismatch = bindMainUploadIdentity({
    connectionId: 'archive',
    profile: {
      remote: 'archive',
      bucket: 'archive-media',
      endpointHost: 'sfo3.digitaloceanspaces.com',
    },
  }, CONNECTIONS);

  assert.match(caseMismatch.connectionId, /^unmanaged-[a-f0-9]{32}$/);
  assert.throws(() => bindMainUploadIdentity({
    connectionId: 'archive',
    profile: {
      remote: 'Archive',
      bucket: 'archive-media',
      endpointHost: 'https://sfo3.digitaloceanspaces.com/path',
    },
  }, CONNECTIONS), /profile|endpoint|invalid/i);
});

test('main transfer binding gives downloads the same canonical connection identity', () => {
  const binding = bindMainTransferIdentity({
    connectionId: 'archive',
    profileSnapshot: {
      remote: 'media',
      bucket: 'media',
      endpointHost: 'nyc3.digitaloceanspaces.com',
    },
  }, CONNECTIONS);

  assert.equal(binding.connectionId, 'media');
  assert.deepEqual(binding.profile, {
    remote: 'media',
    bucket: 'media',
    endpointHost: 'nyc3.digitaloceanspaces.com',
  });
});
