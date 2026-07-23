const crypto = require('node:crypto');

function createAutomationToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function cleanName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error('API key name is required and must be 80 characters or fewer.');
  }
  return name;
}

function buildAutomationCredential({
  id = crypto.randomUUID(),
  name,
  encryptedToken,
  createdAt = new Date().toISOString(),
  lastUsedAt = '',
} = {}) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(id)) {
    throw new Error('API key identity is invalid.');
  }
  if (typeof encryptedToken !== 'string' || !encryptedToken) {
    throw new Error('Protected API key data is required.');
  }
  return {
    id,
    name: cleanName(name),
    encryptedToken,
    createdAt,
    lastUsedAt: typeof lastUsedAt === 'string' ? lastUsedAt : '',
  };
}

function publicAutomationCredential(value) {
  return {
    id: value.id,
    name: value.name,
    createdAt: value.createdAt,
    lastUsedAt: value.lastUsedAt || '',
  };
}

function timingSafeTokenEqual(left, right) {
  const first = Buffer.from(String(left || ''), 'utf8');
  const second = Buffer.from(String(right || ''), 'utf8');
  return first.length === second.length && crypto.timingSafeEqual(first, second);
}

module.exports = {
  buildAutomationCredential,
  cleanName,
  createAutomationToken,
  publicAutomationCredential,
  timingSafeTokenEqual,
};
