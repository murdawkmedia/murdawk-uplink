const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  buildJobRecord,
  getJobPath,
  readJobRecord,
  readJobRecords,
  redactTarget,
  shouldNotify,
  writeJobRecord,
} = require('../src/job-core');
const {
  buildNtfyRequest,
  buildWebhookRequest,
  normalizeNtfyTarget,
  sendNotifications,
} = require('../src/notification-core');

test('job records keep notification targets redacted', () => {
  const record = buildJobRecord({
    jobId: 'job-1',
    intentId: 'queue-intent-1',
    resumeFromJobId: 'older-failed-job',
    manifestPath: 'C:\\AppRuns\\manifests\\must-not-persist.files-from-raw',
    source: 'C:\\video.mp4',
    prefix: 'archive-event/recordings/day1',
    notifications: {
      webhook: 'https://example.test/hook?token=secret',
      ntfy: 'private-topic',
      notifyOn: 'always',
    },
  });

  assert.equal(record.jobId, 'job-1');
  assert.equal(record.intentId, 'queue-intent-1');
  assert.equal(record.resumeFromJobId, 'older-failed-job');
  assert.equal(Object.hasOwn(record, 'manifestPath'), false);
  assert.equal(JSON.stringify(record).includes('files-from-raw'), false);
  assert.equal(record.notifications.webhook, 'https://example.test/hook?REDACTED');
  assert.equal(record.notifications.ntfy, 'private-topic');
  assert.equal(JSON.stringify(record).includes('token=secret'), false);
});

test('notification policy decides success and failure delivery', () => {
  assert.equal(shouldNotify({ notifyOn: 'success', status: 'verified' }), true);
  assert.equal(shouldNotify({ notifyOn: 'success', status: 'failed' }), false);
  assert.equal(shouldNotify({ notifyOn: 'failure', status: 'failed' }), true);
  assert.equal(shouldNotify({ notifyOn: 'always', status: 'warning' }), true);
});

test('webhook request posts JSON without leaking redacted target into payload', () => {
  const request = buildWebhookRequest({
    target: 'https://example.test/hook',
    payload: { jobId: 'job-1', status: 'verified' },
  });

  assert.equal(request.url, 'https://example.test/hook');
  assert.equal(request.headers['Content-Type'], 'application/json');
  assert.equal(JSON.parse(request.body).status, 'verified');
});

test('ntfy target accepts topics and full URLs', () => {
  assert.equal(normalizeNtfyTarget('murdawk-test'), 'https://ntfy.sh/murdawk-test');
  assert.equal(
    normalizeNtfyTarget('https://ntfy.example.test/topic'),
    'https://ntfy.example.test/topic',
  );
});

test('ntfy request uses title priority tags and text body', () => {
  const request = buildNtfyRequest({
    target: 'murdawk-test',
    title: 'Upload verified',
    message: 'Day 1 is ready',
    priority: 3,
    tags: ['white_check_mark', 'arrow_up'],
  });

  assert.equal(request.url, 'https://ntfy.sh/murdawk-test');
  assert.equal(request.headers.Title, 'Upload verified');
  assert.equal(request.headers.Priority, '3');
  assert.equal(request.headers.Tags, 'white_check_mark,arrow_up');
  assert.equal(request.body, 'Day 1 is ready');
});

test('redacts sensitive URL query strings and long bearer-like path chunks', () => {
  assert.equal(redactTarget('https://example.test/hook?token=secret'), 'https://example.test/hook?REDACTED');
  assert.equal(
    redactTarget('https://ntfy.sh/abcdefghijklmnopqrstuvwxyz123456'),
    'https://ntfy.sh/abc...456',
  );
});

test('sends verified payload to a local webhook', async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      received.push({ headers: req.headers, body: JSON.parse(body) });
      res.writeHead(204);
      res.end();
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const attempts = await sendNotifications({
    notifications: {
      webhook: `http://127.0.0.1:${port}/hook?token=secret`,
      notifyOn: 'success',
    },
    payload: {
      jobId: 'job-1',
      status: 'verified',
      prefix: 'archive-event/recordings/day1',
      urls: ['https://example.test/video.mp4'],
      sizeVerification: { verified: [{ name: 'video.mp4', size: 7 }] },
    },
  });
  server.close();

  assert.equal(attempts[0].ok, true);
  assert.equal(attempts[0].target, `http://127.0.0.1:${port}/hook?REDACTED`);
  assert.equal(received[0].headers['content-type'], 'application/json');
  assert.equal(received[0].body.status, 'verified');
});

test('reads recent job records newest first and skips invalid files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uplink-jobs-'));
  writeJobRecord(root, buildJobRecord({
    jobId: 'older',
    status: 'complete',
    prefix: 'archive-event/recordings/old',
    completedAt: '2026-06-01T01:00:00.000Z',
  }));
  writeJobRecord(root, buildJobRecord({
    jobId: 'newer',
    status: 'running',
    prefix: 'archive-event/recordings/new',
    startedAt: '2026-06-01T02:00:00.000Z',
  }));
  fs.writeFileSync(path.join(root, 'broken.json'), '{ nope', 'utf8');

  const records = readJobRecords(root);

  assert.deepEqual(records.map((record) => record.jobId), ['newer', 'older']);
});

test('durable job records preserve connection identity and a frozen non-secret profile snapshot', () => {
  const record = buildJobRecord({
    jobId: 'connection-job-1',
    connectionId: 'archive',
    source: 'C:/video.mp4',
    prefix: 'event/recordings',
    profileSnapshot: {
      remote: 'archive',
      bucket: 'archive-media',
      endpointHost: 'sfo3.digitaloceanspaces.com',
      secretAccessKey: 'MUST_NOT_STORE',
    },
  });

  assert.equal(record.connectionId, 'archive');
  assert.deepEqual(record.profileSnapshot, {
    remote: 'archive',
    bucket: 'archive-media',
    endpointHost: 'sfo3.digitaloceanspaces.com',
  });
  assert.notStrictEqual(record.profile, record.profileSnapshot);
  assert.equal(Object.isFrozen(record.profile), true);
  assert.equal(Object.isFrozen(record.profileSnapshot), true);
  assert.equal(Reflect.set(record.profile, 'remote', 'changed'), false);
  assert.equal(record.profileSnapshot.remote, 'archive');
  assert.doesNotMatch(JSON.stringify(record), /MUST_NOT_STORE|secretAccessKey/i);
});

test('durable job records discard unsafe connection ids', () => {
  const record = buildJobRecord({
    jobId: 'unsafe-connection-job',
    connectionId: '../access_key=DO_NOT_STORE',
    source: 'C:/video.mp4',
  });

  assert.equal(record.connectionId, '');
  assert.doesNotMatch(JSON.stringify(record), /DO_NOT_STORE|access_key/i);
});

test('recovers one job from its exact backup without listing backup or temp duplicates', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uplink-job-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = buildJobRecord({
    jobId: 'recoverable',
    intentId: 'queue-intent-1',
    resumeFromJobId: 'failed-parent',
    source: 'C:/exports/day1.mov',
    prefix: 'archive/day1',
    profile: {
      remote: 'archive',
      bucket: 'media',
      endpointHost: 'sfo3.digitaloceanspaces.com',
    },
    notifications: {
      webhook: 'https://example.test/hook?token=secret',
      ntfy: 'private-topic-with-a-long-secret-shape',
    },
  });
  writeJobRecord(root, original);
  writeJobRecord(root, buildJobRecord({ ...original, status: 'running' }));
  const target = path.join(root, 'recoverable.json');
  fs.writeFileSync(target, '{broken-primary', 'utf8');
  fs.writeFileSync(`${target}.tmp-abandoned`, JSON.stringify({ jobId: 'duplicate-temp' }), 'utf8');
  fs.writeFileSync(path.join(root, 'invalid.json'), '{broken-without-backup', 'utf8');

  const recovered = readJobRecord(root, 'recoverable');
  const records = readJobRecords(root);

  assert.equal(recovered.jobId, 'recoverable');
  assert.equal(recovered.intentId, 'queue-intent-1');
  assert.equal(recovered.resumeFromJobId, 'failed-parent');
  assert.deepEqual(recovered.profile, original.profile);
  assert.equal(JSON.stringify(recovered).includes('token=secret'), false);
  assert.deepEqual(records.map((record) => record.jobId), ['recoverable']);
});

test('job reads recover valid backup from parsed but invalid primary records', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uplink-job-shape-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  for (const [index, invalid] of [null, {}, [], { jobId: 'wrong-shape' }].entries()) {
    const jobId = `shape-${index}`;
    const target = path.join(root, `${jobId}.json`);
    const backup = buildJobRecord({
      jobId,
      status: 'running',
      source: `C:/exports/${jobId}.mov`,
      prefix: `archive/${jobId}`,
    });
    fs.writeFileSync(target, JSON.stringify(invalid), 'utf8');
    fs.writeFileSync(`${target}.bak`, JSON.stringify(backup), 'utf8');
    assert.equal(readJobRecord(root, jobId).prefix, backup.prefix);
  }
  assert.deepEqual(
    new Set(readJobRecords(root).map((record) => record.jobId)),
    new Set(['shape-0', 'shape-1', 'shape-2', 'shape-3']),
  );
});

test('job validator rejects secret-shaped structurally plausible primary records', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uplink-job-secret-shape-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const jobId = 'safe-backup';
  const target = path.join(root, `${jobId}.json`);
  const backup = buildJobRecord({
    jobId,
    status: 'running',
    source: 'C:/exports/safe.mov',
    prefix: 'archive/safe',
  });
  fs.writeFileSync(target, JSON.stringify({
    ...backup,
    accessKeyId: 'MUST_NOT_ACCEPT',
  }), 'utf8');
  fs.writeFileSync(`${target}.bak`, JSON.stringify(backup), 'utf8');

  assert.equal(readJobRecord(root, jobId).prefix, backup.prefix);
  assert.doesNotMatch(JSON.stringify(readJobRecord(root, jobId)), /MUST_NOT_ACCEPT|accessKeyId/i);
});

test('job validator rejects malformed connection identity and non-strict snapshots', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uplink-job-connection-shape-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const backup = buildJobRecord({
    jobId: 'safe-connection-backup',
    status: 'running',
    connectionId: 'archive',
    source: 'C:/exports/safe.mov',
    prefix: 'archive/safe',
    profileSnapshot: {
      remote: 'archive',
      bucket: 'archive-media',
      endpointHost: 'sfo3.digitaloceanspaces.com',
    },
  });
  const target = path.join(root, `${backup.jobId}.json`);
  fs.writeFileSync(`${target}.bak`, JSON.stringify(backup), 'utf8');

  for (const invalid of [
    { ...backup, connectionId: '../archive' },
    { ...backup, profileSnapshot: { ...backup.profileSnapshot, extra: 'not allowed' } },
  ]) {
    fs.writeFileSync(target, JSON.stringify(invalid), 'utf8');
    assert.deepEqual(readJobRecord(root, backup.jobId), backup);
  }
});

test('job write does not rotate structurally invalid primary over good backup', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uplink-job-rotate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const jobId = 'rotation-safe';
  const target = path.join(root, `${jobId}.json`);
  const backup = buildJobRecord({
    jobId,
    status: 'created',
    source: 'C:/exports/original.mov',
    prefix: 'archive/original',
  });
  fs.writeFileSync(target, JSON.stringify({ jobId, unrelated: true }), 'utf8');
  fs.writeFileSync(`${target}.bak`, JSON.stringify(backup), 'utf8');

  writeJobRecord(root, buildJobRecord({
    jobId,
    status: 'running',
    source: 'C:/exports/new.mov',
    prefix: 'archive/new',
  }));

  assert.equal(JSON.parse(fs.readFileSync(`${target}.bak`, 'utf8')).prefix, backup.prefix);
  assert.equal(readJobRecord(root, jobId).prefix, 'archive/new');
});

test('job ids cannot escape the jobs directory', (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'uplink-job-path-'));
  const root = path.join(parent, 'jobs');
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const unsafeIds = ['../outside', '..\\outside', '/absolute/outside', 'C:\\absolute\\outside', '.', 'bad\u0000id'];

  for (const jobId of unsafeIds) {
    assert.throws(() => getJobPath(root, jobId), (error) => error.code === 'EJOBID');
    assert.throws(
      () => writeJobRecord(root, buildJobRecord({ jobId, status: 'created', source: 'C:/safe.mov' })),
      (error) => error.code === 'EJOBID',
    );
    assert.throws(() => readJobRecord(root, jobId), (error) => error.code === 'EJOBID');
  }

  assert.equal(fs.existsSync(path.join(parent, 'outside.json')), false);
  assert.deepEqual(fs.existsSync(root) ? fs.readdirSync(root) : [], []);
});

test('required job reads throw typed missing and corrupt errors', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uplink-job-errors-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.throws(
    () => readJobRecord(root, 'missing-job'),
    (error) => error.code === 'EJOBNOTFOUND' && /not found/i.test(error.message),
  );
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'corrupt-job.json'), JSON.stringify({ jobId: 'corrupt-job' }), 'utf8');
  assert.throws(
    () => readJobRecord(root, 'corrupt-job'),
    (error) => error.code === 'EJOBCORRUPT' && /corrupt|invalid/i.test(error.message),
  );
});

test('CLI status by missing job reports a clear record error', () => {
  const result = spawnSync(process.execPath, [
    path.resolve(__dirname, '../bin/murdawk-uplink.js'),
    'status',
    '--job',
    'definitely-missing-quality-review-job',
  ], { encoding: 'utf8' });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /job record not found/i);
  assert.doesNotMatch(result.stderr, /cannot convert undefined|null dereference/i);
});
