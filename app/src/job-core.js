const fs = require('node:fs');
const path = require('node:path');
const { readJsonWithBackup, writeJsonAtomic } = require('./atomic-json-core');
const {
  normalizeConnectionProfile,
  sanitizeConnectionReferenceId,
  sanitizeDurableId,
} = require('./connection-core');
const { normalizeDownloadSelection, normalizeLocalDestination } = require('./download-core');

const JOB_STATUSES = new Set([
  'blocked',
  'cancelled',
  'complete',
  'created',
  'dry-run',
  'failed',
  'paused',
  'ready',
  'running',
  'verified',
  'warning',
]);

class JobRecordReadError extends Error {
  constructor(message, code, jobId) {
    super(message);
    this.name = 'JobRecordReadError';
    this.code = code;
    this.jobId = jobId;
  }
}

function createJobId(prefix = 'job') {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const random = Math.random().toString(16).slice(2, 8);
  return `${prefix}-${stamp}-${random}`;
}

function redactTarget(target = '') {
  if (!target) return '';
  try {
    const url = new URL(target);
    if (url.search) {
      url.search = '?REDACTED';
    }
    const lastPart = url.pathname.split('/').filter(Boolean).at(-1);
    if (!url.search && lastPart && lastPart.length > 20) {
      const redacted = `${lastPart.slice(0, 3)}...${lastPart.slice(-3)}`;
      url.pathname = url.pathname.replace(lastPart, redacted);
    }
    return url.toString();
  } catch (_error) {
    return target.length > 20 ? `${target.slice(0, 3)}...${target.slice(-3)}` : target;
  }
}

function redactNotifications(notifications = {}) {
  return {
    webhook: redactTarget(notifications.webhook || ''),
    ntfy: redactTarget(notifications.ntfy || ''),
    notifyOn: notifications.notifyOn || 'success',
  };
}

function sanitizeDiagnostics(input = null) {
  if (!input || typeof input !== 'object') return null;
  const speed = input.speed && typeof input.speed === 'object' ? input.speed : {};
  const tuning = input.tuning && typeof input.tuning === 'object' ? input.tuning : {};
  const samples = Array.isArray(input.samples) ? input.samples : [];
  return {
    state: input.state || '',
    isRunning: Boolean(input.isRunning),
    pid: Number(input.pid || 0),
    activeJobId: input.activeJobId || '',
    mode: input.mode || '',
    currentFile: input.currentFile || '',
    eta: input.eta || '',
    lastOutputAt: input.lastOutputAt || '',
    lastProgressAt: input.lastProgressAt || '',
    lastOutputAgeSeconds: input.lastOutputAgeSeconds === null
      ? null
      : Number.isFinite(Number(input.lastOutputAgeSeconds)) ? Number(input.lastOutputAgeSeconds) : null,
    lastProgressAgeSeconds: input.lastProgressAgeSeconds === null
      ? null
      : Number.isFinite(Number(input.lastProgressAgeSeconds)) ? Number(input.lastProgressAgeSeconds) : null,
    speed: {
      currentBytesPerSecond: Math.max(0, Math.round(Number(speed.currentBytesPerSecond || 0))),
      current: speed.current || '',
      rollingAverageBytesPerSecond: Math.max(0, Math.round(Number(speed.rollingAverageBytesPerSecond || 0))),
      rollingAverage: speed.rollingAverage || '',
      peakBytesPerSecond: Math.max(0, Math.round(Number(speed.peakBytesPerSecond || 0))),
      peak: speed.peak || '',
    },
    samples: samples
      .map((sample) => ({
        at: typeof sample.at === 'string' ? sample.at : '',
        bytesPerSecond: Math.max(0, Math.round(Number(sample.bytesPerSecond || 0))),
      }))
      .filter((sample) => sample.at && sample.bytesPerSecond > 0)
      .slice(-12),
    tuning: {
      transfers: Number(tuning.transfers || 4),
      chunkSize: tuning.chunkSize || '64M',
      uploadConcurrency: Number(tuning.uploadConcurrency || 4),
    },
    recommendation: input.recommendation || '',
    safeAction: input.safeAction || '',
  };
}

function sanitizeProfileSnapshot(input = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  return Object.freeze(normalizeConnectionProfile(input));
}

function buildJobRecord({
  jobId = createJobId(),
  intentId = '',
  resumeFromJobId = '',
  source = '',
  sources = [],
  prefix = '',
  include = '',
  filterMode = 'all',
  folderUploadMode = 'package',
  publicRead = true,
  checksumMode = 'sha256',
  notifications = {},
  status = 'created',
  startedAt = new Date().toISOString(),
  completedAt = '',
  verification = null,
  checksum = null,
  urls = [],
  notificationAttempts = [],
  error = '',
  connectionId = '',
  profile = null,
  profileSnapshot = null,
  transferState = null,
  diagnostics = null,
  direction = 'upload',
  localDestination = '',
  remoteItems = [],
} = {}) {
  const sanitizedProfile = sanitizeProfileSnapshot(profileSnapshot || profile);
  const frozenProfile = sanitizedProfile ? Object.freeze({ ...sanitizedProfile }) : null;
  const frozenProfileSnapshot = sanitizedProfile ? Object.freeze({ ...sanitizedProfile }) : null;
  const transferDirection = direction === 'download' ? 'download' : 'upload';
  const normalizedRemoteItems = transferDirection === 'download'
    ? normalizeDownloadSelection(remoteItems)
    : [];
  const normalizedLocalDestination = transferDirection === 'download'
    ? normalizeLocalDestination(localDestination)
    : '';
  return {
    app: 'Murdawk Uplink',
    jobId,
    intentId: String(intentId || ''),
    resumeFromJobId: String(resumeFromJobId || '').trim().slice(0, 256),
    status,
    sources: sources.length ? sources : [source].filter(Boolean),
    prefix,
    include,
    filterMode,
    folderUploadMode: folderUploadMode === 'contents' ? 'contents' : 'package',
    publicRead: publicRead !== false,
    checksumMode,
    startedAt,
    completedAt,
    verification,
    checksum,
    urls,
    connectionId: sanitizeConnectionReferenceId(connectionId),
    profile: frozenProfile,
    profileSnapshot: frozenProfileSnapshot,
    notifications: redactNotifications(notifications),
    notificationAttempts,
    error,
    transferState: transferState && typeof transferState === 'object' ? {
      activeJobId: transferState.activeJobId || jobId,
      pid: Number(transferState.pid || 0),
      source: transferState.source || '',
      sourceIndex: Number(transferState.sourceIndex || 0),
      sourceTotal: Number(transferState.sourceTotal || 0),
      mode: transferState.mode || '',
      startedAt: transferState.startedAt || '',
      lastOutputAt: transferState.lastOutputAt || '',
      lastProgressAt: transferState.lastProgressAt || '',
      currentFile: transferState.currentFile || '',
      transferred: transferState.transferred || '',
      total: transferState.total || '',
      percent: Number.isFinite(Number(transferState.percent)) ? Number(transferState.percent) : 0,
      speed: transferState.speed || '',
      eta: transferState.eta || '',
    } : null,
    diagnostics: sanitizeDiagnostics(diagnostics),
    direction: transferDirection,
    localDestination: normalizedLocalDestination,
    remoteItems: normalizedRemoteItems.map((item) => ({ ...item })),
  };
}

function shouldNotify({ notifyOn = 'success', status }) {
  if (notifyOn === 'always') return true;
  if (notifyOn === 'success') return status === 'verified' || status === 'complete';
  if (notifyOn === 'failure') return status === 'failed' || status === 'warning';
  return false;
}

function ensureJobsDir(jobsDir) {
  fs.mkdirSync(jobsDir, { recursive: true });
  return jobsDir;
}

function assertValidJobId(jobId) {
  if (
    typeof jobId !== 'string'
    || sanitizeDurableId(jobId) !== jobId
  ) {
    const error = new TypeError('Job id must use only safe letters, numbers, dots, underscores, or hyphens.');
    error.code = 'EJOBID';
    throw error;
  }
  return jobId;
}

function getJobPath(jobsDir, jobId) {
  const safeJobId = assertValidJobId(jobId);
  const root = path.resolve(jobsDir);
  const target = path.resolve(root, `${safeJobId}.json`);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    const error = new TypeError('Job path must remain inside the jobs directory.');
    error.code = 'EJOBID';
    throw error;
  }
  return target;
}

function writeJobRecord(jobsDir, record, options = {}) {
  assertValidJobId(record?.jobId);
  if (!isJobRecord(record)) {
    const error = new TypeError('Job record must include a safe jobId, valid status, and meaningful job fields.');
    error.code = 'EJOBRECORD';
    throw error;
  }
  ensureJobsDir(jobsDir);
  writeJsonAtomic(getJobPath(jobsDir, record.jobId), record, {
    ...options,
    validator: isJobRecord,
  });
  return record;
}

function buildCancelledJobRecord(record = {}, error = 'Transfer cancelled by user.') {
  if (!isJobRecord(record)) {
    const invalid = new TypeError('Cancellation requires an existing valid job record.');
    invalid.code = 'EJOBCANCEL';
    throw invalid;
  }
  return buildJobRecord({
    ...record,
    status: 'cancelled',
    completedAt: new Date().toISOString(),
    error: error || 'Transfer cancelled by user.',
  });
}

function readJobRecord(jobsDir, jobId) {
  const target = getJobPath(jobsDir, jobId);
  const validator = (record) => isJobRecord(record) && record.jobId === jobId;
  const record = readJsonWithBackup(target, { validator });
  if (record) return record;
  const hasCandidate = fs.existsSync(target) || fs.existsSync(`${target}.bak`);
  throw new JobRecordReadError(
    hasCandidate
      ? `Job record is corrupt or structurally invalid: ${jobId}`
      : `Job record not found: ${jobId}`,
    hasCandidate ? 'EJOBCORRUPT' : 'EJOBNOTFOUND',
    jobId,
  );
}

function buildPausedJobRecord(record = {}, error = '') {
  if (!isJobRecord(record)) {
    const invalid = new TypeError('Pause requires an existing valid job record.');
    invalid.code = 'EJOBPAUSE';
    throw invalid;
  }
  return buildJobRecord({
    ...record,
    status: 'paused',
    completedAt: '',
    error,
  });
}

function jobRecordTime(record = {}) {
  const value = record.completedAt || record.startedAt || '';
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function readJobRecords(jobsDir, limit = 200) {
  try {
    const jobIds = new Set();
    for (const name of fs.readdirSync(jobsDir)) {
      if (name.includes('.tmp-')) continue;
      if (name.endsWith('.json')) {
        jobIds.add(name.slice(0, -5));
      } else if (name.endsWith('.json.bak')) {
        jobIds.add(name.slice(0, -9));
      }
    }
    return [...jobIds]
      .map((jobId) => {
        try {
          const target = getJobPath(jobsDir, jobId);
          return readJsonWithBackup(target, {
            validator: (record) => isJobRecord(record) && record.jobId === jobId,
          });
        } catch (_error) {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => jobRecordTime(b) - jobRecordTime(a))
      .slice(0, limit);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function hasSecretShapedField(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  for (const [key, nested] of Object.entries(value)) {
    if (/(?:secret|password|credential|access.?key|api.?key|bearer|token)/i.test(key)) return true;
    if (hasSecretShapedField(nested, seen)) return true;
  }
  return false;
}

function isStrictProfileSnapshot(value, optional = true) {
  if (value === undefined || value === null) return optional;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 3
    && ['remote', 'bucket', 'endpointHost'].every((key) => typeof value[key] === 'string')
    && keys.every((key) => ['remote', 'bucket', 'endpointHost'].includes(key));
}

function isJobRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  if (hasSecretShapedField(record)) return false;
  try {
    assertValidJobId(record.jobId);
  } catch (_error) {
    return false;
  }
  if (!JOB_STATUSES.has(record.status)) return false;
  if (record.connectionId !== undefined
    && record.connectionId !== ''
    && sanitizeConnectionReferenceId(record.connectionId) !== record.connectionId) return false;
  if (!isStrictProfileSnapshot(record.profile) || !isStrictProfileSnapshot(record.profileSnapshot)) return false;
  if (!['upload', 'download'].includes(record.direction || 'upload')) return false;
  if (record.direction === 'download') {
    try {
      normalizeLocalDestination(record.localDestination);
      normalizeDownloadSelection(record.remoteItems);
    } catch (_error) {
      return false;
    }
  }
  const meaningful = (Array.isArray(record.sources) && record.sources.some((source) => typeof source === 'string' && source))
    || (typeof record.prefix === 'string' && record.prefix)
    || (typeof record.startedAt === 'string' && Number.isFinite(Date.parse(record.startedAt)))
    || (typeof record.completedAt === 'string' && Number.isFinite(Date.parse(record.completedAt)));
  return Boolean(meaningful);
}

function jobRecordHasVerifiedCompletion(record = {}) {
  const verification = record.verification || {};
  const checksum = record.checksum || {};
  const missing = Array.isArray(verification.missing) ? verification.missing : [];
  const sizeMismatch = Array.isArray(verification.sizeMismatch) ? verification.sizeMismatch : [];
  return verification.ok === true
    && missing.length === 0
    && sizeMismatch.length === 0
    && checksum.ok !== false;
}

function jobRecordCanResume(record = {}) {
  if (['failed', 'cancelled', 'paused', 'running', 'blocked'].includes(record.status)) {
    return true;
  }
  if (record.status === 'dry-run') {
    return !Number.isFinite(Date.parse(record.completedAt || ''));
  }
  if (record.status === 'warning') {
    return !jobRecordHasVerifiedCompletion(record);
  }
  return false;
}

function buildResumeQueueSettings(record = {}) {
  if (!jobRecordCanResume(record)) {
    throw new Error('Only failed, interrupted dry-run, unverified warning, cancelled, paused, blocked, or stale running jobs can be resumed.');
  }
  const sources = Array.isArray(record.sources) ? record.sources.filter(Boolean) : [];
  if (!sources.length) {
    throw new Error('Resume requires original local source paths.');
  }
  if (!record.prefix && record.direction !== 'download') {
    throw new Error('Resume requires the original remote prefix.');
  }
  const settings = {
    intentId: createJobId('queue'),
    sources,
    prefix: record.prefix,
    filterMode: ['all', 'videos-images', 'media-docs', 'custom'].includes(record.filterMode)
      ? record.filterMode
      : 'all',
    include: typeof record.include === 'string' ? record.include : '',
    checksum: ['size', 'sha256'].includes(record.checksumMode) ? record.checksumMode : 'sha256',
    folderUploadMode: record.folderUploadMode === 'contents' ? 'contents' : 'package',
    publicRead: record.publicRead !== false,
    resumeFromJobId: String(record.jobId || '').trim().slice(0, 256),
    direction: record.direction === 'download' ? 'download' : 'upload',
  };
  if (settings.direction === 'download') {
    settings.localDestination = normalizeLocalDestination(record.localDestination);
    settings.remoteItems = normalizeDownloadSelection(record.remoteItems).map((item) => ({ ...item }));
  }
  if (record.profile) {
    settings.profile = record.profile;
  }
  if (record.profileSnapshot) {
    settings.profileSnapshot = record.profileSnapshot;
    settings.profile = record.profileSnapshot;
  }
  if (typeof record.connectionId === 'string' && record.connectionId) {
    settings.connectionId = record.connectionId;
  }
  return settings;
}

function summarizeJobRecord(record = {}) {
  const verification = record.verification || {};
  return {
    jobId: record.jobId || '',
    status: record.status || 'unknown',
    prefix: record.prefix || '',
    sourceCount: Array.isArray(record.sources) ? record.sources.length : 0,
    verifiedCount: Array.isArray(verification.verified) ? verification.verified.length : 0,
    missingCount: Array.isArray(verification.missing) ? verification.missing.length : 0,
    urlCount: Array.isArray(record.urls) ? record.urls.length : 0,
    canResume: jobRecordCanResume(record),
    error: record.error || '',
    direction: record.direction === 'download' ? 'download' : 'upload',
    localDestination: record.direction === 'download' ? record.localDestination || '' : '',
  };
}

module.exports = {
  JobRecordReadError,
  assertValidJobId,
  buildCancelledJobRecord,
  buildPausedJobRecord,
  buildResumeQueueSettings,
  buildJobRecord,
  createJobId,
  getJobPath,
  jobRecordCanResume,
  jobRecordHasVerifiedCompletion,
  readJobRecord,
  readJobRecords,
  redactTarget,
  sanitizeDiagnostics,
  shouldNotify,
  summarizeJobRecord,
  writeJobRecord,
};
