const fs = require('node:fs');
const path = require('node:path');
const { sanitizeRcloneRemoteName } = require('./rclone-remote-core');

const DEFAULT_PROFILE = {
  remote: 'media',
  bucket: 'media',
  endpointHost: 'media.nyc3.digitaloceanspaces.com',
  defaultPrefix: 'archive-event/recordings/day1',
  defaultFilterMode: 'all',
  defaultInclude: '',
  transfers: 4,
  chunkSize: '64M',
  uploadConcurrency: 4,
  retries: 20,
  retriesSleep: '30s',
  lowLevelRetries: 60,
};

function normalizeProfile(profile = {}) {
  const source = profile && typeof profile === 'object' ? profile : {};
  const remote = sanitizeRcloneRemoteName(
    String(source.remote || DEFAULT_PROFILE.remote).trim() || DEFAULT_PROFILE.remote,
    { platform: 'win32' },
  );
  const bucket = String(source.bucket || DEFAULT_PROFILE.bucket).trim() || DEFAULT_PROFILE.bucket;
  const endpointHost =
    String(source.endpointHost || source.endpoint || DEFAULT_PROFILE.endpointHost).trim()
    || DEFAULT_PROFILE.endpointHost;
  return {
    ...DEFAULT_PROFILE,
    remote,
    bucket,
    endpointHost,
  };
}

const FILTER_PRESETS = {
  all: [],
  'videos-images': ['*.mp4', '*.mov', '*.m4v', '*.jpg', '*.jpeg', '*.png'],
  'media-docs': [
    '*.mp4',
    '*.mov',
    '*.m4v',
    '*.jpg',
    '*.jpeg',
    '*.png',
    '*.wav',
    '*.mp3',
    '*.m4a',
    '*.pdf',
    '*.txt',
    '*.md',
    '*.csv',
    '*.doc',
    '*.docx',
    '*.xls',
    '*.xlsx',
  ],
};

function normalizeFilterMode(mode = DEFAULT_PROFILE.defaultFilterMode) {
  const clean = String(mode || DEFAULT_PROFILE.defaultFilterMode).trim().toLowerCase();
  if (clean === 'video-images') return 'videos-images';
  if (clean === 'media') return 'media-docs';
  if (['all', 'videos-images', 'media-docs', 'custom'].includes(clean)) return clean;
  throw new Error(`Unsupported filter mode: ${mode}`);
}

function normalizeIncludePatterns(include = '', filterMode = DEFAULT_PROFILE.defaultFilterMode) {
  const mode =
    normalizeFilterMode(filterMode) === 'all' && String(include || '').trim()
      ? 'custom'
      : normalizeFilterMode(filterMode);
  if (mode === 'all') return [];
  if (mode !== 'custom') return FILTER_PRESETS[mode];
  return String(include || '')
    .split(/[,\n;]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function buildIncludeArgs(include = '', filterMode = DEFAULT_PROFILE.defaultFilterMode) {
  return normalizeIncludePatterns(include, filterMode)
    .flatMap((pattern) => ['--include', pattern]);
}

function normalizePrefix(prefix) {
  return String(prefix || DEFAULT_PROFILE.defaultPrefix)
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/{2,}/g, '/');
}

function normalizeExplorerPath(prefix = '') {
  return String(prefix || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/{2,}/g, '/');
}

function buildDestination(prefix, profile = DEFAULT_PROFILE) {
  const cleanProfile = normalizeProfile(profile);
  return `${cleanProfile.remote}:${cleanProfile.bucket}/${normalizePrefix(prefix)}/`;
}

function normalizeFolderUploadMode(mode = 'package') {
  return mode === 'contents' ? 'contents' : 'package';
}

function sourceDestinationPrefix(source, prefix, folderUploadMode = 'package', sourceIsDirectory = null) {
  const cleanPrefix = normalizePrefix(prefix);
  if (normalizeFolderUploadMode(folderUploadMode) !== 'package') {
    return cleanPrefix;
  }
  if (sourceIsDirectory === true) {
    return [cleanPrefix, path.basename(source)].filter(Boolean).join('/');
  }
  if (sourceIsDirectory === false) {
    return cleanPrefix;
  }
  try {
    if (fs.statSync(source).isDirectory()) {
      return [cleanPrefix, path.basename(source)].filter(Boolean).join('/');
    }
  } catch (_error) {
    return cleanPrefix;
  }
  return cleanPrefix;
}

function buildRemotePath(prefix = '', profile = DEFAULT_PROFILE, { trailingSlash = true } = {}) {
  const cleanProfile = normalizeProfile(profile);
  const clean = normalizeExplorerPath(prefix);
  const suffix = clean ? `/${clean}` : '';
  return `${cleanProfile.remote}:${cleanProfile.bucket}${suffix}${trailingSlash ? '/' : ''}`;
}

function buildCopyArgs({
  source,
  prefix = DEFAULT_PROFILE.defaultPrefix,
  include = DEFAULT_PROFILE.defaultInclude,
  filterMode = DEFAULT_PROFILE.defaultFilterMode,
  publicRead = true,
  dryRun = false,
  folderUploadMode = 'package',
  profile = DEFAULT_PROFILE,
  filesFromRawPath = '',
  sourceIsDirectory = null,
}) {
  if (!source) {
    throw new Error('Source is required.');
  }
  const cleanProfile = normalizeProfile(profile);

  const args = [
    'copy',
    source,
    buildDestination(sourceDestinationPrefix(source, prefix, folderUploadMode, sourceIsDirectory), cleanProfile),
    ...(filesFromRawPath ? ['--files-from-raw', filesFromRawPath] : buildIncludeArgs(include, filterMode)),
    '--progress',
    '--transfers',
    String(cleanProfile.transfers),
    '--s3-chunk-size',
    cleanProfile.chunkSize,
    '--s3-upload-concurrency',
    String(cleanProfile.uploadConcurrency),
    '--retries',
    String(cleanProfile.retries),
    '--retries-sleep',
    cleanProfile.retriesSleep,
    '--low-level-retries',
    String(cleanProfile.lowLevelRetries),
    '--size-only',
  ];

  if (publicRead && !dryRun) {
    args.push('--s3-acl', 'public-read');
  }

  if (dryRun) {
    args.push('--dry-run');
  }

  return args;
}

function buildJsonListArgs({
  prefix = DEFAULT_PROFILE.defaultPrefix,
  profile = DEFAULT_PROFILE,
}) {
  return [
    'lsjson',
    buildDestination(prefix, profile),
    '--recursive',
    '--files-only',
  ];
}

function buildExplorerListArgs({
  prefix = '',
  profile = DEFAULT_PROFILE,
}) {
  return [
    'lsjson',
    buildRemotePath(prefix, profile),
    '--max-depth',
    '1',
  ];
}

function buildListArgs({
  prefix = DEFAULT_PROFILE.defaultPrefix,
  include = DEFAULT_PROFILE.defaultInclude,
  filterMode = DEFAULT_PROFILE.defaultFilterMode,
  profile = DEFAULT_PROFILE,
}) {
  return [
    'lsf',
    buildDestination(prefix, profile),
    ...buildIncludeArgs(include, filterMode),
    '--recursive',
    '--files-only',
  ];
}

function encodeObjectKey(prefix, fileName) {
  return `${normalizePrefix(prefix)}/${String(fileName).replace(/\\/g, '/')}`
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
}

function buildPublicUrl({
  prefix = DEFAULT_PROFILE.defaultPrefix,
  fileName,
  profile = DEFAULT_PROFILE,
}) {
  if (!fileName) {
    throw new Error('File name is required.');
  }

  const cleanProfile = normalizeProfile(profile);
  return `https://${cleanProfile.endpointHost}/${encodeObjectKey(prefix, fileName)}`;
}

function buildPublicUrlForKey(remoteKey, profile = DEFAULT_PROFILE) {
  const cleanProfile = normalizeProfile(profile);
  const encodedKey = normalizeExplorerPath(remoteKey)
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
  return `https://${cleanProfile.endpointHost}/${encodedKey}`;
}

function formatBytes(bytes) {
  const size = Number(bytes || 0);
  if (size < 1024) {
    return `${size} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = size / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(1)} ${units[index]}`;
}

function joinRemoteKey(prefix, name) {
  return [normalizeExplorerPath(prefix), normalizeExplorerPath(name)].filter(Boolean).join('/');
}

function explorerEntryType(name = '', isDir = false) {
  if (isDir) return 'FOLDER';
  const value = String(name || '');
  const dotIndex = value.lastIndexOf('.');
  if (dotIndex < 0 || dotIndex === value.length - 1) return 'FILE';
  const extension = value.slice(dotIndex + 1).toUpperCase();
  return extension === 'JPG' || extension === 'JPE' ? 'JPEG' : extension;
}

function parseExplorerEntries({
  prefix = '',
  rawEntries = [],
  profile = DEFAULT_PROFILE,
}) {
  return rawEntries
    .map((entry) => {
      const name = entry.Name || path.basename(entry.Path || '');
      const remoteKey = joinRemoteKey(prefix, entry.Path || name);
      const isDir = Boolean(entry.IsDir);
      return {
        name,
        path: remoteKey,
        type: explorerEntryType(name, isDir),
        isDir,
        size: Number(entry.Size || 0),
        displaySize: isDir ? '-' : formatBytes(entry.Size || 0),
        modified: entry.ModTime || '',
        publicUrl: isDir ? '' : buildPublicUrlForKey(remoteKey, profile),
      };
    })
    .sort((a, b) => {
      if (a.isDir !== b.isDir) {
        return a.isDir ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
}

function buildRemoteOperationArgs({
  action,
  sourcePrefix,
  targetPrefix,
  isDir = false,
  profile = DEFAULT_PROFILE,
}) {
  const source = buildRemotePath(sourcePrefix, profile, { trailingSlash: isDir });

  if (action === 'delete') {
    if (isDir) {
      return ['purge', source];
    }
    return ['deletefile', source];
  }

  if (!targetPrefix) {
    throw new Error('Target path is required.');
  }

  const target = buildRemotePath(targetPrefix, profile, { trailingSlash: isDir });

  if (action === 'copy') {
    return isDir
      ? ['copy', source, target, '--size-only']
      : ['copyto', source, target, '--size-only'];
  }

  if (action === 'move' || action === 'rename') {
    return ['moveto', source, target, '--size-only', '--retries', '1'];
  }

  throw new Error(`Unsupported remote operation: ${action}`);
}

function buildTouchArgs({
  prefix,
  profile = DEFAULT_PROFILE,
  publicRead = false,
  dryRun = false,
}) {
  if (!prefix) {
    throw new Error('Remote path is required.');
  }
  return [
    'touch',
    buildRemotePath(prefix, profile, { trailingSlash: false }),
    ...(publicRead && !dryRun ? ['--s3-acl', 'public-read'] : []),
    ...(dryRun ? ['--dry-run'] : []),
  ];
}

function globToRegExp(pattern) {
  const escaped = String(pattern)
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function collectLocalUploadSourcePlan(
  source,
  include = DEFAULT_PROFILE.defaultInclude,
  filterMode = DEFAULT_PROFILE.defaultFilterMode,
  options = {},
) {
  const stat = fs.statSync(source);
  const folderUploadMode = normalizeFolderUploadMode(options.folderUploadMode);
  const patterns = normalizeIncludePatterns(include, filterMode);
  const includePatterns = patterns.map(globToRegExp);
  const isIncluded = (name) =>
    includePatterns.length === 0 || includePatterns.some((pattern) => pattern.test(name));

  if (stat.isFile()) {
    const name = path.basename(source);
    return {
      source,
      isDirectory: false,
      entries: isIncluded(name) ? [{
        name,
        size: stat.size,
        localPath: source,
        relativePath: name,
      }] : [],
      placeholderEntries: [],
    };
  }

  if (!stat.isDirectory()) {
    return { source, isDirectory: false, entries: [], placeholderEntries: [] };
  }

  const names = [];
  const placeholderEntries = [];
  const packageName = (relativeName) => folderUploadMode === 'package'
    ? [path.basename(source), relativeName].join('/')
    : relativeName;

  function walk(folder) {
    const directoryEntries = fs.readdirSync(folder, { withFileTypes: true });
    if (directoryEntries.length === 0) {
      const relativeFolder = path.relative(source, folder).replace(/\\/g, '/');
      const relativePath = [relativeFolder, '.keep'].filter(Boolean).join('/');
      placeholderEntries.push({
        name: packageName(relativePath),
        size: 0,
        localPath: '',
        relativePath,
        placeholder: true,
      });
      return;
    }

    for (const entry of directoryEntries) {
      const fullPath = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && isIncluded(entry.name)) {
        const relativeName = path.relative(source, fullPath).replace(/\\/g, '/');
        names.push({
          name: packageName(relativeName),
          size: fs.statSync(fullPath).size,
          localPath: fullPath,
          relativePath: relativeName,
        });
      }
    }
  }

  walk(source);
  return {
    source,
    isDirectory: true,
    entries: names.sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
    placeholderEntries: placeholderEntries.sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
  };
}

function collectLocalUploadEntries(
  source,
  include = DEFAULT_PROFILE.defaultInclude,
  filterMode = DEFAULT_PROFILE.defaultFilterMode,
  options = {},
) {
  return collectLocalUploadSourcePlan(source, include, filterMode, options).entries
    .map(({ name, size }) => ({ name, size }));
}

function collectLocalUploadNames(
  source,
  include = DEFAULT_PROFILE.defaultInclude,
  filterMode = DEFAULT_PROFILE.defaultFilterMode,
  options = {},
) {
  return collectLocalUploadEntries(source, include, filterMode, options).map((entry) => entry.name);
}

function parseRcloneProgress(text) {
  const raw = String(text);
  const currentMatch = [...raw.matchAll(/^\s*\*\s+(.+?):\s+\d+%\s+\/\s+.+?,\s+.+?,\s+.+$/gm)].at(-1);
  const currentFile = currentMatch ? currentMatch[1].trim() : '';
  const match = raw.match(
    /Transferred:\s+(.+?)\s+\/\s+(.+?),\s+(\d+)%\s*,\s+(.+?),\s+ETA\s+([^\r\n]+)/,
  );

  if (!match) {
    return currentFile ? { currentFile } : null;
  }

  return {
    transferred: match[1].trim(),
    total: match[2].trim(),
    percent: Number(match[3]),
    speed: match[4].trim(),
    eta: match[5].trim(),
    currentFile,
  };
}

function buildVerificationReport({
  localEntries,
  remoteEntries,
  expectedSourceCount = 0,
  existingRemoteNames = null,
}) {
  if (expectedSourceCount > 0 && localEntries.length === 0) {
    return {
      verified: [],
      missing: [],
      sizeMismatch: [],
      ok: false,
      blocked: true,
      reason: 'No local files matched the active upload filter.',
    };
  }

  const remoteByPath = new Map(
    remoteEntries.map((entry) => [String(entry.Path || entry.Name || '').replace(/\\/g, '/'), entry]),
  );

  const verified = [];
  const missing = [];
  const sizeMismatch = [];

  for (const local of localEntries) {
    const remote = remoteByPath.get(local.name);
    if (!remote) {
      missing.push({ name: local.name, localSize: local.size });
    } else if (Number(remote.Size) !== Number(local.size)) {
      sizeMismatch.push({
        name: local.name,
        localSize: Number(local.size),
        remoteSize: Number(remote.Size),
      });
    } else {
      verified.push({ name: local.name, size: Number(local.size) });
    }
  }

  const report = {
    verified,
    missing,
    sizeMismatch,
    ok: missing.length === 0 && sizeMismatch.length === 0,
  };
  if (Array.isArray(existingRemoteNames)) {
    const expectedNames = new Set(localEntries.map((entry) => entry.name));
    const existingNames = new Set(existingRemoteNames);
    report.unexpected = remoteEntries
      .map((entry) => ({
        name: String(entry.Path || entry.Name || '').replace(/\\/g, '/'),
        remoteSize: Number(entry.Size || 0),
      }))
      .filter((entry) => entry.name && !expectedNames.has(entry.name) && !existingNames.has(entry.name));
    report.ok = report.ok && report.unexpected.length === 0;
  }
  return report;
}

module.exports = {
  buildExplorerListArgs,
  buildJsonListArgs,
  buildRemoteOperationArgs,
  buildRemotePath,
  buildTouchArgs,
  buildVerificationReport,
  buildIncludeArgs,
  collectLocalUploadEntries,
  collectLocalUploadSourcePlan,
  collectLocalUploadNames,
  DEFAULT_PROFILE,
  FILTER_PRESETS,
  buildCopyArgs,
  buildDestination,
  buildListArgs,
  buildPublicUrl,
  buildPublicUrlForKey,
  sourceDestinationPrefix,
  formatBytes,
  normalizeFolderUploadMode,
  normalizeFilterMode,
  normalizeProfile,
  normalizeIncludePatterns,
  normalizeExplorerPath,
  normalizePrefix,
  parseExplorerEntries,
  parseRcloneProgress,
};
