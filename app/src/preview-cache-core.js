const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeDownloadSelection } = require('./download-core');
const { buildRemotePath, normalizeProfile } = require('./upload-core');

const MAX_PREVIEW_BYTES = 50 * 1024 * 1024;
const DEFAULT_PREVIEW_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_PREVIEW_MAX_FILES = 100;
const PREVIEW_EXTENSIONS = new Map([
  ['.avif', 'AVIF'],
  ['.gif', 'GIF'],
  ['.jpeg', 'JPEG'],
  ['.jpg', 'JPEG'],
  ['.png', 'PNG'],
  ['.webp', 'WEBP'],
]);
const GENERATED_PREVIEW_PATTERN = /^preview-[a-f0-9]{64}\.(?:avif|gif|jpeg|jpg|png|webp)$/;

function previewError(message, code) {
  const error = new TypeError(message);
  error.code = code;
  return error;
}

function normalizePreviewRequest(request = {}) {
  const [item] = normalizeDownloadSelection([request.item]);
  if (item.isDir) throw previewError('Preview requires one image file.', 'EPREVIEWFOLDER');
  const extension = path.extname(item.name).toLowerCase();
  const format = PREVIEW_EXTENSIONS.get(extension);
  if (!format) throw previewError('Preview requires a supported image format.', 'EPREVIEWFORMAT');
  if (item.size > MAX_PREVIEW_BYTES) {
    throw previewError('Images larger than 50 MB must be downloaded to view.', 'EPREVIEWSIZE');
  }
  const profile = normalizeProfile(request.profile);
  return Object.freeze({
    connectionId: String(request.connectionId || '').trim(),
    profile: Object.freeze({
      remote: profile.remote,
      bucket: profile.bucket,
      endpointHost: profile.endpointHost,
    }),
    item,
    extension,
    format,
  });
}

function containedPreviewPath(cacheDirectory, fileName) {
  const root = path.resolve(String(cacheDirectory || ''));
  const target = path.resolve(root, fileName);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw previewError('Preview cache path must remain inside its cache directory.', 'EPREVIEWPATH');
  }
  return target;
}

function buildPreviewCacheTarget(cacheDirectory, request = {}) {
  const normalized = normalizePreviewRequest(request);
  const cacheKey = crypto.createHash('sha256').update(JSON.stringify({
    connectionId: normalized.connectionId,
    remote: normalized.profile.remote,
    bucket: normalized.profile.bucket,
    endpointHost: normalized.profile.endpointHost,
    path: normalized.item.path,
    size: normalized.item.size,
    modified: normalized.item.modified,
  })).digest('hex');
  const cachePath = containedPreviewPath(
    cacheDirectory,
    `preview-${cacheKey}${normalized.extension}`,
  );
  return Object.freeze({
    ...normalized,
    cacheKey,
    cachePath,
    remotePath: buildRemotePath(normalized.item.path, normalized.profile, { trailingSlash: false }),
  });
}

function buildPreviewCopyArgs(target = {}) {
  if (!target.remotePath || !target.cachePath) {
    throw previewError('A validated preview cache target is required.', 'EPREVIEWTARGET');
  }
  return ['copyto', target.remotePath, target.cachePath, '--size-only'];
}

function generatedPreviewEntries(cacheDirectory, fsModule = fs) {
  try {
    return fsModule.readdirSync(cacheDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && GENERATED_PREVIEW_PATTERN.test(entry.name))
      .map((entry) => {
        const filePath = path.join(cacheDirectory, entry.name);
        return { filePath, name: entry.name, stat: fsModule.statSync(filePath) };
      });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function cleanupPreviewCache(cacheDirectory, {
  fsModule = fs,
  maxAgeMs = DEFAULT_PREVIEW_MAX_AGE_MS,
  maxFiles = DEFAULT_PREVIEW_MAX_FILES,
  now = Date.now(),
} = {}) {
  const ageLimit = Math.max(0, Number(maxAgeMs) || 0);
  const fileLimit = Math.max(0, Math.floor(Number(maxFiles) || 0));
  const entries = generatedPreviewEntries(cacheDirectory, fsModule)
    .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs || left.name.localeCompare(right.name));
  const fresh = entries.filter((entry) => now - entry.stat.mtimeMs <= ageLimit);
  const remove = new Set([
    ...entries.filter((entry) => now - entry.stat.mtimeMs > ageLimit).map((entry) => entry.filePath),
    ...fresh.slice(fileLimit).map((entry) => entry.filePath),
  ]);
  const removed = [];
  for (const filePath of remove) {
    try {
      fsModule.unlinkSync(filePath);
      removed.push(path.basename(filePath));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return {
    removed,
    kept: entries.filter((entry) => !remove.has(entry.filePath)).map((entry) => entry.name),
  };
}

function clearPreviewCache(cacheDirectory, { fsModule = fs } = {}) {
  const entries = generatedPreviewEntries(cacheDirectory, fsModule);
  const removed = [];
  for (const entry of entries) {
    try {
      fsModule.unlinkSync(entry.filePath);
      removed.push(entry.name);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return { removed };
}

module.exports = {
  DEFAULT_PREVIEW_MAX_AGE_MS,
  DEFAULT_PREVIEW_MAX_FILES,
  GENERATED_PREVIEW_PATTERN,
  MAX_PREVIEW_BYTES,
  buildPreviewCacheTarget,
  buildPreviewCopyArgs,
  cleanupPreviewCache,
  clearPreviewCache,
  normalizePreviewRequest,
};
