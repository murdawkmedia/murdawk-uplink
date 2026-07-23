const path = require('node:path');

const PUBLIC_PATHS = Object.freeze([
  '.github',
  '.gitignore',
  'AGENTS.md',
  'CONTRIBUTING.md',
  'LICENSE',
  'NOTICE',
  'README.md',
  'SECURITY.md',
  'app',
  'docs/event-workspace-reconcile.md',
  'docs/verified-job-notifications.md',
  'examples',
  'launch-murdawk-uplink.cmd',
  'launch-murdawk-uplink.vbs',
  'scripts/build-public-snapshot.js',
  'scripts/install-desktop-shortcut.ps1',
  'scripts/public-release-core.js',
]);

const BLOCKED_PATH_PATTERNS = Object.freeze([
  /(^|\/)\.runs(\/|$)/i,
  /(^|\/)dist(\/|$)/i,
  /(^|\/)node_modules(\/|$)/i,
  /(^|\/)status\.md$/i,
  /(^|\/)docs\/superpowers(\/|$)/i,
  /(^|\/)(client|private|internal)(\/|$)/i,
  /(^|\/)(\.env|rclone\.conf|s3cmd\.ini|credentials?(\.json)?|secrets?\.json)$/i,
  /\.(pem|key|p12|pfx|log|sqlite3?|db)$/i,
]);

const privateWorkflowPattern = new RegExp([
  'Murphy',
  'OS|\\.her',
  'mes|super',
  'powers[\\\\/]work',
  'trees',
].join(''), 'i');

const clientIdentifierPattern = new RegExp([
  'Bitcoin',
  '\\+\\+|',
  'bt',
  'cpp|',
  'Nai',
  'robi|Toronto 2026 E',
  '5|Vienna Digital',
  'Ocean',
].join(''), 'i');

const BLOCKED_TEXT_PATTERNS = Object.freeze({
  'absolute-windows-path': /\b[A-Za-z]:\\(?:Users|Documents|Desktop|AppData)\\/i,
  'absolute-posix-home': /\/(?:Users|home)\/[A-Za-z0-9._-]+\//,
  'private-workflow-name': privateWorkflowPattern,
  'client-identifier': clientIdentifierPattern,
  'private-key': /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  'provider-token': /(?:github_pat_|gh[pousr]_|dop_v1_|AKIA|ASIA)[A-Za-z0-9_\-]{16,}/,
});

function normalizeTrackedPath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function findBlockedPublicPaths(paths) {
  return [...new Set(paths.map(normalizeTrackedPath)
    .filter((entry) => BLOCKED_PATH_PATTERNS.some((pattern) => pattern.test(entry))))]
    .sort();
}

function findBlockedPublicText(text) {
  return Object.entries(BLOCKED_TEXT_PATTERNS)
    .filter(([, pattern]) => pattern.test(String(text || '')))
    .map(([name]) => name);
}

function isAllowedPublicPath(candidate) {
  const normalized = normalizeTrackedPath(candidate);
  return PUBLIC_PATHS.some((entry) => normalized === entry || normalized.startsWith(`${entry}/`));
}

module.exports = {
  BLOCKED_PATH_PATTERNS,
  BLOCKED_TEXT_PATTERNS,
  PUBLIC_PATHS,
  findBlockedPublicPaths,
  findBlockedPublicText,
  isAllowedPublicPath,
  normalizeTrackedPath,
};
