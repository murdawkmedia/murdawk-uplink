const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  appendRedactedLogFile,
  cleanupActivityLogs,
  createChildLogCoordinator,
  createLogStreamRedactor,
  redactLogText,
  summarizeActivityRecord,
  summarizeActivityRecords,
} = require('../src/activity-core');
const { buildJobRecord, readJobRecords, writeJobRecord } = require('../src/job-core');

test('writes only redacted text to a durable log sink', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uplink-redacted-log-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'nested', 'job.log');

  appendRedactedLogFile(target, { message: 'upload failed', authorization: 'Bearer disk-secret' });
  appendRedactedLogFile(target, 'webhook=https://example.test/hook?token=other-secret');

  const saved = fs.readFileSync(target, 'utf8');
  assert.match(saved, /upload failed/);
  assert.match(saved, /authorization.*REDACTED/i);
  assert.match(saved, /webhook=REDACTED/i);
  assert.doesNotMatch(saved, /disk-secret|other-secret/);
  assert.equal(saved.endsWith('\n'), true);
});

test('summarizes verified work with safe user-facing fields', () => {
  const item = summarizeActivityRecord({
    jobId: 'run-1',
    status: 'complete',
    prefix: 'sample-event/recordings/edits/Main',
    sources: ['C:/private/event/Day1-edit.mp4'],
    startedAt: '2026-07-19T10:00:00.000Z',
    completedAt: '2026-07-19T10:10:00.000Z',
    verification: { ok: true, verified: [{ name: 'Day1-edit.mp4' }], missing: [], sizeMismatch: [] },
    checksum: { ok: true, verified: [{ name: 'Day1-edit.mp4' }], mismatched: [] },
    transferState: { transferred: '8.1 GiB', total: '8.1 GiB', speed: '41 MiB/s' },
    hasLog: true,
  });

  assert.deepEqual(item, {
    jobId: 'run-1',
    direction: 'upload',
    title: 'Day1-edit.mp4',
    sourceCount: 1,
    destination: 'sample-event/recordings/edits/Main',
    result: 'Complete',
    status: 'complete',
    startedAt: '2026-07-19T10:00:00.000Z',
    completedAt: '2026-07-19T10:10:00.000Z',
    elapsedSeconds: 600,
    verification: 'Verified',
    verifiedCount: 1,
    missingCount: 0,
    sizeMismatchCount: 0,
    transferred: '8.1 GiB',
    total: '8.1 GiB',
    speed: '41 MiB/s',
    canResume: false,
    hasLog: true,
    detail: '',
  });
  assert.doesNotMatch(JSON.stringify(item), /C:\/private/i);
});

test('maps durable outcomes to complete attention paused and interrupted', () => {
  const base = { jobId: 'run', sources: ['C:/clip.mov'], prefix: 'event/recordings' };
  assert.equal(summarizeActivityRecord({ ...base, status: 'verified' }).result, 'Complete');
  assert.equal(summarizeActivityRecord({ ...base, status: 'failed' }).result, 'Needs attention');
  assert.equal(summarizeActivityRecord({ ...base, status: 'paused' }).result, 'Paused');
  assert.equal(summarizeActivityRecord({ ...base, status: 'cancelled' }).result, 'Paused');
  assert.equal(summarizeActivityRecord({ ...base, status: 'running' }).result, 'Interrupted');
  assert.equal(summarizeActivityRecord({ ...base, status: 'warning', verification: { ok: true, missing: [], sizeMismatch: [] }, checksum: { ok: true } }).result, 'Complete');
  assert.equal(summarizeActivityRecord({ ...base, status: 'warning', verification: { ok: false } }).result, 'Needs attention');
});

test('summaries redact unsafe errors and never expose notification or profile extras', () => {
  const item = summarizeActivityRecord({
    jobId: 'run-secret',
    status: 'failed',
    sources: ['C:/clip.mov', 'C:/second.mov'],
    prefix: 'event/recordings',
    error: 'Authorization: Bearer top-secret-token',
    access_key: 'must-not-escape',
    notifications: { webhook: 'https://example.test/hook?token=must-not-escape' },
    profile: { remote: 'safe', secret: 'must-not-escape' },
  });

  assert.equal(item.title, 'clip.mov + 1 more');
  assert.equal(item.detail, 'Authorization: REDACTED');
  assert.equal(item.canResume, true);
  assert.doesNotMatch(JSON.stringify(item), /top-secret|must-not-escape|C:\//i);
});

test('summaries redact every credential-shaped user-facing string', () => {
  const item = summarizeActivityRecord({
    jobId: 'safe-job-id',
    status: 'running',
    sources: ['C:/event/access_key=LOCAL-SECRET.mov'],
    prefix: 'sample-event/recordings?token=REMOTE-SECRET',
    startedAt: '2026-07-19T10:00:00.000Z',
    transferState: {
      transferred: 'secret=TRANSFERRED-SECRET',
      total: 'token=TOTAL-SECRET',
      speed: 'access_key=SPEED-SECRET',
    },
  });

  assert.equal(item.title, 'access_key=REDACTED');
  assert.equal(item.destination, 'sample-event/recordings?token=REDACTED');
  assert.equal(item.transferred, 'secret=REDACTED');
  assert.equal(item.total, 'token=REDACTED');
  assert.equal(item.speed, 'access_key=REDACTED');
  assert.equal(item.startedAt, '2026-07-19T10:00:00.000Z');
  assert.doesNotMatch(JSON.stringify(item), /LOCAL-SECRET|REMOTE-SECRET|TRANSFERRED-SECRET|TOTAL-SECRET|SPEED-SECRET/);
});

test('unfinished dry runs are interrupted and resumable while completed dry runs remain complete', () => {
  const base = {
    jobId: 'dry-run-record',
    status: 'dry-run',
    sources: ['C:/event/precheck.mov'],
    prefix: 'sample-event/recordings',
    startedAt: '2026-07-19T10:00:00.000Z',
  };
  const interrupted = summarizeActivityRecord(base);
  const completed = summarizeActivityRecord({
    ...base,
    completedAt: '2026-07-19T10:02:00.000Z',
  });

  assert.equal(interrupted.result, 'Interrupted');
  assert.equal(interrupted.canResume, true);
  assert.equal(completed.result, 'Complete');
  assert.equal(completed.canResume, false);
});

test('redacts credential assignments headers JSON and query-shaped values', () => {
  const cases = [
    ['secret_access_key = abc123', 'secret_access_key = REDACTED'],
    ['Authorization: Bearer token-value', 'Authorization: REDACTED'],
    ['authorization=Basic dXNlcjpwYXNz', 'authorization=REDACTED'],
    ['"token": "json-secret"', '"token": "REDACTED"'],
    ["'access_key':'quoted-secret'", "'access_key':'REDACTED'"],
    ['URL https://example.test/callback?token=query-secret&safe=yes', 'URL https://example.test/callback?token=REDACTED&safe=yes'],
    ['webhook_url=https://example.test/hook?foo=bar&token=nested', 'webhook_url=REDACTED'],
    ['API-TOKEN: value123 useful context', 'API-TOKEN: REDACTED useful context'],
  ];

  for (const [input, expected] of cases) {
    assert.equal(redactLogText(input), expected);
  }
});

test('redacts complete Authorization values and AWS credential query fields', () => {
  const cases = [
    ['Authorization: AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/20260719/nyc3/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=abcdef', 'Authorization: REDACTED'],
    ['authorization: Digest username="murphy", response="digest-secret", opaque="opaque-secret"', 'authorization: REDACTED'],
    ['AUTHORIZATION: CustomScheme custom-secret with spaces', 'AUTHORIZATION: REDACTED'],
    ['{"Authorization":"Bearer json-secret","safe":"kept"}', '{"Authorization":"REDACTED","safe":"kept"}'],
    ['https://example.test/?X-Amz-Credential=AKIAEXAMPLE%2F20260719%2Fnyc3%2Fs3%2Faws4_request&safe=yes', 'https://example.test/?X-Amz-Credential=REDACTED&safe=yes'],
    ['https://example.test/?x-amz-signature=abcdef123&safe=yes', 'https://example.test/?x-amz-signature=REDACTED&safe=yes'],
    ['X-Amz-Security-Token=session-token-value', 'X-Amz-Security-Token=REDACTED'],
    ['AWSAccessKeyId=AKIAEXAMPLE&safe=yes', 'AWSAccessKeyId=REDACTED&safe=yes'],
    ['X%2DAmz%2DCredential%3DAKIAEXAMPLE%2Fscope%26safe%3Dyes', 'X%2DAmz%2DCredential%3DREDACTED%26safe%3Dyes'],
  ];

  for (const [input, expected] of cases) {
    assert.equal(redactLogText(input), expected);
  }
});

test('stream redaction withholds partial records and is safe across every split point', () => {
  const cases = [
    ['token=ASSIGNMENT-SECRET\n', 'token=REDACTED\n', /ASSIGNMENT-SECRET/],
    ['Authorization: AWS4-HMAC-SHA256 Credential=AKIA-SPLIT, Signature=SIG-SPLIT\n', 'Authorization: REDACTED\n', /AKIA-SPLIT|SIG-SPLIT/],
    ['{"access_key":"JSON-SPLIT-SECRET","safe":"kept"}\n', '{"access_key":"REDACTED","safe":"kept"}\n', /JSON-SPLIT-SECRET/],
    ['GET /upload?token=QUERY-SPLIT-SECRET&safe=yes HTTP/1.1\r\nNext: safe\r\n', 'GET /upload?token=REDACTED&safe=yes HTTP/1.1\r\nNext: safe\r\n', /QUERY-SPLIT-SECRET/],
    ['first safe\nsecret=MULTILINE-SECRET\nthird safe\n', 'first safe\nsecret=REDACTED\nthird safe\n', /MULTILINE-SECRET/],
    ['secret_access_key=FINAL-SECRET', 'secret_access_key=REDACTED', /FINAL-SECRET/],
  ];

  for (const [input, expected, secretPattern] of cases) {
    for (let split = 0; split <= input.length; split += 1) {
      const stream = createLogStreamRedactor();
      const first = stream.push(input.slice(0, split));
      assert.doesNotMatch(first, secretPattern, `unsafe partial output at split ${split} for ${input}`);
      const output = first + stream.push(input.slice(split)) + stream.flush();
      assert.equal(output, expected, `split ${split} for ${input}`);
      assert.doesNotMatch(output, secretPattern, `split ${split} for ${input}`);
    }
  }
});

test('stdout and stderr stream redactors keep partial credential state isolated', () => {
  const stdout = createLogStreamRedactor();
  const stderr = createLogStreamRedactor();

  assert.equal(stdout.push('token='), '');
  assert.equal(stderr.push('ordinary stderr\n'), 'ordinary stderr\n');
  assert.equal(stdout.push('STDOUT-SECRET\n'), 'token=REDACTED\n');
  assert.equal(stderr.push('Authorization: Custom STDERR-SECRET'), '');
  assert.equal(stderr.flush(), 'Authorization: REDACTED');
});

test('stream redaction hides folded Authorization continuations for LF and CRLF character streams', () => {
  for (const newline of ['\n', '\r\n']) {
    const input = [
      'Authorization: AWS4-HMAC-SHA256',
      ' Credential=AKIA-FOLDED/20260719/nyc3/s3/aws4_request,',
      '\tSignature=FOLDED-SIGNATURE',
      'Safe: visible',
    ].join(newline) + newline;
    const expected = [
      'Authorization: REDACTED',
      ' REDACTED',
      '\tREDACTED',
      'Safe: visible',
    ].join(newline) + newline;
    const stream = createLogStreamRedactor();
    let output = '';
    for (const character of input) output += stream.push(character);
    output += stream.flush();

    assert.equal(output, expected, JSON.stringify(newline));
    assert.doesNotMatch(output, /AKIA-FOLDED|FOLDED-SIGNATURE/);
  }
});

test('stream redaction hides full Authorization assignments across character splits', () => {
  const cases = [
    'authorization=Custom value; Credential=AKIA-ASSIGN; Signature=ASSIGN-SIGNATURE\n',
    'authorization=Digest value; Signature=ASSIGN-SIGNATURE\r\n',
  ];
  for (const input of cases) {
    const stream = createLogStreamRedactor();
    let output = '';
    for (const character of input) output += stream.push(character);
    output += stream.flush();

    assert.match(output, /^authorization=REDACTED\r?\n$/);
    assert.doesNotMatch(output, /AKIA-ASSIGN|ASSIGN-SIGNATURE|Credential/);
  }
});

test('child log coordinator drains trailing data on close after error exactly once', () => {
  const emitted = [];
  const coordinator = createChildLogCoordinator({
    onSafeText: (stream, text) => emitted.push({ stream, text }),
  });
  const spawnError = new Error('spawn failed');

  coordinator.push('stdout', 'safe before error\n');
  coordinator.push('stdout', 'token=');
  coordinator.noteError(spawnError);
  coordinator.push('stdout', 'TRAILING-SECRET');
  coordinator.push('stderr', 'Authorization: Custom STDERR-SECRET');
  const settlement = coordinator.close(1);
  const duplicate = coordinator.close(1);

  assert.equal(settlement.error, spawnError);
  assert.equal(settlement.code, 1);
  assert.equal(duplicate, null);
  assert.deepEqual(emitted, [
    { stream: 'stdout', text: 'safe before error\n' },
    { stream: 'stdout', text: 'token=REDACTED' },
    { stream: 'stderr', text: 'Authorization: REDACTED' },
  ]);
  assert.doesNotMatch(JSON.stringify(emitted), /TRAILING-SECRET|STDERR-SECRET/);
});

test('child log coordinator handles error then close with no data or duplicate flush', () => {
  const emitted = [];
  const coordinator = createChildLogCoordinator({
    onSafeText: (stream, text) => emitted.push({ stream, text }),
  });
  const spawnError = new Error('spawn failed');

  coordinator.noteError(spawnError);
  assert.deepEqual(coordinator.close(null), { code: null, error: spawnError });
  assert.equal(coordinator.close(null), null);
  assert.deepEqual(emitted, []);
});

test('successful durable resume descendants supersede ancestors across restart without queue state', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uplink-resume-lineage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeJobRecord(root, buildJobRecord({
    jobId: 'resume-parent', status: 'failed', source: 'C:/clip.mov', prefix: 'event/recordings',
    completedAt: '2026-07-19T10:00:00.000Z',
  }));
  writeJobRecord(root, buildJobRecord({
    jobId: 'resume-child', resumeFromJobId: 'resume-parent', status: 'complete',
    source: 'C:/clip.mov', prefix: 'event/recordings', completedAt: '2026-07-19T11:00:00.000Z',
  }));

  const restartedActivity = summarizeActivityRecords(readJobRecords(root, Infinity));
  const parent = restartedActivity.find((record) => record.jobId === 'resume-parent');

  assert.equal(parent.canResume, false);
  assert.equal(parent.result, 'Complete');
  assert.match(parent.detail, /completed by a resumed transfer/i);
});

test('failed cancelled and paused descendants do not supersede resumable ancestors', () => {
  for (const status of ['failed', 'cancelled', 'paused']) {
    const records = summarizeActivityRecords([
      { jobId: `parent-${status}`, status: 'failed', sources: ['C:/clip.mov'], prefix: 'event/recordings' },
      {
        jobId: `child-${status}`, resumeFromJobId: `parent-${status}`, status,
        sources: ['C:/clip.mov'], prefix: 'event/recordings',
      },
    ]);
    assert.equal(records.find((record) => record.jobId === `parent-${status}`).canResume, true, status);
    assert.equal(records.find((record) => record.jobId === `child-${status}`).canResume, true, status);
  }
});

test('summarizes downloads with their direction and local destination', () => {
  const [record] = summarizeActivityRecords([{
    jobId: 'download-complete',
    status: 'complete',
    direction: 'download',
    localDestination: 'C:\\Downloads\\Sample Event',
    prefix: 'sample-event/recordings/edits/Main',
    sources: ['sample-event/recordings/edits/Main/day1-edit.mp4'],
    verification: { ok: true, verified: [{ name: 'day1-edit.mp4' }], missing: [], sizeMismatch: [] },
  }]);

  assert.equal(record.direction, 'download');
  assert.equal(record.destination, 'C:\\Downloads\\Sample Event');
  assert.equal(record.title, 'day1-edit.mp4');
});

test('successful resume lineage supersedes every resumable ancestor transitively', () => {
  const records = summarizeActivityRecords([
    { jobId: 'lineage-root', status: 'failed', sources: ['C:/clip.mov'], prefix: 'event/recordings' },
    {
      jobId: 'lineage-middle', resumeFromJobId: 'lineage-root', status: 'failed',
      sources: ['C:/clip.mov'], prefix: 'event/recordings',
    },
    {
      jobId: 'lineage-complete', resumeFromJobId: 'lineage-middle', status: 'complete',
      sources: ['C:/clip.mov'], prefix: 'event/recordings', completedAt: '2026-07-19T12:00:00.000Z',
    },
  ]);

  assert.equal(records.find((record) => record.jobId === 'lineage-root').canResume, false);
  assert.equal(records.find((record) => record.jobId === 'lineage-middle').canResume, false);
  assert.equal(records.find((record) => record.jobId === 'lineage-complete').canResume, false);
});

test('redacts objects errors circular values and hostile coercion safely', () => {
  const circular = { message: 'still useful', token: 'object-secret' };
  circular.self = circular;
  const hostile = { toString() { throw new Error('secret=coercion-secret'); } };

  assert.doesNotMatch(redactLogText(circular), /object-secret/);
  assert.match(redactLogText(circular), /still useful/);
  assert.equal(redactLogText(new Error('access_key=error-secret')), 'Error: access_key=REDACTED');
  assert.equal(redactLogText(hostile), '[Unprintable log value]');
});

test('redaction never throws or exposes secrets from hostile proxy inspection traps', () => {
  const cases = [
    new Proxy({}, {
      ownKeys() { throw new Error('token=OWNKEYS-SECRET'); },
    }),
    new Proxy({}, {
      getPrototypeOf() { throw new Error('secret=PROTOTYPE-SECRET'); },
    }),
    new Proxy({}, {
      ownKeys() { return []; },
      get(target, property, receiver) {
        if (property === 'toString') throw new Error('access_key=TOSTRING-SECRET');
        return Reflect.get(target, property, receiver);
      },
    }),
    new Proxy(Object.create({ toString() { return 'unused'; } }), {
      ownKeys() { return []; },
      get(target, property, receiver) {
        if (property === Symbol.toPrimitive) throw new Error('token=PRIMITIVE-TRAP-SECRET');
        return Reflect.get(target, property, receiver);
      },
    }),
  ];

  for (const value of cases) {
    let output;
    assert.doesNotThrow(() => { output = redactLogText(value); });
    assert.equal(output, '[Unprintable log value]');
    assert.doesNotMatch(output, /OWNKEYS-SECRET|PROTOTYPE-SECRET|TOSTRING-SECRET|PRIMITIVE-TRAP-SECRET/);
  }
});

test('redaction handles throwing Error properties and primitive coercion without leaking trap errors', () => {
  const throwingName = new Error('safe message');
  Object.defineProperty(throwingName, 'name', {
    get() { throw new Error('token=ERROR-NAME-SECRET'); },
  });
  const throwingMessage = new Error('safe message');
  Object.defineProperty(throwingMessage, 'message', {
    get() { throw new Error('secret=ERROR-MESSAGE-SECRET'); },
  });
  const throwingPrimitive = Object.create({ toString() { return 'unused'; } });
  Object.defineProperty(throwingPrimitive, Symbol.toPrimitive, {
    value() { throw new Error('authorization=PRIMITIVE-SECRET'); },
  });

  for (const value of [throwingName, throwingMessage, throwingPrimitive]) {
    let output;
    assert.doesNotThrow(() => { output = redactLogText(value); });
    assert.equal(output, '[Unprintable log value]');
    assert.doesNotMatch(output, /ERROR-NAME-SECRET|ERROR-MESSAGE-SECRET|PRIMITIVE-SECRET/);
  }
});

test('redaction safely handles circular objects BigInt symbols and functions', () => {
  const circular = { count: 42n, token: 'nested-secret' };
  circular.self = circular;
  const symbol = Symbol('token=SYMBOL-SECRET');
  const callable = function safeCallable() { return 'secret=FUNCTION-SECRET'; };

  for (const value of [circular, 42n, symbol, callable]) {
    let output;
    assert.doesNotThrow(() => { output = redactLogText(value); });
    assert.equal(typeof output, 'string');
    assert.doesNotMatch(output, /nested-secret|SYMBOL-SECRET|FUNCTION-SECRET/);
  }
});

test('cleans only expired and excess direct log files deterministically', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uplink-activity-logs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = Date.parse('2026-07-19T12:00:00.000Z');
  const make = (name, ageDays) => {
    const target = path.join(root, name);
    fs.writeFileSync(target, name, 'utf8');
    const time = new Date(now - ageDays * 86400000);
    fs.utimesSync(target, time, time);
    return target;
  };
  make('expired.log', 31);
  make('boundary.log', 30);
  make('newest.log', 1);
  make('second.log', 2);
  make('unrelated.json', 90);
  fs.mkdirSync(path.join(root, 'nested'));
  make('nested.log', 3);
  fs.renameSync(path.join(root, 'nested.log'), path.join(root, 'nested', 'nested.log'));

  const result = cleanupActivityLogs(root, { now, maxAgeDays: 30, maxFiles: 2 });

  assert.deepEqual(result.removed.map((item) => path.basename(item)), ['expired.log', 'boundary.log']);
  assert.deepEqual(result.kept.map((item) => path.basename(item)), ['newest.log', 'second.log']);
  assert.equal(fs.existsSync(path.join(root, 'unrelated.json')), true);
  assert.equal(fs.existsSync(path.join(root, 'nested', 'nested.log')), true);
});

test('log cleanup orders all deletion candidates oldest first before removing them', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uplink-activity-order-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = Date.parse('2026-07-19T12:00:00.000Z');
  const files = [
    ['alphabetically-first.log', 31],
    ['alphabetically-last.log', 40],
    ['middle.log', 35],
  ];
  for (const [name, ageDays] of files) {
    const target = path.join(root, name);
    fs.writeFileSync(target, name, 'utf8');
    const time = new Date(now - ageDays * 86400000);
    fs.utimesSync(target, time, time);
  }

  const result = cleanupActivityLogs(root, { now, maxAgeDays: 30 });
  assert.deepEqual(result.removed.map((item) => path.basename(item)), [
    'alphabetically-last.log',
    'middle.log',
    'alphabetically-first.log',
  ]);
});

test('log cleanup keeps exactly 500 files and tolerates missing folders', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uplink-activity-limit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = Date.parse('2026-07-19T12:00:00.000Z');
  for (let index = 0; index < 501; index += 1) {
    const target = path.join(root, `${String(index).padStart(3, '0')}.log`);
    fs.writeFileSync(target, 'safe', 'utf8');
    const time = new Date(now - index * 1000);
    fs.utimesSync(target, time, time);
  }

  const result = cleanupActivityLogs(root, { now });
  assert.equal(result.kept.length, 500);
  assert.deepEqual(result.removed.map((item) => path.basename(item)), ['500.log']);
  assert.deepEqual(cleanupActivityLogs(path.join(root, 'missing'), { now }), {
    scanned: 0,
    kept: [],
    removed: [],
    errors: [],
  });
});
