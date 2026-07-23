const fs = require('node:fs');
const path = require('node:path');

const { normalizeEventManifest } = require('./event-manifest-core');

const MAX_EVENT_MANIFEST_BYTES = 256 * 1024;

async function loadEventManifestFile(filePath, { maxBytes = MAX_EVENT_MANIFEST_BYTES } = {}) {
  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (_error) {
    throw new Error('Event manifest could not be opened.');
  }
  if (!stat.isFile()) throw new Error('Event manifest must be a JSON file.');
  if (stat.size > maxBytes) throw new Error('Event manifest is too large.');

  let parsed;
  try {
    parsed = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('Event manifest is not valid JSON.');
    throw new Error('Event manifest could not be opened.');
  }

  return {
    label: path.basename(filePath),
    manifest: normalizeEventManifest(parsed),
  };
}

module.exports = {
  MAX_EVENT_MANIFEST_BYTES,
  loadEventManifestFile,
};
