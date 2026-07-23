const path = require('node:path');
const {
  assertUnderRecordingsPrefix,
  joinRemotePath,
  normalizeEventManifest,
  normalizePathPart,
} = require('./event-manifest-core');

function getDayName(text = '') {
  const match = String(text || '').match(/day[\s_-]*([123])/i) || String(text || '').match(/\bday([123])\b/i);
  return match ? `Day ${match[1]}` : '';
}

function fileNameFromPath(fullPath = '', relativePath = '') {
  return path.basename(String(fullPath || relativePath).replace(/\\/g, '/'));
}

function destination(manifest, ...parts) {
  return assertUnderRecordingsPrefix(joinRemotePath(manifest.recordingsPrefix, ...parts), manifest);
}

function inferEventDestination({
  manifest: inputManifest,
  sourceRoot = '',
  relativePath = '',
  fullPath = '',
} = {}) {
  const manifest = normalizeEventManifest(inputManifest);
  const rel = normalizePathPart(relativePath);
  const lower = rel.toLowerCase();
  const fileName = fileNameFromPath(fullPath, rel);
  const day = getDayName(`${rel} ${fileName}`);

  if (lower.startsWith('assets/davinci/')) {
    return { destinationPath: destination(manifest, 'assets/Main/Davinci', rel.slice('assets/davinci/'.length)) };
  }
  if (lower === 'assets/sponsors/short-sponsor-for-talk-edits.mp4') {
    return { destinationPath: destination(manifest, 'assets/Main/2_sec_sponsor', fileName) };
  }
  if (lower.startsWith('assets/sponsors/')) {
    return { destinationPath: destination(manifest, 'assets/Main/15_sec_sponsor', rel.slice('assets/sponsors/'.length)) };
  }
  if (lower.startsWith('assets/talk-slides/main-stage/')) {
    return { destinationPath: destination(manifest, 'assets/Main/talk-slides', rel.slice('assets/talk-slides/main-stage/'.length)) };
  }
  if (lower.startsWith('assets/talk-slides/talks-stage/')) {
    return { destinationPath: destination(manifest, 'assets/Talk/talk-slides', rel.slice('assets/talk-slides/talks-stage/'.length)) };
  }
  if (lower.startsWith('assets/talk-slides/workshops-stage/')) {
    return { destinationPath: destination(manifest, 'assets/Workshop/talk-slides', rel.slice('assets/talk-slides/workshops-stage/'.length)) };
  }
  if (lower.startsWith('assets/music/')) {
    return { destinationPath: destination(manifest, 'assets/Main/custom song', rel.slice('assets/music/'.length)) };
  }
  if (lower.startsWith('assets/') && /bug.*\.(png|mov|mp4)$/i.test(lower)) {
    return { destinationPath: destination(manifest, 'assets/Main/bug overlay', fileName) };
  }
  if (lower.startsWith('assets/')) {
    return { destinationPath: destination(manifest, 'assets/Main/misc', rel.slice('assets/'.length)) };
  }
  if (lower.startsWith('live stream/')) {
    return { destinationPath: destination(manifest, 'edits/Main', fileName) };
  }
  if (lower.startsWith('canon-c100-raw/') && day) {
    return { destinationPath: destination(manifest, 'raw/Main', day, 'Canon C100', fileName) };
  }
  if (lower.startsWith('canon-c100-raw/')) {
    return {
      destinationPath: null,
      ambiguousReason: 'Canon C100 file has a generic filename and no day in the local path.',
    };
  }
  if (lower.startsWith('iso-raw-mix/logs/') && day) {
    return { destinationPath: destination(manifest, 'raw/Main', day, 'Mix/logs', fileName) };
  }
  if (lower.startsWith('iso-raw-mix/') && day) {
    return { destinationPath: destination(manifest, 'raw/Main', day, 'Mix', fileName) };
  }
  if (lower.startsWith('dji_hackathonexpo/')) {
    return { destinationPath: destination(manifest, 'raw/Main/Day 2/Hackathon/dji_hackathonExpo', rel.slice('dji_hackathonexpo/'.length)) };
  }
  if (day && (/^day [123]\//i.test(rel) || /^day[123]\//i.test(rel))) {
    return { destinationPath: destination(manifest, 'raw/Main', day, 'Cameras', fileName) };
  }

  return {
    destinationPath: null,
    ambiguousReason: 'No conservative destination rule matched.',
  };
}

function buildLocalEventRecord({
  manifest,
  sourceRoot = '',
  relativePath = '',
  fullPath = '',
  size = 0,
  modifiedTime = '',
} = {}) {
  const inferred = inferEventDestination({ manifest, sourceRoot, relativePath, fullPath });
  return {
    sourceRoot,
    path: fullPath,
    relativePath: normalizePathPart(relativePath),
    fileName: fileNameFromPath(fullPath, relativePath),
    size: Number(size || 0),
    modifiedTime,
    destinationPath: inferred.destinationPath || null,
    ambiguousReason: inferred.ambiguousReason || null,
  };
}

module.exports = {
  buildLocalEventRecord,
  getDayName,
  inferEventDestination,
};
