const fs = require('node:fs');
const path = require('node:path');
const { buildRemotePath, normalizeExplorerPath, normalizeProfile } = require('./upload-core');

const MAX_DOWNLOAD_ITEMS = 1_000;

function normalizeDownloadSelection(items = []) {
  if (!Array.isArray(items) || !items.length || items.length > MAX_DOWNLOAD_ITEMS) {
    throw new TypeError(`Download selection must contain between 1 and ${MAX_DOWNLOAD_ITEMS} items.`);
  }
  return items.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new TypeError('Each download item must be an object.');
    }
    const rawPath = String(item.path || '').replace(/\\/g, '/').trim();
    const segments = rawPath.split('/');
    if (!rawPath
      || rawPath.startsWith('/')
      || segments.some((segment) => !segment || segment === '.' || segment === '..')
      || /[\u0000-\u001f\u007f]/.test(rawPath)) {
      throw new TypeError('Each download item requires a safe remote path.');
    }
    const name = String(item.name || segments.at(-1) || '').trim();
    if (!name || name === '.' || name === '..' || /[\\/\u0000-\u001f\u007f]/.test(name)) {
      throw new TypeError('Each download item requires a plain file or folder name.');
    }
    const size = Number(item.size || 0);
    if (!Number.isFinite(size) || size < 0) {
      throw new TypeError('Download item size must be a non-negative number.');
    }
    return Object.freeze({
      path: normalizeExplorerPath(rawPath),
      name,
      isDir: Boolean(item.isDir),
      size,
      modified: typeof item.modified === 'string' ? item.modified : '',
    });
  });
}

function normalizeLocalDestination(destination = '') {
  const value = String(destination || '').trim();
  if (!path.win32.isAbsolute(value)) {
    throw new TypeError('Download requires an absolute local destination.');
  }
  return path.win32.resolve(value);
}

function containedLocalChild(destination, name) {
  const root = normalizeLocalDestination(destination);
  const target = path.win32.resolve(root, name);
  const relative = path.win32.relative(root, target);
  if (!relative || relative.startsWith('..') || path.win32.isAbsolute(relative)) {
    throw new TypeError('Download item must remain inside the selected local destination.');
  }
  return target;
}

function buildDownloadOperations({ destination = '', items = [], profile = {} } = {}) {
  const localRoot = normalizeLocalDestination(destination);
  const normalizedProfile = normalizeProfile(profile);
  return normalizeDownloadSelection(items).map((item) => Object.freeze({
    ...item,
    localRoot,
    localPath: containedLocalChild(localRoot, item.name),
    remotePath: buildRemotePath(item.path, normalizedProfile, { trailingSlash: item.isDir }),
    profile: Object.freeze({ ...normalizedProfile }),
  }));
}

function buildDownloadArgs(operation = {}, { dryRun = false } = {}) {
  if (!operation.remotePath || !operation.localPath) {
    throw new TypeError('A frozen download operation is required.');
  }
  const profile = normalizeProfile(operation.profile || {});
  return [
    operation.isDir ? 'copy' : 'copyto',
    operation.remotePath,
    operation.localPath,
    '--progress',
    '--transfers',
    String(profile.transfers),
    '--retries',
    String(profile.retries),
    '--retries-sleep',
    profile.retriesSleep,
    '--low-level-retries',
    String(profile.lowLevelRetries),
    '--size-only',
    ...(dryRun ? ['--dry-run'] : []),
  ];
}

function buildDownloadCheckArgs(operation = {}) {
  if (!operation.isDir || !operation.remotePath || !operation.localPath) {
    throw new TypeError('Folder verification requires a frozen folder download operation.');
  }
  return [
    'check',
    operation.remotePath,
    operation.localPath,
    '--size-only',
    '--one-way',
  ];
}

function statOrNull(localPath, statSync) {
  try {
    return statSync(localPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function precheckDownloadTargets(operations = [], { statSync = fs.statSync } = {}) {
  const report = { existing: [], mismatched: [], pending: [] };
  for (const operation of operations) {
    if (operation.isDir) {
      report.pending.push(operation);
      continue;
    }
    const stat = statOrNull(operation.localPath, statSync);
    if (stat?.isFile() && Number(stat.size) === Number(operation.size)) {
      report.existing.push(operation);
      continue;
    }
    if (stat) report.mismatched.push(operation);
    report.pending.push(operation);
  }
  return report;
}

function verifyDownloadedTargets(operations = [], {
  statSync = fs.statSync,
  checkedFolders = new Set(),
} = {}) {
  const report = { verified: [], missing: [], sizeMismatch: [], ok: true };
  for (const operation of operations) {
    if (operation.isDir) {
      if (checkedFolders.has(operation.localPath)) report.verified.push(operation);
      else report.missing.push(operation);
      continue;
    }
    const stat = statOrNull(operation.localPath, statSync);
    if (!stat?.isFile()) report.missing.push(operation);
    else if (Number(stat.size) !== Number(operation.size)) report.sizeMismatch.push({
      ...operation,
      localSize: Number(stat.size),
    });
    else report.verified.push(operation);
  }
  report.ok = report.missing.length === 0 && report.sizeMismatch.length === 0;
  return report;
}

module.exports = {
  MAX_DOWNLOAD_ITEMS,
  buildDownloadArgs,
  buildDownloadCheckArgs,
  buildDownloadOperations,
  normalizeDownloadSelection,
  normalizeLocalDestination,
  precheckDownloadTargets,
  verifyDownloadedTargets,
};
