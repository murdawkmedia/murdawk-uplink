const path = require('node:path');
const {
  normalizeChecksumMode,
} = require('./checksum-core');
const {
  sanitizeDiagnostics,
} = require('./job-core');
const {
  buildTransferDiagnostics,
} = require('./transfer-diagnostics-core');
const {
  assertUnderRecordingsPrefix,
  normalizeEventManifest,
} = require('./event-manifest-core');
const {
  credentialLikeEventPathReason,
} = require('./event-workspace-runtime');
const {
  DEFAULT_PROFILE,
  buildPublicUrl,
  formatBytes,
  normalizeFilterMode,
  normalizeExplorerPath,
  normalizeProfile,
  normalizePrefix,
} = require('./upload-core');

const SAFE_COMMANDS = new Set([
  'check',
  'list',
  'inventory',
  'dry-run',
  'upload',
  'urls',
  'verify',
  'status',
  'event',
  'help',
]);

function normalizeCliProfile(profile = {}) {
  const clean = normalizeProfile(profile);
  return {
    remote: clean.remote,
    bucket: clean.bucket,
    endpointHost: clean.endpointHost,
  };
}

function buildHelp() {
  return [
    'Murdawk Uplink CLI',
    '',
    'Usage:',
    '  npm run cli -- check [--remote <rclone-profile>] [--bucket <space>] [--endpoint <host>]',
    '  npm run cli -- list [prefix] [--remote <rclone-profile>] [--bucket <space>] [--endpoint <host>] [--json]',
    '  npm run cli -- inventory [prefix] [--remote <rclone-profile>] [--bucket <space>] [--endpoint <host>] [--json]',
    '  npm run cli -- dry-run --source <path> [--prefix <prefix>] [--remote <rclone-profile>] [--bucket <space>] [--endpoint <host>] [--filter all|videos-images|media-docs|custom] [--folder-mode package|contents] [--include "*.mp4"] [--json]',
    '  npm run cli -- upload --source <path> [--prefix <prefix>] [--remote <rclone-profile>] [--bucket <space>] [--endpoint <host>] [--filter all|videos-images|media-docs|custom] [--folder-mode package|contents] [--include "*.mp4"] [--checksum size|sha256] [--notify-webhook <url>] [--notify-ntfy <topic-or-url>] [--notify-on success|failure|always] [--private]',
    '  npm run cli -- verify --source <path> [--prefix <prefix>] [--remote <rclone-profile>] [--bucket <space>] [--endpoint <host>] [--filter all|videos-images|media-docs|custom] [--folder-mode package|contents] [--include "*.mp4"] [--checksum size|sha256] [--json]',
    '  npm run cli -- status --source <path> [--prefix <prefix>] [--remote <rclone-profile>] [--bucket <space>] [--endpoint <host>] [--filter all|videos-images|media-docs|custom] [--folder-mode package|contents] [--include "*.mp4"] [--checksum size|sha256] [--json]',
    '  npm run cli -- status --job <job-id> [--json]',
    '  npm run cli -- urls [prefix] [--filter all|videos-images|media-docs|custom] [--include "*.mp4"] [--json]',
    '  npm run cli -- event manifest [--output <path>] [--json]',
    '  npm run cli -- event reconcile --manifest <path> --local-root <path> [--local-root <path>] [--output <dir>] [--json]',
    '  npm run cli -- event queue-missing --manifest <path> --reconcile <path> [--dry-run] [--json]',
    '',
    'Safety:',
    '  Credentials stay in local rclone config. This CLI does not read or print keys.',
    '  No delete, purge, move, or rename commands are exposed in the agent CLI.',
  ].join('\n');
}

function parseCliArgs(argv = []) {
  const [command = 'help', ...rest] = argv;
  const normalizedCommand = command === '--help' || command === '-h' ? 'help' : command;
  if (!SAFE_COMMANDS.has(normalizedCommand)) {
    throw new Error(`Unsupported command: ${command}`);
  }

  const options = {
    sources: [],
    prefix: '',
    include: DEFAULT_PROFILE.defaultInclude,
    filterMode: DEFAULT_PROFILE.defaultFilterMode,
    publicRead: true,
    folderUploadMode: 'package',
    json: false,
    checksum: 'sha256',
    profile: normalizeCliProfile(),
    job: '',
    notifications: {
      webhook: '',
      ntfy: '',
      notifyOn: 'success',
    },
    event: {
      action: '',
      manifestPath: '',
      outputPath: '',
      outputDirectory: '',
      reconcilePath: '',
      preset: 'sample-event',
      localRoots: [],
      dryRun: false,
    },
  };
  const positionals = [];

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === '--source' || token === '-s') {
      index += 1;
      if (!rest[index]) throw new Error(`${token} requires a path.`);
      options.sources.push(rest[index]);
    } else if (token === '--prefix' || token === '-p') {
      index += 1;
      if (rest[index] === undefined) throw new Error(`${token} requires a prefix.`);
      options.prefix = rest[index];
    } else if (token === '--include' || token === '-i') {
      index += 1;
      if (!rest[index]) throw new Error(`${token} requires a filter.`);
      options.include = rest[index];
      options.filterMode = 'custom';
    } else if (token === '--filter') {
      index += 1;
      if (!rest[index]) throw new Error(`${token} requires a mode.`);
      options.filterMode = normalizeFilterMode(rest[index]);
      if (options.filterMode !== 'custom') {
        options.include = '';
      }
    } else if (token === '--json') {
      options.json = true;
    } else if (token === '--remote') {
      index += 1;
      if (!rest[index]) throw new Error(`${token} requires an rclone profile name.`);
      options.profile.remote = rest[index];
    } else if (token === '--bucket' || token === '--space') {
      index += 1;
      if (!rest[index]) throw new Error(`${token} requires a Space / bucket name.`);
      options.profile.bucket = rest[index];
    } else if (token === '--endpoint') {
      index += 1;
      if (!rest[index]) throw new Error(`${token} requires a DigitalOcean Spaces endpoint host.`);
      options.profile.endpointHost = rest[index];
    } else if (token === '--folder-mode') {
      index += 1;
      if (!['package', 'contents'].includes(rest[index])) {
        throw new Error(`Unsupported folder mode: ${rest[index]}`);
      }
      options.folderUploadMode = rest[index];
    } else if (token === '--checksum') {
      index += 1;
      if (!rest[index]) throw new Error(`${token} requires a mode.`);
      options.checksum = normalizeChecksumMode(rest[index]);
    } else if (token === '--job') {
      index += 1;
      if (!rest[index]) throw new Error(`${token} requires a job id.`);
      options.job = rest[index];
    } else if (token === '--notify-webhook') {
      index += 1;
      if (!rest[index]) throw new Error(`${token} requires a URL.`);
      options.notifications.webhook = rest[index];
    } else if (token === '--notify-ntfy') {
      index += 1;
      if (!rest[index]) throw new Error(`${token} requires a topic or URL.`);
      options.notifications.ntfy = rest[index];
    } else if (token === '--notify-on') {
      index += 1;
      if (!['success', 'failure', 'always'].includes(rest[index])) {
        throw new Error(`Unsupported notify-on mode: ${rest[index]}`);
      }
      options.notifications.notifyOn = rest[index];
    } else if (token === '--private' || token === '--no-public-read') {
      options.publicRead = false;
    } else if (token === '--public-read') {
      options.publicRead = true;
    } else if (token === '--manifest') {
      index += 1;
      if (!rest[index]) throw new Error(`${token} requires a path.`);
      options.event.manifestPath = rest[index];
    } else if (token === '--output') {
      index += 1;
      if (!rest[index]) throw new Error(`${token} requires a path.`);
      options.event.outputPath = rest[index];
      options.event.outputDirectory = rest[index];
    } else if (token === '--local-root') {
      index += 1;
      if (!rest[index]) throw new Error(`${token} requires a path.`);
      options.event.localRoots.push(rest[index]);
    } else if (token === '--reconcile') {
      index += 1;
      if (!rest[index]) throw new Error(`${token} requires a path.`);
      options.event.reconcilePath = rest[index];
    } else if (token === '--dry-run') {
      options.event.dryRun = true;
    } else if (token.startsWith('--')) {
      throw new Error(`Unknown option: ${token}`);
    } else {
      positionals.push(token);
    }
  }

  if (!options.prefix && positionals.length && ['list', 'inventory', 'urls'].includes(normalizedCommand)) {
    options.prefix = positionals[0];
  }
  if (normalizedCommand === 'event') {
    options.event.action = positionals[0] || 'help';
    if (!['help', 'manifest', 'reconcile', 'queue-missing'].includes(options.event.action)) {
      throw new Error(`Unsupported event action: ${options.event.action}`);
    }
  }

  const cleanOptions = {
    ...options,
    profile: normalizeCliProfile(options.profile),
  };
  if (normalizedCommand !== 'event') {
    delete cleanOptions.event;
  }

  return {
    command: normalizedCommand,
    options: cleanOptions,
    positionals,
  };
}

function normalizeUploadOptions(options = {}) {
  const sources = Array.isArray(options.sources)
    ? options.sources.filter((source) => typeof source === 'string' && source.trim())
    : [];
  if (!sources.length) {
    throw new Error('At least one --source path is required.');
  }

  return {
    sources,
    prefix: normalizePrefix(options.prefix || DEFAULT_PROFILE.defaultPrefix),
    include: options.include || DEFAULT_PROFILE.defaultInclude,
    filterMode: normalizeFilterMode(
      options.filterMode || (options.include ? 'custom' : DEFAULT_PROFILE.defaultFilterMode),
    ),
    publicRead: options.publicRead !== false,
    folderUploadMode: options.folderUploadMode === 'contents' ? 'contents' : 'package',
    profile: normalizeCliProfile(options.profile),
  };
}

function normalizeEventCliOptions(options = {}) {
  const event = options.event || {};
  return {
    action: event.action || 'help',
    manifestPath: event.manifestPath || '',
    outputPath: event.outputPath || '',
    outputDirectory: event.outputDirectory || '',
    reconcilePath: event.reconcilePath || '',
    preset: event.preset || 'sample-event',
    localRoots: Array.isArray(event.localRoots) ? event.localRoots.filter(Boolean) : [],
    dryRun: Boolean(event.dryRun),
    json: Boolean(options.json),
  };
}

const EVENT_PRESETS = Object.freeze({
  'sample-event': {},
});

function buildDefaultEventManifest(preset = 'sample-event') {
  const key = String(preset || 'sample-event').toLowerCase();
  if (key !== 'sample-event') throw new Error(`Unsupported event preset: ${preset}`);
  return normalizeEventManifest(EVENT_PRESETS[key]);
}

function formatEventReconcileReport(result = {}) {
  const summary = result.summary || {};
  return [
    `Local files: ${summary.localCount || 0}`,
    `Remote files: ${summary.remoteCount || 0}`,
    `Matched: ${summary.matchedCount || 0}`,
    `Missing: ${summary.missingCount || 0}`,
    `Size mismatch: ${summary.sizeMismatchCount || 0}`,
    `Needs decision: ${summary.ambiguousCount || 0}`,
    `Missing bytes: ${formatBytes(summary.missingBytes || 0)}`,
  ].join('\n');
}

function buildMissingQueuePlan({ manifest, reconcile, includeMeta = false }) {
  const cleanManifest = normalizeEventManifest(manifest);
  const missing = Array.isArray(reconcile?.missing) ? reconcile.missing : [];
  const skipped = [];
  const jobs = [];
  for (const local of missing) {
    const destinationPath = assertUnderRecordingsPrefix(local.destinationPath, cleanManifest);
    const credentialReason = credentialLikeEventPathReason(
      [
        local.path,
        local.relativePath,
        local.fileName,
        destinationPath,
      ].filter(Boolean).join('/'),
    );
    if (credentialReason) {
      skipped.push({
        sourcePath: local.path || '',
        destinationPath,
        fileName: local.fileName || '',
        reason: credentialReason,
      });
      continue;
    }
    jobs.push({
      sourcePath: local.path,
      destinationPath,
      fileName: local.fileName,
      size: Number(local.size || 0),
      remote: cleanManifest.remote,
      bucket: cleanManifest.bucket,
      rcloneDestination: `${cleanManifest.remote}:${cleanManifest.bucket}/${destinationPath}`,
    });
  }
  if (includeMeta) {
    return {
      jobs,
      skipped: {
        credentialLike: skipped,
        summary: {
          credentialLikeCount: skipped.length,
        },
      },
    };
  }
  return jobs;
}

function formatExplorerTable(entries = []) {
  if (!entries.length) {
    return 'No remote files in this prefix.';
  }

  const rows = entries.map((entry) => ({
    type: entry.isDir ? 'DIR' : 'FILE',
    size: entry.isDir ? '-' : entry.displaySize,
    modified: entry.modified ? entry.modified.slice(0, 19).replace('T', ' ') : '-',
    name: entry.name,
  }));

  const widths = {
    type: 4,
    size: Math.max(4, ...rows.map((row) => row.size.length)),
    modified: 19,
  };

  return rows
    .map((row) =>
      [
        row.type.padEnd(widths.type),
        row.size.padStart(widths.size),
        row.modified.padEnd(widths.modified),
        row.name,
      ].join('  '),
    )
    .join('\n');
}

function formatInventoryReport({ prefix = '', entries = [] } = {}) {
  const files = entries.filter((entry) => !entry.isDir);
  const lines = [
    `Remote folder: ${prefix || '(root)'}`,
    '',
    '| File location | Size | Public URL |',
    '|---|---:|---|',
  ];

  if (!files.length) {
    lines.push('| No files found | - | - |');
    return lines.join('\n');
  }

  for (const entry of files) {
    lines.push(`| ${entry.path || entry.name || ''} | ${entry.displaySize || '-'} | ${entry.publicUrl || '-'} |`);
  }

  return lines.join('\n');
}

function formatVerificationSummary(report) {
  return [
    report.ok ? 'Verification OK' : 'Verification FAILED',
    `verified=${report.verified.length}`,
    `missing=${report.missing.length}`,
    `sizeMismatch=${report.sizeMismatch.length}`,
  ].join(' ');
}

function buildStatusSummary({ prefix, entries = [], verification = null, urls = [] }) {
  const remoteFiles = entries.filter((entry) => !entry.isDir);
  const lines = [
    `Prefix: ${prefix || '(root)'}`,
    `Remote files: ${remoteFiles.length}`,
  ];

  if (verification) {
    lines.push(formatVerificationSummary(verification));
  }

  if (urls.length) {
    lines.push('URLs:');
    lines.push(...urls);
  }

  return lines.join('\n');
}

function recordTime(record = {}) {
  const value = record.completedAt || record.startedAt || '';
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function normalizeSourcePath(source = '') {
  return path.resolve(String(source || '')).replace(/\\/g, '/').toLowerCase();
}

function findMatchingStatusRecord(records = [], request = {}) {
  const expectedPrefix = normalizePrefix(request.prefix || DEFAULT_PROFILE.defaultPrefix);
  const expectedSources = Array.isArray(request.sources)
    ? request.sources.map(normalizeSourcePath).filter(Boolean)
    : [];
  return records
    .filter((record) => normalizePrefix(record.prefix || '') === expectedPrefix)
    .filter((record) => {
      if (!expectedSources.length) return true;
      const recordSources = Array.isArray(record.sources)
        ? record.sources.map(normalizeSourcePath)
        : [];
      return expectedSources.every((source) => recordSources.includes(source));
    })
    .sort((a, b) => recordTime(b) - recordTime(a))[0] || null;
}

function statusDiagnosticsFromRecord(record = {}, now = Date.now()) {
  const previous = sanitizeDiagnostics(record.diagnostics) || {};
  const transferState = record.transferState || {};
  if (previous.state && !record.transferState) {
    const terminal = ['complete', 'warning', 'ready'].includes(record.status)
      ? 'complete'
      : ['failed', 'blocked'].includes(record.status)
        ? 'failed'
        : record.status === 'cancelled' ? 'cancelled' : previous.state;
    return {
      ...previous,
      state: terminal,
      isRunning: terminal === previous.state ? Boolean(previous.isRunning) : false,
    };
  }
  return buildTransferDiagnostics({
    previous,
    status: record.status || 'running',
    transfer: {
      activeJobId: transferState.activeJobId || record.jobId || previous.activeJobId || '',
      isRunning: Boolean(transferState.isRunning),
      pid: transferState.pid || previous.pid || 0,
      mode: transferState.mode || previous.mode || 'upload',
      currentFile: transferState.currentFile || previous.currentFile || '',
      source: transferState.source || '',
      lastOutputAt: transferState.lastOutputAt || previous.lastOutputAt || '',
      lastProgressAt: transferState.lastProgressAt || previous.lastProgressAt || '',
      speed: transferState.speed || previous.speed?.current || '',
      eta: transferState.eta || previous.eta || '',
    },
    profile: previous.tuning || record.profile || DEFAULT_PROFILE,
    now,
  });
}

function formatUrls({ prefix, names, profile = DEFAULT_PROFILE }) {
  return names.map((fileName) => buildPublicUrl({ prefix, fileName, profile }));
}

function describeLocalSource(source) {
  return path.resolve(source);
}

function summarizeProfile(profile = DEFAULT_PROFILE) {
  const cleanProfile = normalizeProfile(profile);
  return {
    remote: cleanProfile.remote,
    bucket: cleanProfile.bucket,
    endpointHost: cleanProfile.endpointHost,
    defaultPrefix: cleanProfile.defaultPrefix,
    defaultInclude: cleanProfile.defaultInclude,
    defaultFilterMode: cleanProfile.defaultFilterMode,
  };
}

module.exports = {
  buildHelp,
  buildStatusSummary,
  describeLocalSource,
  findMatchingStatusRecord,
  formatExplorerTable,
  formatInventoryReport,
  formatUrls,
  buildDefaultEventManifest,
  buildMissingQueuePlan,
  formatEventReconcileReport,
  formatVerificationSummary,
  normalizeEventCliOptions,
  normalizeUploadOptions,
  parseCliArgs,
  statusDiagnosticsFromRecord,
  summarizeProfile,
  normalizeExplorerPath,
};
