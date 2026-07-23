const fs = require('node:fs');
const path = require('node:path');
const { readJsonWithBackup, writeJsonAtomic } = require('./atomic-json-core');
const {
  canonicalConnectionTuple,
  isRepairableLegacyConnectionId,
  migrateLegacyProfile,
  normalizeConnectionProfile,
  repairManagedConnectionId,
  resolveConnectionBinding,
  sanitizeConnection,
  sanitizeConnectionId,
  sanitizeConnectionReferenceId,
  sanitizeConnectionProfile,
  sanitizeDurableId,
} = require('./connection-core');
const { connectionDescriptorForProfile } = require('./navigation-core');
const { DEFAULT_PROFILE } = require('./upload-core');

const DEFAULT_SETTINGS = {
  settingsVersion: 2,
  connections: [],
  activeConnectionId: '',
  source: '',
  prefix: DEFAULT_PROFILE.defaultPrefix,
  include: DEFAULT_PROFILE.defaultInclude,
  filterMode: DEFAULT_PROFILE.defaultFilterMode,
  publicRead: true,
  checksum: 'sha256',
  notifyWebhook: '',
  notifyNtfy: '',
  notifyOn: 'success',
  folderUploadMode: 'package',
  recentPrefixes: [],
  recentPrefixesByConnection: {},
  pinnedPrefixes: [],
  archiveEvent: 'event',
  archiveCategory: 'raw',
  archiveStage: 'main',
  archiveDay: 'day-1',
  archivePackageName: 'mix',
  profile: {
    remote: DEFAULT_PROFILE.remote,
    bucket: DEFAULT_PROFILE.bucket,
    endpointHost: DEFAULT_PROFILE.endpointHost,
  },
  queueJobs: [],
};
const RECOGNIZED_SETTINGS_FIELDS = new Set(Object.keys(DEFAULT_SETTINGS));
const FILTER_MODES = new Set(['all', 'videos-images', 'media-docs', 'custom']);
const CHECKSUM_MODES = new Set(['size', 'sha256']);
const NOTIFY_MODES = new Set(['success', 'failure', 'always']);
const FOLDER_UPLOAD_MODES = new Set(['package', 'contents']);
const ARCHIVE_CATEGORIES = new Set(['raw', 'livestream', 'talks']);
const PROFILE_FIELDS = new Set(['remote', 'bucket', 'endpointHost']);
const QUEUE_PROFILE_FIELDS = new Set(['remote', 'bucket', 'endpointHost']);
const QUEUE_NOTIFICATION_FIELDS = new Set(['webhook', 'ntfy', 'notifyOn']);
const QUEUE_JOB_FIELDS = new Set([
  'id',
  'intentId',
  'clientJobId',
  'sources',
  'connectionId',
  'profile',
  'profileSnapshot',
  'prefix',
  'filterMode',
  'include',
  'folderUploadMode',
  'publicRead',
  'checksum',
  'notifications',
  'status',
  'jobId',
  'resumeFromJobId',
  'urls',
  'error',
  'verification',
  'direction',
  'localDestination',
  'remoteItems',
]);
const QUEUE_REMOTE_ITEM_FIELDS = new Set(['name', 'path', 'isDir', 'size', 'modified']);
const QUEUE_JOB_STATUSES = new Set([
  'queued',
  'ready',
  'failed',
  'blocked',
  'paused',
  'cancelled',
  'needs-resume-check',
  'prechecking',
  'uploading',
  'verifying',
  'pausing',
  'complete',
]);
const SECRET_SHAPED_KEY = /(?:secret|password|credential|access.?key|api.?key|bearer|token)/i;

function isObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasSecretShapedKey(value, seen = new Set()) {
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_SHAPED_KEY.test(key) || hasSecretShapedKey(child, seen)) return true;
  }
  return false;
}

function stripSecretShapedFields(value, seen = new Set()) {
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => stripSecretShapedFields(item, seen));
  }
  const result = {};
  const structuralContainers = new Set(['connections', 'queueJobs', 'profile', 'profileSnapshot']);
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_SHAPED_KEY.test(key)) continue;
    const childHasSecrets = hasSecretShapedKey(child);
    if (childHasSecrets && !structuralContainers.has(key)) continue;
    result[key] = stripSecretShapedFields(child, seen);
  }
  return result;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isStringArrayMap(value) {
  return isObject(value) && Object.values(value).every(isStringArray);
}

function isProfileCandidate(value) {
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0
    && keys.every((key) => PROFILE_FIELDS.has(key) && typeof value[key] === 'string');
}

function isQueueProfileCandidate(value) {
  return isObject(value)
    && ['remote', 'bucket', 'endpointHost'].every((key) => typeof value[key] === 'string' && value[key].trim());
}

function isStrictQueueProfile(value) {
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== QUEUE_PROFILE_FIELDS.size || !keys.every((key) => QUEUE_PROFILE_FIELDS.has(key))) return false;
  try {
    sanitizeConnectionProfile(value);
    return true;
  } catch (_error) {
    return false;
  }
}

function isSafeQueueId(value, optional = false) {
  if (optional && (value === undefined || value === '')) return true;
  return typeof value === 'string' && sanitizeDurableId(value) === value;
}

function isQueuePrefix(value) {
  return typeof value === 'string'
    && value.length <= 2_048
    && !/[\u0000-\u001f\u007f]/.test(value)
    && !value.split(/[\\/]+/).includes('..');
}

function isSafePersistedString(value) {
  return typeof value === 'string'
    && value.length <= 32_768
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function isQueueNotifications(value) {
  if (!isObject(value) || !Object.keys(value).every((key) => QUEUE_NOTIFICATION_FIELDS.has(key))) return false;
  if (value.webhook !== undefined && !isSafePersistedString(value.webhook)) return false;
  if (value.ntfy !== undefined && !isSafePersistedString(value.ntfy)) return false;
  if (value.notifyOn !== undefined && !NOTIFY_MODES.has(value.notifyOn)) return false;
  return true;
}

function isSafeRemoteItem(value) {
  if (!isObject(value) || !Object.keys(value).every((key) => QUEUE_REMOTE_ITEM_FIELDS.has(key))) return false;
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  const remotePath = typeof value.path === 'string' ? value.path.replace(/\\/g, '/').trim() : '';
  const segments = remotePath.split('/');
  return Boolean(name)
    && !/[\\/\u0000-\u001f\u007f]/.test(name)
    && name !== '.'
    && name !== '..'
    && Boolean(remotePath)
    && !remotePath.startsWith('/')
    && !segments.some((segment) => !segment || segment === '.' || segment === '..')
    && !/[\u0000-\u001f\u007f]/.test(remotePath)
    && typeof value.isDir === 'boolean'
    && Number.isFinite(Number(value.size))
    && Number(value.size) >= 0
    && (value.modified === undefined || typeof value.modified === 'string');
}

function isPersistedQueueJobCandidate(value) {
  if (!isObject(value) || !Object.keys(value).every((key) => QUEUE_JOB_FIELDS.has(key))) return false;
  if (!isSafeQueueId(value.id)) return false;
  if (!Array.isArray(value.sources)
    || value.sources.length === 0
    || value.sources.length > 1_000
    || !value.sources.every((source) => isSafePersistedString(source) && source.trim())) return false;
  if (!isQueuePrefix(value.prefix) || !QUEUE_JOB_STATUSES.has(value.status)) return false;
  if (!isSafeQueueId(value.intentId, true) || !isSafeQueueId(value.clientJobId, true)) return false;
  if (!isSafeQueueId(value.jobId, true) || !isSafeQueueId(value.resumeFromJobId, true)) return false;
  if (value.connectionId !== undefined
    && value.connectionId !== ''
    && sanitizeConnectionReferenceId(value.connectionId) !== value.connectionId) return false;
  if (value.profile !== undefined && !isStrictQueueProfile(value.profile)) return false;
  if (value.profileSnapshot !== undefined && !isStrictQueueProfile(value.profileSnapshot)) return false;
  if (value.profile && value.profileSnapshot
    && canonicalConnectionTuple(value.profile) !== canonicalConnectionTuple(value.profileSnapshot)) return false;
  if (value.filterMode !== undefined && !FILTER_MODES.has(value.filterMode)) return false;
  if (value.include !== undefined && !isSafePersistedString(value.include)) return false;
  if (value.folderUploadMode !== undefined && !FOLDER_UPLOAD_MODES.has(value.folderUploadMode)) return false;
  if (value.publicRead !== undefined && typeof value.publicRead !== 'boolean') return false;
  if (value.checksum !== undefined && !CHECKSUM_MODES.has(value.checksum)) return false;
  if (value.notifications !== undefined && !isQueueNotifications(value.notifications)) return false;
  if (value.urls !== undefined
    && (!Array.isArray(value.urls) || value.urls.length > 1_000 || !value.urls.every(isSafePersistedString))) return false;
  if (value.error !== undefined && !isSafePersistedString(value.error)) return false;
  if (value.verification !== undefined
    && value.verification !== null
    && !isObject(value.verification)) return false;
  const direction = value.direction === undefined ? 'upload' : value.direction;
  if (!['upload', 'download'].includes(direction)) return false;
  if (direction === 'download') {
    if (typeof value.localDestination !== 'string' || !path.win32.isAbsolute(value.localDestination)) return false;
    if (!Array.isArray(value.remoteItems)
      || !value.remoteItems.length
      || value.remoteItems.length > 1_000
      || !value.remoteItems.every(isSafeRemoteItem)) return false;
  } else if ((value.localDestination !== undefined && value.localDestination !== '')
    || (value.remoteItems !== undefined && (!Array.isArray(value.remoteItems) || value.remoteItems.length))) {
    return false;
  }
  return true;
}

const SETTINGS_FIELD_VALIDATORS = {
  settingsVersion: (value) => value === 1 || value === 2,
  connections: (value) => Array.isArray(value),
  activeConnectionId: (value) => typeof value === 'string',
  source: (value) => typeof value === 'string',
  prefix: (value) => typeof value === 'string',
  include: (value) => typeof value === 'string',
  filterMode: (value) => FILTER_MODES.has(value),
  publicRead: (value) => typeof value === 'boolean',
  checksum: (value) => CHECKSUM_MODES.has(value),
  notifyWebhook: (value) => typeof value === 'string',
  notifyNtfy: (value) => typeof value === 'string',
  notifyOn: (value) => NOTIFY_MODES.has(value),
  folderUploadMode: (value) => FOLDER_UPLOAD_MODES.has(value),
  recentPrefixes: isStringArray,
  recentPrefixesByConnection: isStringArrayMap,
  pinnedPrefixes: isStringArray,
  archiveEvent: (value) => typeof value === 'string',
  archiveCategory: (value) => ARCHIVE_CATEGORIES.has(value),
  archiveStage: (value) => typeof value === 'string',
  archiveDay: (value) => typeof value === 'string',
  archivePackageName: (value) => typeof value === 'string',
  profile: (value) => isQueueProfileCandidate(stripSecretShapedFields(value)),
  queueJobs: (value) => Array.isArray(value),
};

function isSettingsCandidate(value) {
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0
    && keys.every((key) => RECOGNIZED_SETTINGS_FIELDS.has(key))
    && keys.every((key) => SETTINGS_FIELD_VALIDATORS[key](value[key]));
}

function sanitizePrefixList(value, limit = 8) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item) => typeof item === 'string')
    .map((item) =>
      item
        .trim()
        .replace(/\\/g, '/')
        .replace(/^\/+|\/+$/g, '')
        .replace(/\/{2,}/g, '/'),
    )
    .filter(Boolean)
    .filter((item, index, list) => list.indexOf(item) === index)
    .slice(0, limit);
}

function sanitizeRecentPrefixesByConnection(
  value,
  legacyPrefixes,
  profile,
  connectionId = '',
  identityMap = new Map(),
  limit = 32,
) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const result = {};
  const blockedIds = new Set(['__proto__', 'constructor', 'prototype']);

  for (const [rawId, prefixes] of Object.entries(source)) {
    if (Object.keys(result).length >= limit) break;
    const sourceId = String(rawId || '').trim();
    const id = identityMap.get(sourceId) || sourceId;
    if (!id || id.length > 256 || blockedIds.has(id) || !Array.isArray(prefixes)) continue;
    const sanitized = sanitizePrefixList(prefixes);
    if (sanitized.length) {
      result[id] = sanitized;
    }
  }

  if (legacyPrefixes.length) {
    const legacyId = connectionId || connectionDescriptorForProfile(profile).id;
    if (!Object.hasOwn(result, legacyId)) {
      const ids = Object.keys(result);
      if (ids.length >= limit) {
        delete result[ids.at(-1)];
      }
      result[legacyId] = legacyPrefixes;
    }
  }

  return result;
}

function sanitizeSettings(input = {}) {
  input = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  input = stripSecretShapedFields(input);
  const filterMode = ['all', 'videos-images', 'media-docs', 'custom'].includes(input.filterMode)
    ? input.filterMode
    : DEFAULT_SETTINGS.filterMode;
  const include =
    filterMode === 'custom' && typeof input.include === 'string' && input.include.trim()
      ? input.include.trim()
      : DEFAULT_SETTINGS.include;
  const isVersion2 = input.settingsVersion === 2
    || Array.isArray(input.connections)
    || Object.hasOwn(input, 'activeConnectionId');
  const legacyProfile = isProfileCandidate(input.profile) ? input.profile : null;
  const profile = sanitizeProfile(input.profile);
  const recentPrefixes = sanitizePrefixList(input.recentPrefixes);
  const legacyProfileId = connectionDescriptorForProfile(profile).id;
  const legacyScopedRecents = sanitizePrefixList(input.recentPrefixesByConnection?.[legacyProfileId]);
  const migrated = isVersion2
    ? { connections: [], activeConnectionId: '' }
    : migrateLegacyProfile(legacyProfile, {
      recentPrefixes: recentPrefixes.length ? recentPrefixes : legacyScopedRecents,
      pinnedPrefixes: input.pinnedPrefixes,
      publicRead: typeof input.publicRead === 'boolean' ? input.publicRead : DEFAULT_SETTINGS.publicRead,
      checksum: CHECKSUM_MODES.has(input.checksum) ? input.checksum : DEFAULT_SETTINGS.checksum,
    });
  const connectionMigration = sanitizeConnectionsWithIdentityMap(
    isVersion2 ? input.connections : migrated.connections,
  );
  let { connections } = connectionMigration;
  const rawRequestedActiveId = isVersion2
    ? String(input.activeConnectionId || '').trim()
    : migrated.activeConnectionId;
  const requestedActiveId = connectionMigration.identityMap.get(rawRequestedActiveId)
    || sanitizeConnectionId(rawRequestedActiveId);
  const activeConnectionId = connections.some((connection) => connection.id === requestedActiveId)
    ? requestedActiveId
    : connections[0]?.id || '';
  if (isVersion2 && activeConnectionId) {
    connections = connections.map((connection) => {
      if (connection.id !== activeConnectionId) return connection;
      const scopedRecents = sanitizePrefixList(
        input.recentPrefixesByConnection?.[activeConnectionId]
          || input.recentPrefixesByConnection?.[rawRequestedActiveId],
      );
      return sanitizeConnection({
        ...connection,
        publicRead: typeof input.publicRead === 'boolean' ? input.publicRead : connection.publicRead,
        checksum: CHECKSUM_MODES.has(input.checksum) ? input.checksum : connection.checksum,
        recentPrefixes: Array.isArray(input.recentPrefixes)
          ? recentPrefixes
          : scopedRecents.length ? scopedRecents : connection.recentPrefixes,
        pinnedPrefixes: Array.isArray(input.pinnedPrefixes)
          ? sanitizePrefixList(input.pinnedPrefixes)
          : connection.pinnedPrefixes,
      });
    });
  }
  const activeConnection = connections.find((connection) => connection.id === activeConnectionId) || null;
  const compatibleProfile = activeConnection
    ? {
      remote: activeConnection.remote,
      bucket: activeConnection.bucket,
      endpointHost: activeConnection.endpointHost,
    }
    : profile;
  const compatibleRecents = activeConnection?.recentPrefixes || recentPrefixes;
  const compatiblePins = activeConnection?.pinnedPrefixes || sanitizePrefixList(input.pinnedPrefixes);

  return {
    settingsVersion: 2,
    connections,
    activeConnectionId,
    source: typeof input.source === 'string' ? input.source : DEFAULT_SETTINGS.source,
    prefix:
      typeof input.prefix === 'string' && input.prefix.trim()
        ? input.prefix.trim()
        : DEFAULT_SETTINGS.prefix,
    include,
    filterMode,
    publicRead:
      activeConnection?.publicRead
        ?? (typeof input.publicRead === 'boolean' ? input.publicRead : DEFAULT_SETTINGS.publicRead),
    checksum:
      activeConnection?.checksum
        || (['size', 'sha256'].includes(input.checksum) ? input.checksum : DEFAULT_SETTINGS.checksum),
    notifyWebhook:
      typeof input.notifyWebhook === 'string' ? input.notifyWebhook.trim() : DEFAULT_SETTINGS.notifyWebhook,
    notifyNtfy:
      typeof input.notifyNtfy === 'string' ? input.notifyNtfy.trim() : DEFAULT_SETTINGS.notifyNtfy,
    notifyOn:
      ['success', 'failure', 'always'].includes(input.notifyOn)
        ? input.notifyOn
        : DEFAULT_SETTINGS.notifyOn,
    folderUploadMode:
      input.folderUploadMode === 'contents' ? 'contents' : DEFAULT_SETTINGS.folderUploadMode,
    recentPrefixes: compatibleRecents,
    recentPrefixesByConnection: sanitizeRecentPrefixesByConnection(
      input.recentPrefixesByConnection,
      compatibleRecents,
      compatibleProfile,
      activeConnectionId,
      connectionMigration.identityMap,
    ),
    pinnedPrefixes: compatiblePins,
    archiveEvent:
      typeof input.archiveEvent === 'string' && input.archiveEvent.trim()
        ? input.archiveEvent.trim()
        : DEFAULT_SETTINGS.archiveEvent,
    archiveCategory:
      ['raw', 'livestream', 'talks'].includes(input.archiveCategory)
        ? input.archiveCategory
        : DEFAULT_SETTINGS.archiveCategory,
    archiveStage:
      typeof input.archiveStage === 'string' && input.archiveStage.trim()
        ? input.archiveStage.trim()
        : DEFAULT_SETTINGS.archiveStage,
    archiveDay:
      typeof input.archiveDay === 'string' && input.archiveDay.trim()
        ? input.archiveDay.trim()
        : DEFAULT_SETTINGS.archiveDay,
    archivePackageName:
      typeof input.archivePackageName === 'string' && input.archivePackageName.trim()
        ? input.archivePackageName.trim()
        : DEFAULT_SETTINGS.archivePackageName,
    profile: compatibleProfile,
    queueJobs: sanitizeQueueJobs(input.queueJobs, connections, 100, connectionMigration.identityMap),
  };
}

function sanitizeConnectionsWithIdentityMap(value, limit = 32) {
  if (!Array.isArray(value)) return { connections: [], identityMap: new Map() };
  const seen = new Set();
  const connections = [];
  const identityMap = new Map();
  for (const candidate of value) {
    if (connections.length >= limit) break;
    try {
      const profile = sanitizeConnectionProfile(candidate);
      const rawId = typeof candidate?.id === 'string' ? candidate.id.trim() : '';
      if (!sanitizeConnectionId(rawId) && !isRepairableLegacyConnectionId(rawId)) {
        throw new Error('Connection id cannot be migrated safely');
      }
      let id = sanitizeConnectionId(rawId) || repairManagedConnectionId(rawId, profile);
      let connection = sanitizeConnection({ ...candidate, ...profile, id });
      let collisionIndex = 0;
      while (seen.has(id)) {
        const existing = connections.find((item) => item.id === id);
        if (existing && canonicalConnectionTuple(existing) === canonicalConnectionTuple(connection)) {
          if (rawId && !identityMap.has(rawId)) identityMap.set(rawId, id);
          connection = null;
          break;
        }
        collisionIndex += 1;
        id = repairManagedConnectionId(rawId, profile, collisionIndex);
        connection = sanitizeConnection({ ...candidate, ...profile, id });
      }
      if (!connection) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      if (rawId && !identityMap.has(rawId)) identityMap.set(rawId, id);
      connections.push(connection);
    } catch (_error) {
      // A malformed descriptor cannot invalidate unrelated safe connections.
    }
  }
  return { connections, identityMap };
}

function sanitizeConnections(value, limit = 32) {
  return sanitizeConnectionsWithIdentityMap(value, limit).connections;
}

function sanitizeProfile(input = {}) {
  const profile = input && typeof input === 'object' ? input : {};
  const remote =
    typeof profile.remote === 'string' && profile.remote.trim()
      ? profile.remote.trim()
      : DEFAULT_SETTINGS.profile.remote;
  const bucket =
    typeof profile.bucket === 'string' && profile.bucket.trim()
      ? profile.bucket.trim()
      : DEFAULT_SETTINGS.profile.bucket;
  const endpointHost =
    typeof profile.endpointHost === 'string' && profile.endpointHost.trim()
      ? profile.endpointHost.trim()
      : DEFAULT_SETTINGS.profile.endpointHost;
  try {
    return sanitizeConnectionProfile({ remote, bucket, endpointHost });
  } catch (_error) {
    return normalizeConnectionProfile(DEFAULT_SETTINGS.profile);
  }
}

function sanitizeQueueJobs(value, connections = [], limit = 100, identityMap = new Map()) {
  if (!Array.isArray(value)) {
    return [];
  }
  // Unknown or future fields are dropped deliberately: an older runtime must not infer new upload behavior.
  return stripSecretShapedFields(value)
    .map((job) => {
      if (!isObject(job)) return job;
      const rawConnectionId = typeof job.connectionId === 'string' ? job.connectionId.trim() : '';
      const repairedConnectionId = identityMap.get(rawConnectionId)
        || sanitizeConnectionReferenceId(rawConnectionId)
        || (isRepairableLegacyConnectionId(rawConnectionId) && /^unmanaged-/i.test(rawConnectionId)
          ? ''
          : rawConnectionId);
      return { ...job, connectionId: repairedConnectionId };
    })
    .filter(isPersistedQueueJobCandidate)
    .map((job) => {
      const referencedConnection = connections.find((connection) => connection.id === job.connectionId);
      const canonicalProfile = sanitizeConnectionProfile(
        job.profileSnapshot || job.profile || referencedConnection || DEFAULT_SETTINGS.profile,
      );
      const binding = resolveConnectionBinding({
        connections,
        connectionId: job.connectionId,
        profile: canonicalProfile,
      });
      const profile = Object.freeze({ ...binding.profile });
      const profileSnapshot = Object.freeze({ ...binding.profile });
      return ({
        id: typeof job.id === 'string' && job.id.trim() ? job.id.trim() : '',
        intentId: typeof job.intentId === 'string' ? job.intentId.trim().slice(0, 256) : '',
        clientJobId: typeof job.clientJobId === 'string' ? job.clientJobId.trim().slice(0, 256) : '',
        sources: Array.isArray(job.sources)
          ? job.sources.filter((source) => typeof source === 'string' && source.trim())
          : [],
        connectionId: binding.connectionId,
        profile,
        profileSnapshot,
        prefix:
          typeof job.prefix === 'string' && job.prefix.trim()
            ? job.prefix.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/')
            : DEFAULT_SETTINGS.prefix,
        include: typeof job.include === 'string' ? job.include.trim() : DEFAULT_SETTINGS.include,
        filterMode: ['all', 'videos-images', 'media-docs', 'custom'].includes(job.filterMode)
          ? job.filterMode
          : DEFAULT_SETTINGS.filterMode,
        publicRead: typeof job.publicRead === 'boolean' ? job.publicRead : DEFAULT_SETTINGS.publicRead,
        checksum: ['size', 'sha256'].includes(job.checksum) ? job.checksum : DEFAULT_SETTINGS.checksum,
        folderUploadMode: job.folderUploadMode === 'contents' ? 'contents' : DEFAULT_SETTINGS.folderUploadMode,
        notifications: {
          webhook: '',
          ntfy: '',
          notifyOn: ['success', 'failure', 'always'].includes(job.notifications?.notifyOn)
            ? job.notifications.notifyOn
            : DEFAULT_SETTINGS.notifyOn,
        },
        status: job.status,
        jobId: typeof job.jobId === 'string' ? job.jobId : '',
        resumeFromJobId: typeof job.resumeFromJobId === 'string'
          ? job.resumeFromJobId.trim().slice(0, 256)
          : '',
        urls: Array.isArray(job.urls) ? job.urls.filter((url) => typeof url === 'string') : [],
        error: typeof job.error === 'string' ? job.error : '',
        verification: null,
        direction: job.direction === 'download' ? 'download' : 'upload',
        localDestination: job.direction === 'download' ? path.win32.resolve(job.localDestination) : '',
        remoteItems: job.direction === 'download'
          ? job.remoteItems.map((item) => ({
            name: item.name.trim(),
            path: item.path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''),
            isDir: item.isDir,
            size: Number(item.size),
            modified: typeof item.modified === 'string' ? item.modified : '',
          }))
          : [],
      });
    })
    .filter((job) => job.id && job.sources.length)
    .slice(0, limit);
}

function readSettings(settingsPath) {
  const rawPrimary = readRawJson(settingsPath);
  const rawBackup = readRawJson(`${settingsPath}.bak`);
  const settings = readJsonWithBackup(settingsPath, { validator: isSettingsReadCandidate });
  const sanitized = sanitizeSettings(settings === null ? DEFAULT_SETTINGS : settings);
  if (hasSecretShapedKey(rawPrimary) || hasSecretShapedKey(rawBackup)) {
    writeSettings(settingsPath, sanitized);
    if (hasSecretShapedKey(readRawJson(`${settingsPath}.bak`))) {
      writeSettings(settingsPath, sanitized);
    }
  }
  return sanitized;
}

function readRawJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return null;
  }
}

function isSettingsReadCandidate(value) {
  if (!isSettingsCandidate(value)) return false;
  const connectionMigration = sanitizeConnectionsWithIdentityMap(value.connections);
  if (value.connections?.length && connectionMigration.connections.length === 0) return false;
  if (value.queueJobs?.length && sanitizeQueueJobs(
    value.queueJobs,
    connectionMigration.connections,
    100,
    connectionMigration.identityMap,
  ).length === 0) {
    return false;
  }
  return true;
}

function isSettingsWriteCandidate(value) {
  return !hasSecretShapedKey(value)
    && isSettingsReadCandidate(value)
    && (!value.connections || value.connections.every((connection) => {
      try {
        sanitizeConnection(connection);
        return true;
      } catch (_error) {
        return false;
      }
    }))
    && (!value.queueJobs || value.queueJobs.every(isPersistedQueueJobCandidate));
}

function writeSettings(settingsPath, settings, options = {}) {
  const sanitized = sanitizeSettings(settings);
  writeJsonAtomic(settingsPath, sanitized, { ...options, validator: isSettingsWriteCandidate });
  return sanitized;
}

module.exports = {
  DEFAULT_SETTINGS,
  isSettingsCandidate,
  readSettings,
  sanitizeProfile,
  sanitizeConnections,
  sanitizeSettings,
  sanitizeQueueJobs,
  writeSettings,
};
