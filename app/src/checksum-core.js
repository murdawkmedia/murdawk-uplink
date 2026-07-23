const crypto = require('node:crypto');
const fs = require('node:fs');

function normalizeChecksumMode(mode = 'size') {
  const clean = String(mode || 'size').toLowerCase();
  if (clean === 'size' || clean === 'size-only') return 'size';
  if (clean === 'sha256' || clean === 'full' || clean === 'full-sha256') return 'sha256';
  throw new Error(`Unsupported checksum mode: ${mode}`);
}

function computeFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function compareChecksumEntries(entries = []) {
  const verified = [];
  const mismatched = [];

  for (const entry of entries) {
    if (entry.localSha256 && entry.remoteSha256 && entry.localSha256 === entry.remoteSha256) {
      verified.push({ name: entry.name, sha256: entry.localSha256 });
    } else {
      mismatched.push({
        name: entry.name,
        localSha256: entry.localSha256 || '',
        remoteSha256: entry.remoteSha256 || '',
      });
    }
  }

  return {
    mode: 'sha256',
    verified,
    mismatched,
    ok: mismatched.length === 0,
  };
}

function skippedChecksumReport(mode = 'size') {
  return {
    mode: normalizeChecksumMode(mode),
    verified: [],
    mismatched: [],
    ok: true,
    skipped: normalizeChecksumMode(mode) === 'size',
  };
}

module.exports = {
  compareChecksumEntries,
  computeFileSha256,
  normalizeChecksumMode,
  skippedChecksumReport,
};
