const assert = require('node:assert/strict');
const test = require('node:test');
const {
  connectionDescriptorForProfile,
  navigationListingPlan,
  navigationMoveTargetPrefixes,
  recordRecentPrefix,
  recentPrefixesForConnection,
  rootFolderShortcuts,
} = require('../src/navigation-core');

test('records normalized deduplicated recents per connection', () => {
  let value = recordRecentPrefix({}, 'media', 'second-event/recordings');
  value = recordRecentPrefix(value, 'other', '/projects//current/');
  value = recordRecentPrefix(value, 'media', '\\second-event\\recordings\\');

  assert.deepEqual(recentPrefixesForConnection(value, 'media'), ['second-event/recordings']);
  assert.deepEqual(recentPrefixesForConnection(value, 'other'), ['projects/current']);
});

test('derives root shortcuts only from listed root folders', () => {
  const shortcuts = rootFolderShortcuts([
    { name: 'Sample Event', path: 'sample-event', isDir: true },
    { name: 'readme.txt', path: 'readme.txt', isDir: false },
    { name: 'Second Event', path: 'second-event', isDir: true },
  ]);

  assert.deepEqual(shortcuts.map((item) => item.path), ['sample-event', 'second-event']);
});

test('derives stable distinct compatibility identities from non-secret profile fields', () => {
  const media = connectionDescriptorForProfile({
    remote: 'media',
    bucket: 'media',
    endpointHost: 'media.nyc3.digitaloceanspaces.com',
  });
  const normalizedMedia = connectionDescriptorForProfile({
    remote: ' MEDIA ',
    bucket: 'MEDIA',
    endpointHost: 'MEDIA.NYC3.DIGITALOCEANSPACES.COM',
  });
  const alternate = connectionDescriptorForProfile({
    remote: 'archive',
    bucket: 'media',
    endpointHost: 'sfo3.digitaloceanspaces.com',
  });

  assert.notEqual(media.id, normalizedMedia.id);
  assert.equal(normalizedMedia.profile.remote, 'MEDIA');
  assert.equal(normalizedMedia.profile.bucket, 'media');
  assert.equal(media.name, 'media');
  assert.equal(alternate.name, 'media');
  assert.notEqual(media.id, alternate.id);
  assert.notEqual(
    alternate.id,
    connectionDescriptorForProfile({ ...alternate.profile, endpointHost: 'nyc3.digitaloceanspaces.com' }).id,
  );
});

test('bounds root shortcuts and rejects malformed or nested entries', () => {
  const shortcuts = rootFolderShortcuts([
    { name: 'Sample Event', path: '/sample-event/', isDir: true },
    { name: 'Nested', path: 'archive/year', isDir: true },
    { name: 'readme.txt', path: 'readme.txt', isDir: false },
    { name: 'Second Event', path: 'second-event', isDir: true },
    { name: 'Second Event duplicate', path: 'second-event', isDir: true },
    { name: 'Zagreb', path: 'zagreb', isDir: true },
    null,
  ], 2);

  assert.deepEqual(shortcuts, [
    { name: 'Sample Event', path: 'sample-event' },
    { name: 'Second Event', path: 'second-event' },
  ]);
});

test('builds Move To choices from current root pinned and scoped recent folders', () => {
  const prefixes = navigationMoveTargetPrefixes({
    currentPrefix: '/second-event//recordings/',
    rootEntries: [
      { name: 'Sample Event', path: 'sample-event' },
      { name: 'Second Event', path: 'second-event' },
    ],
    pinnedPrefixes: ['custom/delivery', 'second-event'],
    recentPrefixes: ['projects/current', 'second-event/recordings'],
  });

  assert.deepEqual(prefixes, [
    'second-event/recordings',
    'sample-event',
    'second-event',
    'custom/delivery',
    'projects/current',
  ]);
  assert.equal(prefixes.some((prefix) => prefix.startsWith('archive-event/')), false);
});

test('plans root priming before an uncached nested startup without recording root', () => {
  assert.deepEqual(navigationListingPlan('/second-event//recordings/', false), {
    targetPrefix: 'second-event/recordings',
    shouldPrimeRoot: true,
  });
  assert.deepEqual(navigationListingPlan('second-event/recordings', true), {
    targetPrefix: 'second-event/recordings',
    shouldPrimeRoot: false,
  });
  assert.deepEqual(navigationListingPlan('', false), {
    targetPrefix: '',
    shouldPrimeRoot: false,
  });
  assert.deepEqual(recordRecentPrefix({}, 'connection', ''), {});
});
