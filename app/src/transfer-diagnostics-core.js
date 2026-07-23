(function attachTransferDiagnosticsCore(root, factory) {
  const core = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = core;
  }
  if (root) {
    root.transferDiagnosticsCore = core;
  }
})(typeof window !== 'undefined' ? window : globalThis, function createTransferDiagnosticsCore() {
const DEFAULT_TUNING = {
  transfers: 4,
  chunkSize: '64M',
  uploadConcurrency: 4,
};

const MAX_SAMPLES = 12;
const SLOW_BYTES_PER_SECOND = 10 * 1024 * 1024;
const QUIET_SECONDS = 60;
const STALLED_SECONDS = 300;

const SPEED_UNITS = {
  b: 1,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
  kb: 1000,
  mb: 1000 ** 2,
  gb: 1000 ** 3,
  tb: 1000 ** 4,
};

function parseSpeedToBytesPerSecond(value = '') {
  const match = String(value || '').trim().match(/^([\d.]+)\s*([kmgt]?i?b)\/s$/i);
  if (!match) return 0;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * (SPEED_UNITS[unit] || 1));
}

function formatBytesPerSecond(bytesPerSecond = 0) {
  const value = Number(bytesPerSecond || 0);
  if (!Number.isFinite(value) || value <= 0) return '-';
  if (value < 1024) return `${Math.round(value)} B/s`;
  const units = ['KiB/s', 'MiB/s', 'GiB/s', 'TiB/s'];
  let size = value / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(1)} ${units[index]}`;
}

function secondsSince(value, now = Date.now()) {
  const time = Date.parse(value || '');
  if (!Number.isFinite(time)) return null;
  return Math.max(0, Math.floor((Number(now) - time) / 1000));
}

function sanitizeTuning(profile = {}) {
  return {
    transfers: Number(profile.transfers || DEFAULT_TUNING.transfers),
    chunkSize: profile.chunkSize || DEFAULT_TUNING.chunkSize,
    uploadConcurrency: Number(profile.uploadConcurrency || DEFAULT_TUNING.uploadConcurrency),
  };
}

function boundedSamples(previous = {}, sample = null) {
  const samples = Array.isArray(previous.samples) ? previous.samples : [];
  const normalized = samples
    .map((item) => ({
      at: typeof item.at === 'string' ? item.at : '',
      bytesPerSecond: Math.max(0, Math.round(Number(item.bytesPerSecond || 0))),
    }))
    .filter((item) => item.at && item.bytesPerSecond > 0);
  if (sample && sample.bytesPerSecond > 0) {
    normalized.push(sample);
  }
  return normalized.slice(-MAX_SAMPLES);
}

function average(values = []) {
  if (!values.length) return 0;
  return Math.round(values.reduce((total, value) => total + value, 0) / values.length);
}

function terminalState(status = '') {
  if (status === 'complete' || status === 'warning' || status === 'ready') return 'complete';
  if (status === 'failed' || status === 'blocked') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  return '';
}

function classifyTransfer({
  status = 'running',
  transfer = {},
  currentBytesPerSecond = 0,
  averageBytesPerSecond = 0,
  now = Date.now(),
} = {}) {
  const terminal = terminalState(status);
  if (terminal) return terminal;
  if (transfer.mode === 'verify' || transfer.mode === 'checksum') return 'verifying';

  if (!transfer.isRunning && (transfer.activeJobId || status === 'running')) {
    return 'stalled';
  }

  const lastProgressAgeSeconds = secondsSince(transfer.lastProgressAt || transfer.lastOutputAt, now);
  const lastOutputAgeSeconds = secondsSince(transfer.lastOutputAt || transfer.lastProgressAt, now);

  if (lastProgressAgeSeconds !== null && lastProgressAgeSeconds >= STALLED_SECONDS) {
    return 'stalled';
  }
  if (lastOutputAgeSeconds !== null && lastOutputAgeSeconds >= QUIET_SECONDS) {
    return 'quiet';
  }
  if (
    currentBytesPerSecond > 0
    && currentBytesPerSecond < SLOW_BYTES_PER_SECOND
    && averageBytesPerSecond > 0
    && averageBytesPerSecond < SLOW_BYTES_PER_SECOND
  ) {
    return 'slow';
  }
  return 'healthy';
}

function recommendationForState(state) {
  if (state === 'slow') {
    return 'Observed speed is low for a sustained period. Current settings are conservative; for a future fast preset, consider higher transfers/concurrency after this job finishes.';
  }
  if (state === 'stalled') {
    return 'Progress appears stalled. Do not retry blindly; check activity or run status/verify first because the object may already have committed.';
  }
  return 'Current settings are conservative. Keep them unchanged for this transfer; tune future uploads only after verification.';
}

function safeActionForState(state) {
  if (state === 'quiet') {
    return 'Keep uploading if the rclone process is still alive; quiet multipart uploads can still commit successfully.';
  }
  if (state === 'slow') {
    return 'Keep uploading; use this speed evidence to choose future tuning after verification completes.';
  }
  if (state === 'stalled') {
    return 'Check activity, then use History / Resume or CLI verify before retrying.';
  }
  if (state === 'verifying') {
    return 'Wait for verification; progress is not the completion authority.';
  }
  if (state === 'complete') {
    return 'Upload completed only if verification also passed.';
  }
  if (state === 'failed') {
    return 'Inspect status and diagnostics before retrying.';
  }
  if (state === 'cancelled') {
    return 'Resume from history after a fresh check when you are ready.';
  }
  return 'Keep uploading; verification is still the source of truth.';
}

function buildTransferDiagnostics({
  previous = {},
  status = 'running',
  transfer = {},
  profile = {},
  now = Date.now(),
} = {}) {
  const currentBytesPerSecond = parseSpeedToBytesPerSecond(transfer.speed);
  const sample = currentBytesPerSecond > 0
    ? {
      at: new Date(Number(now)).toISOString(),
      bytesPerSecond: currentBytesPerSecond,
    }
    : null;
  const samples = boundedSamples(previous, sample);
  const speeds = samples.map((item) => item.bytesPerSecond);
  const rollingAverageBytesPerSecond = average(speeds);
  const peakBytesPerSecond = speeds.length ? Math.max(...speeds) : 0;
  const state = classifyTransfer({
    status,
    transfer,
    currentBytesPerSecond,
    averageBytesPerSecond: rollingAverageBytesPerSecond,
    now,
  });

  return {
    state,
    isRunning: Boolean(transfer.isRunning),
    pid: Number(transfer.pid || transfer.activePid || 0),
    activeJobId: transfer.activeJobId || '',
    mode: transfer.mode || '',
    currentFile: transfer.currentFile || transfer.source || '',
    eta: transfer.eta || '',
    lastOutputAt: transfer.lastOutputAt || '',
    lastProgressAt: transfer.lastProgressAt || '',
    lastOutputAgeSeconds: secondsSince(transfer.lastOutputAt || transfer.lastProgressAt, now),
    lastProgressAgeSeconds: secondsSince(transfer.lastProgressAt || transfer.lastOutputAt, now),
    speed: {
      currentBytesPerSecond,
      current: formatBytesPerSecond(currentBytesPerSecond),
      rollingAverageBytesPerSecond,
      rollingAverage: formatBytesPerSecond(rollingAverageBytesPerSecond),
      peakBytesPerSecond,
      peak: formatBytesPerSecond(peakBytesPerSecond),
    },
    samples,
    tuning: sanitizeTuning(profile),
    recommendation: recommendationForState(state),
    safeAction: safeActionForState(state),
  };
}

function formatAge(seconds) {
  if (seconds === null || seconds === undefined) return '-';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}m ${rest}s ago`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
}

function labelForState(state, diagnostics = {}) {
  if (state === 'quiet') return 'Still uploading (quiet)';
  if (state === 'slow') return 'Uploading slowly';
  if (state === 'stalled') return diagnostics.isRunning ? 'Possible stall' : 'Needs resume check';
  if (state === 'verifying') return 'Verifying upload';
  if (state === 'complete') return 'Upload complete';
  if (state === 'failed') return 'Upload failed';
  if (state === 'cancelled') return 'Upload cancelled';
  if (diagnostics.isRunning) return `rclone running${diagnostics.pid ? ` (PID ${diagnostics.pid})` : ''}`;
  return 'No active rclone transfer';
}

function summarizeDiagnosticsForDisplay(diagnostics = {}) {
  const state = diagnostics.state || 'healthy';
  const speed = diagnostics.speed || {};
  const tuning = diagnostics.tuning || sanitizeTuning();
  const detail = diagnostics.currentFile
    ? `${diagnostics.currentFile} - ${diagnostics.safeAction || ''}`.trim()
    : diagnostics.safeAction || 'Safe to close if no queue job is uploading.';
  return {
    label: labelForState(state, diagnostics),
    detail,
    className: state === 'healthy' ? 'running' : state,
    process: diagnostics.mode || (diagnostics.isRunning ? 'upload' : '-'),
    lastOutput: formatAge(diagnostics.lastOutputAgeSeconds),
    metrics: [
      `current ${speed.current || '-'}`,
      `avg ${speed.rollingAverage || '-'}`,
      `peak ${speed.peak || '-'}`,
    ].join(' | '),
    tuning: `transfers ${tuning.transfers}, chunk ${tuning.chunkSize}, concurrency ${tuning.uploadConcurrency}`,
    recommendation: diagnostics.recommendation || recommendationForState(state),
    safeAction: diagnostics.safeAction || safeActionForState(state),
  };
}

return {
  buildTransferDiagnostics,
  classifyTransfer,
  formatBytesPerSecond,
  parseSpeedToBytesPerSecond,
  summarizeDiagnosticsForDisplay,
};
});
