const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildRcloneConfigCreateArgs,
  buildRcloneConfigDeleteArgs,
  endpointFromRegion,
  profileSetupSummary,
  regionFromEndpoint,
  redactProfileSetup,
  validateProfileSetup,
} = require('../src/profile-core');

test('builds a narrow rclone profile delete command without accepting paths or drive names', () => {
  assert.deepEqual(buildRcloneConfigDeleteArgs('Archive+Fast'), ['config', 'delete', 'Archive+Fast']);
  for (const name of ['', 'C', '../archive', 'archive:other']) {
    assert.throws(() => buildRcloneConfigDeleteArgs(name), /remote|invalid|required/i, name);
  }
});

test('builds DigitalOcean rclone profile config args from setup input', () => {
  const args = buildRcloneConfigCreateArgs({
    name: 'frog-space',
    bucket: 'frog-bucket',
    endpoint: 'nyc3.digitaloceanspaces.com',
    accessKeyId: 'ACCESS_VALUE',
    secretAccessKey: 'SECRET_VALUE',
    publicRead: true,
  });

  assert.deepEqual(args, [
    'config',
    'create',
    'frog-space',
    's3',
    'provider',
    'DigitalOcean',
    'env_auth',
    'false',
    'access_key_id',
    'ACCESS_VALUE',
    'secret_access_key',
    'SECRET_VALUE',
    'endpoint',
    'nyc3.digitaloceanspaces.com',
    'acl',
    'public-read',
    '--obscure',
  ]);
});

test('uses official rclone remote names unchanged in config arguments', () => {
  const args = buildRcloneConfigCreateArgs({
    name: 'Archive+Media@Sample Event',
    bucket: 'frog-bucket',
    endpoint: 'tor1.digitaloceanspaces.com',
    accessKeyId: 'ACCESS_VALUE',
    secretAccessKey: 'SECRET_VALUE',
  });

  assert.equal(args[2], 'Archive+Media@Sample Event');
  for (const name of ['bad:name', 'bad/name', 'bad\\name', '-bad', 'C']) {
    assert.throws(() => buildRcloneConfigCreateArgs({
      name,
      bucket: 'frog-bucket',
      endpoint: 'tor1.digitaloceanspaces.com',
      accessKeyId: 'ACCESS_VALUE',
      secretAccessKey: 'SECRET_VALUE',
    }), /profile name|remote|Windows drive/i, name);
  }
});

test('profile setup summaries never expose access keys or secret keys', () => {
  const setup = {
    name: 'frog-space',
    bucket: 'frog-bucket',
    endpoint: 'nyc3.digitaloceanspaces.com',
    accessKeyId: 'ACCESS_VALUE',
    secretAccessKey: 'SECRET_VALUE',
    publicRead: true,
  };

  const redacted = redactProfileSetup(setup);
  const summary = profileSetupSummary(setup);
  const serialized = JSON.stringify({ redacted, summary });

  assert.equal(redacted.accessKeyId, 'ACC...LUE');
  assert.equal(redacted.secretAccessKey, 'REDACTED');
  assert.equal(summary, 'frog-space -> frog-bucket at nyc3.digitaloceanspaces.com (public-read)');
  assert.equal(serialized.includes('ACCESS_VALUE'), false);
  assert.equal(serialized.includes('SECRET_VALUE'), false);
});

test('converts DigitalOcean Spaces regions into endpoint hosts', () => {
  assert.equal(endpointFromRegion('nyc3'), 'nyc3.digitaloceanspaces.com');
  assert.equal(endpointFromRegion('SFO3'), 'sfo3.digitaloceanspaces.com');
  assert.equal(regionFromEndpoint('fra1.digitaloceanspaces.com'), 'fra1');
  assert.throws(() => endpointFromRegion('moon1'), /supported DigitalOcean Spaces region/);
});

test('profile setup can derive endpoint from selected region', () => {
  const setup = validateProfileSetup({
    name: 'frog-space',
    bucket: 'frog-bucket',
    region: 'sfo3',
    accessKeyId: 'ACCESS',
    secretAccessKey: 'SECRET',
  });

  assert.equal(setup.endpoint, 'sfo3.digitaloceanspaces.com');
  assert.equal(setup.region, 'sfo3');
});

test('profile setup rejects missing required fields', () => {
  assert.throws(
    () => buildRcloneConfigCreateArgs({ name: '', bucket: 'media', endpoint: 'nyc3.digitaloceanspaces.com' }),
    /profile name/i,
  );
  assert.throws(
    () => buildRcloneConfigCreateArgs({ name: 'media', bucket: '', endpoint: 'nyc3.digitaloceanspaces.com' }),
    /bucket/i,
  );
  assert.throws(
    () => buildRcloneConfigCreateArgs({ name: 'media', bucket: 'media', endpoint: '', region: 'moon1' }),
    /region/i,
  );
  assert.throws(
    () => buildRcloneConfigCreateArgs({ name: 'media', bucket: 'media', endpoint: 'nyc3.digitaloceanspaces.com' }),
    /access key/i,
  );
});
