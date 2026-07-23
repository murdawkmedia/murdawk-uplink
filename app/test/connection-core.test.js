const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const {
  canonicalConnectionTuple,
  collectConnectionRemovalBlockers,
  migrateLegacyProfile,
  removeConnection,
  repairManagedConnectionId,
  resolveConnectionBinding,
  sanitizeConnection,
  sanitizeConnectionId,
  sanitizeConnectionReferenceId,
  transferBlocksConnectionChange,
  unmanagedConnectionId,
} = require('../src/connection-core');

const MEDIA_PROFILE = {
  remote: 'media',
  bucket: 'media',
  endpointHost: 'nyc3.digitaloceanspaces.com',
};

test('sanitizes a strict non-secret connection descriptor', () => {
  const value = sanitizeConnection({
    id: ' media ',
    name: ' Media Archive ',
    remote: ' media ',
    bucket: ' media ',
    endpointHost: ' NYC3.DIGITALOCEANSPACES.COM ',
    publicRead: false,
    checksum: 'sha256',
    recentPrefixes: [' /second-event//recordings/ ', 7, 'second-event/recordings', 'sample-event/recordings'],
    pinnedPrefixes: Array.from({ length: 10 }, (_, index) => ` event-${index} `),
    lastTestedAt: '2026-07-19T12:00:00.000Z',
    accessKeyId: 'MUST_NOT_SURVIVE',
    secretAccessKey: 'MUST_NOT_SURVIVE',
    oauthToken: 'MUST_NOT_SURVIVE',
    nestedCredentials: { password: 'MUST_NOT_SURVIVE' },
    unrelated: 'discard me',
  });

  assert.deepEqual(value, {
    id: 'media',
    name: 'Media Archive',
    remote: 'media',
    bucket: 'media',
    endpointHost: 'nyc3.digitaloceanspaces.com',
    publicRead: false,
    checksum: 'sha256',
    recentPrefixes: ['second-event/recordings', 'sample-event/recordings'],
    pinnedPrefixes: Array.from({ length: 8 }, (_, index) => `event-${index}`),
    lastTestedAt: '2026-07-19T12:00:00.000Z',
  });
  assert.doesNotMatch(JSON.stringify(value), /MUST_NOT_SURVIVE|key|secret|token|credential|unrelated/i);
});

test('rejects incomplete and unsafe connection identities', () => {
  const base = {
    id: 'archive',
    name: 'Archive Space',
    remote: 'archive',
    bucket: 'archive-media',
    endpointHost: 'sfo3.digitaloceanspaces.com',
  };

  for (const patch of [
    { id: '../archive' },
    { name: 'bad\u0000name' },
    { remote: 'archive:other' },
    { endpointHost: 'https://sfo3.digitaloceanspaces.com/path' },
    { endpointHost: 'localhost:9000' },
    { lastTestedAt: 'not-a-date' },
  ]) {
    assert.throws(() => sanitizeConnection({ ...base, ...patch }), /connection|invalid/i);
  }
  assert.equal(sanitizeConnection({ ...base, bucket: 'ARCHIVE-MEDIA' }).bucket, 'archive-media');
});

test('uses one path-safe policy for managed descriptors and queue references', () => {
  const base = {
    name: 'Archive Space',
    remote: 'archive',
    bucket: 'archive-media',
    endpointHost: 'sfo3.digitaloceanspaces.com',
  };

  for (const id of ['CON', 'archive.', 'a..b', 'unmanaged-impostor', 'internal-reserved']) {
    assert.equal(sanitizeConnectionId(id), '', id);
    assert.throws(() => sanitizeConnection({ ...base, id }), /connection.*id.*invalid/i, id);
  }
  const generatedId = `unmanaged-${'a'.repeat(32)}`;
  assert.equal(sanitizeConnectionReferenceId(generatedId), generatedId);
  assert.equal(sanitizeConnectionReferenceId('unmanaged-deadbeef'), '');
  assert.equal(sanitizeConnectionReferenceId('CON'), '');
  assert.equal(sanitizeConnectionReferenceId('archive.'), '');
  assert.equal(sanitizeConnectionReferenceId('a..b'), '');
});

test('repairs unsafe legacy managed ids deterministically without entering internal namespaces', () => {
  const profile = {
    remote: 'Archive+Fast',
    bucket: 'archive-media',
    endpointHost: 'sfo3.digitaloceanspaces.com',
  };

  for (const id of ['CON', 'archive.', 'a..b', 'unmanaged-impostor']) {
    const first = repairManagedConnectionId(id, profile);
    const second = repairManagedConnectionId(id, profile);
    assert.equal(first, second, id);
    assert.equal(sanitizeConnectionId(first), first, id);
    assert.doesNotMatch(first, /^(?:unmanaged|internal)-/i, id);
  }
});

test('migrates a legacy profile and its navigation state once', () => {
  const migrated = migrateLegacyProfile(MEDIA_PROFILE, {
    recentPrefixes: ['/second-event//recordings/', 'second-event/recordings'],
    pinnedPrefixes: ['second-event/recordings/edits'],
    publicRead: false,
    checksum: 'sha256',
  });

  assert.equal(migrated.activeConnectionId, 'media');
  assert.deepEqual(migrated.connections, [{
    id: 'media',
    name: 'media',
    remote: 'media',
    bucket: 'media',
    endpointHost: 'nyc3.digitaloceanspaces.com',
    publicRead: false,
    checksum: 'sha256',
    recentPrefixes: ['second-event/recordings'],
    pinnedPrefixes: ['second-event/recordings/edits'],
    lastTestedAt: '',
  }]);
  assert.deepEqual(migrateLegacyProfile(null), { connections: [], activeConnectionId: '' });
});

test('creates a stable safe id and friendly name for another legacy remote', () => {
  const first = migrateLegacyProfile({
    remote: 'Archive Media',
    bucket: 'archive-media',
    endpointHost: 'sfo3.digitaloceanspaces.com',
  });
  const second = migrateLegacyProfile({
    remote: 'Archive Media',
    bucket: 'archive-media',
    endpointHost: 'sfo3.digitaloceanspaces.com',
  });

  assert.equal(first.connections[0].id, 'archive-media');
  assert.equal(first.connections[0].name, 'Archive Media');
  assert.deepEqual(first, second);
});

test('legacy profile migration uses the profile name without client special cases', () => {
  const migrated = migrateLegacyProfile({
    remote: 'media',
    bucket: 'media-archive',
    endpointHost: 'nyc3.digitaloceanspaces.com',
  });
  assert.equal(migrated.connections[0].id, 'media');
  assert.equal(migrated.connections[0].name, 'media');
});

test('removes a connection immutably only when all referencing work is safely terminal', () => {
  const connections = [
    sanitizeConnection({ id: 'media', name: 'Media Archive', ...MEDIA_PROFILE }),
    sanitizeConnection({
      id: 'archive',
      name: 'Archive',
      remote: 'archive',
      bucket: 'archive-media',
      endpointHost: 'sfo3.digitaloceanspaces.com',
    }),
  ];

  for (const status of ['queued', 'ready', 'prechecking', 'uploading', 'verifying', 'pausing', 'paused', 'needs-resume-check', 'failed', 'cancelled', 'blocked', 'dry-run']) {
    assert.throws(
      () => removeConnection(connections, 'media', [{ connectionId: 'media', status }]),
      /unfinished/i,
      status,
    );
  }

  const result = removeConnection(connections, 'media', [
    { connectionId: 'media', status: 'complete' },
    { connectionId: 'media', status: 'verified' },
    { connectionId: 'media', status: 'warning', verification: { ok: true }, checksum: { ok: true } },
    { connectionId: 'archive', status: 'uploading' },
  ]);
  assert.deepEqual(result.map((connection) => connection.id), ['archive']);
  assert.deepEqual(connections.map((connection) => connection.id), ['media', 'archive']);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result[0]), true);
  assert.equal(Object.isFrozen(result[0].recentPrefixes), true);
  assert.throws(() => result[0].recentPrefixes.push('changed'), TypeError);
});

test('blocks unresolved warning records while allowing verified warning history', () => {
  const connections = [sanitizeConnection({ id: 'media', name: 'Media Archive', ...MEDIA_PROFILE })];
  assert.throws(() => removeConnection(connections, 'media', [{
    connectionId: 'media',
    status: 'warning',
    verification: { ok: false },
  }]), /unfinished/i);
  assert.deepEqual(removeConnection(connections, 'media', [{
    connectionId: 'media',
    status: 'warning',
    verification: { ok: true },
    checksum: { ok: true },
  }]), []);
});

test('collects durable and active lifecycle blockers for profile removal', () => {
  const connection = sanitizeConnection({ id: 'media', name: 'Media Archive', ...MEDIA_PROFILE });
  for (const status of ['paused', 'interrupted', 'verifying', 'needs-resume-check']) {
    const blockers = collectConnectionRemovalBlockers({
      connection,
      jobs: [{ jobId: `job-${status}`, connectionId: 'media', status }],
    });
    assert.equal(blockers.length, 1, status);
    assert.equal(blockers[0].status, status);
  }

  const blockers = collectConnectionRemovalBlockers({
    connection,
    activeTransfer: {
      activeJobId: 'active-verify',
      isLifecycleActive: true,
      phase: 'verifying',
      profile: MEDIA_PROFILE,
    },
  });
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].jobId, 'active-verify');
});

test('deduplicates active lifecycle blockers and blocks an external profile transfer', () => {
  const connection = sanitizeConnection({ id: 'media', name: 'Media Archive', ...MEDIA_PROFILE });
  const blockers = collectConnectionRemovalBlockers({
    connection,
    jobs: [{ jobId: 'same-job', connectionId: 'media', status: 'paused' }],
    activeTransfer: {
      activeJobId: 'same-job',
      phase: 'verifying',
      profile: MEDIA_PROFILE,
    },
  });
  assert.equal(blockers.length, 1);
  const externalBlockers = collectConnectionRemovalBlockers({
    connection,
    activeTransfer: {
      activeJobId: 'other-job',
      isLifecycleActive: true,
      phase: 'uploading',
      profile: { remote: 'archive', bucket: 'archive', endpointHost: 'sfo3.digitaloceanspaces.com' },
    },
  });
  assert.equal(externalBlockers.length, 1);
  assert.equal(externalBlockers[0].jobId, 'other-job');
});

test('treats external active, paused, interrupted, and verifying transfers as connection blockers', () => {
  for (const transfer of [
    { isLifecycleActive: true, phase: 'uploading' },
    { isRunning: true, phase: 'uploading' },
    { phase: 'paused' },
    { phase: 'interrupted' },
    { phase: 'verifying' },
  ]) {
    assert.equal(transferBlocksConnectionChange(transfer), true, JSON.stringify(transfer));
  }
  assert.equal(transferBlocksConnectionChange({ phase: 'idle' }), false);
  assert.equal(transferBlocksConnectionChange({ phase: 'complete' }), false);
});

test('blocks removal when unfinished work matches the connection profile despite a mismatched id', () => {
  const connections = [
    sanitizeConnection({ id: 'media', name: 'Media Archive', ...MEDIA_PROFILE }),
    sanitizeConnection({
      id: 'archive',
      name: 'Archive',
      remote: 'archive',
      bucket: 'archive-media',
      endpointHost: 'sfo3.digitaloceanspaces.com',
    }),
  ];

  assert.throws(() => removeConnection(connections, 'media', [{
    connectionId: 'archive',
    profileSnapshot: {
      remote: 'media',
      bucket: 'media',
      endpointHost: 'NYC3.DIGITALOCEANSPACES.COM.',
    },
    status: 'uploading',
  }]), /unfinished/i);
});

test('canonical identity follows rclone remote case semantics and normalizes bucket and endpoint', () => {
  const profile = {
    remote: 'Archive',
    bucket: 'ARCHIVE-MEDIA',
    endpointHost: 'SFO3.DIGITALOCEANSPACES.COM.',
  };
  const tuple = canonicalConnectionTuple(profile);
  const expectedDigest = crypto.createHash('sha256').update(tuple, 'utf8').digest('hex').slice(0, 32);

  assert.equal(tuple, 'Archive\u0000archive-media\u0000sfo3.digitaloceanspaces.com');
  assert.equal(unmanagedConnectionId(profile), `unmanaged-${expectedDigest}`);
  assert.notEqual(
    canonicalConnectionTuple(profile),
    canonicalConnectionTuple({ ...profile, remote: 'archive' }),
    'Regular rclone remote names are case-sensitive.',
  );
});

test('resolves exact remote case while repairing old unmanaged ids to the SHA-256 identity', () => {
  const connections = [sanitizeConnection({
    id: 'archive',
    name: 'Archive',
    remote: 'Archive',
    bucket: 'archive-media',
    endpointHost: 'sfo3.digitaloceanspaces.com',
  })];
  const managed = resolveConnectionBinding({
    connections,
    connectionId: 'spoofed',
    profile: {
      remote: 'Archive',
      bucket: 'ARCHIVE-MEDIA',
      endpointHost: 'SFO3.DIGITALOCEANSPACES.COM.',
    },
  });
  const unmanaged = resolveConnectionBinding({
    connections,
    connectionId: 'unmanaged-deadbeef',
    profile: {
      remote: 'archive',
      bucket: 'archive-media',
      endpointHost: 'sfo3.digitaloceanspaces.com',
    },
  });

  assert.equal(managed.connectionId, 'archive');
  assert.match(unmanaged.connectionId, /^unmanaged-[a-f0-9]{32}$/);
  assert.notEqual(unmanaged.connectionId, 'unmanaged-deadbeef');
});

test('keeps an unmanaged tuple id stable when managed impostors are added or removed', () => {
  const profile = {
    remote: 'event+upload',
    bucket: 'event-media',
    endpointHost: 'fra1.digitaloceanspaces.com',
  };
  const expected = unmanagedConnectionId(profile);
  const impostor = {
    id: expected,
    name: 'Managed impostor',
    remote: 'other',
    bucket: 'other-media',
    endpointHost: 'sfo3.digitaloceanspaces.com',
  };

  assert.throws(() => sanitizeConnection(impostor), /connection.*id.*invalid/i);
  assert.equal(resolveConnectionBinding({ connections: [], profile }).connectionId, expected);
  assert.equal(resolveConnectionBinding({ connections: [impostor], profile }).connectionId, expected);
});

test('does not block removal for an unrelated case-distinct remote tuple', () => {
  const connections = [sanitizeConnection({
    id: 'archive',
    name: 'Archive',
    remote: 'Archive',
    bucket: 'archive-media',
    endpointHost: 'sfo3.digitaloceanspaces.com',
  })];

  assert.deepEqual(removeConnection(connections, 'archive', [{
    connectionId: 'unmanaged-deadbeef',
    profileSnapshot: {
      remote: 'archive',
      bucket: 'archive-media',
      endpointHost: 'sfo3.digitaloceanspaces.com',
    },
    status: 'uploading',
  }]), []);
});

test('treats malformed legacy profile values as absent migration data', () => {
  assert.deepEqual(migrateLegacyProfile({
    remote: 'archive',
    bucket: 'archive-media',
    endpointHost: 'https://invalid.example/path',
  }), { connections: [], activeConnectionId: '' });
});
