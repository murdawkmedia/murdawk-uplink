const { sanitizeRcloneRemoteName } = require('./rclone-remote-core');

function cleanString(value = '') {
  return String(value || '').trim();
}

const DIGITALOCEAN_REGIONS = [
  'nyc3',
  'sfo3',
  'sfo2',
  'ams3',
  'sgp1',
  'lon1',
  'fra1',
  'tor1',
  'blr1',
  'syd1',
];

function endpointFromRegion(region = '') {
  const clean = cleanString(region).toLowerCase();
  if (!DIGITALOCEAN_REGIONS.includes(clean)) {
    throw new Error('Choose a supported DigitalOcean Spaces region.');
  }
  return `${clean}.digitaloceanspaces.com`;
}

function regionFromEndpoint(endpoint = '') {
  const clean = cleanString(endpoint).toLowerCase();
  const match = clean.match(/^([a-z0-9-]+)\.digitaloceanspaces\.com$/);
  return match?.[1] || '';
}

function validateProfileSetup(input = {}) {
  const endpoint = cleanString(input.endpoint) || endpointFromRegion(input.region || 'nyc3');
  const setup = {
    name: cleanString(input.name),
    bucket: cleanString(input.bucket),
    endpoint,
    region: regionFromEndpoint(endpoint),
    accessKeyId: cleanString(input.accessKeyId),
    secretAccessKey: cleanString(input.secretAccessKey),
    publicRead: input.publicRead !== false,
  };

  if (!setup.name) throw new Error('DigitalOcean profile name is required.');
  setup.name = sanitizeRcloneRemoteName(setup.name, { platform: 'win32' });
  if (!setup.bucket) throw new Error('DigitalOcean bucket / Space name is required.');
  if (!setup.endpoint) throw new Error('DigitalOcean Spaces endpoint is required.');
  if (!setup.accessKeyId) throw new Error('DigitalOcean access key is required.');
  if (!setup.secretAccessKey) throw new Error('DigitalOcean secret key is required.');
  return setup;
}

function buildRcloneConfigCreateArgs(input = {}) {
  const setup = validateProfileSetup(input);
  return [
    'config',
    'create',
    setup.name,
    's3',
    'provider',
    'DigitalOcean',
    'env_auth',
    'false',
    'access_key_id',
    setup.accessKeyId,
    'secret_access_key',
    setup.secretAccessKey,
    'endpoint',
    setup.endpoint,
    'acl',
    setup.publicRead ? 'public-read' : 'private',
    '--obscure',
  ];
}

function buildRcloneConfigDeleteArgs(name = '') {
  return [
    'config',
    'delete',
    sanitizeRcloneRemoteName(cleanString(name), { platform: 'win32' }),
  ];
}

function shortKey(value = '') {
  const clean = cleanString(value);
  if (!clean) return '';
  if (clean.length <= 8) return 'REDACTED';
  return `${clean.slice(0, 3)}...${clean.slice(-3)}`;
}

function redactProfileSetup(input = {}) {
  return {
    name: cleanString(input.name),
    bucket: cleanString(input.bucket),
    endpoint: cleanString(input.endpoint),
    accessKeyId: shortKey(input.accessKeyId),
    secretAccessKey: input.secretAccessKey ? 'REDACTED' : '',
    publicRead: input.publicRead !== false,
  };
}

function profileSetupSummary(input = {}) {
  const setup = redactProfileSetup(input);
  const acl = setup.publicRead ? 'public-read' : 'private';
  return `${setup.name} -> ${setup.bucket} at ${setup.endpoint} (${acl})`;
}

module.exports = {
  buildRcloneConfigCreateArgs,
  buildRcloneConfigDeleteArgs,
  DIGITALOCEAN_REGIONS,
  endpointFromRegion,
  profileSetupSummary,
  regionFromEndpoint,
  redactProfileSetup,
  validateProfileSetup,
};
