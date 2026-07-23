const {
  buildDownloadArgs,
  buildDownloadCheckArgs,
  buildDownloadOperations,
  precheckDownloadTargets,
  verifyDownloadedTargets,
} = require('./download-core');
const { buildJobRecord } = require('./job-core');

function operationNames(items = []) {
  return items.map((item) => item.name);
}

async function runDownloadLifecycle(normalized = {}, {
  dryRun = false,
  jobId = '',
  job = {},
} = {}, dependencies = {}) {
  const {
    assertReady = async () => true,
    emit = () => {},
    getDiagnostics = () => null,
    runRclone,
    statSync,
    updatePhase = () => {},
    waitForContinuation = async () => true,
    writeJobRecord,
  } = dependencies;
  if (typeof runRclone !== 'function' || typeof writeJobRecord !== 'function') {
    throw new TypeError('Download runtime requires rclone and durable job persistence.');
  }

  const operations = buildDownloadOperations({
    destination: normalized.localDestination,
    items: normalized.remoteItems,
    profile: normalized.profile,
  });
  const mode = dryRun ? 'download-check' : 'download';
  const record = (updates = {}) => buildJobRecord({
    ...job,
    direction: 'download',
    localDestination: normalized.localDestination,
    remoteItems: normalized.remoteItems,
    ...updates,
  });

  try {
    await waitForContinuation(jobId);
    const preflight = precheckDownloadTargets(operations, { statSync });
    await assertReady(normalized.profile, { jobId });
    await waitForContinuation(jobId);
    updatePhase(dryRun ? 'prechecking' : 'uploading');
    await writeJobRecord(record({ status: dryRun ? 'dry-run' : 'running' }));

    emit('upload:preflight', {
      jobId,
      intentId: normalized.intentId,
      direction: 'download',
      selectedCount: operations.length,
      existingCount: preflight.existing.length,
      mismatchCount: preflight.mismatched.length,
      pendingCount: preflight.pending.length,
      existing: operationNames(preflight.existing),
      mismatched: operationNames(preflight.mismatched),
      pending: operationNames(preflight.pending),
    });
    emit('upload:start', {
      jobId,
      intentId: normalized.intentId,
      direction: 'download',
      mode,
      sources: operations.map((operation) => operation.remotePath),
      localDestination: normalized.localDestination,
    });

    for (let index = 0; index < preflight.pending.length; index += 1) {
      await waitForContinuation(jobId);
      const operation = preflight.pending[index];
      const sourceIndex = index + 1;
      const sourceTotal = preflight.pending.length;
      emit('upload:source-start', {
        jobId,
        intentId: normalized.intentId,
        direction: 'download',
        mode,
        source: operation.remotePath,
        destination: operation.localPath,
        sourceIndex,
        sourceTotal,
      });
      await runRclone(buildDownloadArgs(operation, { dryRun }), {
        jobId,
        intentId: normalized.intentId,
        source: operation.remotePath,
        sourceIndex,
        sourceTotal,
        mode,
        profile: normalized.profile,
      });
      emit('upload:source-complete', {
        jobId,
        intentId: normalized.intentId,
        direction: 'download',
        mode,
        source: operation.remotePath,
        destination: operation.localPath,
        sourceIndex,
        sourceTotal,
      });
    }

    if (dryRun) {
      updatePhase('persisting');
      await writeJobRecord(record({
        status: 'ready',
        completedAt: new Date().toISOString(),
        diagnostics: getDiagnostics(jobId, 'complete'),
      }));
      const result = {
        ok: true,
        jobId,
        intentId: normalized.intentId,
        direction: 'download',
        dryRun: true,
        preflight,
        verification: null,
        localDestination: normalized.localDestination,
      };
      emit('upload:complete', result);
      return result;
    }

    updatePhase('verifying');
    const checkedFolders = new Set();
    for (const operation of operations.filter((item) => item.isDir)) {
      await waitForContinuation(jobId);
      await runRclone(buildDownloadCheckArgs(operation), {
        jobId,
        intentId: normalized.intentId,
        source: operation.remotePath,
        mode: 'download-verify',
        profile: normalized.profile,
      });
      checkedFolders.add(operation.localPath);
    }
    await waitForContinuation(jobId);
    const verification = verifyDownloadedTargets(operations, { statSync, checkedFolders });
    emit('upload:verified', {
      jobId,
      intentId: normalized.intentId,
      direction: 'download',
      verification,
    });
    if (!verification.ok) {
      const error = new Error(
        `Download finished but local verification failed. Missing: ${verification.missing.length}. Size mismatches: ${verification.sizeMismatch.length}.`,
      );
      error.verification = verification;
      throw error;
    }

    updatePhase('persisting');
    await writeJobRecord(record({
      status: 'complete',
      completedAt: new Date().toISOString(),
      verification,
      diagnostics: getDiagnostics(jobId, 'complete'),
    }));
    const result = {
      ok: true,
      jobId,
      intentId: normalized.intentId,
      direction: 'download',
      dryRun: false,
      preflight,
      verification,
      localDestination: normalized.localDestination,
    };
    emit('upload:complete', result);
    return result;
  } catch (error) {
    if (error.paused) {
      if (!error.terminalPersisted) {
        await writeJobRecord(record({
          status: 'paused',
          completedAt: '',
          error: error.message,
          diagnostics: getDiagnostics(jobId, 'paused'),
        }));
        error.terminalPersisted = true;
      }
      throw error;
    }
    if (error.cancelled) {
      if (!error.terminalPersisted) {
        await writeJobRecord(record({
          status: 'cancelled',
          completedAt: new Date().toISOString(),
          error: error.message,
          diagnostics: getDiagnostics(jobId, 'cancelled'),
        }));
        emit('upload:cancelled', {
          jobId,
          intentId: normalized.intentId,
          direction: 'download',
          message: error.message,
        });
        error.terminalPersisted = true;
      }
      throw error;
    }
    if (!error.terminalPersisted) {
      await writeJobRecord(record({
        status: 'failed',
        completedAt: new Date().toISOString(),
        verification: error.verification || null,
        error: error.message,
        diagnostics: getDiagnostics(jobId, 'failed'),
      }));
      emit('upload:error', {
        jobId,
        intentId: normalized.intentId,
        direction: 'download',
        message: error.message,
        stderr: error.stderr || '',
        verification: error.verification || null,
        checksum: null,
      });
      error.terminalPersisted = true;
    }
    throw error;
  }
}

module.exports = { runDownloadLifecycle };
