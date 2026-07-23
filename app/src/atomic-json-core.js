const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REPLACE_CONFLICT_CODES = new Set(['EACCES', 'EEXIST', 'ENOTEMPTY', 'EPERM']);
const LOCK_CONTENTION_CODES = new Set(['EACCES', 'EBUSY', 'EEXIST', 'EPERM']);
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
let tempSequence = 0;

function nextTempPath(target) {
  tempSequence += 1;
  return `${target}.tmp-${process.pid}-${Date.now().toString(36)}-${tempSequence}-${crypto.randomUUID()}`;
}

function removeTempBestEffort(fsImpl, tempPath) {
  if (!tempPath.includes('.tmp-')) return;
  try {
    fsImpl.unlinkSync(tempPath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      // Cleanup must not hide the persistence result or the original failure.
    }
  }
}

function sleepSync(milliseconds) {
  if (milliseconds > 0) Atomics.wait(sleepBuffer, 0, 0, milliseconds);
}

function positiveNumber(value, fallback) {
  return Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : fallback;
}

function lockOptions(options = {}) {
  return {
    lockTimeoutMs: positiveNumber(options.lockTimeoutMs, 5_000),
    lockRetryMs: Math.max(1, positiveNumber(options.lockRetryMs, 5)),
    staleLockMs: Math.max(1, positiveNumber(options.staleLockMs, 30_000)),
  };
}

function operationDeadline(options = {}) {
  if (Number.isFinite(Number(options.deadline))) return Number(options.deadline);
  return Date.now() + lockOptions(options).lockTimeoutMs;
}

function retryDelay(attempt, baseDelay, remaining) {
  return Math.max(0, Math.min(remaining, 50, baseDelay * Math.max(1, attempt)));
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function parseLockOwner(contents) {
  try {
    const owner = JSON.parse(contents);
    return owner && typeof owner === 'object' ? owner : null;
  } catch (_error) {
    return null;
  }
}

function sameFileVersion(first, second) {
  const hasIdentity = first.ino !== 0 && second.ino !== 0;
  return (!hasIdentity || (first.dev === second.dev && first.ino === second.ino))
    && first.size === second.size
    && first.mtimeMs === second.mtimeMs;
}

function readFileState(filePath, fsImpl) {
  try {
    const firstStat = fsImpl.statSync(filePath);
    const contents = fsImpl.readFileSync(filePath, 'utf8');
    const secondStat = fsImpl.statSync(filePath);
    return sameFileVersion(firstStat, secondStat) ? { contents, stat: secondStat } : null;
  } catch (error) {
    if (error.code === 'ENOENT' || LOCK_CONTENTION_CODES.has(error.code)) return null;
    throw error;
  }
}

function readStaleLock(filePath, fsImpl, staleLockMs) {
  const state = readFileState(filePath, fsImpl);
  if (!state || Date.now() - state.stat.mtimeMs <= staleLockMs) return null;

  const now = Date.now();
  const owner = parseLockOwner(state.contents);
  const hasCompleteOwner = owner
    && Number.isInteger(Number(owner.pid))
    && Number(owner.pid) > 0
    && typeof owner.token === 'string'
    && owner.token.length > 0
    && Number.isFinite(Number(owner.createdAt));
  if (hasCompleteOwner) {
    if (now - Number(owner.createdAt) <= staleLockMs) {
      return null;
    }
    if (isProcessAlive(Number(owner.pid))) return null;
  } else if (now - state.stat.mtimeMs <= staleLockMs * 2) {
    return null;
  }
  return { ...state, owner };
}

function fileMatchesState(filePath, fsImpl, expected) {
  try {
    const stat = fsImpl.statSync(filePath);
    if (!sameFileVersion(stat, expected.stat)) return false;
    return fsImpl.readFileSync(filePath, 'utf8') === expected.contents
      && sameFileVersion(fsImpl.statSync(filePath), stat);
  } catch (error) {
    if (error.code === 'ENOENT' || LOCK_CONTENTION_CODES.has(error.code)) return false;
    throw error;
  }
}

function fileExistsConservatively(filePath, fsImpl) {
  try {
    fsImpl.statSync(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    if (LOCK_CONTENTION_CODES.has(error.code)) return true;
    throw error;
  }
}

function createOwnedLock(lockPath, fsImpl) {
  let handle;
  try {
    handle = fsImpl.openSync(lockPath, 'wx');
    const owner = {
      pid: process.pid,
      token: crypto.randomUUID(),
      createdAt: Date.now(),
    };
    try {
      fsImpl.writeFileSync(handle, `${JSON.stringify(owner)}\n`, 'utf8');
      fsImpl.fsyncSync(handle);
    } catch (error) {
      try {
        fsImpl.closeSync(handle);
      } catch (_closeError) {
        // Preserve the metadata write failure.
      }
      handle = undefined;
      try {
        fsImpl.unlinkSync(lockPath);
      } catch (_cleanupError) {
        // This exact lock was created by this acquisition attempt.
      }
      throw error;
    }
    return { handle, lockPath, token: owner.token };
  } catch (error) {
    if (handle !== undefined) {
      try {
        fsImpl.closeSync(handle);
      } catch (_closeError) {
        // Preserve the acquisition failure.
      }
    }
    throw error;
  }
}

function tryCreateOwnedLock(lockPath, fsImpl) {
  try {
    return createOwnedLock(lockPath, fsImpl);
  } catch (error) {
    if (LOCK_CONTENTION_CODES.has(error.code)) return null;
    throw error;
  }
}

function releaseLock(lock, fsImpl, options) {
  try {
    fsImpl.closeSync(lock.handle);
  } catch (_error) {
    // Continue to remove the owned lock path after the handle is closed or invalid.
  }

  const { lockRetryMs } = lockOptions(options);
  const deadline = operationDeadline(options);
  let attempt = 0;
  let owner;
  while (true) {
    try {
      owner = parseLockOwner(fsImpl.readFileSync(lock.lockPath, 'utf8'));
      break;
    } catch (error) {
      if (error.code === 'ENOENT') return;
      if (!LOCK_CONTENTION_CODES.has(error.code) || Date.now() >= deadline) throw error;
    }
    attempt += 1;
    sleepSync(retryDelay(attempt, lockRetryMs, deadline - Date.now()));
  }
  if (!owner || owner.token !== lock.token) {
    const error = new Error(`Atomic JSON lock ownership changed: ${lock.lockPath}`);
    error.code = 'ELOCKOWNER';
    throw error;
  }

  attempt = 0;
  while (true) {
    try {
      fsImpl.unlinkSync(lock.lockPath);
      return;
    } catch (error) {
      if (error.code === 'ENOENT') return;
      if (!LOCK_CONTENTION_CODES.has(error.code) || Date.now() >= deadline) throw error;
    }
    attempt += 1;
    sleepSync(retryDelay(attempt, lockRetryMs, deadline - Date.now()));
  }
}

function removeExpectedStaleFile(filePath, fsImpl, options, expected) {
  const { lockRetryMs, staleLockMs } = lockOptions(options);
  const stale = readStaleLock(filePath, fsImpl, staleLockMs);
  const state = expected || stale;
  if (!stale || !state || !sameFileVersion(stale.stat, state.stat) || stale.contents !== state.contents) {
    return false;
  }

  const deadline = operationDeadline(options);
  let attempt = 0;
  while (fileMatchesState(filePath, fsImpl, state)) {
    try {
      fsImpl.unlinkSync(filePath);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return true;
      if (!LOCK_CONTENTION_CODES.has(error.code) || Date.now() >= deadline) return false;
    }
    attempt += 1;
    sleepSync(retryDelay(attempt, lockRetryMs, deadline - Date.now()));
  }
  return !fileExistsConservatively(filePath, fsImpl);
}

function cleanupQuarantine(quarantinePath, fsImpl, options, expected) {
  return removeExpectedStaleFile(quarantinePath, fsImpl, options, expected);
}

function renameStaleLockToQuarantine(
  lockPath,
  quarantinePath,
  expected,
  reservation,
  fsImpl,
  options,
) {
  const { lockRetryMs } = lockOptions(options);
  const deadline = operationDeadline(options);
  let attempt = 0;
  while (true) {
    if (!fileMatchesState(quarantinePath, fsImpl, reservation)) return false;
    if (!fileMatchesState(lockPath, fsImpl, expected)) return false;
    try {
      fsImpl.renameSync(lockPath, quarantinePath);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EEXIST' || error.code === 'ENOTEMPTY') {
        return false;
      }
      if (!LOCK_CONTENTION_CODES.has(error.code) || Date.now() >= deadline) return false;
    }
    attempt += 1;
    sleepSync(retryDelay(attempt, lockRetryMs, deadline - Date.now()));
  }
}

function tryRecoverStaleLock(lockPath, quarantinePath, fsImpl, options) {
  const { staleLockMs } = lockOptions(options);
  const stale = readStaleLock(lockPath, fsImpl, staleLockMs);
  if (!stale || fileExistsConservatively(quarantinePath, fsImpl)) return false;

  // Node's Windows rename replaces destinations, so reserve the fixed quarantine exclusively first.
  const reservationLock = tryCreateOwnedLock(quarantinePath, fsImpl);
  if (!reservationLock) return false;
  const reservation = readFileState(quarantinePath, fsImpl);
  let replacedReservation = false;
  try {
    if (!reservation || !fileMatchesState(lockPath, fsImpl, stale)) return false;
    try {
      fsImpl.closeSync(reservationLock.handle);
    } finally {
      reservationLock.handle = undefined;
    }
    replacedReservation = renameStaleLockToQuarantine(
      lockPath,
      quarantinePath,
      stale,
      reservation,
      fsImpl,
      options,
    );
    if (!replacedReservation) return false;
    return cleanupQuarantine(quarantinePath, fsImpl, options, stale);
  } finally {
    if (!replacedReservation) releaseLock(reservationLock, fsImpl, options);
  }
}

function cleanupLegacyClaims(lockPath, fsImpl, options) {
  const directory = path.dirname(lockPath);
  const prefix = `${path.basename(lockPath)}-claim-`;
  let names;
  try {
    names = fsImpl.readdirSync(directory);
  } catch (error) {
    if (error.code === 'ENOENT' || LOCK_CONTENTION_CODES.has(error.code)) return;
    throw error;
  }

  for (const name of names.filter((entry) => entry.startsWith(prefix)).slice(0, 32)) {
    const claimPath = path.join(directory, name);
    if (path.dirname(claimPath) !== directory || path.basename(claimPath) !== name) continue;
    removeExpectedStaleFile(claimPath, fsImpl, options);
  }
}

function waitForLockRetry(lockPath, deadline, attempt, lockRetryMs) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    const error = new Error(`Timed out waiting for atomic JSON lock: ${lockPath}`);
    error.code = 'ELOCKED';
    throw error;
  }
  sleepSync(retryDelay(attempt, lockRetryMs, remaining));
}

function acquireLock(target, fsImpl, options) {
  const { lockRetryMs } = lockOptions(options);
  const lockPath = `${target}.lock`;
  const quarantinePath = `${lockPath}.stale`;
  const deadline = operationDeadline(options);
  let attempt = 0;

  while (true) {
    attempt += 1;
    if (fileExistsConservatively(quarantinePath, fsImpl)) {
      cleanupQuarantine(quarantinePath, fsImpl, options);
      waitForLockRetry(lockPath, deadline, attempt, lockRetryMs);
      continue;
    }

    const lock = tryCreateOwnedLock(lockPath, fsImpl);
    if (!lock) {
      tryRecoverStaleLock(lockPath, quarantinePath, fsImpl, options);
      waitForLockRetry(lockPath, deadline, attempt, lockRetryMs);
      continue;
    }
    if (fileExistsConservatively(quarantinePath, fsImpl)) {
      releaseLock(lock, fsImpl, options);
      waitForLockRetry(lockPath, deadline, attempt, lockRetryMs);
      continue;
    }
    return lock;
  }
}

function writeDurableTemp(target, contents, fsImpl) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const tempPath = nextTempPath(target);
    let handle;
    try {
      handle = fsImpl.openSync(tempPath, 'wx');
      try {
        fsImpl.writeFileSync(handle, contents, 'utf8');
        fsImpl.fsyncSync(handle);
      } finally {
        fsImpl.closeSync(handle);
        handle = undefined;
      }
      return tempPath;
    } catch (error) {
      if (handle !== undefined) {
        try {
          fsImpl.closeSync(handle);
        } catch (_closeError) {
          // Preserve the original write error.
        }
      }
      removeTempBestEffort(fsImpl, tempPath);
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new Error(`Could not allocate a unique temporary file for ${target}`);
}

function renameWithRetry(source, destination, fsImpl, options) {
  const { lockRetryMs } = lockOptions(options);
  const deadline = operationDeadline(options);
  let attempt = 0;
  while (true) {
    try {
      fsImpl.renameSync(source, destination);
      return;
    } catch (error) {
      if (!LOCK_CONTENTION_CODES.has(error.code) || Date.now() >= deadline) throw error;
    }
    attempt += 1;
    sleepSync(retryDelay(attempt, lockRetryMs, deadline - Date.now()));
  }
}

function replaceFile(tempPath, target, fsImpl, options) {
  try {
    fsImpl.renameSync(tempPath, target);
    return;
  } catch (error) {
    if (!REPLACE_CONFLICT_CODES.has(error.code) || !fsImpl.existsSync(target)) {
      throw error;
    }
  }

  const displacedPath = nextTempPath(target);
  renameWithRetry(target, displacedPath, fsImpl, options);
  try {
    renameWithRetry(tempPath, target, fsImpl, options);
  } catch (error) {
    try {
      renameWithRetry(displacedPath, target, fsImpl, options);
    } catch (restoreError) {
      error.restoreError = restoreError;
    }
    throw error;
  }
  removeTempBestEffort(fsImpl, displacedPath);
}

function readJsonCandidate(candidate, fsImpl, validator) {
  let contents;
  try {
    contents = fsImpl.readFileSync(candidate, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }

  let value;
  try {
    value = JSON.parse(contents);
  } catch (_error) {
    return null;
  }
  return !validator || validator(value) ? { contents, value } : null;
}

function readJsonWithBackup(target, options = {}) {
  const fsImpl = options.fs || fs;
  const { validator } = options;
  if (validator !== undefined && typeof validator !== 'function') {
    throw new TypeError('Atomic JSON validator must be a function.');
  }
  const primary = readJsonCandidate(target, fsImpl, validator);
  if (primary) return primary.value;
  const backup = readJsonCandidate(`${target}.bak`, fsImpl, validator);
  return backup ? backup.value : null;
}

function writeJsonAtomic(target, value, options = {}) {
  const fsImpl = options.fs || fs;
  const { validator } = options;
  if (validator !== undefined && typeof validator !== 'function') {
    throw new TypeError('Atomic JSON validator must be a function.');
  }
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) {
    throw new TypeError('Atomic JSON value must be JSON-serializable.');
  }

  const runtimeOptions = {
    ...options,
    deadline: Date.now() + lockOptions(options).lockTimeoutMs,
  };
  fsImpl.mkdirSync(path.dirname(target), { recursive: true });
  cleanupLegacyClaims(`${target}.lock`, fsImpl, runtimeOptions);
  const lock = acquireLock(target, fsImpl, runtimeOptions);
  let failure;
  try {
    const tempPath = writeDurableTemp(target, `${serialized}\n`, fsImpl);
    try {
      const previous = readJsonCandidate(target, fsImpl, validator);
      if (previous) {
        const backupPath = `${target}.bak`;
        const backupTempPath = writeDurableTemp(backupPath, previous.contents, fsImpl);
        try {
          replaceFile(backupTempPath, backupPath, fsImpl, runtimeOptions);
        } finally {
          removeTempBestEffort(fsImpl, backupTempPath);
        }
      }
      replaceFile(tempPath, target, fsImpl, runtimeOptions);
      return value;
    } finally {
      removeTempBestEffort(fsImpl, tempPath);
    }
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      releaseLock(lock, fsImpl, runtimeOptions);
    } catch (lockError) {
      if (failure) failure.lockReleaseError = lockError;
      else throw lockError;
    }
  }
}

module.exports = { readJsonWithBackup, writeJsonAtomic };
