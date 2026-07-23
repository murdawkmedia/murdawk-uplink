const crypto = require('node:crypto');
const { sanitizeConnection } = require('./connection-core');

const PACKAGE_FORMAT = 'murdawk-connection';
const PACKAGE_VERSION = 1;
const KDF = 'scrypt';
const CIPHER = 'aes-256-gcm';
const MIN_PASSWORD_LENGTH = 12;

function packageConnection(input = {}) {
  const safe = sanitizeConnection(input);
  return sanitizeConnection({
    id: safe.id,
    name: safe.name,
    remote: safe.remote,
    bucket: safe.bucket,
    endpointHost: safe.endpointHost,
    publicRead: safe.publicRead,
    checksum: safe.checksum,
    recentPrefixes: [],
    pinnedPrefixes: [],
    lastTestedAt: '',
  });
}

function publicHeader() {
  return {
    format: PACKAGE_FORMAT,
    version: PACKAGE_VERSION,
    encrypted: false,
  };
}

function encryptedHeader() {
  return {
    format: PACKAGE_FORMAT,
    version: PACKAGE_VERSION,
    encrypted: true,
    kdf: KDF,
    cipher: CIPHER,
  };
}

function assertPackageHeader(value, { encrypted }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.format !== PACKAGE_FORMAT
    || value.version !== PACKAGE_VERSION
    || value.encrypted !== encrypted) {
    throw new Error('Unsupported Murdawk connection package.');
  }
}

function buildPublicConnectionPackage(connection) {
  return {
    ...publicHeader(),
    connection: packageConnection(connection),
  };
}

function parsePackageText(text) {
  if (typeof text !== 'string') throw new Error('Connection package must be text.');
  let value;
  try {
    value = JSON.parse(text);
  } catch (_error) {
    throw new Error('This is not a valid Murdawk connection package.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('This is not a valid Murdawk connection package.');
  }
  return value;
}

function parsePublicConnectionPackage(input) {
  const value = typeof input === 'string' ? parsePackageText(input) : input;
  assertPackageHeader(value, { encrypted: false });
  return packageConnection(value.connection);
}

function inspectConnectionPackage(input) {
  const value = typeof input === 'string' ? parsePackageText(input) : input;
  if (value?.encrypted === true) {
    assertPackageHeader(value, { encrypted: true });
    return { encrypted: true, value };
  }
  return {
    encrypted: false,
    connection: parsePublicConnectionPackage(value),
    value,
  };
}

function requirePassword(password) {
  const value = typeof password === 'string' ? password : '';
  if (value.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Use a password with at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  return value;
}

function credentialPayload(input = {}) {
  const accessKeyId = typeof input.accessKeyId === 'string' ? input.accessKeyId.trim() : '';
  const secretAccessKey = typeof input.secretAccessKey === 'string' ? input.secretAccessKey.trim() : '';
  if (!accessKeyId || !secretAccessKey) throw new Error('Both Spaces access keys are required.');
  if (accessKeyId.length > 4096 || secretAccessKey.length > 4096) {
    throw new Error('The Spaces access keys are too large.');
  }
  return {
    connection: packageConnection(input.connection),
    accessKeyId,
    secretAccessKey,
  };
}

function encodeAdditionalData(header) {
  return Buffer.from(JSON.stringify(header), 'utf8');
}

function decodeBase64(value, label) {
  if (typeof value !== 'string' || !value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error(`The encrypted package ${label} is invalid.`);
  }
  const result = Buffer.from(value, 'base64');
  if (!result.length || result.toString('base64') !== value) {
    throw new Error(`The encrypted package ${label} is invalid.`);
  }
  return result;
}

function encryptConnectionPackage(input, password) {
  const safePassword = requirePassword(password);
  const payload = credentialPayload(input);
  const header = encryptedHeader();
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(safePassword, salt, 32);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const cipher = crypto.createCipheriv(CIPHER, key, iv);
  cipher.setAAD(encodeAdditionalData(header));
  let ciphertext;
  try {
    ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
      ...header,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  } finally {
    key.fill(0);
    plaintext.fill(0);
    ciphertext?.fill(0);
  }
}

function decryptConnectionPackage(input, password) {
  const safePassword = requirePassword(password);
  const value = typeof input === 'string' ? parsePackageText(input) : input;
  assertPackageHeader(value, { encrypted: true });
  if (value.kdf !== KDF || value.cipher !== CIPHER) {
    throw new Error('Unsupported encrypted Murdawk connection package.');
  }
  const salt = decodeBase64(value.salt, 'salt');
  const iv = decodeBase64(value.iv, 'IV');
  const authTag = decodeBase64(value.authTag, 'authentication tag');
  const ciphertext = decodeBase64(value.ciphertext, 'ciphertext');
  if (salt.length !== 16 || iv.length !== 12 || authTag.length !== 16) {
    throw new Error('The encrypted package metadata is invalid.');
  }
  const key = crypto.scryptSync(safePassword, salt, 32);
  const decipher = crypto.createDecipheriv(CIPHER, key, iv);
  decipher.setAAD(encodeAdditionalData(encryptedHeader()));
  decipher.setAuthTag(authTag);
  let plaintext;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (_error) {
    throw new Error('The password is wrong or the connection package was changed.');
  } finally {
    key.fill(0);
  }
  try {
    const payload = JSON.parse(plaintext.toString('utf8'));
    return credentialPayload(payload);
  } catch (error) {
    if (/Both Spaces access keys|too large|Connection /.test(error.message)) throw error;
    throw new Error('The password is wrong or the connection package was changed.');
  } finally {
    plaintext.fill(0);
  }
}

module.exports = {
  buildPublicConnectionPackage,
  decryptConnectionPackage,
  encryptConnectionPackage,
  inspectConnectionPackage,
  MIN_PASSWORD_LENGTH,
  PACKAGE_FORMAT,
  PACKAGE_VERSION,
  parsePackageText,
  parsePublicConnectionPackage,
};
