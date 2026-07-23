const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  PUBLIC_PATHS,
  findBlockedPublicPaths,
  findBlockedPublicText,
  isAllowedPublicPath,
} = require('../../scripts/public-release-core');

const repoRoot = path.resolve(__dirname, '..', '..');

test('public snapshot allowlist excludes private project material', () => {
  assert(PUBLIC_PATHS.includes('app'));
  assert(PUBLIC_PATHS.includes('README.md'));
  assert(!PUBLIC_PATHS.includes('STATUS.md'));
  assert(!PUBLIC_PATHS.includes('docs/superpowers'));
  assert(!PUBLIC_PATHS.includes('docs/client-upload-one-pager.md'));
  assert.equal(isAllowedPublicPath('app/src/main.js'), true);
  assert.equal(isAllowedPublicPath('STATUS.md'), false);
});

test('public release scan blocks private paths client data and credentials', () => {
  assert.deepEqual(findBlockedPublicPaths([
    'README.md',
    '.runs/jobs/one.json',
    'dist/Murdawk Uplink.exe',
    'client/event-manifest.json',
  ]), [
    '.runs/jobs/one.json',
    'client/event-manifest.json',
    'dist/Murdawk Uplink.exe',
  ]);

  const workstationPath = ['D:', '\\Users\\Example\\private'].join('');
  const tokenPrefix = ['github', '_pat_'].join('');
  const findings = findBlockedPublicText(`${workstationPath}\n${tokenPrefix}${'A'.repeat(40)}`);
  assert(findings.includes('absolute-windows-path'));
  assert(findings.includes('provider-token'));
});

test('public metadata declares Apache-2.0 and contribution boundaries', () => {
  const license = fs.readFileSync(path.join(repoRoot, 'LICENSE'), 'utf8');
  assert.match(license, /Apache License\s+Version 2\.0, January 2004/);

  const notice = fs.readFileSync(path.join(repoRoot, 'NOTICE'), 'utf8');
  assert.match(notice, /Murdawk Uplink/);
  assert.match(notice, /Copyright 2026 Murdawk Media/);

  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'app', 'package.json'), 'utf8'));
  assert.equal(packageJson.private, true);
  assert.equal(packageJson.license, 'Apache-2.0');
  assert.equal(PUBLIC_PATHS.includes('CONTRIBUTING.md'), true);
});
