const fs = require('node:fs');
const {
  buildAutomationCredential,
  cleanName,
  createAutomationToken,
  publicAutomationCredential,
  timingSafeTokenEqual,
} = require('./automation-auth-core');
const { readJsonWithBackup, writeJsonAtomic } = require('./atomic-json-core');

const STORE_VERSION = 1;

function validStore(value) {
  return value?.version === STORE_VERSION && Array.isArray(value.credentials);
}

class AutomationAuthStore {
  constructor({ filePath, safeStorage, fsImpl = fs, now = () => new Date() }) {
    this.filePath = filePath;
    this.safeStorage = safeStorage;
    this.fs = fsImpl;
    this.now = now;
  }

  assertAvailable() {
    if (!this.safeStorage?.isEncryptionAvailable?.()) {
      throw new Error('Protected API key storage is not available on this computer.');
    }
  }

  read() {
    const stored = readJsonWithBackup(this.filePath, { fs: this.fs, validator: validStore });
    if (!stored) return { version: STORE_VERSION, credentials: [] };
    const credentials = [];
    for (const value of stored.credentials.slice(0, 32)) {
      try {
        credentials.push(buildAutomationCredential(value));
      } catch (_error) {
        // Invalid records are excluded rather than exposed to the renderer or API.
      }
    }
    return { version: STORE_VERSION, credentials };
  }

  write(credentials) {
    return writeJsonAtomic(this.filePath, {
      version: STORE_VERSION,
      credentials: credentials.map(buildAutomationCredential),
    }, { fs: this.fs, validator: validStore });
  }

  list() {
    return this.read().credentials.map(publicAutomationCredential);
  }

  create(name) {
    this.assertAvailable();
    const token = createAutomationToken();
    const encryptedToken = this.safeStorage.encryptString(token).toString('base64');
    const credential = buildAutomationCredential({
      name: cleanName(name),
      encryptedToken,
      createdAt: this.now().toISOString(),
    });
    const current = this.read().credentials;
    if (current.length >= 32) throw new Error('Remove an old API key before creating another one.');
    this.write([...current, credential]);
    return { token, credential: publicAutomationCredential(credential) };
  }

  revoke(id) {
    const current = this.read().credentials;
    const next = current.filter((credential) => credential.id !== id);
    if (next.length === current.length) throw new Error('API key not found.');
    this.write(next);
    return publicAutomationCredential(current.find((credential) => credential.id === id));
  }

  authenticate(token) {
    this.assertAvailable();
    const current = this.read().credentials;
    let matched = null;
    for (const credential of current) {
      try {
        const decrypted = this.safeStorage.decryptString(Buffer.from(credential.encryptedToken, 'base64'));
        if (timingSafeTokenEqual(decrypted, token)) matched = credential;
      } catch (_error) {
        // A damaged protected record cannot authenticate.
      }
    }
    if (!matched) return null;
    const now = this.now();
    const previous = Date.parse(matched.lastUsedAt || '');
    if (!Number.isFinite(previous) || now.getTime() - previous >= 60_000) {
      const updated = current.map((credential) => credential.id === matched.id
        ? { ...credential, lastUsedAt: now.toISOString() }
        : credential);
      this.write(updated);
      matched = updated.find((credential) => credential.id === matched.id);
    }
    return publicAutomationCredential(matched);
  }
}

module.exports = { AutomationAuthStore, STORE_VERSION, validStore };
