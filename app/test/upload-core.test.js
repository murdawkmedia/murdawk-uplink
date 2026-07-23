const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  collectLocalUploadNames,
  DEFAULT_PROFILE,
  buildCopyArgs,
  buildExplorerListArgs,
  buildJsonListArgs,
  buildListArgs,
  buildRemoteOperationArgs,
  buildRemotePath,
  buildTouchArgs,
  buildPublicUrl,
  buildVerificationReport,
  collectLocalUploadEntries,
  collectLocalUploadSourcePlan,
  formatBytes,
  normalizeExplorerPath,
  normalizeFilterMode,
  normalizePrefix,
  parseExplorerEntries,
  parseRcloneProgress,
  normalizeProfile,
} = require('../src/upload-core');
const { connectionDescriptorForProfile } = require('../src/navigation-core');
const { connectionStateAfterRemoval, repairManagedConnectionId } = require('../src/connection-core');
const { DEFAULT_SETTINGS, readSettings, sanitizeSettings, writeSettings } = require('../src/settings');

test('builds required dry-run rclone copy arguments without public ACL', () => {
  const args = buildCopyArgs({
    source: 'C:\\Austria Mix\\day-1',
    prefix: '/archive-event/recordings/day1/',
    include: '*.mp4',
    publicRead: true,
    dryRun: true,
    folderUploadMode: 'contents',
  });

  assert.deepEqual(args, [
    'copy',
    'C:\\Austria Mix\\day-1',
    'media:media/archive-event/recordings/day1/',
    '--include',
    '*.mp4',
    '--progress',
    '--transfers',
    '4',
    '--s3-chunk-size',
    '64M',
    '--s3-upload-concurrency',
    '4',
    '--retries',
    '20',
    '--retries-sleep',
    '30s',
    '--low-level-retries',
    '60',
    '--size-only',
    '--dry-run',
  ]);
});

test('fills transfer defaults when copy args receive a summarized profile', () => {
  const args = buildCopyArgs({
    source: 'C:\\Austria Mix\\day-1',
    prefix: 'archive-event/recordings/_acceptance',
    dryRun: true,
    profile: {
      remote: 'media',
      bucket: 'media',
      endpointHost: 'media.nyc3.digitaloceanspaces.com',
    },
  });

  assert.equal(args.includes('undefined'), false);
  assert.equal(args[args.indexOf('--transfers') + 1], '4');
  assert.equal(args[args.indexOf('--s3-chunk-size') + 1], '64M');
  assert.equal(args[args.indexOf('--s3-upload-concurrency') + 1], '4');
});

test('all-files mode omits include filters and collects every regular file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spaces-uploader-all-'));
  fs.mkdirSync(path.join(root, 'nested'));
  fs.writeFileSync(path.join(root, 'clip.mov'), 'mov');
  fs.writeFileSync(path.join(root, 'poster.jpeg'), 'jpeg');
  fs.writeFileSync(path.join(root, 'nested', 'notes.txt'), 'notes');

  assert.equal(normalizeFilterMode(''), 'all');
  assert.equal(DEFAULT_PROFILE.defaultFilterMode, 'all');
  assert.equal(DEFAULT_PROFILE.defaultInclude, '');
  assert.deepEqual(collectLocalUploadNames(root, '', 'all', { folderUploadMode: 'contents' }), [
    'clip.mov',
    'nested/notes.txt',
    'poster.jpeg',
  ]);

  const args = buildCopyArgs({
    source: root,
    prefix: 'archive-event/recordings/stage-2',
    filterMode: 'all',
    dryRun: true,
  });
  assert.equal(args.includes('--include'), false);
});

test('folder package mode preserves the dropped folder root remotely', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spaces-uploader-package-'));
  const source = path.join(root, 'assets');
  fs.mkdirSync(path.join(source, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(source, 'poster.png'), 'png');
  fs.writeFileSync(path.join(source, 'nested', 'notes.txt'), 'notes');

  assert.deepEqual(collectLocalUploadNames(source, '', 'all', { folderUploadMode: 'package' }), [
    'assets/nested/notes.txt',
    'assets/poster.png',
  ]);
  assert.deepEqual(collectLocalUploadEntries(source, '', 'all', { folderUploadMode: 'contents' }).map((entry) => entry.name), [
    'nested/notes.txt',
    'poster.png',
  ]);

  const args = buildCopyArgs({
    source,
    prefix: 'archive-event/recordings/raw/stage1/day1',
    filterMode: 'all',
    folderUploadMode: 'package',
    dryRun: true,
  });

  assert.equal(args[2].replace(/\\/g, '/'), 'media:media/archive-event/recordings/raw/stage1/day1/assets/');
});

test('folder package mode preserves physically empty leaf folders with placeholder entries', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spaces-uploader-empty-tree-'));
  const source = path.join(root, 'recordings');
  fs.mkdirSync(path.join(source, 'main', 'assets'), { recursive: true });
  fs.mkdirSync(path.join(source, 'main', 'mix', 'day 1'), { recursive: true });
  fs.mkdirSync(path.join(source, 'main', 'mix', 'day 2'), { recursive: true });
  fs.mkdirSync(path.join(source, 'main', 'mix', 'day 3'), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const plan = collectLocalUploadSourcePlan(source, '', 'all', { folderUploadMode: 'package' });

  assert.deepEqual(plan.entries, []);
  assert.deepEqual(plan.placeholderEntries.map((entry) => entry.name), [
    'recordings/main/assets/.keep',
    'recordings/main/mix/day 1/.keep',
    'recordings/main/mix/day 2/.keep',
    'recordings/main/mix/day 3/.keep',
  ]);
  assert.equal(plan.placeholderEntries.every((entry) => entry.size === 0), true);
});

test('media presets include multiple file types while custom filters stay narrow', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spaces-uploader-media-'));
  fs.writeFileSync(path.join(root, 'clip.mp4'), '');
  fs.writeFileSync(path.join(root, 'talk.mov'), '');
  fs.writeFileSync(path.join(root, 'poster.png'), '');
  fs.writeFileSync(path.join(root, 'notes.txt'), '');

  assert.deepEqual(collectLocalUploadNames(root, '', 'videos-images', { folderUploadMode: 'contents' }), [
    'clip.mp4',
    'poster.png',
    'talk.mov',
  ]);
  assert.deepEqual(collectLocalUploadNames(root, '*.mp4', 'custom', { folderUploadMode: 'contents' }), ['clip.mp4']);
});

test('builds public upload args, remote listing args, and JSON verification args', () => {
  const uploadArgs = buildCopyArgs({
    source: 'C:\\video.mp4',
    prefix: 'archive-event/recordings/day1',
    include: '*.mp4',
    publicRead: true,
    dryRun: false,
  });
  const listArgs = buildListArgs({ prefix: 'archive-event/recordings/day1', include: '*.mp4' });
  const jsonArgs = buildJsonListArgs({ prefix: 'archive-event/recordings/day1' });

  assert.equal(uploadArgs.includes('--s3-acl'), true);
  assert.equal(uploadArgs[uploadArgs.indexOf('--s3-acl') + 1], 'public-read');
  assert.deepEqual(listArgs, [
    'lsf',
    'media:media/archive-event/recordings/day1/',
    '--include',
    '*.mp4',
    '--recursive',
    '--files-only',
  ]);
  assert.deepEqual(jsonArgs, [
    'lsjson',
    'media:media/archive-event/recordings/day1/',
    '--recursive',
    '--files-only',
  ]);
});

test('normalizes prefixes and generates public DigitalOcean URLs', () => {
  assert.equal(normalizePrefix('\\archive-event\\recordings\\day1\\'), 'archive-event/recordings/day1');
  assert.equal(
    buildPublicUrl({ prefix: 'archive-event/recordings/day1', fileName: 'clip 01.mp4' }),
    'https://media.nyc3.digitaloceanspaces.com/archive-event/recordings/day1/clip%2001.mp4',
  );
});

test('normalizes non-secret DigitalOcean profile settings for alternate Spaces', () => {
  const profile = normalizeProfile({
    remote: 'frog-space',
    bucket: 'frog-bucket',
    endpointHost: 'sfo3.digitaloceanspaces.com',
    secretAccessKey: 'DO_NOT_KEEP',
  });

  assert.equal(profile.remote, 'frog-space');
  assert.equal(profile.bucket, 'frog-bucket');
  assert.equal(profile.endpointHost, 'sfo3.digitaloceanspaces.com');
  assert.equal(Object.hasOwn(profile, 'secretAccessKey'), false);
  assert.equal(buildPublicUrl({
    prefix: 'archive/raw',
    fileName: 'clip.mov',
    profile,
  }), 'https://sfo3.digitaloceanspaces.com/archive/raw/clip.mov');
});

test('sanitizes persisted settings and keeps secrets out', () => {
  const settings = sanitizeSettings({
    source: 'C:\\Austria Mix\\day-1',
    prefix: '',
    include: '',
    publicRead: false,
    access_key_id: 'DO_NOT_STORE',
    secret_access_key: 'DO_NOT_STORE',
  });

  assert.deepEqual(settings, {
    settingsVersion: 2,
    connections: [],
    activeConnectionId: '',
    source: 'C:\\Austria Mix\\day-1',
    prefix: DEFAULT_PROFILE.defaultPrefix,
    include: DEFAULT_PROFILE.defaultInclude,
    filterMode: 'all',
    publicRead: false,
    checksum: 'sha256',
    notifyWebhook: '',
    notifyNtfy: '',
    notifyOn: 'success',
    folderUploadMode: 'package',
    recentPrefixes: [],
    recentPrefixesByConnection: {},
    pinnedPrefixes: [],
    archiveEvent: 'event',
    archiveCategory: 'raw',
    archiveStage: 'main',
    archiveDay: 'day-1',
    archivePackageName: 'mix',
    profile: {
      remote: DEFAULT_PROFILE.remote,
      bucket: DEFAULT_PROFILE.bucket,
      endpointHost: DEFAULT_PROFILE.endpointHost,
    },
    queueJobs: [],
  });
  assert.equal(Object.hasOwn(settings, 'secret_access_key'), false);
});

test('uses validated rclone remote names in command destinations', () => {
  const args = buildCopyArgs({
    source: 'C:\\Sample Event\\day-1.mov',
    prefix: 'sample-event/recordings/edits/Main',
    dryRun: true,
    profile: {
      remote: 'Archive+Media@Sample Event',
      bucket: 'event-media',
      endpointHost: 'tor1.digitaloceanspaces.com',
    },
  });

  assert.equal(args[2], 'Archive+Media@Sample Event:event-media/sample-event/recordings/edits/Main/');
  for (const remote of ['archive:other', 'archive/path', 'archive\\path', 'C']) {
    assert.throws(() => buildRemotePath('event', {
      remote,
      bucket: 'event-media',
      endpointHost: 'tor1.digitaloceanspaces.com',
    }), /remote|Windows drive/i, remote);
  }
});

test('migrates legacy settings to schema v2 exactly once without guessing on fresh settings', () => {
  const legacy = sanitizeSettings({
    profile: {
      remote: 'media',
      bucket: 'media',
      endpointHost: 'nyc3.digitaloceanspaces.com',
    },
    recentPrefixes: ['second-event/recordings'],
    pinnedPrefixes: ['second-event/recordings/edits'],
  });

  assert.equal(legacy.settingsVersion, 2);
  assert.equal(legacy.activeConnectionId, 'media');
  assert.equal(legacy.connections.length, 1);
  assert.deepEqual(legacy.connections[0].recentPrefixes, ['second-event/recordings']);
  assert.deepEqual(legacy.connections[0].pinnedPrefixes, ['second-event/recordings/edits']);
  assert.deepEqual(legacy.recentPrefixesByConnection, { media: ['second-event/recordings'] });
  assert.deepEqual(sanitizeSettings(legacy), legacy);

  const fresh = sanitizeSettings({ settingsVersion: 2 });
  assert.equal(fresh.settingsVersion, 2);
  assert.deepEqual(fresh.connections, []);
  assert.equal(fresh.activeConnectionId, '');
});

test('sanitizes v2 connections and repairs an invalid active connection id', () => {
  const settings = sanitizeSettings({
    settingsVersion: 2,
    activeConnectionId: 'missing',
    connections: [{
      id: 'archive',
      name: 'Archive Space',
      remote: 'archive',
      bucket: 'archive-media',
      endpointHost: 'sfo3.digitaloceanspaces.com',
      accessKeyId: 'MUST_NOT_STORE',
    }],
  });

  assert.equal(settings.activeConnectionId, 'archive');
  assert.equal(settings.connections.length, 1);
  assert.doesNotMatch(JSON.stringify(settings), /MUST_NOT_STORE|accessKeyId/i);
});

test('folds current navigation and upload preferences into the active v2 connection', () => {
  const settings = sanitizeSettings({
    settingsVersion: 2,
    activeConnectionId: 'archive',
    connections: [{
      id: 'archive',
      name: 'Archive Space',
      remote: 'archive',
      bucket: 'archive-media',
      endpointHost: 'sfo3.digitaloceanspaces.com',
      publicRead: true,
      checksum: 'size',
      recentPrefixes: ['old/folder'],
      pinnedPrefixes: ['old/pin'],
    }],
    recentPrefixes: ['new/folder'],
    pinnedPrefixes: ['new/pin'],
    publicRead: false,
    checksum: 'sha256',
  });

  assert.deepEqual(settings.connections[0].recentPrefixes, ['new/folder']);
  assert.deepEqual(settings.connections[0].pinnedPrefixes, ['new/pin']);
  assert.equal(settings.connections[0].publicRead, false);
  assert.equal(settings.connections[0].checksum, 'sha256');
});

test('sanitizes settings before writing the primary or backup', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uplink-settings-write-'));
  const settingsPath = path.join(root, 'settings.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const unsafe = {
    source: 'C:/exports',
    secretAccessKey: 'DO_NOT_STORE',
    profile: {
      remote: 'archive',
      bucket: 'media',
      endpointHost: 'sfo3.digitaloceanspaces.com',
      accessKeyId: 'DO_NOT_STORE',
    },
  };

  writeSettings(settingsPath, unsafe);
  writeSettings(settingsPath, unsafe);

  assert.doesNotMatch(fs.readFileSync(settingsPath, 'utf8'), /DO_NOT_STORE|secretAccessKey|accessKeyId/i);
  assert.doesNotMatch(fs.readFileSync(`${settingsPath}.bak`, 'utf8'), /DO_NOT_STORE|secretAccessKey|accessKeyId/i);
});

test('falls back to sanitized defaults when settings primary and backup are corrupt', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uplink-settings-corrupt-'));
  const settingsPath = path.join(root, 'settings.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(settingsPath, '{broken-primary', 'utf8');
  fs.writeFileSync(`${settingsPath}.bak`, '{broken-backup', 'utf8');

  assert.deepEqual(readSettings(settingsPath), sanitizeSettings(DEFAULT_SETTINGS));
});

test('settings recover valid backup from parsed but unrecognized primary shapes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uplink-settings-shape-'));
  const settingsPath = path.join(root, 'settings.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const backup = { source: 'C:/valid-backup', prefix: 'archive/recovered' };
  fs.writeFileSync(`${settingsPath}.bak`, JSON.stringify(backup), 'utf8');

  for (const invalid of [null, {}, [], { accessKeyId: 'SECRET_ONLY' }, { unrelated: true }]) {
    fs.writeFileSync(settingsPath, JSON.stringify(invalid), 'utf8');
    const recovered = readSettings(settingsPath);
    assert.equal(recovered.source, backup.source);
    assert.equal(recovered.prefix, backup.prefix);
    assert.doesNotMatch(JSON.stringify(recovered), /SECRET_ONLY|accessKeyId/i);
  }
});

test('settings reject malformed recognized fields and recover a valid backup', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uplink-settings-field-shapes-'));
  const settingsPath = path.join(root, 'settings.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const backup = { source: 'C:/valid-backup', prefix: 'archive/recovered' };
  const malformedCandidates = [
    { source: 7 },
    { prefix: [] },
    { include: false },
    { filterMode: 'invalid' },
    { publicRead: 'yes' },
    { checksum: 'md5' },
    { notifyWebhook: [] },
    { notifyNtfy: {} },
    { notifyOn: 'sometimes' },
    { folderUploadMode: 'folder' },
    { recentPrefixes: ['valid', 7] },
    { recentPrefixesByConnection: { connection: 'not-an-array' } },
    { recentPrefixesByConnection: { connection: ['valid', null] } },
    { pinnedPrefixes: [false] },
    { archiveEvent: 1 },
    { archiveCategory: 'other' },
    { archiveStage: false },
    { archiveDay: [] },
    { archivePackageName: {} },
    { profile: null },
    { profile: [] },
    { profile: { remote: 7 } },
    { profile: { remote: 'archive', accessKeyId: 'DO_NOT_STORE' } },
    { queueJobs: {} },
    { source: 'C:/unsafe', unrecognizedSetting: true },
    { source: 'C:/unsafe', bearerToken: 'DO_NOT_STORE' },
  ];
  fs.writeFileSync(`${settingsPath}.bak`, JSON.stringify(backup), 'utf8');

  for (const malformed of malformedCandidates) {
    fs.writeFileSync(settingsPath, JSON.stringify(malformed), 'utf8');
    assert.equal(
      readSettings(settingsPath).source,
      backup.source,
      `Expected backup recovery for ${JSON.stringify(malformed)}`,
    );
  }
});

test('settings write never rotates a malformed recognized primary over a good backup', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uplink-settings-malformed-rotate-'));
  const settingsPath = path.join(root, 'settings.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const backup = { source: 'C:/last-good', prefix: 'archive/last-good' };
  const malformedCandidates = [
    { queueJobs: null },
    { profile: { endpointHost: [] } },
    { recentPrefixesByConnection: { archive: [7] } },
    { source: 'C:/unsafe', unrecognizedSetting: true },
    { source: 'C:/unsafe', secretAccessKey: 'DO_NOT_STORE' },
  ];

  for (const malformed of malformedCandidates) {
    fs.writeFileSync(settingsPath, JSON.stringify(malformed), 'utf8');
    fs.writeFileSync(`${settingsPath}.bak`, JSON.stringify(backup), 'utf8');
    writeSettings(settingsPath, { source: 'C:/new', prefix: 'archive/new' });
    assert.deepEqual(JSON.parse(fs.readFileSync(`${settingsPath}.bak`, 'utf8')), backup);
  }
});

test('settings drop malformed collection members without losing valid descriptors or queued work', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uplink-settings-queue-shapes-'));
  const settingsPath = path.join(root, 'settings.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const primary = {
    settingsVersion: 2,
    source: 'C:/valid-primary',
    activeConnectionId: 'missing',
    connections: [
      { id: 'broken', name: 'Broken' },
      {
        id: 'archive',
        name: 'Archive',
        remote: 'archive',
        bucket: 'archive-media',
        endpointHost: 'sfo3.digitaloceanspaces.com',
      },
    ],
    queueJobs: [
      { id: 'broken-job', sources: [], prefix: 'archive/broken', status: 'queued' },
      {
        id: 'valid-job',
        connectionId: 'archive',
        sources: ['C:/exports/valid.mov'],
        prefix: 'archive/valid',
        profileSnapshot: {
          remote: 'archive',
          bucket: 'archive-media',
          endpointHost: 'SFO3.DIGITALOCEANSPACES.COM.',
        },
        status: 'paused',
      },
    ],
  };

  const direct = sanitizeSettings(primary);
  assert.deepEqual(direct.connections.map((connection) => connection.id), ['archive']);
  assert.equal(direct.activeConnectionId, 'archive');
  assert.deepEqual(direct.queueJobs.map((job) => job.id), ['valid-job']);
  assert.equal(direct.queueJobs[0].connectionId, 'archive');

  fs.writeFileSync(settingsPath, JSON.stringify(primary), 'utf8');
  const withoutBackup = readSettings(settingsPath);
  assert.equal(withoutBackup.source, primary.source);
  assert.deepEqual(withoutBackup.connections.map((connection) => connection.id), ['archive']);
  assert.deepEqual(withoutBackup.queueJobs.map((job) => job.id), ['valid-job']);

  const backup = { source: 'C:/valid-backup', prefix: 'archive/recovered' };
  fs.writeFileSync(`${settingsPath}.bak`, JSON.stringify(backup), 'utf8');
  const withBackup = readSettings(settingsPath);
  assert.equal(withBackup.source, primary.source);
  assert.deepEqual(withBackup.connections.map((connection) => connection.id), ['archive']);
  assert.deepEqual(withBackup.queueJobs.map((job) => job.id), ['valid-job']);
});

test('settings recover backup when any nonempty important collection has zero valid survivors', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uplink-settings-empty-survivors-'));
  const settingsPath = path.join(root, 'settings.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const backup = { source: 'C:/healthy-backup', prefix: 'archive/recovered' };
  const incoherentPrimaries = [
    {
      source: 'C:/bad-connections',
      settingsVersion: 2,
      connections: [{ id: 'broken', name: 'Missing tuple' }],
    },
    {
      source: 'C:/bad-queue',
      queueJobs: [{ id: 'broken-job', sources: [], prefix: 'archive/broken', status: 'queued' }],
    },
    {
      source: 'C:/bad-both',
      settingsVersion: 2,
      connections: [null, { id: '../unsafe' }],
      queueJobs: [null, { id: 'also-broken', sources: [7], prefix: 'archive/broken', status: 'queued' }],
    },
    {
      source: 'C:/valid-queue-bad-connections',
      settingsVersion: 2,
      connections: [{ id: 'broken', name: 'Missing tuple' }],
      queueJobs: [{
        id: 'valid-job',
        sources: ['C:/exports/valid.mov'],
        prefix: 'archive/valid',
        status: 'paused',
      }],
    },
    {
      source: 'C:/valid-connections-bad-queue',
      settingsVersion: 2,
      connections: [{
        id: 'archive',
        name: 'Archive',
        remote: 'archive',
        bucket: 'archive-media',
        endpointHost: 'sfo3.digitaloceanspaces.com',
      }],
      queueJobs: [{ id: 'broken-job', sources: [], prefix: 'archive/broken', status: 'queued' }],
    },
  ];

  for (const primary of incoherentPrimaries) {
    fs.writeFileSync(settingsPath, JSON.stringify(primary), 'utf8');
    fs.writeFileSync(`${settingsPath}.bak`, JSON.stringify(backup), 'utf8');
    assert.equal(readSettings(settingsPath).source, backup.source, primary.source);
  }
});

test('settings accept intentional empty collections, isolated valid collections, and legacy migration', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uplink-settings-coherent-collections-'));
  const settingsPath = path.join(root, 'settings.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const backup = { source: 'C:/healthy-backup', prefix: 'archive/recovered' };
  const cases = [
    {
      primary: {
        source: 'C:/intentional-empty',
        settingsVersion: 2,
        connections: [],
        queueJobs: [],
      },
      verify(settings) {
        assert.deepEqual(settings.connections, []);
        assert.deepEqual(settings.queueJobs, []);
      },
    },
    {
      primary: {
        source: 'C:/queue-only',
        queueJobs: [{
          id: 'valid-job',
          sources: ['C:/exports/valid.mov'],
          prefix: 'archive/valid',
          status: 'paused',
        }],
      },
      verify(settings) {
        assert.deepEqual(settings.queueJobs.map((job) => job.id), ['valid-job']);
      },
    },
    {
      primary: {
        source: 'C:/connection-only',
        settingsVersion: 2,
        activeConnectionId: 'archive',
        connections: [{
          id: 'archive',
          name: 'Archive',
          remote: 'archive',
          bucket: 'archive-media',
          endpointHost: 'sfo3.digitaloceanspaces.com',
        }],
      },
      verify(settings) {
        assert.deepEqual(settings.connections.map((connection) => connection.id), ['archive']);
        assert.equal(settings.activeConnectionId, 'archive');
      },
    },
    {
      primary: {
        source: 'C:/legacy-profile',
        profile: {
          remote: 'media',
          bucket: 'media',
          endpointHost: 'nyc3.digitaloceanspaces.com',
        },
      },
      verify(settings) {
        assert.equal(settings.settingsVersion, 2);
        assert.equal(settings.activeConnectionId, 'media');
      },
    },
  ];

  for (const scenario of cases) {
    fs.writeFileSync(settingsPath, JSON.stringify(scenario.primary), 'utf8');
    fs.writeFileSync(`${settingsPath}.bak`, JSON.stringify(backup), 'utf8');
    const settings = readSettings(settingsPath);
    assert.equal(settings.source, scenario.primary.source);
    scenario.verify(settings);
  }
});

test('settings accept valid legacy and current queue member schemas', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uplink-settings-valid-queue-'));
  const settingsPath = path.join(root, 'settings.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(settingsPath, JSON.stringify({
    queueJobs: [
      {
        id: 'legacy-job-1',
        sources: ['C:/exports/legacy.mov'],
        prefix: 'archive/legacy',
        status: 'paused',
      },
      {
        id: 'queue-200-current',
        intentId: 'intent-current-1',
        sources: ['C:/exports/current.mov'],
        prefix: 'archive/current',
        profile: {
          remote: 'archive',
          bucket: 'media',
          endpointHost: 'sfo3.digitaloceanspaces.com',
        },
        filterMode: 'custom',
        include: '*.mov',
        folderUploadMode: 'contents',
        publicRead: false,
        checksum: 'size',
        notifications: { webhook: '', ntfy: '', notifyOn: 'always' },
        status: 'uploading',
        jobId: 'upload-current-1',
        resumeFromJobId: 'upload-previous-1',
        urls: [],
        error: '',
        verification: null,
      },
    ],
  }), 'utf8');
  fs.writeFileSync(`${settingsPath}.bak`, JSON.stringify({ source: 'C:/backup' }), 'utf8');

  const settings = readSettings(settingsPath);

  assert.deepEqual(settings.queueJobs.map((job) => job.id), ['legacy-job-1', 'queue-200-current']);
  assert.equal(settings.queueJobs[1].status, 'uploading');
});

test('settings write preserves backup when a queue member is malformed', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uplink-settings-queue-rotate-'));
  const settingsPath = path.join(root, 'settings.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const backup = { source: 'C:/last-good', prefix: 'archive/last-good' };
  fs.writeFileSync(settingsPath, JSON.stringify({ queueJobs: [null] }), 'utf8');
  fs.writeFileSync(`${settingsPath}.bak`, JSON.stringify(backup), 'utf8');

  writeSettings(settingsPath, { source: 'C:/new', prefix: 'archive/new' });

  assert.deepEqual(JSON.parse(fs.readFileSync(`${settingsPath}.bak`, 'utf8')), backup);
});

test('settings write preserves valid backup when parsed primary has the wrong schema', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uplink-settings-rotate-'));
  const settingsPath = path.join(root, 'settings.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const backup = { source: 'C:/last-good', prefix: 'archive/last-good' };
  fs.writeFileSync(settingsPath, JSON.stringify({ unrelated: true }), 'utf8');
  fs.writeFileSync(`${settingsPath}.bak`, JSON.stringify(backup), 'utf8');

  writeSettings(settingsPath, { source: 'C:/new', prefix: 'archive/new' });

  assert.equal(JSON.parse(fs.readFileSync(`${settingsPath}.bak`, 'utf8')).source, backup.source);
  assert.equal(readSettings(settingsPath).source, 'C:/new');
});

test('rejects unsafe values recovered from a settings backup', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uplink-settings-backup-'));
  const settingsPath = path.join(root, 'settings.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(settingsPath, '{broken-primary', 'utf8');
  fs.writeFileSync(`${settingsPath}.bak`, JSON.stringify({
    source: 'C:/exports',
    secretAccessKey: 'DO_NOT_STORE',
    profile: {
      remote: 'archive',
      bucket: 'media',
      endpointHost: 'sfo3.digitaloceanspaces.com',
      accessKeyId: 'DO_NOT_STORE',
    },
    queueJobs: [{
      id: 'queued-1',
      sources: ['C:/exports/day1.mov'],
      prefix: 'archive/day1',
      notifications: {
        webhook: 'https://example.test/hook?token=DO_NOT_STORE',
        ntfy: 'DO_NOT_STORE',
      },
    }],
  }), 'utf8');

  const recovered = readSettings(settingsPath);

  assert.deepEqual(recovered, sanitizeSettings(DEFAULT_SETTINGS));
  assert.doesNotMatch(JSON.stringify(recovered), /DO_NOT_STORE|secretAccessKey|accessKeyId/i);
});

test('sanitizes recent and pinned remote prefixes', () => {
  const settings = sanitizeSettings({
    recentPrefixes: [' /archive-event//recordings/raw/ ', '', 'archive-event\\recordings\\raw'],
    pinnedPrefixes: ['archive-event/recordings/edits/youtube', 7, ''],
  });

  assert.deepEqual(settings.recentPrefixes, ['archive-event/recordings/raw']);
  assert.deepEqual(settings.pinnedPrefixes, ['archive-event/recordings/edits/youtube']);
});

test('keeps a private active connection private after removing another connection across a disk roundtrip', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uplink-private-remove-roundtrip-'));
  const settingsPath = path.join(root, 'settings.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const privateActive = {
    id: 'private',
    name: 'Private Space',
    remote: 'private',
    bucket: 'private-media',
    endpointHost: 'tor1.digitaloceanspaces.com',
    publicRead: false,
    checksum: 'sha256',
    recentPrefixes: ['private/review'],
    pinnedPrefixes: ['private/final'],
  };
  const removable = {
    id: 'archive',
    name: 'Archive Space',
    remote: 'archive',
    bucket: 'archive-media',
    endpointHost: 'sfo3.digitaloceanspaces.com',
    publicRead: true,
  };
  const next = connectionStateAfterRemoval({
    connections: [privateActive, removable],
    removeId: 'archive',
    activeConnectionId: 'private',
  });

  writeSettings(settingsPath, {
    settingsVersion: 2,
    connections: next.connections,
    activeConnectionId: next.activeConnectionId,
    profile: next.activeConnection,
    publicRead: next.activeConnection.publicRead,
    checksum: next.activeConnection.checksum,
    recentPrefixes: next.activeConnection.recentPrefixes,
    recentPrefixesByConnection: { private: next.activeConnection.recentPrefixes },
    pinnedPrefixes: next.activeConnection.pinnedPrefixes,
  });
  const restarted = readSettings(settingsPath);

  assert.equal(restarted.connections.length, 1);
  assert.equal(restarted.activeConnectionId, 'private');
  assert.equal(restarted.publicRead, false);
  assert.equal(restarted.connections[0].publicRead, false);
  assert.deepEqual(restarted.connections[0].pinnedPrefixes, ['private/final']);
});

test('freezes directory metadata into a source-relative upload plan', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spaces-uploader-plan-'));
  fs.mkdirSync(path.join(root, 'day1'), { recursive: true });
  fs.writeFileSync(path.join(root, 'day1', 'camera-a.mov'), 'first');

  const plan = collectLocalUploadSourcePlan(root, '', 'all', { folderUploadMode: 'package' });
  fs.writeFileSync(path.join(root, 'day1', 'created-after-plan.mov'), 'late');

  assert.equal(plan.isDirectory, true);
  assert.deepEqual(plan.entries.map((entry) => entry.relativePath), ['day1/camera-a.mov']);
  assert.deepEqual(plan.entries.map((entry) => entry.name), [`${path.basename(root)}/day1/camera-a.mov`]);
  assert.equal(plan.entries[0].localPath, path.join(root, 'day1', 'camera-a.mov'));
});

test('enforces a frozen files-from-raw manifest for directory copy args', () => {
  const args = buildCopyArgs({
    source: 'C:\\Event',
    prefix: 'event/recordings',
    include: '*.mov',
    filterMode: 'custom',
    filesFromRawPath: 'C:\\AppRuns\\manifest-1.txt',
    sourceIsDirectory: true,
    dryRun: true,
  });

  assert.equal(args[2], 'media:media/event/recordings/Event/');
  assert.equal(args[args.indexOf('--files-from-raw') + 1], 'C:\\AppRuns\\manifest-1.txt');
  assert.equal(args.includes('--include'), false);
  assert.equal(args.includes('--dry-run'), true);
});

test('migrates legacy recents into the schema v2 connection identity', () => {
  const profile = {
    remote: 'media',
    bucket: 'media',
    endpointHost: 'media.nyc3.digitaloceanspaces.com',
  };
  const alternateId = connectionDescriptorForProfile({
    remote: 'archive',
    bucket: 'media',
    endpointHost: 'sfo3.digitaloceanspaces.com',
  }).id;
  const settings = sanitizeSettings({
    profile,
    recentPrefixes: ['/second-event//recordings/', 'second-event/recordings'],
    recentPrefixesByConnection: {
      [alternateId]: ['projects/current'],
    },
  });

  assert.deepEqual(settings.recentPrefixesByConnection, {
    [alternateId]: ['projects/current'],
    media: ['second-event/recordings'],
  });
});

test('read and write migration is idempotent for explicit v1 settings', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uplink-settings-v1-migration-'));
  const settingsPath = path.join(root, 'settings.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(settingsPath, JSON.stringify({
    settingsVersion: 1,
    profile: {
      remote: 'media',
      bucket: 'media',
      endpointHost: 'nyc3.digitaloceanspaces.com',
    },
    recentPrefixes: ['second-event/recordings'],
    pinnedPrefixes: ['second-event/recordings/edits'],
  }), 'utf8');

  const migrated = readSettings(settingsPath);
  const written = writeSettings(settingsPath, migrated);
  const reread = readSettings(settingsPath);

  assert.deepEqual(written, migrated);
  assert.deepEqual(reread, migrated);
  assert.deepEqual(reread.connections.map((connection) => connection.id), ['media']);
});

test('legacy queue jobs gain a connection id and profile snapshot without losing recovery fields', () => {
  const settings = sanitizeSettings({
    settingsVersion: 2,
    connections: [{
      id: 'archive',
      name: 'Archive',
      remote: 'archive',
      bucket: 'archive-media',
      endpointHost: 'sfo3.digitaloceanspaces.com',
    }],
    activeConnectionId: 'archive',
    queueJobs: [{
      id: 'legacy-queue',
      sources: ['C:/clip.mov'],
      prefix: 'event/recordings',
      profile: {
        remote: 'archive',
        bucket: 'archive-media',
        endpointHost: 'sfo3.digitaloceanspaces.com',
      },
      status: 'needs-resume-check',
      resumeFromJobId: 'old-upload',
    }],
  });

  assert.equal(settings.queueJobs[0].connectionId, 'archive');
  assert.deepEqual(settings.queueJobs[0].profileSnapshot, settings.queueJobs[0].profile);
  assert.equal(settings.queueJobs[0].resumeFromJobId, 'old-upload');
});

test('drops unsafe queue connection ids instead of persisting them', () => {
  const settings = sanitizeSettings({
    settingsVersion: 2,
    connections: [],
    queueJobs: [{
      id: 'unsafe-connection-id',
      connectionId: '../access_key=DO_NOT_STORE',
      sources: ['C:/clip.mov'],
      prefix: 'event/recordings',
      status: 'queued',
    }],
  });

  assert.doesNotMatch(JSON.stringify(settings), /DO_NOT_STORE|access_key/i);
  assert.deepEqual(settings.queueJobs, []);
});

test('repairs malicious queue connection ids from the canonical frozen profile tuple', () => {
  const settings = sanitizeSettings({
    settingsVersion: 2,
    connections: [
      {
        id: 'archive',
        name: 'Archive',
        remote: 'archive',
        bucket: 'archive-media',
        endpointHost: 'sfo3.digitaloceanspaces.com',
      },
      {
        id: 'media',
        name: 'Media Archive',
        remote: 'media',
        bucket: 'media',
        endpointHost: 'nyc3.digitaloceanspaces.com',
      },
    ],
    activeConnectionId: 'archive',
    queueJobs: [{
      id: 'mismatched-job',
      connectionId: 'archive',
      sources: ['C:/clip.mov'],
      prefix: 'second-event/recordings',
      profileSnapshot: {
        remote: 'media',
        bucket: 'MEDIA',
        endpointHost: 'NYC3.DIGITALOCEANSPACES.COM.',
      },
      status: 'queued',
    }, {
      id: 'unmanaged-job',
      connectionId: 'archive',
      sources: ['C:/other.mov'],
      prefix: 'other/recordings',
      profileSnapshot: {
        remote: 'other',
        bucket: 'other-media',
        endpointHost: 'fra1.digitaloceanspaces.com',
      },
      status: 'queued',
    }],
  });

  assert.equal(settings.queueJobs[0].connectionId, 'media');
  assert.match(settings.queueJobs[1].connectionId, /^unmanaged-[a-f0-9]{32}$/);
  assert.notEqual(settings.queueJobs[1].connectionId, 'archive');
});

test('drops persisted queue jobs with invalid behavior fields, unsafe ids, or unknown fields', () => {
  const valid = {
    id: 'valid-job',
    intentId: 'intent-valid',
    clientJobId: 'client-valid',
    sources: ['C:/exports/valid.mov'],
    connectionId: 'archive',
    profileSnapshot: {
      remote: 'archive',
      bucket: 'archive-media',
      endpointHost: 'sfo3.digitaloceanspaces.com',
    },
    prefix: 'archive/valid',
    filterMode: 'all',
    include: '',
    folderUploadMode: 'package',
    publicRead: false,
    checksum: 'size',
    notifications: { webhook: '', ntfy: '', notifyOn: 'success' },
    status: 'paused',
    jobId: 'upload-valid',
    resumeFromJobId: 'upload-parent',
    urls: [],
    error: '',
    verification: null,
  };
  const adversarial = [
    { publicRead: 'false' },
    { status: 'future-auto-run' },
    { status: undefined },
    { filterMode: 'everything-and-secrets' },
    { folderUploadMode: 'overwrite-root' },
    { checksum: 'trust-me' },
    { include: 7 },
    { intentId: '../intent' },
    { clientJobId: '..\\client' },
    { jobId: '../outside' },
    { jobId: 'CON' },
    { jobId: 'upload.' },
    { resumeFromJobId: '..\\outside' },
    { connectionId: '../spoofed' },
    { connectionId: 'CON' },
    { connectionId: 'archive.' },
    { prefix: '../outside' },
    { sources: ['C:/exports/valid.mov', 7] },
    { notifications: { webhook: '', ntfy: '', notifyOn: 'sometimes' } },
    { urls: ['https://example.test/file', 7] },
    { error: { message: 'not a string' } },
    { verification: 'verified-ish' },
    { profileSnapshot: { ...valid.profileSnapshot, unrelated: true } },
    { futureBehavior: { autoStart: true } },
  ].map((patch, index) => ({ ...valid, ...patch, id: `invalid-${index}` }));

  const settings = sanitizeSettings({
    settingsVersion: 2,
    connections: [{
      id: 'archive',
      name: 'Archive',
      remote: 'archive',
      bucket: 'archive-media',
      endpointHost: 'sfo3.digitaloceanspaces.com',
    }],
    activeConnectionId: 'archive',
    queueJobs: [valid, ...adversarial],
  });

  assert.deepEqual(settings.queueJobs.map((job) => job.id), ['valid-job']);
  assert.equal(settings.queueJobs[0].publicRead, false);
  assert.equal(settings.queueJobs[0].status, 'paused');
});

test('repairs old unmanaged queue ids without losing durable queue identity', () => {
  const settings = sanitizeSettings({
    settingsVersion: 2,
    connections: [],
    queueJobs: [{
      id: 'durable-row',
      intentId: 'durable-intent',
      clientJobId: 'durable-client',
      connectionId: 'unmanaged-deadbeef',
      sources: ['C:/exports/clip.mov'],
      prefix: 'event/recordings',
      profileSnapshot: {
        remote: 'event-remote',
        bucket: 'event-media',
        endpointHost: 'fra1.digitaloceanspaces.com',
      },
      status: 'needs-resume-check',
      resumeFromJobId: 'upload-parent',
    }],
  });

  assert.equal(settings.queueJobs[0].id, 'durable-row');
  assert.equal(settings.queueJobs[0].intentId, 'durable-intent');
  assert.equal(settings.queueJobs[0].clientJobId, 'durable-client');
  assert.equal(settings.queueJobs[0].resumeFromJobId, 'upload-parent');
  assert.match(settings.queueJobs[0].connectionId, /^unmanaged-[a-f0-9]{32}$/);
  assert.notEqual(settings.queueJobs[0].connectionId, 'unmanaged-deadbeef');
});

test('repairs unsafe legacy descriptor ids and paused queue references across disk round trips', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uplink-settings-id-migration-'));
  const settingsPath = path.join(root, 'settings.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const legacyIds = ['CON', 'archive.', 'a..b'];
  const profiles = [
    { remote: 'Console+Media', bucket: 'console-media', endpointHost: 'nyc3.digitaloceanspaces.com' },
    { remote: 'Archive@Sample Event', bucket: 'archive-media', endpointHost: 'tor1.digitaloceanspaces.com' },
    { remote: 'Double.Dot', bucket: 'double-dot-media', endpointHost: 'sfo3.digitaloceanspaces.com' },
  ];
  const raw = {
    settingsVersion: 2,
    activeConnectionId: 'archive.',
    connections: legacyIds.map((id, index) => ({
      id,
      name: `Legacy ${index + 1}`,
      ...profiles[index],
    })),
    recentPrefixesByConnection: Object.fromEntries(
      legacyIds.map((id, index) => [id, [`event-${index + 1}/recordings`]]),
    ),
    queueJobs: legacyIds.map((connectionId, index) => ({
      id: `paused-${index + 1}`,
      connectionId,
      sources: [`C:/exports/day-${index + 1}.mov`],
      prefix: `event-${index + 1}/recordings`,
      profileSnapshot: profiles[index],
      status: 'paused',
      jobId: `upload-${index + 1}`,
    })),
  };
  fs.writeFileSync(settingsPath, JSON.stringify(raw), 'utf8');

  const first = readSettings(settingsPath);
  const repairedIds = first.connections.map((connection) => connection.id);
  assert.equal(first.connections.length, 3);
  assert.equal(new Set(repairedIds).size, 3);
  assert.equal(repairedIds.every((id) => !legacyIds.includes(id)), true);
  assert.equal(first.activeConnectionId, repairedIds[1]);
  assert.deepEqual(first.queueJobs.map((job) => job.status), ['paused', 'paused', 'paused']);
  assert.deepEqual(first.queueJobs.map((job) => job.connectionId), repairedIds);
  assert.deepEqual(
    repairedIds.map((id) => first.recentPrefixesByConnection[id]),
    [['event-1/recordings'], ['event-2/recordings'], ['event-3/recordings']],
  );

  writeSettings(settingsPath, first);
  assert.deepEqual(readSettings(settingsPath), first);
});

test('repairs managed descriptors that impersonate generated unmanaged identities', () => {
  const profile = {
    remote: 'Managed+Impostor',
    bucket: 'managed-impostor',
    endpointHost: 'fra1.digitaloceanspaces.com',
  };
  const settings = sanitizeSettings({
    settingsVersion: 2,
    activeConnectionId: 'unmanaged-deadbeef',
    connections: [{
      id: 'unmanaged-deadbeef',
      name: 'Managed impostor',
      ...profile,
    }],
    queueJobs: [{
      id: 'paused-impostor',
      connectionId: 'unmanaged-deadbeef',
      sources: ['C:/exports/impostor.mov'],
      prefix: 'impostor/recordings',
      profileSnapshot: profile,
      status: 'paused',
      jobId: 'upload-impostor',
    }],
  });

  assert.equal(settings.connections.length, 1);
  assert.doesNotMatch(settings.connections[0].id, /^unmanaged-/);
  assert.equal(settings.activeConnectionId, settings.connections[0].id);
  assert.equal(settings.queueJobs[0].connectionId, settings.connections[0].id);
});

test('repairs managed id collisions deterministically without dropping paused jobs', () => {
  const legacyProfile = {
    remote: 'Collision+Archive',
    bucket: 'collision-archive',
    endpointHost: 'fra1.digitaloceanspaces.com',
  };
  const collidingId = repairManagedConnectionId('CON', legacyProfile);
  const input = {
    settingsVersion: 2,
    connections: [
      {
        id: collidingId,
        name: 'Existing managed connection',
        remote: 'Existing',
        bucket: 'existing-media',
        endpointHost: 'sfo3.digitaloceanspaces.com',
      },
      { id: 'CON', name: 'Legacy connection', ...legacyProfile },
    ],
    queueJobs: [{
      id: 'paused-collision',
      connectionId: 'CON',
      sources: ['C:/exports/collision.mov'],
      prefix: 'collision/recordings',
      profileSnapshot: legacyProfile,
      status: 'paused',
      jobId: 'upload-collision',
    }],
  };

  const first = sanitizeSettings(input);
  const second = sanitizeSettings(input);
  assert.equal(first.connections.length, 2);
  assert.deepEqual(second.connections, first.connections);
  assert.notEqual(first.connections[1].id, collidingId);
  assert.equal(first.queueJobs[0].connectionId, first.connections[1].id);
  assert.equal(first.queueJobs[0].status, 'paused');
});

test('cleans credential-bearing settings without rotating raw secrets into the backup', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uplink-settings-secret-recovery-'));
  const settingsPath = path.join(root, 'settings.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const backup = { source: 'C:/healthy-backup', prefix: 'archive/recovered' };
  const primary = {
    settingsVersion: 2,
    source: 'C:/credential-bearing-primary',
    activeConnectionId: 'archive',
    connections: [{
      id: 'archive',
      name: 'Archive',
      remote: 'archive',
      bucket: 'archive-media',
      endpointHost: 'sfo3.digitaloceanspaces.com',
      credentials: { accessKeyId: 'RAW_PRIMARY_SECRET' },
    }],
    profile: {
      remote: 'archive',
      bucket: 'archive-media',
      endpointHost: 'sfo3.digitaloceanspaces.com',
      apiToken: 'RAW_PROFILE_SECRET',
    },
    queueJobs: [{
      id: 'safe-after-cleaning',
      sources: ['C:/exports/clip.mov'],
      prefix: 'archive/recordings',
      profileSnapshot: {
        remote: 'archive',
        bucket: 'archive-media',
        endpointHost: 'sfo3.digitaloceanspaces.com',
        secretAccessKey: 'RAW_QUEUE_SECRET',
      },
      unknownNested: { bearerToken: 'RAW_NESTED_SECRET' },
      status: 'paused',
    }],
  };
  fs.writeFileSync(settingsPath, JSON.stringify(primary), 'utf8');
  fs.writeFileSync(`${settingsPath}.bak`, JSON.stringify(backup), 'utf8');

  const recovered = readSettings(settingsPath);
  const diskPrimary = fs.readFileSync(settingsPath, 'utf8');
  const diskBackup = fs.readFileSync(`${settingsPath}.bak`, 'utf8');

  assert.equal(recovered.source, primary.source);
  assert.deepEqual(recovered.queueJobs.map((job) => job.id), ['safe-after-cleaning']);
  assert.doesNotMatch(JSON.stringify(recovered), /RAW_.*_SECRET/);
  assert.doesNotMatch(diskPrimary, /RAW_.*_SECRET/);
  assert.doesNotMatch(diskBackup, /RAW_.*_SECRET/);
  assert.equal(JSON.parse(diskBackup).source, backup.source);
});

test('strict settings writes preserve a healthy backup when the raw primary contains nested credentials', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uplink-settings-secret-rotation-'));
  const settingsPath = path.join(root, 'settings.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const backup = { source: 'C:/healthy-backup', prefix: 'archive/recovered' };
  fs.writeFileSync(settingsPath, JSON.stringify({
    settingsVersion: 2,
    connections: [{
      id: 'archive',
      name: 'Archive',
      remote: 'archive',
      bucket: 'archive-media',
      endpointHost: 'sfo3.digitaloceanspaces.com',
      metadata: { password: 'RAW_ROTATION_SECRET' },
    }],
  }), 'utf8');
  fs.writeFileSync(`${settingsPath}.bak`, JSON.stringify(backup), 'utf8');

  writeSettings(settingsPath, { source: 'C:/clean-primary', queueJobs: [] });

  const diskPrimary = fs.readFileSync(settingsPath, 'utf8');
  const diskBackup = fs.readFileSync(`${settingsPath}.bak`, 'utf8');
  assert.doesNotMatch(diskPrimary, /RAW_ROTATION_SECRET/);
  assert.doesNotMatch(diskBackup, /RAW_ROTATION_SECRET/);
  assert.equal(JSON.parse(diskBackup).source, backup.source);
});

test('recovery replaces a wholly incoherent secret primary from a healthy backup', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uplink-settings-secret-incoherent-'));
  const settingsPath = path.join(root, 'settings.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const backup = { source: 'C:/healthy-backup', prefix: 'archive/recovered' };
  fs.writeFileSync(settingsPath, JSON.stringify({
    settingsVersion: 2,
    connections: [{ credentials: { accessKeyId: 'RAW_INCOHERENT_SECRET' } }],
  }), 'utf8');
  fs.writeFileSync(`${settingsPath}.bak`, JSON.stringify(backup), 'utf8');

  const recovered = readSettings(settingsPath);
  const diskPrimary = fs.readFileSync(settingsPath, 'utf8');
  const diskBackup = fs.readFileSync(`${settingsPath}.bak`, 'utf8');

  assert.equal(recovered.source, backup.source);
  assert.equal(JSON.parse(diskPrimary).source, backup.source);
  assert.equal(JSON.parse(diskBackup).source, backup.source);
  assert.doesNotMatch(`${diskPrimary}\n${diskBackup}`, /RAW_INCOHERENT_SECRET/);
});

test('recovery scrubs credentials from a selected backup as well as the restored primary', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uplink-settings-secret-backup-'));
  const settingsPath = path.join(root, 'settings.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(settingsPath, '{"connections":[null]}', 'utf8');
  fs.writeFileSync(`${settingsPath}.bak`, JSON.stringify({
    settingsVersion: 2,
    source: 'C:/recovered-secret-backup',
    connections: [{
      id: 'archive',
      name: 'Archive',
      remote: 'archive',
      bucket: 'archive-media',
      endpointHost: 'sfo3.digitaloceanspaces.com',
      apiToken: 'RAW_BACKUP_SECRET',
    }],
  }), 'utf8');

  const recovered = readSettings(settingsPath);
  const diskPrimary = fs.readFileSync(settingsPath, 'utf8');
  const diskBackup = fs.readFileSync(`${settingsPath}.bak`, 'utf8');

  assert.equal(recovered.source, 'C:/recovered-secret-backup');
  assert.doesNotMatch(`${diskPrimary}\n${diskBackup}`, /RAW_BACKUP_SECRET|apiToken/);
});

test('bounds malformed scoped recents and round trips two connection identities', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uplink-settings-navigation-'));
  const settingsPath = path.join(root, 'settings.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const firstId = connectionDescriptorForProfile({
    remote: 'media',
    bucket: 'media',
    endpointHost: 'media.nyc3.digitaloceanspaces.com',
  }).id;
  const secondId = connectionDescriptorForProfile({
    remote: 'archive',
    bucket: 'media',
    endpointHost: 'sfo3.digitaloceanspaces.com',
  }).id;
  const overflow = Object.fromEntries(
    Array.from({ length: 40 }, (_, index) => [`connection-${index}`, Array.from({ length: 12 }, (__, item) => `folder-${item}`)]),
  );
  const sanitized = sanitizeSettings({
    recentPrefixesByConnection: {
      [firstId]: ['/second-event//recordings/', 7, '', 'second-event/recordings'],
      [secondId]: ['projects/current', 'projects/archive'],
      ...overflow,
      ['x'.repeat(300)]: ['ignored'],
      constructor: ['ignored'],
      malformed: 'not-an-array',
    },
  });

  assert.deepEqual(sanitized.recentPrefixesByConnection[firstId], ['second-event/recordings']);
  assert.deepEqual(sanitized.recentPrefixesByConnection[secondId], ['projects/current', 'projects/archive']);
  assert.equal(Object.keys(sanitized.recentPrefixesByConnection).length <= 32, true);
  assert.equal(
    Object.values(sanitized.recentPrefixesByConnection).every((prefixes) => prefixes.length <= 8),
    true,
  );
  assert.equal(Object.hasOwn(sanitized.recentPrefixesByConnection, 'constructor'), false);
  assert.equal(Object.hasOwn(sanitized.recentPrefixesByConnection, 'malformed'), false);

  writeSettings(settingsPath, sanitized);
  const roundTripped = readSettings(settingsPath);
  assert.deepEqual(roundTripped.recentPrefixesByConnection[firstId], ['second-event/recordings']);
  assert.deepEqual(roundTripped.recentPrefixesByConnection[secondId], ['projects/current', 'projects/archive']);
});

test('sanitizes persisted queue jobs without notification secrets', () => {
  const settings = sanitizeSettings({
    queueJobs: [
      {
        id: 'job-1',
        connectionId: 'media',
        profileSnapshot: {
          remote: 'media',
          bucket: 'media',
          endpointHost: 'nyc3.digitaloceanspaces.com',
          secretAccessKey: 'MUST_NOT_STORE',
        },
        intentId: 'intent-job-1',
        clientJobId: 'client-job-1',
        sources: ['C:/exports/day1.mov'],
        prefix: ' /archive-event//recordings/raw/stage1/day1/ ',
        filterMode: 'all',
        include: '',
        folderUploadMode: 'package',
        publicRead: true,
        checksum: 'size',
        notifications: {
          webhook: 'https://example.com/secret-hook',
          ntfy: 'https://ntfy.sh/secret-topic',
          notifyOn: 'always',
        },
        status: 'ready',
        jobId: 'dryrun-1',
        urls: ['https://media.nyc3.digitaloceanspaces.com/object.mov'],
        error: '',
      },
      {
        id: 'done',
        sources: ['C:/exports/done.mov'],
        prefix: 'archive-event/recordings/done',
        status: 'complete',
      },
      {
        id: 'stale-active',
        sources: ['C:/exports/active.mov'],
        prefix: 'archive-event/recordings/active',
        status: 'needs-resume-check',
        resumeFromJobId: 'upload-failed-before-restart',
      },
    ],
  });

  assert.equal(settings.queueJobs.length, 3);
  assert.equal(settings.queueJobs[0].prefix, 'archive-event/recordings/raw/stage1/day1');
  assert.equal(settings.queueJobs[0].notifications.webhook, '');
  assert.equal(settings.queueJobs[0].notifications.ntfy, '');
  assert.equal(settings.queueJobs[0].notifications.notifyOn, 'always');
  assert.equal(settings.queueJobs[0].status, 'ready');
  assert.equal(settings.queueJobs[0].intentId, 'intent-job-1');
  assert.equal(settings.queueJobs[0].clientJobId, 'client-job-1');
  assert.match(settings.queueJobs[0].connectionId, /^unmanaged-[a-f0-9]{32}$/);
  assert.deepEqual(settings.queueJobs[0].profileSnapshot, {
    remote: 'media',
    bucket: 'media',
    endpointHost: 'nyc3.digitaloceanspaces.com',
  });
  assert.doesNotMatch(JSON.stringify(settings.queueJobs[0]), /MUST_NOT_STORE|secretAccessKey/i);
  assert.equal(settings.queueJobs[1].status, 'complete');
  assert.equal(settings.queueJobs[2].status, 'needs-resume-check');
  assert.equal(settings.queueJobs[2].jobId, '');
  assert.equal(settings.queueJobs[2].resumeFromJobId, 'upload-failed-before-restart');

  const settingsPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'uplink-queue-identities-')), 'settings.json');
  writeSettings(settingsPath, settings);
  const roundTripped = readSettings(settingsPath);
  assert.equal(roundTripped.queueJobs[0].intentId, 'intent-job-1');
  assert.equal(roundTripped.queueJobs[0].clientJobId, 'client-job-1');
  assert.equal(roundTripped.queueJobs[0].notifications.webhook, '');
  assert.equal(roundTripped.queueJobs[0].notifications.ntfy, '');
});

test('preserves recognized lifecycle states and drops unknown states', () => {
  const statuses = [
    'queued',
    'ready',
    'failed',
    'blocked',
    'paused',
    'cancelled',
    'needs-resume-check',
    'prechecking',
    'uploading',
    'verifying',
    'pausing',
    'complete',
    'unknown-state',
  ];
  const settings = sanitizeSettings({
    queueJobs: statuses.map((status) => ({
      id: `job-${status}`,
      sources: [`C:/exports/${status}.mov`],
      prefix: `archive/${status}`,
      status,
    })),
  });

  assert.deepEqual(
    Object.fromEntries(settings.queueJobs.map((job) => [job.id, job.status])),
    {
      'job-queued': 'queued',
      'job-ready': 'ready',
      'job-failed': 'failed',
      'job-blocked': 'blocked',
      'job-paused': 'paused',
      'job-cancelled': 'cancelled',
      'job-needs-resume-check': 'needs-resume-check',
      'job-prechecking': 'prechecking',
      'job-uploading': 'uploading',
      'job-verifying': 'verifying',
      'job-pausing': 'pausing',
      'job-complete': 'complete',
    },
  );
});

test('collects relative local upload names for folder preflight', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spaces-uploader-'));
  fs.mkdirSync(path.join(root, 'nested'));
  fs.writeFileSync(path.join(root, 'clip one.mp4'), '');
  fs.writeFileSync(path.join(root, 'nested', 'clip two.mp4'), '');
  fs.writeFileSync(path.join(root, 'notes.txt'), '');

  assert.deepEqual(collectLocalUploadNames(root, '*.mp4', 'all', { folderUploadMode: 'contents' }), [
    'clip one.mp4',
    'nested/clip two.mp4',
  ]);
});

test('parses rclone progress lines into terminal-style progress state', () => {
  const progress = parseRcloneProgress(
    [
      'Transferred:   19.055 GiB / 19.076 GiB, 99%, 632.346 KiB/s, ETA 35s',
      ' * austria-main - 28 May 2026 - 01-08-26 PM - 00000.mp4: 45% / 544.2 MiB, 7.8 MiB/s, 35s',
    ].join('\n'),
  );

  assert.equal(progress.percent, 99);
  assert.equal(progress.transferred, '19.055 GiB');
  assert.equal(progress.total, '19.076 GiB');
  assert.equal(progress.speed, '632.346 KiB/s');
  assert.equal(progress.eta, '35s');
  assert.equal(progress.currentFile, 'austria-main - 28 May 2026 - 01-08-26 PM - 00000.mp4');
});

test('parses current rclone file lines without aggregate progress', () => {
  const progress = parseRcloneProgress(
    ' * nested/render.mov: 12% / 2.1 GiB, 8.1 MiB/s, 4m3s',
  );

  assert.equal(progress.currentFile, 'nested/render.mov');
});

test('builds verification report by comparing local names and sizes to remote JSON', () => {
  const report = buildVerificationReport({
    localEntries: [
      { name: 'clip one.mp4', size: 7 },
      { name: 'nested/clip two.mp4', size: 11 },
    ],
    remoteEntries: [
      { Path: 'clip one.mp4', Size: 7 },
      { Path: 'nested/clip two.mp4', Size: 10 },
    ],
  });

  assert.deepEqual(report, {
    verified: [{ name: 'clip one.mp4', size: 7 }],
    missing: [],
    sizeMismatch: [{ name: 'nested/clip two.mp4', localSize: 11, remoteSize: 10 }],
    ok: false,
  });
});

test('verification rejects remote files that were neither frozen nor present at preflight', () => {
  const report = buildVerificationReport({
    localEntries: [{ name: 'day1/camera-a.mov', size: 7 }],
    remoteEntries: [
      { Path: 'existing.mov', Size: 3 },
      { Path: 'day1/camera-a.mov', Size: 7 },
      { Path: 'day1/created-after-plan.mov', Size: 9 },
    ],
    existingRemoteNames: ['existing.mov'],
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.unexpected, [{ name: 'day1/created-after-plan.mov', remoteSize: 9 }]);
});

test('normalizes explorer paths and builds breadcrumbs', () => {
  assert.equal(normalizeExplorerPath('/archive-event//recordings\\day2/'), 'archive-event/recordings/day2');
  assert.equal(buildRemotePath('archive-event/recordings/day2'), 'media:media/archive-event/recordings/day2/');
});

test('builds explorer list and confirmed operation commands', () => {
  assert.deepEqual(buildExplorerListArgs({ prefix: 'archive-event/recordings' }), [
    'lsjson',
    'media:media/archive-event/recordings/',
    '--max-depth',
    '1',
  ]);
  assert.deepEqual(buildRemoteOperationArgs({
    action: 'copy',
    sourcePrefix: 'archive-event/recordings/day1/clip.mp4',
    targetPrefix: 'archive-event/recordings/day2/clip.mp4',
    isDir: false,
  }), [
    'copyto',
    'media:media/archive-event/recordings/day1/clip.mp4',
    'media:media/archive-event/recordings/day2/clip.mp4',
    '--size-only',
  ]);
  assert.deepEqual(buildRemoteOperationArgs({
    action: 'delete',
    sourcePrefix: 'archive-event/recordings/day2/clip.mp4',
    isDir: false,
  }), [
    'deletefile',
    'media:media/archive-event/recordings/day2/clip.mp4',
  ]);
});

test('parses explorer entries with public URLs and display sizes', () => {
  const entries = parseExplorerEntries({
    prefix: 'archive-event/recordings',
    rawEntries: [
      { Name: 'day1', Path: 'day1', IsDir: true, Size: 0 },
      { Name: 'clip.mp4', Path: 'clip.mp4', IsDir: false, Size: 2048, ModTime: '2026-05-30T00:00:00Z' },
      { Name: 'card.png', Path: 'card.png', IsDir: false, Size: 512, ModTime: '2026-05-30T00:00:00Z' },
    ],
  });

  assert.deepEqual(entries.map((entry) => entry.name), ['day1', 'card.png', 'clip.mp4']);
  assert.equal(entries[0].type, 'FOLDER');
  assert.equal(entries[1].type, 'PNG');
  assert.equal(entries[2].displaySize, '2.0 KB');
  assert.equal(entries[2].publicUrl, 'https://media.nyc3.digitaloceanspaces.com/archive-event/recordings/clip.mp4');
  assert.equal(formatBytes(20482883270), '19.1 GB');
});

test('verification fails for selected sources when no local files match', () => {
  const report = buildVerificationReport({
    localEntries: [],
    remoteEntries: [],
    expectedSourceCount: 2,
  });

  assert.equal(report.ok, false);
  assert.equal(report.blocked, true);
  assert.match(report.reason, /No local files matched/);
});

test('persists strict download queue jobs while defaulting legacy jobs to upload', () => {
  const download = sanitizeSettings({
    queueJobs: [{
      id: 'download-1',
      direction: 'download',
      sources: ['sample-event/card.png', 'sample-event/assets'],
      remoteItems: [
        { name: 'card.png', path: 'sample-event/card.png', isDir: false, size: 10, modified: '' },
        { name: 'assets', path: 'sample-event/assets', isDir: true, size: 0, modified: '' },
      ],
      localDestination: 'C:\\Downloads\\Event',
      prefix: 'sample-event',
      profile: { remote: 'media', bucket: 'media', endpointHost: 'media.nyc3.digitaloceanspaces.com' },
      profileSnapshot: { remote: 'media', bucket: 'media', endpointHost: 'media.nyc3.digitaloceanspaces.com' },
      status: 'queued',
    }],
  });
  assert.equal(download.queueJobs[0].direction, 'download');
  assert.equal(download.queueJobs[0].localDestination, 'C:\\Downloads\\Event');
  assert.equal(download.queueJobs[0].remoteItems[0].name, 'card.png');

  const legacy = sanitizeSettings({
    queueJobs: [{
      id: 'upload-legacy',
      sources: ['C:\\Media\\card.png'],
      prefix: 'sample-event',
      status: 'queued',
    }],
  });
  assert.equal(legacy.queueJobs[0].direction, 'upload');
});

test('rejects malformed download queue paths and unknown remote item fields', () => {
  const settings = sanitizeSettings({
    queueJobs: [{
      id: 'download-bad',
      direction: 'download',
      sources: ['sample-event/card.png'],
      remoteItems: [{ name: 'card.png', path: '../card.png', isDir: false, size: 10, modified: '', extra: true }],
      localDestination: 'relative\\folder',
      prefix: 'sample-event',
      status: 'queued',
    }],
  });
  assert.deepEqual(settings.queueJobs, []);
});

test('builds placeholder object args for creating a visible remote folder', () => {
  assert.deepEqual(buildTouchArgs({ prefix: 'archive-event/recordings/raw/main-stage/day1/.keep' }), [
    'touch',
    'media:media/archive-event/recordings/raw/main-stage/day1/.keep',
  ]);
});

test('builds dry-run and public placeholder upload arguments safely', () => {
  assert.deepEqual(buildTouchArgs({
    prefix: 'sample-event/recordings/main/assets/.keep',
    dryRun: true,
    publicRead: true,
  }), [
    'touch',
    'media:media/sample-event/recordings/main/assets/.keep',
    '--dry-run',
  ]);
  assert.deepEqual(buildTouchArgs({
    prefix: 'sample-event/recordings/main/assets/.keep',
    publicRead: true,
  }), [
    'touch',
    'media:media/sample-event/recordings/main/assets/.keep',
    '--s3-acl',
    'public-read',
  ]);
});
