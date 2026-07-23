const { sanitizeRcloneRemoteName } = require('./rclone-remote-core');

const DEFAULT_UPLOAD_DEFAULTS = {
  publicRead: true,
  sizeOnly: true,
  transfers: 4,
  chunkSize: '64M',
  uploadConcurrency: 4,
  retries: 20,
  retriesSleep: '30s',
  lowLevelRetries: 60,
};

const DEFAULT_EVENT_MANIFEST = {
  client: 'Example Organization',
  eventName: 'sample-event',
  eventPrefix: 'sample-event',
  year: 2026,
  eventNumber: 1,
  remote: 'media',
  bucket: 'media-archive',
  endpointHost: 'media-archive.nyc3.digitaloceanspaces.com',
  recordingsPrefix: 'sample-event/recordings',
  stages: ['Main', 'Talk', 'Workshop'],
  days: ['Day 1', 'Day 2', 'Day 3'],
  localRoots: [],
  uploadDefaults: DEFAULT_UPLOAD_DEFAULTS,
};

const SECRET_KEY_PATTERN = /(secret|access[_-]?key|api[_-]?key|password|token|credential|webhook)/i;

function normalizePathPart(value = '') {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/{2,}/g, '/');
}

function slugEventName(value = '', fallback = 'event') {
  const clean = String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return clean || fallback;
}

function normalizeStage(value = '') {
  const clean = String(value || '').trim();
  if (!clean) return '';
  if (/^main$/i.test(clean)) return 'Main';
  if (/^talks?$/i.test(clean)) return 'Talk';
  if (/^workshops?$/i.test(clean)) return 'Workshop';
  return clean;
}

function normalizeDay(value = '') {
  const clean = String(value || '').trim();
  const number = clean.match(/\d+/)?.[0];
  return number ? `Day ${number}` : clean;
}

function findSecretShapedKeys(value, prefix = '') {
  if (!value || typeof value !== 'object') return [];
  const found = [];
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (SECRET_KEY_PATTERN.test(key)) {
      found.push(path);
    }
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      found.push(...findSecretShapedKeys(child, path));
    }
  }
  return found;
}

function normalizeUploadDefaults(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    ...DEFAULT_UPLOAD_DEFAULTS,
    publicRead: source.publicRead !== false,
    sizeOnly: source.sizeOnly !== false,
    transfers: Number(source.transfers || DEFAULT_UPLOAD_DEFAULTS.transfers),
    chunkSize: String(source.chunkSize || DEFAULT_UPLOAD_DEFAULTS.chunkSize),
    uploadConcurrency: Number(source.uploadConcurrency || DEFAULT_UPLOAD_DEFAULTS.uploadConcurrency),
    retries: Number(source.retries || DEFAULT_UPLOAD_DEFAULTS.retries),
    retriesSleep: String(source.retriesSleep || DEFAULT_UPLOAD_DEFAULTS.retriesSleep),
    lowLevelRetries: Number(source.lowLevelRetries || DEFAULT_UPLOAD_DEFAULTS.lowLevelRetries),
  };
}

function normalizeEventManifest(input = {}) {
  const secretKeys = findSecretShapedKeys(input);
  if (secretKeys.length) {
    throw new Error(`Event manifest contains secret-shaped field(s): ${secretKeys.join(', ')}`);
  }

  const source = {
    ...DEFAULT_EVENT_MANIFEST,
    ...(input && typeof input === 'object' ? input : {}),
  };
  const eventPrefix = normalizePathPart(source.eventPrefix || slugEventName(source.eventName, 'event'));
  if (!eventPrefix || eventPrefix.includes('..')) {
    throw new Error('Event prefix must be a safe non-empty relative path.');
  }

  const recordingsPrefix = normalizePathPart(source.recordingsPrefix || `${eventPrefix}/recordings`);
  if (recordingsPrefix !== `${eventPrefix}/recordings` && !recordingsPrefix.startsWith(`${eventPrefix}/recordings/`)) {
    throw new Error('Recordings prefix must live under the event prefix recordings folder.');
  }

  const stages = Array.from(new Set((source.stages || [])
    .map(normalizeStage)
    .filter(Boolean)));
  const days = Array.from(new Set((source.days || [])
    .map(normalizeDay)
    .filter(Boolean)));
  if (!stages.length) throw new Error('At least one stage is required.');
  if (!days.length) throw new Error('At least one day is required.');

  return {
    client: String(source.client || '').trim(),
    eventName: String(source.eventName || eventPrefix).trim(),
    eventPrefix,
    year: Number(source.year || 0),
    eventNumber: Number(source.eventNumber || 0),
    remote: sanitizeRcloneRemoteName(
      String(source.remote || DEFAULT_EVENT_MANIFEST.remote).trim(),
      { platform: 'win32' },
    ),
    bucket: String(source.bucket || DEFAULT_EVENT_MANIFEST.bucket).trim(),
    endpointHost: String(source.endpointHost || DEFAULT_EVENT_MANIFEST.endpointHost).trim(),
    recordingsPrefix,
    stages,
    days,
    localRoots: Array.isArray(source.localRoots) ? source.localRoots.map(String) : [],
    uploadDefaults: normalizeUploadDefaults(source.uploadDefaults),
  };
}

function joinRemotePath(...parts) {
  return parts
    .map((part) => normalizePathPart(part))
    .filter(Boolean)
    .join('/');
}

function isUnderRecordingsPrefix(destinationPath, manifest) {
  const normalized = normalizePathPart(destinationPath);
  const prefix = normalizeEventManifest(manifest).recordingsPrefix;
  return normalized === prefix || normalized.startsWith(`${prefix}/`);
}

function assertUnderRecordingsPrefix(destinationPath, manifest) {
  if (!isUnderRecordingsPrefix(destinationPath, manifest)) {
    throw new Error(`Destination is outside the recordings prefix: ${destinationPath}`);
  }
  return normalizePathPart(destinationPath);
}

function buildCanonicalRecordingFolders(input = {}) {
  const manifest = normalizeEventManifest(input);
  const folders = [];
  for (const stage of manifest.stages) {
    folders.push(joinRemotePath(manifest.recordingsPrefix, 'assets', stage));
    folders.push(joinRemotePath(manifest.recordingsPrefix, 'edits', stage));
    for (const day of manifest.days) {
      for (const child of ['Audio', 'Cameras', 'Mix']) {
        folders.push(joinRemotePath(manifest.recordingsPrefix, 'raw', stage, day, child));
      }
    }
  }
  return folders;
}

module.exports = {
  DEFAULT_EVENT_MANIFEST,
  DEFAULT_UPLOAD_DEFAULTS,
  assertUnderRecordingsPrefix,
  buildCanonicalRecordingFolders,
  findSecretShapedKeys,
  isUnderRecordingsPrefix,
  joinRemotePath,
  normalizeDay,
  normalizeEventManifest,
  normalizePathPart,
  normalizeStage,
  normalizeUploadDefaults,
};
