const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const {
  findBlockedPublicPaths,
  findBlockedPublicText,
  isAllowedPublicPath,
} = require('./public-release-core');

const repoRoot = path.resolve(__dirname, '..');
const requestedOutput = process.argv[2];

if (!requestedOutput) {
  throw new Error('Usage: node scripts/build-public-snapshot.js <new-empty-directory>');
}

const outputRoot = path.resolve(requestedOutput);
if (fs.existsSync(outputRoot)) {
  throw new Error('Public snapshot destination must not already exist.');
}

const tracked = execFileSync('git', ['ls-files', '-z'], {
  cwd: repoRoot,
  encoding: 'utf8',
}).split('\0').filter(Boolean);
const selected = tracked.filter(isAllowedPublicPath);
const blockedPaths = findBlockedPublicPaths(selected);

if (blockedPaths.length) {
  throw new Error(`Blocked public paths: ${blockedPaths.join(', ')}`);
}

const sources = selected.map((relative) => {
  const source = path.resolve(repoRoot, relative);
  if (!source.startsWith(`${repoRoot}${path.sep}`)) {
    throw new Error(`Source escaped repository: ${relative}`);
  }
  const stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Public snapshot supports regular tracked files only: ${relative}`);
  }
  if (stat.size <= 5 * 1024 * 1024) {
    const findings = findBlockedPublicText(fs.readFileSync(source, 'utf8'));
    if (findings.length) {
      throw new Error(`Blocked public text in ${relative}: ${findings.join(', ')}`);
    }
  }
  return { relative, source };
});

fs.mkdirSync(outputRoot, { recursive: false });
try {
  for (const { relative, source } of sources) {
    const destination = path.resolve(outputRoot, relative);
    if (!destination.startsWith(`${outputRoot}${path.sep}`)) {
      throw new Error(`Destination escaped snapshot: ${relative}`);
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
} catch (error) {
  fs.rmSync(outputRoot, { recursive: true, force: true });
  throw error;
}

console.log(`Created public snapshot with ${selected.length} tracked files.`);
