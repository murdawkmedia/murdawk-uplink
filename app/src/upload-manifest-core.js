const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const GENERATED_MANIFEST_NAME_PATTERN = /^upload-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.files-from-raw$/i;
const DEFAULT_MANIFEST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MANIFEST_SCAN_LIMIT = 1000;

function normalizeManifestRelativePath(value = '') {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
  const parts = normalized.split('/');
  if (
    !normalized
    || normalized.startsWith('/')
    || /^[a-z]:\//i.test(normalized)
    || parts.includes('..')
    || /[\r\n\0]/.test(normalized)
  ) {
    throw new Error(`Unsafe frozen upload manifest path: ${JSON.stringify(value)}`);
  }
  return normalized;
}

function serializeFrozenRelativePaths(relativePaths = []) {
  const paths = Array.from(new Set(relativePaths.map(normalizeManifestRelativePath))).sort();
  if (!paths.length) {
    throw new Error('Frozen directory upload manifest requires at least one relative file path.');
  }
  return `${paths.join('\n')}\n`;
}

function redactRuntimePaths(text = '', runtimePaths = []) {
  const variants = runtimePaths
    .filter(Boolean)
    .flatMap((runtimePath) => {
      const raw = String(runtimePath);
      return [raw, raw.replace(/\\/g, '/'), raw.replace(/\//g, '\\')];
    })
    .filter((runtimePath, index, paths) => paths.indexOf(runtimePath) === index)
    .sort((left, right) => right.length - left.length);
  return variants
    .reduce(
      (value, runtimePath) => value.split(String(runtimePath)).join('[frozen-upload-manifest]'),
      String(text),
    );
}

function scavengeAbandonedManifests({
  manifestDirectory,
  maxAgeMs = DEFAULT_MANIFEST_MAX_AGE_MS,
  maxEntries = DEFAULT_MANIFEST_SCAN_LIMIT,
  nowMs = Date.now(),
  fsApi = fs,
} = {}) {
  const directory = path.resolve(manifestDirectory || '');
  const ageThreshold = Math.max(60 * 1000, Number(maxAgeMs) || DEFAULT_MANIFEST_MAX_AGE_MS);
  const scanLimit = Math.min(
    5000,
    Math.max(1, Math.floor(Number(maxEntries) || DEFAULT_MANIFEST_SCAN_LIMIT)),
  );
  const result = { inspected: 0, removed: [], errors: 0 };
  let directoryHandle;

  try {
    directoryHandle = fsApi.opendirSync(directory);
  } catch (error) {
    if (error?.code !== 'ENOENT') result.errors += 1;
    return result;
  }

  try {
    while (result.inspected < scanLimit) {
      const entry = directoryHandle.readSync();
      if (!entry) break;
      result.inspected += 1;
      if (!entry.isFile() || !GENERATED_MANIFEST_NAME_PATTERN.test(entry.name)) continue;

      const manifestPath = path.join(directory, entry.name);
      try {
        const stat = fsApi.lstatSync(manifestPath);
        if (!stat.isFile() || Number(stat.mtimeMs) > Number(nowMs) - ageThreshold) continue;
        fsApi.rmSync(manifestPath, { force: true });
        result.removed.push(manifestPath);
      } catch (_error) {
        result.errors += 1;
      }
    }
  } finally {
    try {
      directoryHandle.closeSync();
    } catch (_error) {
      result.errors += 1;
    }
  }

  return result;
}

async function withFrozenDirectoryManifest({
  manifestDirectory,
  relativePaths = [],
  fsApi = fs,
  uniqueId = () => crypto.randomUUID(),
} = {}, runWithManifest) {
  if (typeof runWithManifest !== 'function') {
    throw new TypeError('Frozen directory upload runner is required.');
  }
  const directory = path.resolve(manifestDirectory || '');
  const id = String(uniqueId()).replace(/[^a-z0-9-]/gi, '') || crypto.randomUUID();
  const manifestPath = path.join(directory, `upload-${id}.files-from-raw`);
  const contents = serializeFrozenRelativePaths(relativePaths);
  fsApi.mkdirSync(directory, { recursive: true });
  try {
    fsApi.writeFileSync(manifestPath, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return await runWithManifest(manifestPath);
  } catch (error) {
    if (error && typeof error === 'object') {
      for (const key of ['message', 'stdout', 'stderr']) {
        if (typeof error[key] === 'string') {
          error[key] = redactRuntimePaths(error[key], [manifestPath]);
        }
      }
    }
    throw error;
  } finally {
    try {
      fsApi.rmSync(manifestPath, { force: true });
    } catch (error) {
      if (error && typeof error.message === 'string') {
        error.message = redactRuntimePaths(error.message, [manifestPath]);
      }
      throw error;
    }
  }
}

module.exports = {
  DEFAULT_MANIFEST_MAX_AGE_MS,
  GENERATED_MANIFEST_NAME_PATTERN,
  normalizeManifestRelativePath,
  redactRuntimePaths,
  scavengeAbandonedManifests,
  serializeFrozenRelativePaths,
  withFrozenDirectoryManifest,
};
