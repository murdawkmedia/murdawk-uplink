const { normalizePathPart } = require('./event-manifest-core');

function normalizeRemoteRecord(record = {}) {
  return {
    path: normalizePathPart(record.path || record.Path || record.relativePath || ''),
    relativePath: normalizePathPart(record.relativePath || record.Path || record.path || ''),
    fileName: String(record.fileName || record.Name || '').trim(),
    size: Number(record.size ?? record.Size ?? 0),
    modTime: record.modTime || record.ModTime || '',
  };
}

function isPlaceholderRecord(record = {}) {
  const normalized = normalizeRemoteRecord(record);
  const pathParts = normalized.path.split('/').filter(Boolean);
  return normalized.fileName === '.keep' || pathParts.at(-1) === '.keep';
}

function buildRemoteIndexes(remoteRecords = []) {
  const byPath = new Map();
  const byName = new Map();
  for (const raw of remoteRecords) {
    if (isPlaceholderRecord(raw)) continue;
    const remote = normalizeRemoteRecord(raw);
    if (!remote.path) continue;
    byPath.set(remote.path.toLowerCase(), remote);
    const nameKey = remote.fileName.toLowerCase();
    if (!byName.has(nameKey)) byName.set(nameKey, []);
    byName.get(nameKey).push(remote);
  }
  return { byPath, byName };
}

function basenameSizeEvidence(local = {}, byName = new Map()) {
  const nameKey = String(local.fileName || '').toLowerCase();
  if (!nameKey || !byName.has(nameKey)) return [];
  return byName.get(nameKey).filter((remote) => Number(remote.size) === Number(local.size));
}

function reconcileEventRecords({ localRecords = [], remoteRecords = [] } = {}) {
  const mediaRemoteRecords = remoteRecords.filter((record) => !isPlaceholderRecord(record));
  const { byPath, byName } = buildRemoteIndexes(mediaRemoteRecords);
  const matched = [];
  const missing = [];
  const sizeMismatch = [];
  const ambiguous = [];

  for (const local of localRecords) {
    if (!local.destinationPath) {
      ambiguous.push({
        local,
        evidence: basenameSizeEvidence(local, byName),
      });
      continue;
    }

    const key = normalizePathPart(local.destinationPath).toLowerCase();
    if (byPath.has(key)) {
      const remote = byPath.get(key);
      if (Number(remote.size) === Number(local.size)) {
        matched.push({ local, remote, matchType: 'exact-path-size' });
      } else {
        sizeMismatch.push({ local, remote, reason: 'Exact destination exists with different size.' });
      }
      continue;
    }

    const evidence = basenameSizeEvidence(local, byName);
    if (evidence.length) {
      matched.push({ local, remote: evidence, matchType: 'basename-size-elsewhere' });
      continue;
    }

    const sameName = byName.get(String(local.fileName || '').toLowerCase()) || [];
    if (sameName.length) {
      sizeMismatch.push({ local, remote: sameName, reason: 'Filename exists remotely with different size.' });
      continue;
    }

    missing.push(local);
  }

  return {
    summary: {
      localCount: localRecords.length,
      localBytes: localRecords.reduce((total, item) => total + Number(item.size || 0), 0),
      remoteCount: mediaRemoteRecords.length,
      remoteBytes: mediaRemoteRecords.reduce((total, item) => total + Number(item.size ?? item.Size ?? 0), 0),
      matchedCount: matched.length,
      missingCount: missing.length,
      missingBytes: missing.reduce((total, item) => total + Number(item.size || 0), 0),
      sizeMismatchCount: sizeMismatch.length,
      ambiguousCount: ambiguous.length,
    },
    matched,
    missing,
    sizeMismatch,
    ambiguous,
  };
}

module.exports = {
  basenameSizeEvidence,
  buildRemoteIndexes,
  isPlaceholderRecord,
  normalizeRemoteRecord,
  reconcileEventRecords,
};
