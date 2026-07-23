(function attachConnectionCore(root, factory) {
  const sha256Hex = typeof module === 'object' && module.exports
    ? require('./connection-digest-core').sha256Hex
    : root?.spacesUploader?.connectionIdentityDigest;
  const rcloneRemoteCore = typeof module === 'object' && module.exports
    ? require('./rclone-remote-core')
    : root?.rcloneRemoteCore;
  const core = factory(sha256Hex, rcloneRemoteCore);
  if (typeof module === 'object' && module.exports) {
    module.exports = core;
  }
  if (root) {
    root.connectionCore = core;
  }
})(typeof window !== 'undefined' ? window : null, function createConnectionCore(sha256Hex, rcloneRemoteCore) {
const CONNECTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DURABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const GENERATED_CONNECTION_ID_PATTERN = /^unmanaged-[a-f0-9]{32}$/;
const INTERNAL_CONNECTION_ID_PREFIX = /^(?:internal|system|unmanaged|uplink)-/i;
const WINDOWS_DEVICE_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;
const BUCKET_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{1,61}[a-z0-9])?$/;
const HOST_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TERMINAL_CONNECTION_JOB_STATUSES = new Set(['complete', 'verified']);
const ACTIVE_CONNECTION_TRANSFER_PHASES = new Set([
  'prechecking',
  'uploading',
  'verifying',
  'pausing',
  'paused',
  'interrupted',
  'needs-resume-check',
]);

function normalizePrefix(value = '') {
  return String(value)
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/{2,}/g, '/');
}

function sanitizePrefixList(value, limit = 8) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === 'string')
    .map(normalizePrefix)
    .filter(Boolean)
    .filter((item, index, list) => list.indexOf(item) === index)
    .slice(0, limit);
}

function requiredString(value, label, { maxLength = 128, pattern = null, lowerCase = false } = {}) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  const result = lowerCase ? normalized.toLowerCase() : normalized;
  if (!result || result.length > maxLength || /[\u0000-\u001f\u007f]/.test(result) || (pattern && !pattern.test(result))) {
    throw new TypeError(`Connection ${label} is invalid.`);
  }
  return result;
}

function sanitizeConnection(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const lastTestedAt = typeof source.lastTestedAt === 'string' ? source.lastTestedAt.trim() : '';
  if (lastTestedAt && !Number.isFinite(Date.parse(lastTestedAt))) {
    throw new TypeError('Connection last tested time is invalid.');
  }

  const profile = sanitizeConnectionProfile(source);
  const id = sanitizeConnectionId(source.id);
  if (!id) throw new TypeError('Connection id is invalid.');
  return {
    id,
    name: requiredString(source.name, 'name', { maxLength: 100 }),
    ...profile,
    publicRead: source.publicRead !== false,
    checksum: source.checksum === 'sha256' ? 'sha256' : 'size',
    recentPrefixes: sanitizePrefixList(source.recentPrefixes),
    pinnedPrefixes: sanitizePrefixList(source.pinnedPrefixes),
    lastTestedAt,
  };
}

function sanitizeDurableId(value = '') {
  const id = typeof value === 'string' ? value.trim() : '';
  return DURABLE_ID_PATTERN.test(id)
    && !id.includes('..')
    && !id.endsWith('.')
    && !WINDOWS_DEVICE_NAME.test(id)
    ? id
    : '';
}

function sanitizeConnectionId(value = '') {
  const id = sanitizeDurableId(value);
  return id
    && CONNECTION_ID_PATTERN.test(id)
    && !INTERNAL_CONNECTION_ID_PREFIX.test(id)
    ? id
    : '';
}

function sanitizeConnectionReferenceId(value = '') {
  const id = typeof value === 'string' ? value.trim() : '';
  if (GENERATED_CONNECTION_ID_PATTERN.test(id)) return id;
  return sanitizeConnectionId(id);
}

function isRepairableLegacyConnectionId(value = '') {
  const id = typeof value === 'string' ? value.trim() : '';
  return Boolean(id)
    && id.length <= 128
    && !/[\u0000-\u001f\u007f\\/]/.test(id);
}

function normalizeConnectionProfile(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return {
    remote: typeof source.remote === 'string' ? source.remote.trim() : '',
    bucket: typeof source.bucket === 'string' ? source.bucket.trim().toLowerCase() : '',
    endpointHost: typeof source.endpointHost === 'string'
      ? source.endpointHost.trim().toLowerCase().replace(/\.+$/g, '')
      : '',
  };
}

function sanitizeConnectionProfile(input = {}) {
  const profile = normalizeConnectionProfile(input);
  return {
    remote: rcloneRemoteCore.sanitizeRcloneRemoteName(profile.remote, { platform: 'win32' }),
    bucket: requiredString(profile.bucket, 'profile bucket', { maxLength: 63, pattern: BUCKET_PATTERN, lowerCase: true }),
    endpointHost: requiredString(profile.endpointHost, 'profile endpoint host', { maxLength: 253, pattern: HOST_PATTERN, lowerCase: true }),
  };
}

function canonicalConnectionTuple(input = {}) {
  const profile = normalizeConnectionProfile(input);
  return `${profile.remote}\u0000${profile.bucket}\u0000${profile.endpointHost}`;
}

function connectionProfileMatches(connection = {}, profile = {}) {
  const left = normalizeConnectionProfile(connection);
  const right = normalizeConnectionProfile(profile);
  return Boolean(left.remote && left.bucket && left.endpointHost)
    && canonicalConnectionTuple(left) === canonicalConnectionTuple(right);
}

function unmanagedConnectionId(profile = {}) {
  if (typeof sha256Hex !== 'function') {
    throw new Error('Connection identity digest is unavailable.');
  }
  return `unmanaged-${sha256Hex(canonicalConnectionTuple(profile)).slice(0, 32)}`;
}

function resolveConnectionBinding({ connections = [], connectionId = '', profile = {} } = {}) {
  const safeProfile = normalizeConnectionProfile(profile);
  const safeConnections = [];
  for (const candidate of Array.isArray(connections) ? connections : []) {
    try {
      safeConnections.push(sanitizeConnection(candidate));
    } catch (_error) {
      // Invalid descriptors cannot participate in identity resolution.
    }
  }
  const requestedId = sanitizeConnectionReferenceId(connectionId);
  const requested = safeConnections.find((connection) => connection.id === requestedId);
  const matched = requested && connectionProfileMatches(requested, safeProfile)
    ? requested
    : safeConnections.find((connection) => connectionProfileMatches(connection, safeProfile));

  return Object.freeze({
    connectionId: matched?.id || unmanagedConnectionId(safeProfile),
    managed: Boolean(matched),
    profile: Object.freeze({ ...safeProfile }),
  });
}

function stableConnectionId(remote = '') {
  const slug = String(remote)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
    .slice(0, 64);
  return sanitizeConnectionId(slug) || 'space';
}

function repairManagedConnectionId(value = '', profile = {}, collisionIndex = 0) {
  const existing = sanitizeConnectionId(value);
  if (existing && collisionIndex === 0) return existing;
  if (typeof sha256Hex !== 'function') {
    throw new Error('Connection identity digest is unavailable.');
  }
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  let base = raw
    .replace(/\.{2,}/g, '-')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+|[._-]+$/g, '')
    .slice(0, 43);
  if (!base || WINDOWS_DEVICE_NAME.test(base) || INTERNAL_CONNECTION_ID_PREFIX.test(base)) {
    base = stableConnectionId(profile.remote);
  }
  if (!sanitizeConnectionId(base)) base = 'space';
  const suffix = sha256Hex([
    'managed',
    canonicalConnectionTuple(profile),
    raw,
    String(collisionIndex),
  ].join('\u0000')).slice(0, 12);
  return `${base.slice(0, 51)}-${suffix}`;
}

function migrateLegacyProfile(profile, preferences = {}) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    return { connections: [], activeConnectionId: '' };
  }
  const remote = typeof profile.remote === 'string' ? profile.remote.trim() : '';
  const bucket = typeof profile.bucket === 'string' ? profile.bucket.trim() : '';
  const endpointHost = typeof profile.endpointHost === 'string' ? profile.endpointHost.trim() : '';
  if (!remote || !bucket || !endpointHost) {
    return { connections: [], activeConnectionId: '' };
  }
  let descriptor;
  try {
    descriptor = sanitizeConnection({
      id: stableConnectionId(remote),
      name: remote,
      remote,
      bucket,
      endpointHost,
      publicRead: preferences.publicRead,
      checksum: preferences.checksum,
      recentPrefixes: preferences.recentPrefixes,
      pinnedPrefixes: preferences.pinnedPrefixes,
      lastTestedAt: preferences.lastTestedAt,
    });
  } catch (_error) {
    return { connections: [], activeConnectionId: '' };
  }
  return { connections: [descriptor], activeConnectionId: descriptor.id };
}

function jobBlocksConnectionRemoval(job = {}, id = '', connection = null) {
  if (!job || typeof job !== 'object') return false;
  const referencesId = job.connectionId === id;
  const referencesProfile = connectionProfileMatches(connection || {}, job.profileSnapshot || job.profile || {});
  if (!referencesId && !referencesProfile) return false;
  if (TERMINAL_CONNECTION_JOB_STATUSES.has(job.status)) return false;
  if (job.status === 'warning') {
    const verification = job.verification || {};
    const checksum = job.checksum || {};
    return verification.ok !== true || checksum.ok === false;
  }
  return true;
}

function collectConnectionRemovalBlockers({ connection, jobs = [], activeTransfer = null } = {}) {
  const descriptor = sanitizeConnection(connection || {});
  const blockers = (Array.isArray(jobs) ? jobs : [])
    .filter((job) => jobBlocksConnectionRemoval(job, descriptor.id, descriptor));
  const active = activeTransfer && typeof activeTransfer === 'object' ? activeTransfer : {};
  const activePhase = typeof active.phase === 'string' ? active.phase.trim() : '';
  const activeBlocks = transferBlocksConnectionChange(active);

  if (activeBlocks) {
    blockers.push({
      id: typeof active.intentId === 'string' ? active.intentId : '',
      jobId: typeof active.activeJobId === 'string' ? active.activeJobId : '',
      connectionId: descriptor.id,
      profile: descriptor,
      prefix: typeof active.prefix === 'string' ? active.prefix : '',
      status: activePhase || 'unfinished',
    });
  }

  return blockers.filter((job, index, list) => {
    const key = job.jobId || job.id;
    if (!key) return index === list.findIndex((candidate) => !candidate.jobId && !candidate.id);
    return index === list.findIndex((candidate) => (candidate.jobId || candidate.id) === key);
  });
}

function transferBlocksConnectionChange(transfer = {}) {
  if (!transfer || typeof transfer !== 'object') return false;
  const phase = typeof transfer.phase === 'string' ? transfer.phase.trim() : '';
  return transfer.isLifecycleActive === true
    || transfer.isRunning === true
    || ACTIVE_CONNECTION_TRANSFER_PHASES.has(phase);
}

function removeConnection(connections, id, jobs = []) {
  const targetId = typeof id === 'string' ? id.trim() : '';
  if (!targetId) throw new TypeError('Connection id is required.');
  const sanitizedConnections = (Array.isArray(connections) ? connections : []).map(sanitizeConnection);
  const target = sanitizedConnections.find((connection) => connection.id === targetId) || null;
  if ((Array.isArray(jobs) ? jobs : []).some((job) => jobBlocksConnectionRemoval(job, targetId, target))) {
    throw new Error('Connection has unfinished uploads or checks.');
  }
  const result = sanitizedConnections
    .filter((connection) => connection.id !== targetId)
    .map((connection) => Object.freeze({
      ...connection,
      recentPrefixes: Object.freeze([...connection.recentPrefixes]),
      pinnedPrefixes: Object.freeze([...connection.pinnedPrefixes]),
    }));
  return Object.freeze(result);
}

function connectionStateAfterRemoval({ connections = [], removeId = '', activeConnectionId = '', jobs = [] } = {}) {
  const nextConnections = [...removeConnection(connections, removeId, jobs)];
  const activeStillExists = nextConnections.find((connection) => connection.id === activeConnectionId) || null;
  const nextActive = activeStillExists || nextConnections[0] || null;
  return Object.freeze({
    connections: Object.freeze(nextConnections),
    activeConnectionId: nextActive?.id || '',
    activeConnection: nextActive,
  });
}

return {
  canonicalConnectionTuple,
  connectionProfileMatches,
  CONNECTION_ID_PATTERN,
  DURABLE_ID_PATTERN,
  GENERATED_CONNECTION_ID_PATTERN,
  isRepairableLegacyConnectionId,
  collectConnectionRemovalBlockers,
  connectionStateAfterRemoval,
  jobBlocksConnectionRemoval,
  migrateLegacyProfile,
  removeConnection,
  repairManagedConnectionId,
  resolveConnectionBinding,
  sanitizeConnection,
  sanitizeConnectionProfile,
  sanitizeConnectionId,
  sanitizeConnectionReferenceId,
  sanitizeDurableId,
  normalizeConnectionProfile,
  sanitizePrefixList,
  transferBlocksConnectionChange,
  unmanagedConnectionId,
};
});
