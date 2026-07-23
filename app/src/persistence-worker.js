const { parentPort } = require('node:worker_threads');

const { writeJsonAtomic } = require('./atomic-json-core');
const {
  buildCancelledJobRecord,
  buildJobRecord,
  buildPausedJobRecord,
  readJobRecord,
  writeJobRecord,
} = require('./job-core');
const { writeSettings } = require('./settings');

function runOperation(operation, payload = {}) {
  if (operation === 'write-json') {
    return writeJsonAtomic(payload.target, payload.value, payload.options);
  }
  if (operation === 'write-job') {
    return writeJobRecord(payload.jobsDir, payload.record, payload.options);
  }
  if (operation === 'update-running-job') {
    const record = readJobRecord(payload.jobsDir, payload.jobId);
    if (record.status !== 'running') return record;
    return writeJobRecord(payload.jobsDir, buildJobRecord({
      ...record,
      transferState: payload.transferState,
      diagnostics: payload.diagnostics,
    }), payload.options);
  }
  if (operation === 'cancel-job') {
    const record = readJobRecord(payload.jobsDir, payload.jobId);
    return writeJobRecord(payload.jobsDir, buildCancelledJobRecord({
      ...record,
      diagnostics: payload.diagnostics,
    }, payload.message), payload.options);
  }
  if (operation === 'pause-job') {
    const record = readJobRecord(payload.jobsDir, payload.jobId);
    return writeJobRecord(payload.jobsDir, buildPausedJobRecord({
      ...record,
      transferState: payload.transferState,
      diagnostics: payload.diagnostics,
    }), payload.options);
  }
  if (operation === 'write-settings') {
    return writeSettings(payload.settingsPath, payload.settings, payload.options);
  }
  const error = new Error(`Unsupported persistence operation: ${operation}`);
  error.code = 'EPERSISTENCEOP';
  throw error;
}

parentPort.on('message', ({ id, operation, payload }) => {
  try {
    parentPort.postMessage({ id, ok: true, value: runOperation(operation, payload) });
  } catch (error) {
    parentPort.postMessage({
      id,
      ok: false,
      error: {
        name: error.name,
        message: error.message,
        code: error.code,
        stack: error.stack,
      },
    });
  }
});
