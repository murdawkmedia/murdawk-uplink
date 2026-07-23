const fs = require('node:fs');
const path = require('node:path');
const {
  normalizeEventManifest,
  normalizePathPart,
} = require('./event-manifest-core');
const {
  buildLocalEventRecord,
} = require('./event-mapping-core');
const {
  isPlaceholderRecord,
} = require('./event-reconcile-core');

const DEFAULT_EVENT_SCAN_MAX_FILES = 200000;
const EVENT_SCAN_HARD_MAX_FILES = 200000;
const CREDENTIAL_EXACT_NAMES = new Set([
  '.env',
  '.aws',
  '.gnupg',
  '.ssh',
  'rclone.conf',
  's3cmd.ini',
  'credentials',
  'credential',
  'secrets',
  'secret',
  'token',
  'password',
  'access-key',
  'api-key',
  'key',
  'keys',
  'private-key',
  'private-keys',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
]);
const CREDENTIAL_PART_PATTERN = /(^|[-_.\s])(secret|secrets|token|password|credentials?|keys?|private[-_.\s]?keys?|access[-_.\s]?key|api[-_.\s]?key)([-_.\s]|$)/i;
const PRIVATE_KEY_FILE_PATTERN = /(?:^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$|\.(?:key|pem|ppk|p12|pfx|jks)$)/i;

function createScanMeta() {
  return {
    roots: [],
    filesSeen: 0,
    filesRecorded: 0,
    warnings: [],
  };
}

function createSkippedMeta() {
  return {
    credentialLike: [],
    summary: {
      credentialLikeCount: 0,
    },
  };
}

function normalizeEventScanMaxFiles(value = DEFAULT_EVENT_SCAN_MAX_FILES) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return DEFAULT_EVENT_SCAN_MAX_FILES;
  }
  return Math.min(Math.floor(number), EVENT_SCAN_HARD_MAX_FILES);
}

function credentialLikeEventPathReason(filePath = '') {
  const parts = normalizePathPart(filePath).split('/').filter(Boolean);
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (CREDENTIAL_EXACT_NAMES.has(lower) || /^\.env(?:rc|[._-].*)?$/i.test(part) || PRIVATE_KEY_FILE_PATTERN.test(part)) {
      return `Blocked credential-like path part: ${part}`;
    }
    if (CREDENTIAL_PART_PATTERN.test(part)) {
      return `Blocked secret-shaped path part: ${part}`;
    }
  }
  return '';
}

function credentialRelevantResolvedPath(filePath = '') {
  const resolved = path.resolve(filePath);
  const root = path.parse(resolved).root;
  const parts = path.relative(root, resolved).split(path.sep).filter(Boolean);
  const standardUserRoot = ['home', 'users'].includes(String(parts[0] || '').toLowerCase());
  return (standardUserRoot && parts.length > 2 ? parts.slice(2) : parts).join('/');
}

function inspectUploadSourcesForCredentialLikePaths(
  sources = [],
  { maxFiles = DEFAULT_EVENT_SCAN_MAX_FILES } = {},
) {
  const cleanMaxFiles = normalizeEventScanMaxFiles(maxFiles);
  const result = { ok: true, blocked: [], filesScanned: 0 };

  function block(filePath, reason) {
    result.blocked.push({ path: path.resolve(filePath), reason });
    result.ok = false;
  }

  function inspectEntry(fullPath, relativePath) {
    const reason = credentialLikeEventPathReason(relativePath || path.basename(fullPath));
    if (reason) block(fullPath, reason);
  }

  function walk(root, folder) {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const fullPath = path.join(folder, entry.name);
      const relativePath = path.relative(root, fullPath).replace(/\\/g, '/');
      inspectEntry(fullPath, relativePath);
      if (entry.isDirectory()) {
        walk(root, fullPath);
      } else if (entry.isFile()) {
        result.filesScanned += 1;
        if (result.filesScanned > cleanMaxFiles) {
          block(root, `Blocked upload because the credential path scan exceeded ${cleanMaxFiles} files.`);
          return;
        }
      }
      if (result.filesScanned > cleanMaxFiles) return;
    }
  }

  for (const source of Array.isArray(sources) ? sources : []) {
    const resolved = path.resolve(source);
    inspectEntry(resolved, credentialRelevantResolvedPath(resolved));
    if (!fs.existsSync(resolved)) continue;
    try {
      const stat = fs.lstatSync(resolved);
      if (stat.isDirectory()) {
        walk(resolved, resolved);
      } else if (stat.isFile()) {
        result.filesScanned += 1;
      }
    } catch (error) {
      block(resolved, `Blocked upload because the local path could not be safely inspected: ${error.message}`);
    }
    if (result.filesScanned > cleanMaxFiles) break;
  }

  return result;
}

function isCredentialLikeEventPath(filePath = '') {
  return Boolean(credentialLikeEventPathReason(filePath));
}

function skippedCredentialRecord(file = {}, reason = '') {
  return {
    sourceRoot: file.sourceRoot || '',
    relativePath: normalizePathPart(file.relativePath || file.path || file.fullPath || ''),
    fileName: path.basename(String(file.relativePath || file.path || file.fullPath || '').replace(/\\/g, '/')),
    reason,
  };
}

function addCredentialSkip(skipped, file, reason) {
  skipped.credentialLike.push(skippedCredentialRecord(file, reason));
  skipped.summary.credentialLikeCount = skipped.credentialLike.length;
}

function scanLimitWarning(root, maxFiles) {
  const cleanMaxFiles = normalizeEventScanMaxFiles(maxFiles);
  return {
    type: 'scan-limit',
    root: path.resolve(root),
    maxFiles: cleanMaxFiles,
    message: `Event Workspace scan limit reached at ${cleanMaxFiles} file(s). Choose narrower local roots or raise the scan limit.`,
  };
}

function walkLocalFiles(root, { maxFiles = DEFAULT_EVENT_SCAN_MAX_FILES } = {}) {
  const resolvedRoot = path.resolve(root);
  const cleanMaxFiles = normalizeEventScanMaxFiles(maxFiles);
  const files = [];
  const scan = createScanMeta();
  scan.roots.push(resolvedRoot);
  let limitReached = false;

  function walk(folder) {
    if (limitReached) return;
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (limitReached) return;
      const fullPath = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        if (files.length >= cleanMaxFiles) {
          limitReached = true;
          scan.warnings.push(scanLimitWarning(root, cleanMaxFiles));
          return;
        }
        const stat = fs.statSync(fullPath);
        scan.filesSeen += 1;
        files.push({
          sourceRoot: resolvedRoot,
          fullPath,
          relativePath: path.relative(resolvedRoot, fullPath).replace(/\\/g, '/'),
          size: stat.size,
          modifiedTime: stat.mtime.toISOString(),
        });
      }
    }
  }

  walk(resolvedRoot);
  scan.filesRecorded = files.length;
  files.scan = scan;
  return files;
}

function recordsFromFiles({ manifest, files, skipped }) {
  const records = [];
  for (const file of files) {
    const reason = credentialLikeEventPathReason(file.relativePath || file.fullPath);
    if (reason) {
      addCredentialSkip(skipped, file, reason);
      continue;
    }
    records.push(buildLocalEventRecord({
      manifest,
      sourceRoot: file.sourceRoot,
      relativePath: file.relativePath,
      fullPath: file.fullPath,
      size: file.size,
      modifiedTime: file.modifiedTime,
    }));
  }
  return records;
}

function buildLocalEventManifestRecords({
  manifest,
  localRoots = [],
  includeMeta = false,
  maxFiles = DEFAULT_EVENT_SCAN_MAX_FILES,
} = {}) {
  const cleanManifest = normalizeEventManifest(manifest);
  const cleanMaxFiles = normalizeEventScanMaxFiles(maxFiles);
  const skipped = createSkippedMeta();
  const scan = createScanMeta();
  const records = localRoots.flatMap((root) => {
    if (!fs.existsSync(root)) {
      throw new Error(`Local root not found: ${root}`);
    }
    const files = walkLocalFiles(root, { maxFiles: cleanMaxFiles });
    const fileScan = files.scan || createScanMeta();
    scan.roots.push(...fileScan.roots);
    scan.filesSeen += fileScan.filesSeen;
    scan.warnings.push(...fileScan.warnings);
    const recordsForRoot = recordsFromFiles({ manifest: cleanManifest, files, skipped });
    scan.filesRecorded += recordsForRoot.length;
    return recordsForRoot;
  });
  return includeMeta ? { records, skipped, scan } : records;
}

async function waitForTraversalTurn(count) {
  if (count % 200 !== 0) return;
  await new Promise((resolve) => setImmediate(resolve));
}

async function walkLocalFilesAsync(root, { maxFiles = DEFAULT_EVENT_SCAN_MAX_FILES } = {}) {
  const resolvedRoot = path.resolve(root);
  const cleanMaxFiles = normalizeEventScanMaxFiles(maxFiles);
  const files = [];
  const scan = createScanMeta();
  scan.roots.push(resolvedRoot);
  let limitReached = false;

  async function walk(folder) {
    if (limitReached) return;
    const entries = await fs.promises.readdir(folder, { withFileTypes: true });
    for (const entry of entries) {
      if (limitReached) return;
      const fullPath = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        if (files.length >= cleanMaxFiles) {
          limitReached = true;
          scan.warnings.push(scanLimitWarning(root, cleanMaxFiles));
          return;
        }
        const stat = await fs.promises.stat(fullPath);
        scan.filesSeen += 1;
        files.push({
          sourceRoot: resolvedRoot,
          fullPath,
          relativePath: path.relative(resolvedRoot, fullPath).replace(/\\/g, '/'),
          size: stat.size,
          modifiedTime: stat.mtime.toISOString(),
        });
        await waitForTraversalTurn(files.length);
      }
    }
  }

  await walk(resolvedRoot);
  scan.filesRecorded = files.length;
  return { files, scan };
}

async function buildLocalEventManifestRecordsAsync({
  manifest,
  localRoots = [],
  maxFiles = DEFAULT_EVENT_SCAN_MAX_FILES,
} = {}) {
  const cleanManifest = normalizeEventManifest(manifest);
  const cleanMaxFiles = normalizeEventScanMaxFiles(maxFiles);
  const skipped = createSkippedMeta();
  const scan = createScanMeta();
  const records = [];

  for (const root of localRoots) {
    if (!fs.existsSync(root)) {
      throw new Error(`Local root not found: ${root}`);
    }
    const result = await walkLocalFilesAsync(root, { maxFiles: cleanMaxFiles });
    scan.roots.push(...result.scan.roots);
    scan.filesSeen += result.scan.filesSeen;
    scan.warnings.push(...result.scan.warnings);
    const recordsForRoot = recordsFromFiles({ manifest: cleanManifest, files: result.files, skipped });
    scan.filesRecorded += recordsForRoot.length;
    records.push(...recordsForRoot);
  }

  return { records, skipped, scan };
}

function normalizeRemoteItem(manifest, item = {}) {
  const relativePath = normalizePathPart(item.relativePath || item.Path || item.path || item.name || item.Name || '');
  const pathValue = normalizePathPart(item.path || item.Path || relativePath);
  const fullPath = pathValue.startsWith(`${manifest.recordingsPrefix}/`)
    ? pathValue
    : normalizePathPart([manifest.recordingsPrefix, relativePath || pathValue].filter(Boolean).join('/'));
  return {
    path: fullPath,
    relativePath: fullPath.startsWith(`${manifest.recordingsPrefix}/`)
      ? fullPath.slice(`${manifest.recordingsPrefix}/`.length)
      : relativePath,
    fileName: item.fileName || item.name || item.Name || path.basename(relativePath || fullPath),
    size: Number(item.size ?? item.Size ?? 0),
    modTime: item.modTime || item.modified || item.ModTime || '',
  };
}

async function listEventRemoteRecords({
  manifest,
  listRemoteFolder,
  runRclone,
  assertReady,
} = {}) {
  const cleanManifest = normalizeEventManifest(manifest);

  if (typeof listRemoteFolder === 'function') {
    const listing = await listRemoteFolder(cleanManifest.recordingsPrefix, {
      remote: cleanManifest.remote,
      bucket: cleanManifest.bucket,
      endpointHost: cleanManifest.endpointHost,
    });
    return (listing.entries || [])
      .filter((entry) => !entry.isDir && !isPlaceholderRecord(entry))
      .map((entry) => normalizeRemoteItem(cleanManifest, entry));
  }

  if (typeof runRclone !== 'function' || typeof assertReady !== 'function') {
    throw new Error('listEventRemoteRecords requires listRemoteFolder or runRclone/assertReady.');
  }

  const activeProfile = await assertReady({
    remote: cleanManifest.remote,
    bucket: cleanManifest.bucket,
    endpointHost: cleanManifest.endpointHost,
  });
  const remoteRoot = `${activeProfile.remote}:${activeProfile.bucket}/${cleanManifest.recordingsPrefix}`;
  const listing = await runRclone([
    'lsjson',
    remoteRoot,
    '--recursive',
    '--files-only',
    '--exclude',
    '.keep',
  ]);

  return JSON.parse(listing.stdout || '[]')
    .filter((item) => !isPlaceholderRecord(item))
    .map((item) => normalizeRemoteItem(cleanManifest, item));
}

module.exports = {
  DEFAULT_EVENT_SCAN_MAX_FILES,
  EVENT_SCAN_HARD_MAX_FILES,
  buildLocalEventManifestRecords,
  buildLocalEventManifestRecordsAsync,
  credentialLikeEventPathReason,
  inspectUploadSourcesForCredentialLikePaths,
  isCredentialLikeEventPath,
  listEventRemoteRecords,
  normalizeEventScanMaxFiles,
  normalizeRemoteItem,
  walkLocalFilesAsync,
  walkLocalFiles,
};
