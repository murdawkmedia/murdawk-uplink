const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { readJsonWithBackup, writeJsonAtomic } = require('../src/atomic-json-core');

function createRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uplink-atomic-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function injectFs(overrides = {}) {
  return new Proxy(fs, {
    get(target, property) {
      return overrides[property] || Reflect.get(target, property);
    },
  });
}

function tempSiblings(root) {
  return fs.readdirSync(root).filter((name) => name.includes('.tmp-'));
}

function generatedArtifacts(root) {
  return fs.readdirSync(root).filter((name) => (
    name.includes('.tmp-')
    || name.endsWith('.lock')
    || name.endsWith('.lock.stale')
    || name.endsWith('.lock-recovery')
    || name.includes('.lock-claim-')
  ));
}

async function waitForFile(filePath, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for ' + filePath);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function runWriterChild({ helperPath, target, writer, startAt, iterations = 8 }) {
  const script = `
    const { writeJsonAtomic } = require(process.argv[1]);
    const target = process.argv[2];
    const writer = Number(process.argv[3]);
    const startAt = Number(process.argv[4]);
    const iterations = Number(process.argv[5]);
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    while (Date.now() < startAt) Atomics.wait(sleeper, 0, 0, Math.min(10, startAt - Date.now()));
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      writeJsonAtomic(target, {
        writer,
        iteration,
        marker: writer + ':' + iteration,
        body: String(writer).repeat(32768),
      });
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['-e', script, helperPath, target, String(writer), String(startAt), String(iterations)],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`writer ${writer} timed out`));
    }, 10_000);
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`writer ${writer} exited ${code}: ${stderr}`));
    });
  });
}

function runQuarantineRecovererChild({
  helperPath,
  target,
  writer,
  readyPath,
  goPath,
  outcomePath,
  releasePath,
  renamedPath,
}) {
  const script = [
    "const fs = require('node:fs');",
    "const { writeJsonAtomic } = require(process.argv[1]);",
    'const target = process.argv[2];',
    'const writer = Number(process.argv[3]);',
    'const readyPath = process.argv[4];',
    'const goPath = process.argv[5];',
    'const outcomePath = process.argv[6];',
    'const releasePath = process.argv[7];',
    'const renamedPath = process.argv[8];',
    "const lockPath = target + '.lock';",
    "const quarantinePath = lockPath + '.stale';",
    'const sleeper = new Int32Array(new SharedArrayBuffer(4));',
    'let paused = false;',
    'const injectedFs = new Proxy(fs, {',
    '  get(base, property) {',
    "    if (property === 'openSync') {",
    '      return (filePath, flags, ...args) => {',
    "        if (!paused && filePath === quarantinePath && flags === 'wx') {",
    '          paused = true;',
    "          fs.writeFileSync(readyPath, 'ready', 'utf8');",
    '          while (!fs.existsSync(goPath)) Atomics.wait(sleeper, 0, 0, 5);',
    '          try {',
    '            const result = fs.openSync(filePath, flags, ...args);',
    "            fs.writeFileSync(outcomePath, 'won', 'utf8');",
    '            while (!fs.existsSync(releasePath)) Atomics.wait(sleeper, 0, 0, 5);',
    '            return result;',
    '          } catch (error) {',
    "            fs.writeFileSync(outcomePath, 'lost', 'utf8');",
    '            throw error;',
    '          }',
    '        }',
    '        return fs.openSync(filePath, flags, ...args);',
    '      };',
    '    }',
    "    if (property === 'renameSync') {",
    '      return (source, destination) => {',
    '        const result = fs.renameSync(source, destination);',
    '        if (source === lockPath && destination === quarantinePath) {',
    "          fs.writeFileSync(renamedPath, 'renamed', 'utf8');",
    '        }',
    '        return result;',
    '      };',
    '    }',
    '    return Reflect.get(base, property);',
    '  },',
    '});',
    'writeJsonAtomic(target, { writer }, {',
    '  fs: injectedFs,',
    '  lockTimeoutMs: 5_000,',
    '  lockRetryMs: 5,',
    '  staleLockMs: 1_000,',
    '});',
  ].join('\n');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '-e',
      script,
      helperPath,
      target,
      String(writer),
      readyPath,
      goPath,
      outcomePath,
      releasePath,
      renamedPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('quarantine recoverer timed out: ' + stderr));
    }, 10_000);
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error('quarantine recoverer exited ' + code + ': ' + stderr));
    });
  });
}

test('recovers from a corrupt primary using the previous valid backup', (t) => {
  const root = createRoot(t);
  const target = path.join(root, 'settings.json');
  writeJsonAtomic(target, { version: 1 });
  writeJsonAtomic(target, { version: 2 });

  fs.writeFileSync(target, '{broken', 'utf8');

  assert.deepEqual(readJsonWithBackup(target), { version: 1 });
});

test('returns null when both primary and backup contain malformed JSON', (t) => {
  const root = createRoot(t);
  const target = path.join(root, 'settings.json');
  fs.writeFileSync(target, '{broken-primary', 'utf8');
  fs.writeFileSync(`${target}.bak`, '{broken-backup', 'utf8');

  assert.equal(readJsonWithBackup(target), null);
});

test('validator rejects parsed but structurally invalid primaries and recovers backup', (t) => {
  const root = createRoot(t);
  const target = path.join(root, 'validated.json');
  const validator = (value) => Boolean(value && value.kind === 'settings');
  fs.writeFileSync(`${target}.bak`, JSON.stringify({ kind: 'settings', version: 7 }), 'utf8');

  for (const invalid of [null, {}, [], { kind: 'wrong' }]) {
    fs.writeFileSync(target, JSON.stringify(invalid), 'utf8');
    assert.deepEqual(readJsonWithBackup(target, { validator }), { kind: 'settings', version: 7 });
  }
});

test('validator prevents an invalid primary from replacing a valid backup', (t) => {
  const root = createRoot(t);
  const target = path.join(root, 'validated.json');
  const validator = (value) => Boolean(value && value.kind === 'settings');
  const backup = { kind: 'settings', version: 1 };
  fs.writeFileSync(target, JSON.stringify({ wrong: true }), 'utf8');
  fs.writeFileSync(`${target}.bak`, JSON.stringify(backup), 'utf8');

  writeJsonAtomic(target, { kind: 'settings', version: 2 }, { validator });

  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { kind: 'settings', version: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(`${target}.bak`, 'utf8')), backup);
});

test('leaves no temporary siblings after successful writes', (t) => {
  const root = createRoot(t);
  const target = path.join(root, 'job.json');

  writeJsonAtomic(target, { ok: true });
  writeJsonAtomic(target, { ok: true, version: 2 });

  assert.deepEqual(tempSiblings(root), []);
});

test('uses unique temporary paths during repeated rapid writes', (t) => {
  const root = createRoot(t);
  const target = path.join(root, 'settings.json');
  const openedTemps = [];
  const injectedFs = injectFs({
    openSync(filePath, flags, ...args) {
      if (String(filePath).includes('.tmp-')) openedTemps.push(filePath);
      return fs.openSync(filePath, flags, ...args);
    },
  });

  for (let version = 0; version < 25; version += 1) {
    writeJsonAtomic(target, { version }, { fs: injectedFs });
  }

  assert.equal(new Set(openedTemps).size, openedTemps.length);
  assert.deepEqual(readJsonWithBackup(target), { version: 24 });
  assert.deepEqual(tempSiblings(root), []);
});

test('replaces existing files when rename cannot overwrite a Windows destination', (t) => {
  const root = createRoot(t);
  const target = path.join(root, 'job.json');
  writeJsonAtomic(target, { version: 1 });
  const injectedFs = injectFs({
    renameSync(source, destination) {
      if (fs.existsSync(destination)) {
        const error = new Error('destination exists');
        error.code = 'EEXIST';
        throw error;
      }
      return fs.renameSync(source, destination);
    },
  });

  writeJsonAtomic(target, { version: 2 }, { fs: injectedFs });

  assert.deepEqual(readJsonWithBackup(target), { version: 2 });
  assert.deepEqual(readJsonWithBackup(`${target}.bak`), { version: 1 });
  assert.deepEqual(tempSiblings(root), []);
});

test('restores the last valid primary when replacement fails', (t) => {
  const root = createRoot(t);
  const target = path.join(root, 'job.json');
  writeJsonAtomic(target, { version: 1 });
  writeJsonAtomic(target, { version: 2 });
  let candidatePath = '';
  const injectedFs = injectFs({
    openSync(filePath, flags, ...args) {
      if (String(filePath).startsWith(`${target}.tmp-`)) candidatePath = filePath;
      return fs.openSync(filePath, flags, ...args);
    },
    renameSync(source, destination) {
      if (source === candidatePath && destination === target) {
        if (fs.existsSync(destination)) {
          const error = new Error('destination exists');
          error.code = 'EEXIST';
          throw error;
        }
        const error = new Error('injected replacement failure');
        error.code = 'EIO';
        throw error;
      }
      return fs.renameSync(source, destination);
    },
  });

  assert.throws(
    () => writeJsonAtomic(target, { version: 3 }, { fs: injectedFs }),
    /injected replacement failure/,
  );
  assert.deepEqual(readJsonWithBackup(target), { version: 2 });
  assert.deepEqual(readJsonWithBackup(`${target}.bak`), { version: 2 });
  assert.deepEqual(tempSiblings(root), []);
  assert.equal(fs.existsSync(`${target}.lock`), false);
});

test('serializes genuine multi-process writers without partial JSON or artifacts', { timeout: 15_000 }, async (t) => {
  const root = createRoot(t);
  const target = path.join(root, 'shared.json');
  const helperPath = path.resolve(__dirname, '../src/atomic-json-core.js');
  const startAt = Date.now() + 400;

  const results = await Promise.allSettled(Array.from({ length: 4 }, (_, writer) => runWriterChild({
    helperPath,
    target,
    writer,
    startAt,
  })));
  const failures = results.filter((result) => result.status === 'rejected');
  assert.deepEqual(failures, []);

  const primary = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(primary.iteration, 7);
  assert.equal(primary.marker, `${primary.writer}:7`);
  assert.equal(primary.body, String(primary.writer).repeat(32768));
  if (fs.existsSync(`${target}.bak`)) {
    const backup = JSON.parse(fs.readFileSync(`${target}.bak`, 'utf8'));
    assert.equal(backup.marker, `${backup.writer}:${backup.iteration}`);
    assert.equal(backup.body, String(backup.writer).repeat(32768));
  }
  assert.deepEqual(
    generatedArtifacts(root),
    [],
  );
});

test('serializes multiple processes recovering the same stale lock', { timeout: 15_000 }, async (t) => {
  const root = createRoot(t);
  const target = path.join(root, 'stale-shared.json');
  const lockPath = `${target}.lock`;
  const helperPath = path.resolve(__dirname, '../src/atomic-json-core.js');
  const oldTime = Date.now() - 60_000;
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: 2147483647,
    token: 'crashed-owner',
    createdAt: oldTime,
  }), 'utf8');
  fs.utimesSync(lockPath, new Date(oldTime), new Date(oldTime));
  const startAt = Date.now() + 400;

  const results = await Promise.allSettled(Array.from({ length: 6 }, (_, writer) => runWriterChild({
    helperPath,
    target,
    writer,
    startAt,
    iterations: 1,
  })));
  assert.deepEqual(results.filter((result) => result.status === 'rejected'), []);

  const primary = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(primary.marker, `${primary.writer}:0`);
  assert.equal(primary.body, String(primary.writer).repeat(32768));
  if (fs.existsSync(`${target}.bak`)) {
    const backup = JSON.parse(fs.readFileSync(`${target}.bak`, 'utf8'));
    assert.equal(backup.marker, `${backup.writer}:${backup.iteration}`);
    assert.equal(backup.body, String(backup.writer).repeat(32768));
  }
  assert.deepEqual(generatedArtifacts(root), []);
});

test('only one stale recoverer quarantines the lock and neither removes a new canonical lock', { timeout: 15_000 }, async (t) => {
  const root = createRoot(t);
  const target = path.join(root, 'settings.json');
  const lockPath = `${target}.lock`;
  const helperPath = path.resolve(__dirname, '../src/atomic-json-core.js');
  const goPath = path.join(root, 'go.signal');
  const releasePath = path.join(root, 'release.signal');
  const readyPaths = [0, 1].map((writer) => path.join(root, `ready-${writer}.signal`));
  const outcomePaths = [0, 1].map((writer) => path.join(root, `outcome-${writer}.signal`));
  const renamedPaths = [0, 1].map((writer) => path.join(root, `renamed-${writer}.signal`));
  const oldTime = Date.now() - 60_000;
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: 2147483647,
    token: 'crashed-owner',
    createdAt: oldTime,
  }), 'utf8');
  fs.utimesSync(lockPath, new Date(oldTime), new Date(oldTime));

  const children = [0, 1].map((writer) => runQuarantineRecovererChild({
    helperPath,
    target,
    writer,
    readyPath: readyPaths[writer],
    goPath,
    outcomePath: outcomePaths[writer],
    releasePath,
    renamedPath: renamedPaths[writer],
  }));
  await Promise.all(readyPaths.map((readyPath) => waitForFile(readyPath)));
  fs.writeFileSync(goPath, 'go', 'utf8');
  await Promise.all(outcomePaths.map((outcomePath) => waitForFile(outcomePath)));
  const outcomes = outcomePaths.map((outcomePath) => fs.readFileSync(outcomePath, 'utf8'));
  assert.equal(outcomes.filter((outcome) => outcome === 'won').length, 1);
  assert.equal(outcomes.filter((outcome) => outcome === 'lost').length, 1);
  fs.writeFileSync(releasePath, 'release', 'utf8');
  await Promise.all(children);

  assert.equal(renamedPaths.filter((renamedPath) => fs.existsSync(renamedPath)).length, 1);
  assert.ok([0, 1].includes(readJsonWithBackup(target).writer));
  assert.deepEqual(generatedArtifacts(root), []);
});

test('legacy crashed recovery gate cannot block normal lock acquisition', (t) => {
  const root = createRoot(t);
  const target = path.join(root, 'settings.json');
  const recoveryPath = `${target}.lock-recovery`;
  fs.writeFileSync(recoveryPath, JSON.stringify({
    pid: 2147483647,
    token: 'crashed-recoverer',
    createdAt: Date.now() - 60_000,
  }), 'utf8');

  writeJsonAtomic(target, { ignoredLegacyGate: true }, {
    lockTimeoutMs: 250,
    lockRetryMs: 5,
    staleLockMs: 1_000,
  });

  assert.deepEqual(readJsonWithBackup(target), { ignoredLegacyGate: true });
  assert.equal(fs.existsSync(recoveryPath), true);
});

test('fresh quarantine blocks acquisition and remains untouched', (t) => {
  const root = createRoot(t);
  const target = path.join(root, 'settings.json');
  const quarantinePath = `${target}.lock.stale`;
  const owner = {
    pid: process.pid,
    token: 'live-recoverer',
    createdAt: Date.now(),
  };
  fs.writeFileSync(quarantinePath, JSON.stringify(owner), 'utf8');

  assert.throws(
    () => writeJsonAtomic(target, { unsafe: true }, {
      lockTimeoutMs: 80,
      lockRetryMs: 5,
      staleLockMs: 10,
    }),
    (error) => error.code === 'ELOCKED',
  );

  assert.equal(JSON.parse(fs.readFileSync(quarantinePath, 'utf8')).token, owner.token);
  assert.equal(fs.existsSync(`${target}.lock`), false);
  assert.equal(fs.existsSync(target), false);
});

test('busy quarantine respects the configured absolute lock deadline', (t) => {
  const root = createRoot(t);
  const target = path.join(root, 'settings.json');
  const quarantinePath = `${target}.lock.stale`;
  const oldTime = Date.now() - 60_000;
  fs.writeFileSync(quarantinePath, JSON.stringify({
    pid: 2147483647,
    token: 'crashed-recoverer',
    createdAt: oldTime,
  }), 'utf8');
  fs.utimesSync(quarantinePath, new Date(oldTime), new Date(oldTime));
  const injectedFs = injectFs({
    unlinkSync(filePath) {
      if (filePath === quarantinePath) {
        const error = new Error('permanently busy quarantine');
        error.code = 'EBUSY';
        throw error;
      }
      return fs.unlinkSync(filePath);
    },
  });
  const startedAt = Date.now();

  assert.throws(
    () => writeJsonAtomic(target, { blocked: true }, {
      fs: injectedFs,
      lockTimeoutMs: 80,
      lockRetryMs: 5,
      staleLockMs: 1_000,
    }),
    (error) => error.code === 'ELOCKED',
  );

  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 50, `Expected bounded retry, got ${elapsed}ms`);
  assert.ok(elapsed < 350, `Lock timeout exceeded its bound: ${elapsed}ms`);
  assert.equal(fs.existsSync(quarantinePath), true);
});

test('recovers an exact stale lock left by a crashed owner', (t) => {
  const root = createRoot(t);
  const target = path.join(root, 'settings.json');
  const lockPath = `${target}.lock`;
  const oldTime = Date.now() - 60_000;
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: 2147483647,
    token: 'crashed-owner',
    createdAt: oldTime,
  }), 'utf8');
  fs.utimesSync(lockPath, new Date(oldTime), new Date(oldTime));

  writeJsonAtomic(target, { recovered: true }, {
    lockTimeoutMs: 250,
    lockRetryMs: 5,
    staleLockMs: 1_000,
  });

  assert.deepEqual(readJsonWithBackup(target), { recovered: true });
  assert.equal(fs.existsSync(lockPath), false);
});

test('recovers a stale orphan quarantine left by a crashed recoverer', (t) => {
  const root = createRoot(t);
  const target = path.join(root, 'settings.json');
  const quarantinePath = `${target}.lock.stale`;
  const oldTime = Date.now() - 60_000;
  fs.writeFileSync(quarantinePath, JSON.stringify({
    pid: 2147483647,
    token: 'crashed-recoverer',
    createdAt: oldTime,
  }), 'utf8');
  fs.utimesSync(quarantinePath, new Date(oldTime), new Date(oldTime));

  writeJsonAtomic(target, { recovered: true }, {
    lockTimeoutMs: 250,
    lockRetryMs: 5,
    staleLockMs: 1_000,
  });

  assert.deepEqual(readJsonWithBackup(target), { recovered: true });
  assert.deepEqual(generatedArtifacts(root), []);
});

test('recovers when a crash leaves stale canonical and quarantine siblings', (t) => {
  const root = createRoot(t);
  const target = path.join(root, 'settings.json');
  const lockPath = `${target}.lock`;
  const quarantinePath = `${lockPath}.stale`;
  const oldTime = Date.now() - 60_000;
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: 2147483647,
    token: 'crashed-writer',
    createdAt: oldTime,
  }), 'utf8');
  fs.writeFileSync(quarantinePath, JSON.stringify({
    pid: 2147483647,
    token: 'crashed-recoverer',
    createdAt: oldTime,
  }), 'utf8');
  fs.utimesSync(lockPath, new Date(oldTime), new Date(oldTime));
  fs.utimesSync(quarantinePath, new Date(oldTime), new Date(oldTime));

  writeJsonAtomic(target, { recoveredPair: true }, {
    lockTimeoutMs: 500,
    lockRetryMs: 5,
    staleLockMs: 1_000,
  });

  assert.deepEqual(readJsonWithBackup(target), { recoveredPair: true });
  assert.deepEqual(generatedArtifacts(root), []);
});

test('removes stale quarantine without disturbing a fresh live canonical lock', (t) => {
  const root = createRoot(t);
  const target = path.join(root, 'settings.json');
  const lockPath = `${target}.lock`;
  const quarantinePath = `${lockPath}.stale`;
  const oldTime = Date.now() - 60_000;
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: process.pid,
    token: 'live-writer',
    createdAt: Date.now(),
  }), 'utf8');
  fs.writeFileSync(quarantinePath, JSON.stringify({
    pid: 2147483647,
    token: 'crashed-recoverer',
    createdAt: oldTime,
  }), 'utf8');
  fs.utimesSync(quarantinePath, new Date(oldTime), new Date(oldTime));

  assert.throws(
    () => writeJsonAtomic(target, { blocked: true }, {
      lockTimeoutMs: 100,
      lockRetryMs: 5,
      staleLockMs: 1_000,
    }),
    (error) => error.code === 'ELOCKED',
  );

  assert.equal(fs.existsSync(quarantinePath), false);
  assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token, 'live-writer');
  assert.equal(fs.existsSync(target), false);
});

test('serializes processes recovering combined stale canonical and quarantine state', { timeout: 15_000 }, async (t) => {
  const root = createRoot(t);
  const target = path.join(root, 'combined-stale.json');
  const lockPath = `${target}.lock`;
  const quarantinePath = `${lockPath}.stale`;
  const helperPath = path.resolve(__dirname, '../src/atomic-json-core.js');
  const oldTime = Date.now() - 60_000;
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: 2147483647,
    token: 'crashed-writer',
    createdAt: oldTime,
  }), 'utf8');
  fs.writeFileSync(quarantinePath, JSON.stringify({
    pid: 2147483647,
    token: 'crashed-recoverer',
    createdAt: oldTime,
  }), 'utf8');
  fs.utimesSync(lockPath, new Date(oldTime), new Date(oldTime));
  fs.utimesSync(quarantinePath, new Date(oldTime), new Date(oldTime));
  const startAt = Date.now() + 400;

  const results = await Promise.allSettled(Array.from({ length: 4 }, (_, writer) => runWriterChild({
    helperPath,
    target,
    writer,
    startAt,
    iterations: 1,
  })));
  assert.deepEqual(results.filter((result) => result.status === 'rejected'), []);

  const primary = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(primary.marker, `${primary.writer}:0`);
  assert.equal(primary.body, String(primary.writer).repeat(32768));
  if (fs.existsSync(`${target}.bak`)) JSON.parse(fs.readFileSync(`${target}.bak`, 'utf8'));
  assert.deepEqual(generatedArtifacts(root), []);
});

test('releases its own canonical lock when quarantine appears during acquisition', (t) => {
  const root = createRoot(t);
  const target = path.join(root, 'settings.json');
  const lockPath = `${target}.lock`;
  const quarantinePath = `${lockPath}.stale`;
  const oldTime = Date.now() - 60_000;
  let lockAcquisitions = 0;
  const injectedFs = injectFs({
    openSync(filePath, flags, ...args) {
      const handle = fs.openSync(filePath, flags, ...args);
      if (filePath === lockPath && flags === 'wx') {
        lockAcquisitions += 1;
        if (lockAcquisitions === 1) {
          fs.writeFileSync(quarantinePath, JSON.stringify({
            pid: 2147483647,
            token: 'crashed-recoverer',
            createdAt: oldTime,
          }), 'utf8');
          fs.utimesSync(quarantinePath, new Date(oldTime), new Date(oldTime));
        }
      }
      return handle;
    },
  });

  writeJsonAtomic(target, { handshake: true }, {
    fs: injectedFs,
    lockTimeoutMs: 250,
    lockRetryMs: 5,
    staleLockMs: 1_000,
  });

  assert.equal(lockAcquisitions, 2);
  assert.deepEqual(readJsonWithBackup(target), { handshake: true });
  assert.deepEqual(generatedArtifacts(root), []);
});

test('cleans only stale legacy claim siblings with the exact generated prefix', (t) => {
  const root = createRoot(t);
  const target = path.join(root, 'settings.json');
  const oldClaimPath = `${target}.lock-claim-old`;
  const freshClaimPath = `${target}.lock-claim-fresh`;
  const unrelatedPath = path.join(root, 'unrelated.lock-claim-old');
  const oldTime = Date.now() - 60_000;
  fs.writeFileSync(oldClaimPath, JSON.stringify({
    pid: 2147483647,
    token: 'old-claim',
    createdAt: oldTime,
  }), 'utf8');
  fs.utimesSync(oldClaimPath, new Date(oldTime), new Date(oldTime));
  fs.writeFileSync(freshClaimPath, JSON.stringify({
    pid: process.pid,
    token: 'fresh-claim',
    createdAt: Date.now(),
  }), 'utf8');
  fs.writeFileSync(unrelatedPath, 'leave-me', 'utf8');

  writeJsonAtomic(target, { cleaned: true }, {
    lockTimeoutMs: 250,
    lockRetryMs: 5,
    staleLockMs: 1_000,
  });

  assert.equal(fs.existsSync(oldClaimPath), false);
  assert.equal(fs.existsSync(freshClaimPath), true);
  assert.equal(fs.readFileSync(unrelatedPath, 'utf8'), 'leave-me');
});

test('times out without removing a fresh lock owned by a live process', (t) => {
  const root = createRoot(t);
  const target = path.join(root, 'settings.json');
  const lockPath = `${target}.lock`;
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: process.pid,
    token: 'live-owner',
    createdAt: Date.now(),
  }), 'utf8');
  const startedAt = Date.now();

  assert.throws(
    () => writeJsonAtomic(target, { blocked: false }, {
      lockTimeoutMs: 80,
      lockRetryMs: 5,
      staleLockMs: 10,
    }),
    (error) => error.code === 'ELOCKED' && /Timed out/.test(error.message),
  );

  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token, 'live-owner');
  assert.equal(fs.existsSync(`${target}.lock-recovery`), false);
  assert.equal(fs.existsSync(target), false);
});

test('retries bounded Windows lock acquisition and release races', (t) => {
  const root = createRoot(t);
  const target = path.join(root, 'settings.json');
  const lockPath = `${target}.lock`;
  let lockOpenAttempts = 0;
  let lockReadAttempts = 0;
  let lockDeleteAttempts = 0;
  const injectedFs = injectFs({
    openSync(filePath, flags, ...args) {
      if (filePath === lockPath && lockOpenAttempts === 0) {
        lockOpenAttempts += 1;
        const error = new Error('temporary Windows open race');
        error.code = 'EPERM';
        throw error;
      }
      return fs.openSync(filePath, flags, ...args);
    },
    readFileSync(filePath, ...args) {
      if (filePath === lockPath && lockReadAttempts === 0) {
        lockReadAttempts += 1;
        const error = new Error('temporary Windows read race');
        error.code = 'EPERM';
        throw error;
      }
      return fs.readFileSync(filePath, ...args);
    },
    unlinkSync(filePath) {
      if (filePath === lockPath && lockDeleteAttempts === 0) {
        lockDeleteAttempts += 1;
        const error = new Error('temporary Windows delete race');
        error.code = 'EBUSY';
        throw error;
      }
      return fs.unlinkSync(filePath);
    },
  });

  writeJsonAtomic(target, { ok: true }, {
    fs: injectedFs,
    lockTimeoutMs: 250,
    lockRetryMs: 5,
  });

  assert.deepEqual(readJsonWithBackup(target), { ok: true });
  assert.equal(lockOpenAttempts, 1);
  assert.equal(lockReadAttempts, 1);
  assert.equal(lockDeleteAttempts, 1);
  assert.equal(fs.existsSync(lockPath), false);
});
