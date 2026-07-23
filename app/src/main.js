const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, safeStorage, shell } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  publicAutomationCapabilities,
} = require('./automation-capabilities-core');
const { AutomationAuthStore } = require('./automation-auth-store');
const { AutomationServer } = require('./automation-server');
const {
  appendRedactedLogFile,
  cleanupActivityLogs,
  createChildLogCoordinator,
  findSuccessfulResumeSupersessions,
  redactLogText,
  summarizeActivityRecords,
} = require('./activity-core');
const {
  compareChecksumEntries,
  computeFileSha256,
  normalizeChecksumMode,
  skippedChecksumReport,
} = require('./checksum-core');
const {
  CancellationLifecycle,
} = require('./cancellation-core');
const {
  buildCloseGuardMessage,
} = require('./close-guard-core');
const {
  collectConnectionRemovalBlockers,
  connectionProfileMatches,
  sanitizeConnection,
} = require('./connection-core');
const {
  buildPublicConnectionPackage,
  decryptConnectionPackage,
  encryptConnectionPackage,
  inspectConnectionPackage,
} = require('./connection-package-core');
const { buildMissingQueuePlan } = require('./cli-core');
const {
  normalizeDownloadSelection,
  normalizeLocalDestination,
} = require('./download-core');
const { runDownloadLifecycle } = require('./download-runtime');
const {
  normalizeEventManifest,
} = require('./event-manifest-core');
const { loadEventManifestFile } = require('./event-manifest-file-core');
const {
  reconcileEventRecords,
} = require('./event-reconcile-core');
const {
  buildLocalEventManifestRecordsAsync,
  credentialLikeEventPathReason,
  inspectUploadSourcesForCredentialLikePaths,
  listEventRemoteRecords,
  normalizeEventScanMaxFiles,
} = require('./event-workspace-runtime');
const {
  assertValidJobId,
  buildCancelledJobRecord,
  buildJobRecord,
  buildResumeQueueSettings,
  createJobId,
  readJobRecord,
  readJobRecords,
} = require('./job-core');
const {
  buildNotificationPayload,
  sendNotifications,
} = require('./notification-core');
const { bindMainTransferIdentity } = require('./main-request-core');
const { ProfileMutationInterlock } = require('./profile-mutation-interlock');
const {
  buildTransferDiagnostics,
} = require('./transfer-diagnostics-core');
const {
  spawnTransferProcess,
} = require('./transfer-lock-core');
const { runDurableLifecycle, TransferLifecycle } = require('./transfer-lifecycle-core');
const {
  buildExplorerListArgs,
  buildJsonListArgs,
  buildRemoteOperationArgs,
  buildRemotePath,
  buildTouchArgs,
  buildVerificationReport,
  collectLocalUploadEntries,
  collectLocalUploadSourcePlan,
  DEFAULT_PROFILE,
  buildCopyArgs,
  buildListArgs,
  buildPublicUrl,
  normalizeProfile,
  normalizeFilterMode,
  normalizeFolderUploadMode,
  normalizeExplorerPath,
  normalizePrefix,
  parseExplorerEntries,
  parseRcloneProgress,
  sourceDestinationPrefix,
} = require('./upload-core');
const {
  redactRuntimePaths,
  scavengeAbandonedManifests,
  withFrozenDirectoryManifest,
} = require('./upload-manifest-core');
const { PauseLifecycle } = require('./pause-core');
const {
  buildPreviewCacheTarget,
  buildPreviewCopyArgs,
  cleanupPreviewCache,
  clearPreviewCache,
} = require('./preview-cache-core');
const {
  buildRcloneConfigCreateArgs,
  buildRcloneConfigDeleteArgs,
  profileSetupSummary,
  redactProfileSetup,
} = require('./profile-core');
const { SerializedPersistenceWorker } = require('./persistence-queue');
const { createQuitCoordinator } = require('./quit-coordinator');
const { readSettings } = require('./settings');
const { coordinateSingleInstance } = require('./single-instance-core');
const { createQueueJob } = require('./renderer/explorer-ui-core');

let mainWindow;
let activeProcess = null;
let activeJobId = null;
let activeTransferState = null;
let activeHeartbeatTimer = null;
const cancellationLifecycle = new CancellationLifecycle();
const pauseLifecycle = new PauseLifecycle();
const transferLifecycle = new TransferLifecycle();
const transferDiagnosticsByJobId = new Map();
let persistence = null;
let quitCoordinator = null;
const activePauseRequests = new Map();
const rendererPauseAcks = new Map();
let rendererPauseRequestSequence = 0;
const profileMutationInterlock = new ProfileMutationInterlock();
const profileSetupAttempts = new Map();
const pendingConnectionImports = new Map();
let automationAuthStore = null;
let automationServer = null;
let automationServerError = '';

const APP_NAME = 'Murdawk Uplink';
const MURDAWK_URL = 'https://www.murdawkmedia.com';
const JOBS_DIR = path.resolve(__dirname, '..', '..', '.runs', 'jobs');
const LOGS_DIR = path.resolve(__dirname, '..', '..', '.runs', 'logs');
const MANIFESTS_DIR = path.resolve(__dirname, '..', '..', '.runs', 'manifests');

function createApplicationMenu() {
  const template = [
    {
      label: APP_NAME,
      submenu: [
        {
          label: `About ${APP_NAME}`,
          click: async () => {
            const result = await dialog.showMessageBox(mainWindow, {
              type: 'info',
              buttons: ['Close', 'Open Murdawk Media'],
              defaultId: 0,
              cancelId: 0,
              title: `About ${APP_NAME}`,
              message: APP_NAME,
              detail: [
                'A Murdawk Media project for resilient DigitalOcean Spaces transfers.',
                '',
                'This local edition uses the existing rclone profile on this Windows machine and never reads or displays credential secrets.',
                '',
                MURDAWK_URL,
              ].join('\n'),
              noLink: true,
            });
            if (result.response === 1) {
              await shell.openExternal(MURDAWK_URL);
            }
          },
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'togglefullscreen' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 880,
    minHeight: 620,
    title: APP_NAME,
    backgroundColor: '#08090d',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('close', (event) => {
    void quitCoordinator.handleWindowClose(event);
  });
}

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function getAutomationAccessPath() {
  return path.join(app.getPath('userData'), 'automation-access.json');
}

function getPreviewCacheDirectory() {
  return path.join(app.getPath('temp'), 'Murdawk Uplink', 'preview-cache');
}

function sendUploadEvent(eventName, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    let safePayload = payload;
    if (eventName === 'upload:log') {
      safePayload = { ...payload, text: redactLogText(payload?.text) };
    } else if (eventName === 'upload:error') {
      safePayload = {
        ...payload,
        message: redactLogText(payload?.message),
        stderr: redactLogText(payload?.stderr),
      };
    }
    mainWindow.webContents.send(eventName, safePayload);
  }
}

function activeTransferBaseSnapshot() {
  const lifecycle = transferLifecycle.snapshot();
  return {
    activeJobId: lifecycle.jobId || activeJobId || activeTransferState?.activeJobId || '',
    intentId: lifecycle.intentId || activeTransferState?.intentId || '',
    activePid: activeProcess?.pid || activeTransferState?.pid || 0,
    isRunning: lifecycle.isActive || Boolean(activeProcess),
    isLifecycleActive: lifecycle.isActive,
    phase: lifecycle.phase,
    terminalAction: lifecycle.terminalAction,
    cancelPending: lifecycle.cancelPending,
    cancelRequested: lifecycle.cancelRequested,
    pausePending: lifecycle.pausePending,
    pauseRequested: lifecycle.pauseRequested,
    hasChildProcess: Boolean(activeProcess),
    pid: activeTransferState?.pid || activeProcess?.pid || 0,
    source: activeTransferState?.source || '',
    sourceIndex: activeTransferState?.sourceIndex || 0,
    sourceTotal: activeTransferState?.sourceTotal || 0,
    mode: activeTransferState?.mode || '',
    startedAt: activeTransferState?.startedAt || '',
    lastOutputAt: activeTransferState?.lastOutputAt || '',
    lastProgressAt: activeTransferState?.lastProgressAt || '',
    currentFile: activeTransferState?.currentFile || '',
    transferred: activeTransferState?.transferred || '',
    total: activeTransferState?.total || '',
    percent: Number.isFinite(Number(activeTransferState?.percent)) ? Number(activeTransferState.percent) : 0,
    speed: activeTransferState?.speed || '',
    eta: activeTransferState?.eta || '',
    profile: lifecycle.profile || activeTransferState?.tuning || null,
  };
}

function refreshActiveTransferDiagnostics(status = 'running') {
  const lifecycle = transferLifecycle.snapshot();
  if (!activeTransferState && !activeJobId && !lifecycle.isActive) return null;
  const snapshot = activeTransferBaseSnapshot();
  const jobId = snapshot.activeJobId || activeJobId || '';
  const diagnostics = buildTransferDiagnostics({
    previous: jobId ? transferDiagnosticsByJobId.get(jobId) : null,
    status,
    transfer: snapshot,
    profile: lifecycle.profile || activeTransferState?.tuning || DEFAULT_PROFILE,
  });
  if (activeTransferState) {
    activeTransferState.diagnostics = diagnostics;
  }
  if (jobId) {
    transferDiagnosticsByJobId.set(jobId, diagnostics);
  }
  return diagnostics;
}

function activeTransferSnapshot() {
  const snapshot = activeTransferBaseSnapshot();
  const diagnostics = refreshActiveTransferDiagnostics('running');
  return {
    ...snapshot,
    diagnostics,
  };
}

function storedDiagnostics(jobId, status = 'running') {
  if (!jobId) return null;
  const previous = transferDiagnosticsByJobId.get(jobId);
  const lifecycle = transferLifecycle.snapshot();
  const diagnostics = buildTransferDiagnostics({
    previous,
    status,
    transfer: {
      ...(previous || {}),
      activeJobId: jobId,
      isRunning: Boolean(
        (activeProcess && activeJobId === jobId)
        || (lifecycle.isActive && lifecycle.jobId === jobId),
      ),
    },
    profile: previous?.tuning || DEFAULT_PROFILE,
  });
  transferDiagnosticsByJobId.set(jobId, diagnostics);
  return diagnostics;
}

async function persistActiveTransferSnapshot() {
  const snapshot = activeTransferSnapshot();
  if (!snapshot.activeJobId) return;
  try {
    await persistence.updateRunningJob(
      JOBS_DIR,
      snapshot.activeJobId,
      snapshot,
      snapshot.diagnostics,
    );
  } catch (error) {
    logJobEvent(snapshot.activeJobId, 'heartbeat:record-warning', { message: error.message });
  }
}

function emitActiveTransferHeartbeat() {
  if (!activeTransferState && !activeProcess && !transferLifecycle.snapshot().isActive) return;
  const snapshot = activeTransferSnapshot();
  void persistActiveTransferSnapshot();
  sendUploadEvent('upload:heartbeat', snapshot);
}

function startActiveTransferHeartbeat() {
  if (activeHeartbeatTimer) return;
  emitActiveTransferHeartbeat();
  activeHeartbeatTimer = setInterval(emitActiveTransferHeartbeat, 2000);
}

function stopActiveTransferHeartbeat() {
  if (!activeHeartbeatTimer) return;
  clearInterval(activeHeartbeatTimer);
  activeHeartbeatTimer = null;
}

function getLogPath(jobId) {
  assertValidJobId(jobId);
  return path.join(LOGS_DIR, `${jobId}.log`);
}

function appendJobLog(jobId, text) {
  if (!jobId || !text) return;
  appendRedactedLogFile(getLogPath(jobId), text);
}

function logJobEvent(jobId, label, payload = {}) {
  appendJobLog(jobId, `[${new Date().toISOString()}] ${label} ${redactLogText(payload)}\n`);
}

function readLogTail(logPath, maxChars = 200000) {
  const stat = fs.statSync(logPath);
  const start = Math.max(0, stat.size - maxChars);
  const handle = fs.openSync(logPath, 'r');
  try {
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(handle, buffer, 0, buffer.length, start);
    return {
      text: buffer.toString('utf8'),
      truncated: start > 0,
      size: stat.size,
      lastWriteTime: stat.mtime.toISOString(),
    };
  } finally {
    fs.closeSync(handle);
  }
}

function buildDiagnosticsText(jobId) {
  const logPath = getLogPath(jobId);
  const logTail = readLogTail(logPath);
  let record = null;
  try {
    record = readJobRecord(JOBS_DIR, jobId);
  } catch (_error) {
    record = null;
  }
  const active = activeTransferSnapshot();
  return redactLogText([
    'Murdawk Uplink diagnostics',
    `Job: ${jobId}`,
    `Record status: ${record?.status || 'unknown'}`,
    `Remote prefix: ${record?.prefix || ''}`,
    `Verified count: ${record?.verification?.verified?.length || 0}`,
    `Checksum mode: ${record?.checksum?.mode || record?.checksumMode || ''}`,
    `Active process: ${active.isRunning ? `rclone PID ${active.pid}` : 'none'}`,
    `Last output: ${active.lastOutputAt || record?.transferState?.lastOutputAt || ''}`,
    `Current file: ${active.currentFile || record?.transferState?.currentFile || ''}`,
    `Log bytes: ${logTail.size}`,
    `Log modified: ${logTail.lastWriteTime}`,
    logTail.truncated ? 'Log tail: truncated to latest 200000 characters' : 'Log tail: complete',
    '',
    logTail.text,
  ].join('\n'));
}

function listActivityRecords() {
  const records = readJobRecords(JOBS_DIR, Infinity);
  return summarizeActivityRecords(records.map((record) => ({
    ...record,
    hasLog: fs.existsSync(getLogPath(record.jobId)),
  }))).slice(0, 200);
}

function buildActivityResumeSettings(jobId) {
  const safeJobId = assertValidJobId(jobId);
  const records = readJobRecords(JOBS_DIR, Infinity);
  if (findSuccessfulResumeSupersessions(records).has(safeJobId)) {
    throw new Error('This transfer was completed by a resumed run and cannot be resumed again.');
  }
  const record = records.find((candidate) => candidate.jobId === safeJobId)
    || readJobRecord(JOBS_DIR, safeJobId);
  return buildResumeQueueSettings(record);
}

async function requestActiveTransferCancel(message = 'Transfer cancelled by user.') {
  const lifecycle = transferLifecycle.snapshot();
  if (!activeProcess && !lifecycle.isActive) {
    return { ok: false, message: 'No upload is running.' };
  }
  const jobId = lifecycle.jobId || activeJobId || activeTransferState?.activeJobId || '';
  const intentId = lifecycle.intentId || activeTransferState?.intentId || '';
  if (jobId) {
    logJobEvent(jobId, 'cancel:requested', { message });
    try {
      if (lifecycle.isActive && lifecycle.jobId === jobId) {
        await cancellationLifecycle.requestLifecycleCancellation({
          transferLifecycle,
          jobId,
          message,
          persistCancellation: () => persistence.cancelJob(
            JOBS_DIR,
            jobId,
            storedDiagnostics(jobId, 'cancelled'),
            message,
          ),
          getActiveProcess: () => activeProcess,
          getActiveJobId: () => activeJobId,
        });
      } else if (activeProcess && activeJobId === jobId) {
        await cancellationLifecycle.requestCancellation({
          jobId,
          message,
          persistCancellation: () => persistence.cancelJob(
            JOBS_DIR,
            jobId,
            storedDiagnostics(jobId, 'cancelled'),
            message,
          ),
          getActiveProcess: () => activeProcess,
          getActiveJobId: () => activeJobId,
        });
      } else {
        await persistence.cancelJob(
          JOBS_DIR,
          jobId,
          storedDiagnostics(jobId, 'cancelled'),
          message,
        );
      }
    } catch (error) {
      logJobEvent(jobId, 'cancel:record-warning', { message: error.message });
      throw error;
    }
  } else {
    activeProcess.kill();
  }
  sendUploadEvent('upload:cancelled', { jobId, intentId, message });
  return { ok: true, jobId };
}

function normalizePauseAssociation(request = {}) {
  return {
    clientJobId: String(request.clientJobId || '').trim(),
    intentId: String(request.intentId || '').trim(),
    jobId: String(request.jobId || '').trim(),
  };
}

function requestActiveTransferPause(request = {}) {
  const association = normalizePauseAssociation(request);
  const lifecycle = transferLifecycle.snapshot();
  const canonicalJobId = lifecycle.jobId || association.jobId;
  const existing = activePauseRequests.get(canonicalJobId);
  if (existing) return existing;

  const operation = (async () => {
    try {
      logJobEvent(canonicalJobId, 'pause:requested', association);
      await pauseLifecycle.requestLifecyclePause({
        transferLifecycle,
        association,
        persistPaused: () => persistence.pauseJob(
          JOBS_DIR,
          canonicalJobId,
          activeTransferBaseSnapshot(),
          storedDiagnostics(canonicalJobId, 'paused'),
        ),
        getActiveProcess: () => activeProcess,
        getActiveJobId: () => activeJobId,
        onTerminate: () => logJobEvent(canonicalJobId, 'pause:process-terminated'),
      });
      await transferLifecycle.waitForIdle(canonicalJobId);
      const payload = { ...association, jobId: canonicalJobId, message: 'Upload paused by user.' };
      logJobEvent(canonicalJobId, 'pause:settled', payload);
      sendUploadEvent('upload:paused', payload);
      return { ok: true, ...payload };
    } catch (error) {
      const snapshot = transferLifecycle.snapshot();
      sendUploadEvent('upload:pause-failed', {
        ...association,
        jobId: canonicalJobId,
        phase: snapshot.phase,
        terminalAction: snapshot.terminalAction,
        pausePending: snapshot.pausePending,
        pauseRequested: snapshot.pauseRequested,
        message: error.message,
      });
      throw error;
    }
  })().finally(() => {
    if (activePauseRequests.get(canonicalJobId) === operation) {
      activePauseRequests.delete(canonicalJobId);
    }
  });
  activePauseRequests.set(canonicalJobId, operation);
  return operation;
}

function requestRendererPausePreparation(transfer = {}) {
  const requestId = `pause-close-${Date.now()}-${++rendererPauseRequestSequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      rendererPauseAcks.delete(requestId);
      reject(new Error('The upload queue did not acknowledge pause persistence.'));
    }, 30000);
    rendererPauseAcks.set(requestId, {
      resolve: (association) => {
        clearTimeout(timer);
        resolve(association);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    if (!mainWindow || mainWindow.isDestroyed()) {
      clearTimeout(timer);
      rendererPauseAcks.delete(requestId);
      reject(new Error('The upload window is unavailable for pause persistence.'));
      return;
    }
    mainWindow.webContents.send('before-pause-close', {
      requestId,
      activeTransfer: transfer,
    });
  });
}

async function waitForTransferLifecycleContinuation(jobId) {
  if (!jobId) return true;
  await cancellationLifecycle.waitForLifecycleContinuation({ transferLifecycle, jobId });
  await pauseLifecycle.waitForLifecycleContinuation({ transferLifecycle, jobId });
  return true;
}

async function transferLifecycleCancellationError(jobId) {
  if (!jobId) return null;
  return cancellationLifecycle.lifecycleCancellationError({ transferLifecycle, jobId });
}

async function transferLifecycleInterruptionError(jobId) {
  const cancellation = await transferLifecycleCancellationError(jobId);
  if (cancellation) return cancellation;
  return pauseLifecycle.lifecyclePauseError({ transferLifecycle, jobId });
}

async function runRclone(args, {
  jobId,
  intentId = '',
  source,
  sourceIndex = 0,
  sourceTotal = 0,
  mode,
  profile = DEFAULT_PROFILE,
  redactPaths = [],
} = {}) {
  await waitForTransferLifecycleContinuation(jobId);
  cancellationLifecycle.assertProcessStartAllowed();
  pauseLifecycle.assertProcessStartAllowed();
  return new Promise((resolve, reject) => {
    const child = spawnTransferProcess({
      spawnProcess: spawn,
      args,
      options: {
        windowsHide: true,
        shell: false,
      },
      activeProcess,
      activeJobId,
      requestedJobId: jobId,
    });

    activeProcess = child;
    activeJobId = jobId;
    activeTransferState = {
      activeJobId: jobId || '',
      intentId,
      pid: child.pid || 0,
      source: source || '',
      sourceIndex,
      sourceTotal,
      mode: mode || '',
      startedAt: new Date().toISOString(),
      lastOutputAt: new Date().toISOString(),
      lastProgressAt: '',
      currentFile: '',
      transferred: '',
      total: '',
      percent: 0,
      speed: '',
      eta: '',
      tuning: normalizeProfile(profile),
      diagnostics: null,
    };
    refreshActiveTransferDiagnostics('running');
    startActiveTransferHeartbeat();

    let stdout = '';
    let stderr = '';
    let settlementStarted = false;

    function handleSafeOutput(stream, text) {
      if (!text) return;
      if (stream === 'stdout') stdout += text;
      else stderr += text;
      if (activeTransferState?.activeJobId === jobId) {
        activeTransferState.lastOutputAt = new Date().toISOString();
      }
      appendJobLog(jobId, text);
      sendUploadEvent('upload:log', { jobId, intentId, source, mode, stream, text });
      const progress = parseRcloneProgress(text);
      if (!progress) return;
      if (activeTransferState?.activeJobId === jobId) {
        activeTransferState.lastProgressAt = new Date().toISOString();
        activeTransferState.currentFile = progress.currentFile || activeTransferState.currentFile;
        activeTransferState.transferred = progress.transferred || activeTransferState.transferred;
        activeTransferState.total = progress.total || activeTransferState.total;
        activeTransferState.percent = progress.percent ?? activeTransferState.percent;
        activeTransferState.speed = progress.speed || activeTransferState.speed;
        activeTransferState.eta = progress.eta || activeTransferState.eta;
      }
      const diagnostics = refreshActiveTransferDiagnostics('running');
      sendUploadEvent('upload:progress', { jobId, intentId, source, sourceIndex, sourceTotal, mode, ...progress, diagnostics });
    }

    const childLogs = createChildLogCoordinator({
      transformBeforeRedaction: (text) => redactRuntimePaths(text, redactPaths),
      onSafeText: handleSafeOutput,
    });

    child.stdout.on('data', (chunk) => {
      childLogs.push('stdout', chunk.toString());
    });

    child.stderr.on('data', (chunk) => {
      childLogs.push('stderr', chunk.toString());
    });

    async function settleChild(result) {
      if (settlementStarted) return;
      settlementStarted = true;
      if (activeProcess === child) {
        activeProcess = null;
        activeJobId = null;
        activeTransferState = null;
        if (!transferLifecycle.snapshot().isActive) stopActiveTransferHeartbeat();
      }

      const paused = await pauseLifecycle.classifyChildResult(jobId, result);
      if (paused.paused) {
        const error = paused.error || new Error(paused.message);
        error.message = paused.message;
        error.code = paused.code ?? error.code;
        error.stdout = stdout;
        error.stderr = stderr;
        error.paused = true;
        error.terminalPersisted = true;
        reject(error);
        return;
      }
      const classified = await cancellationLifecycle.classifyChildResult(jobId, paused);
      if (classified.cancelled) {
        const error = classified.error || new Error(classified.message);
        error.message = classified.message;
        error.code = classified.code ?? error.code;
        error.stdout = stdout;
        error.stderr = stderr;
        error.cancelled = true;
        reject(error);
        return;
      }
      if (classified.error) {
        reject(classified.error);
        return;
      }
      if (classified.code === 0) {
        resolve({ stdout, stderr });
      } else {
        const error = new Error(`rclone exited with code ${classified.code}`);
        error.code = classified.code;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    }

    child.on('error', (error) => {
      childLogs.noteError(error);
    });

    child.on('close', (code) => {
      const result = childLogs.close(code);
      if (result) void settleChild(result);
    });
  });
}

async function runRcloneOnce(args, {
  jobId = '',
  intentId = '',
  mode = 'precheck',
  profile = DEFAULT_PROFILE,
} = {}) {
  if (jobId) return runRclone(args, { jobId, intentId, mode, profile });
  return new Promise((resolve, reject) => {
    const child = spawn('rclone', args, { windowsHide: true, shell: false });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const error = new Error(`rclone exited with code ${code}`);
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}

async function hashRemoteObject(remotePath, { jobId = '' } = {}) {
  await waitForTransferLifecycleContinuation(jobId);
  return new Promise((resolve, reject) => {
    const child = spawn('rclone', ['cat', remotePath], { windowsHide: true, shell: false });
    const hash = crypto.createHash('sha256');
    let stderr = '';

    child.stdout.on('data', (chunk) => hash.update(chunk));
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(hash.digest('hex'));
      } else {
        reject(new Error(`rclone cat exited with code ${code}: ${stderr.trim()}`));
      }
    });
  });
}

function localPathForEntry(source, entryName, folderUploadMode = 'package') {
  const stat = fs.statSync(source);
  if (stat.isFile()) {
    return source;
  }
  let localEntryName = entryName;
  if (folderUploadMode === 'package') {
    const rootName = path.basename(source);
    if (localEntryName === rootName || localEntryName.startsWith(`${rootName}/`)) {
      localEntryName = localEntryName.slice(rootName.length).replace(/^\/+/, '');
    }
  }
  return path.join(source, localEntryName.replace(/\//g, path.sep));
}

async function buildChecksumReport({
  sources,
  prefix,
  localEntries,
  include,
  filterMode,
  folderUploadMode,
  mode,
  profile,
  jobId = '',
}) {
  const checksumMode = normalizeChecksumMode(mode);
  const activeProfile = normalizeProfile(profile);
  if (checksumMode === 'size') {
    return skippedChecksumReport('size');
  }

  const checksumEntries = [];
  if (localEntries.length && localEntries.every((entry) => entry.localPath)) {
    for (const entry of localEntries) {
      const remoteKey = [prefix, entry.name].filter(Boolean).join('/');
      checksumEntries.push({
        name: entry.name,
        localSha256: await computeFileSha256(entry.localPath),
        remoteSha256: await hashRemoteObject(
          buildRemotePath(remoteKey, activeProfile, { trailingSlash: false }),
          { jobId },
        ),
      });
    }
    return compareChecksumEntries(checksumEntries);
  }
  for (const source of sources) {
    const sourceEntries = collectLocalUploadEntries(source, include, filterMode, { folderUploadMode });
    for (const entry of sourceEntries) {
      if (!localEntries.some((local) => local.name === entry.name)) continue;
      const localPath = localPathForEntry(source, entry.name, folderUploadMode);
      const remoteKey = [prefix, entry.name].filter(Boolean).join('/');
      checksumEntries.push({
        name: entry.name,
        localSha256: await computeFileSha256(localPath),
        remoteSha256: await hashRemoteObject(
          buildRemotePath(remoteKey, activeProfile, { trailingSlash: false }),
          { jobId },
        ),
      });
    }
  }
  return compareChecksumEntries(checksumEntries);
}

async function listRemoteFolder(prefix = '', profile = DEFAULT_PROFILE) {
  const activeProfile = normalizeProfile(profile);
  await assertReady(activeProfile);
  const listing = await runRcloneOnce(buildExplorerListArgs({ prefix, profile: activeProfile }));
  return {
    prefix: normalizeExplorerPath(prefix || ''),
    entries: parseExplorerEntries({
      prefix,
      profile: activeProfile,
      rawEntries: JSON.parse(listing.stdout || '[]'),
    }),
  };
}

async function confirmRemoteOperation({ action, item, targetPrefix }) {
  const itemLabel = item?.path || item?.name || 'selected item';
  const actionLabel = action === 'rename' ? 'rename/move' : action;
  const isDelete = action === 'delete';

  const result = await dialog.showMessageBox(mainWindow, {
    type: isDelete ? 'error' : 'warning',
    buttons: isDelete ? ['Cancel', 'DELETE PERMANENTLY'] : ['Cancel', `Confirm ${actionLabel}`],
    defaultId: 0,
    cancelId: 0,
    title: isDelete ? 'RED ZONE: Permanent Delete' : `Confirm ${actionLabel}`,
    message: isDelete
      ? 'RED ZONE: This permanently deletes from DigitalOcean Spaces.'
      : `Confirm ${actionLabel} on DigitalOcean Spaces`,
    detail: isDelete
      ? `Target: ${itemLabel}\n\nThis is not Windows Recycle Bin. This removes object data from the media Space. Only continue if you are certain.`
      : `Source: ${itemLabel}\nTarget: ${targetPrefix || '(none)'}\n\nThis will change objects in the media Space.`,
    noLink: true,
  });

  return result.response === 1;
}

async function confirmRemoteOperations(operations = []) {
  if (operations.length === 1) {
    return confirmRemoteOperation(operations[0]);
  }

  const action = operations[0]?.action || 'move';
  const actionLabel = action === 'rename' ? 'rename/move' : action;
  const sourceLines = operations
    .slice(0, 8)
    .map((operation) => {
      const source = operation.item?.path || operation.item?.name || 'selected item';
      return `- ${source} -> ${operation.targetPrefix || '(none)'}`;
    });
  const remaining = operations.length > sourceLines.length
    ? `\n...and ${operations.length - sourceLines.length} more.`
    : '';

  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Cancel', `Move ${operations.length} items`],
    defaultId: 0,
    cancelId: 0,
    title: `Confirm ${actionLabel} batch`,
    message: `Confirm ${actionLabel} for ${operations.length} selected items`,
    detail: `${sourceLines.join('\n')}${remaining}\n\nThis will change objects in the media Space.`,
    noLink: true,
  });

  return result.response === 1;
}

async function executeRemoteOperation({ action, item, targetPrefix, profile }) {
  if (!item || !item.path || !action) {
    throw new Error('Remote operation requires an action and selected item.');
  }

  const args = buildRemoteOperationArgs({
    action,
    sourcePrefix: item.path,
    targetPrefix,
    isDir: item.isDir,
    profile: normalizeProfile(profile),
  });
  const jobId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  sendUploadEvent('upload:log', {
    jobId,
    mode: 'remote-op',
    stream: 'stdout',
    text: `rclone ${args.join(' ')}\n`,
  });
  await runRclone(args, { jobId, source: item.path, mode: 'remote-op' });
  return { ok: true };
}

async function runRemoteOperation(request = {}) {
  const profile = normalizeProfile(request.profile);
  await assertReady(profile);
  const { action, item, targetPrefix } = request;
  if (action === 'mkdir') {
    const target = normalizeExplorerPath(targetPrefix || '');
    if (!target) {
      throw new Error('New folder requires a remote placeholder path.');
    }
    const args = buildTouchArgs({ prefix: target, profile });
    const jobId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    logJobEvent(jobId, 'remote-mkdir:start', { target });
    sendUploadEvent('upload:log', {
      jobId,
      mode: 'remote-op',
      stream: 'stdout',
      text: `rclone ${args.join(' ')}\n`,
    });
    await runRclone(args, { jobId, source: target, mode: 'remote-op' });
    logJobEvent(jobId, 'remote-mkdir:complete', { target });
    return { ok: true };
  }

  const confirmed = await confirmRemoteOperation({ action, item, targetPrefix });
  if (!confirmed) {
    return { ok: false, cancelled: true };
  }

  return executeRemoteOperation({ action, item, targetPrefix, profile });
}

async function runRemoteOperations(requests = []) {
  const profile = normalizeProfile(requests[0]?.profile);
  await assertReady(profile);
  const operations = Array.isArray(requests)
    ? requests.filter((request) => request && request.action && request.item?.path)
    : [];
  if (!operations.length) {
    throw new Error('Remote batch operation requires at least one selected item.');
  }
  if (operations.some((operation) => operation.action === 'delete')) {
    throw new Error('Delete is intentionally single-confirm only.');
  }

  const confirmed = await confirmRemoteOperations(operations);
  if (!confirmed) {
    return { ok: false, cancelled: true };
  }

  const results = [];
  for (const operation of operations) {
    results.push(await executeRemoteOperation({ ...operation, profile: operation.profile || profile }));
  }
  return { ok: true, results };
}

async function assertReady(profile = DEFAULT_PROFILE, { jobId = '' } = {}) {
  const activeProfile = normalizeProfile(profile);
  try {
    await runRcloneOnce(['version'], { jobId, profile: activeProfile });
  } catch (error) {
    throw new Error('rclone is not available on PATH. Install it with: winget install Rclone.Rclone');
  }

  const remotes = await runRcloneOnce(['listremotes'], { jobId, profile: activeProfile });
  if (!remotes.stdout.split(/\r?\n/).includes(`${activeProfile.remote}:`)) {
    throw new Error(`The rclone remote "${activeProfile.remote}" is not configured.`);
  }

  return {
    remote: activeProfile.remote,
    bucket: activeProfile.bucket,
    endpointHost: activeProfile.endpointHost,
  };
}

function normalizeUploadRequest(request = {}) {
  const sources = Array.isArray(request.sources)
    ? request.sources.filter((source) => typeof source === 'string' && source.trim())
    : [];

  if (!sources.length) {
    throw new Error('Choose at least one file or folder to upload.');
  }

  const filterMode = normalizeFilterMode(request.filterMode || DEFAULT_PROFILE.defaultFilterMode);
  const requestedProfile = normalizeProfile(request.profileSnapshot || request.profile);
  const identity = bindMainTransferIdentity(
    {
      connectionId: request.connectionId,
      profile: requestedProfile,
      profileSnapshot: requestedProfile,
    },
    readSettings(getSettingsPath()).connections,
  );

  return {
    intentId: String(request.intentId || request.clientJobId || '').trim(),
    resumeFromJobId: String(request.resumeFromJobId || '').trim().slice(0, 256),
    sources,
    connectionId: identity.connectionId,
    profile: identity.profile,
    profileSnapshot: identity.profileSnapshot,
    prefix: normalizePrefix(request.prefix),
    include: request.include || DEFAULT_PROFILE.defaultInclude,
    filterMode,
    publicRead: request.publicRead !== false,
    checksum: normalizeChecksumMode(request.checksum || 'sha256'),
    folderUploadMode: normalizeFolderUploadMode(request.folderUploadMode || 'package'),
    notifications: {
      webhook: typeof request.notifyWebhook === 'string' ? request.notifyWebhook.trim() : '',
      ntfy: typeof request.notifyNtfy === 'string' ? request.notifyNtfy.trim() : '',
      notifyOn: ['success', 'failure', 'always'].includes(request.notifyOn)
        ? request.notifyOn
        : 'success',
    },
  };
}

function previewFailure(error) {
  if (error?.code === 'EPREVIEWSIZE') {
    return {
      ok: false,
      code: error.code,
      message: 'This image is larger than 50 MB. Download it to view.',
    };
  }
  return {
    ok: false,
    code: error?.code || 'EPREVIEWUNAVAILABLE',
    message: 'Preview unavailable. You can still download this file.',
  };
}

async function prepareImagePreview(request = {}) {
  let target;
  try {
    const requestedProfile = normalizeProfile(request.profileSnapshot || request.profile);
    const identity = bindMainTransferIdentity(
      {
        connectionId: request.connectionId,
        profile: requestedProfile,
        profileSnapshot: requestedProfile,
      },
      readSettings(getSettingsPath()).connections,
    );
    target = buildPreviewCacheTarget(getPreviewCacheDirectory(), {
      connectionId: identity.connectionId,
      profile: identity.profile,
      item: request.item,
    });
    fs.mkdirSync(path.dirname(target.cachePath), { recursive: true });

    try {
      const cached = fs.statSync(target.cachePath);
      if (cached.isFile() && Number(cached.size) === Number(target.item.size)) {
        return {
          ok: true,
          cached: true,
          url: pathToFileURL(target.cachePath).href,
          name: target.item.name,
          format: target.format,
          size: target.item.size,
        };
      }
      fs.rmSync(target.cachePath, { force: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    await assertReady(identity.profile);
    await runRcloneOnce(buildPreviewCopyArgs(target), {
      mode: 'preview',
      profile: identity.profile,
    });
    const downloaded = fs.statSync(target.cachePath);
    if (!downloaded.isFile() || Number(downloaded.size) !== Number(target.item.size)) {
      fs.rmSync(target.cachePath, { force: true });
      throw Object.assign(new Error('Preview cache verification failed.'), { code: 'EPREVIEWVERIFY' });
    }
    return {
      ok: true,
      cached: false,
      url: pathToFileURL(target.cachePath).href,
      name: target.item.name,
      format: target.format,
      size: target.item.size,
    };
  } catch (error) {
    if (target?.cachePath) {
      try {
        fs.rmSync(target.cachePath, { force: true });
      } catch (_cleanupError) {
        // Cache cleanup is best effort and never changes remote data.
      }
    }
    return previewFailure(error);
  }
}

function normalizeDownloadRequest(request = {}) {
  const remoteItems = normalizeDownloadSelection(request.remoteItems);
  const localDestination = normalizeLocalDestination(request.localDestination);
  const requestedProfile = normalizeProfile(request.profileSnapshot || request.profile);
  const identity = bindMainTransferIdentity(
    {
      connectionId: request.connectionId,
      profile: requestedProfile,
      profileSnapshot: requestedProfile,
    },
    readSettings(getSettingsPath()).connections,
  );

  return {
    intentId: String(request.intentId || request.clientJobId || '').trim(),
    resumeFromJobId: String(request.resumeFromJobId || '').trim().slice(0, 256),
    sources: remoteItems.map((item) => item.path),
    remoteItems,
    localDestination,
    connectionId: identity.connectionId,
    profile: identity.profile,
    profileSnapshot: identity.profileSnapshot,
    prefix: normalizePrefix(request.prefix),
  };
}

async function runUploadRequest(request, { dryRun }) {
  if (profileSetupAttempts.size) {
    const error = new Error('A new connection is still being saved. Try the transfer again in a moment.');
    error.code = 'EPROFILEMUTATION';
    error.retryable = true;
    throw error;
  }
  const releaseTransferClaim = profileMutationInterlock.beginTransfer();
  try {
    const normalized = normalizeUploadRequest(request);
    const jobId = createJobId(dryRun ? 'dryrun' : 'upload');
    const job = buildJobRecord({
      jobId,
      intentId: normalized.intentId,
      resumeFromJobId: normalized.resumeFromJobId,
      sources: normalized.sources,
      prefix: normalized.prefix,
      include: normalized.include,
      filterMode: normalized.filterMode,
      folderUploadMode: normalized.folderUploadMode,
      publicRead: normalized.publicRead,
      checksumMode: normalized.checksum,
      connectionId: normalized.connectionId,
      profile: normalized.profile,
      profileSnapshot: normalized.profileSnapshot,
      notifications: normalized.notifications,
      status: 'created',
    });
    return await runDurableLifecycle({
      persistInitial: () => persistence.writeJobRecord(JOBS_DIR, job),
      begin: () => {
        transferLifecycle.begin({
          jobId,
          intentId: normalized.intentId,
          profile: normalized.profile,
          phase: 'prechecking',
        });
        startActiveTransferHeartbeat();
      },
      prepare: async () => null,
      cancellationError: () => transferLifecycleInterruptionError(jobId),
      execute: () => runUploadLifecycle(normalized, { dryRun, jobId, job }),
      persistTerminal: (error) => persistPreparingLifecycleTerminal(job, error),
      finish: () => {
        transferLifecycle.finish(jobId);
        if (!activeProcess) stopActiveTransferHeartbeat();
      },
    });
  } finally {
    releaseTransferClaim();
  }
}

async function runDownloadRequest(request, { dryRun }) {
  if (profileSetupAttempts.size) {
    const error = new Error('A new connection is still being saved. Try the transfer again in a moment.');
    error.code = 'EPROFILEMUTATION';
    error.retryable = true;
    throw error;
  }
  const releaseTransferClaim = profileMutationInterlock.beginTransfer();
  try {
    const normalized = normalizeDownloadRequest(request);
    const jobId = createJobId(dryRun ? 'download-check' : 'download');
    const job = buildJobRecord({
      jobId,
      intentId: normalized.intentId,
      resumeFromJobId: normalized.resumeFromJobId,
      sources: normalized.sources,
      prefix: normalized.prefix,
      connectionId: normalized.connectionId,
      profile: normalized.profile,
      profileSnapshot: normalized.profileSnapshot,
      status: 'created',
      direction: 'download',
      localDestination: normalized.localDestination,
      remoteItems: normalized.remoteItems,
    });
    return await runDurableLifecycle({
      persistInitial: () => persistence.writeJobRecord(JOBS_DIR, job),
      begin: () => {
        transferLifecycle.begin({
          jobId,
          intentId: normalized.intentId,
          profile: normalized.profile,
          phase: 'prechecking',
        });
        startActiveTransferHeartbeat();
      },
      prepare: async () => null,
      cancellationError: () => transferLifecycleInterruptionError(jobId),
      execute: () => runDownloadLifecycle(normalized, { dryRun, jobId, job }, {
        assertReady,
        emit: sendUploadEvent,
        getDiagnostics: storedDiagnostics,
        runRclone,
        statSync: fs.statSync,
        updatePhase: (phase) => transferLifecycle.update(jobId, { phase }),
        waitForContinuation: waitForTransferLifecycleContinuation,
        writeJobRecord: (record) => persistence.writeJobRecord(JOBS_DIR, record),
      }),
      persistTerminal: (error) => persistPreparingLifecycleTerminal(job, error),
      finish: () => {
        transferLifecycle.finish(jobId);
        if (!activeProcess) stopActiveTransferHeartbeat();
      },
    });
  } finally {
    releaseTransferClaim();
  }
}

async function persistPreparingLifecycleTerminal(job, error) {
  if (error.code === 'ETRANSFERACTIVE') {
    error.externalLifecycle = true;
    await persistence.writeJobRecord(JOBS_DIR, buildJobRecord({
      ...job,
      status: 'created',
      error: 'Waiting for another transfer lifecycle to finish.',
    }));
    return;
  }
  transferLifecycle.update(job.jobId, { phase: 'persisting' });
  if (error.paused) return;
  if (error.cancelled) {
    await persistence.writeJobRecord(JOBS_DIR, buildCancelledJobRecord({
      ...job,
      diagnostics: storedDiagnostics(job.jobId, 'cancelled'),
    }, error.message));
    sendUploadEvent('upload:cancelled', {
      jobId: job.jobId,
      intentId: job.intentId,
      message: error.message,
    });
    return;
  }
  await persistence.writeJobRecord(JOBS_DIR, buildJobRecord({
    ...job,
    status: 'failed',
    completedAt: new Date().toISOString(),
    error: error.message,
    diagnostics: storedDiagnostics(job.jobId, 'failed'),
  }));
  sendUploadEvent('upload:error', {
    jobId: job.jobId,
    intentId: job.intentId,
    message: error.message,
    stderr: error.stderr || '',
    verification: null,
    checksum: null,
  });
}

async function runUploadLifecycle(normalized, { dryRun, jobId, job }) {
  await waitForTransferLifecycleContinuation(jobId);
  const credentialScan = inspectUploadSourcesForCredentialLikePaths(normalized.sources);
  if (!credentialScan.ok) {
    const first = credentialScan.blocked[0];
    const error = new Error(
      `Blocked credential-like local path: ${first?.path || 'unknown path'}. ${first?.reason || ''}`.trim(),
    );
    error.blocked = true;
    error.blockedPaths = credentialScan.blocked.map((item) => item.path);
    throw error;
  }
  const sourcePlans = [];
  for (const source of normalized.sources) {
    await waitForTransferLifecycleContinuation(jobId);
    sourcePlans.push(collectLocalUploadSourcePlan(source, normalized.include, normalized.filterMode, {
      folderUploadMode: normalized.folderUploadMode,
    }));
  }
  const blockedEntry = sourcePlans
    .flatMap((plan) => [...plan.entries, ...plan.placeholderEntries])
    .find((entry) => credentialLikeEventPathReason(entry.relativePath));
  if (blockedEntry) {
    const error = new Error(
      `Blocked credential-like local path discovered during frozen upload planning: ${blockedEntry.relativePath}`,
    );
    error.blocked = true;
    throw error;
  }
  const localEntries = sourcePlans.flatMap((plan) => [...plan.entries, ...plan.placeholderEntries]);
  const localNames = localEntries.map((entry) => entry.name);
  if (!localEntries.length) {
    const error = new Error('No local files matched the active upload filter.');
    error.blocked = true;
    throw error;
  }
  await waitForTransferLifecycleContinuation(jobId);
  await assertReady(normalized.profile, { jobId });
  await waitForTransferLifecycleContinuation(jobId);
  const activePlans = sourcePlans.filter((plan) => plan.entries.length || plan.placeholderEntries.length);
  const uploadedRoots = activePlans.map((plan) => ({
    source: plan.source,
    rootPrefix: sourceDestinationPrefix(
      plan.source,
      normalized.prefix,
      normalized.folderUploadMode,
      plan.isDirectory,
    ),
  }));
  const remoteListing = await runRcloneOnce(
    buildJsonListArgs({ prefix: normalized.prefix, profile: normalized.profile }),
    { jobId },
  );
  await waitForTransferLifecycleContinuation(jobId);
  await persistence.writeJobRecord(JOBS_DIR, buildJobRecord({
    ...job,
    status: dryRun ? 'dry-run' : 'running',
  }));
  const preflightRemoteEntries = JSON.parse(remoteListing.stdout || '[]');
  const remoteNames = new Set(
    preflightRemoteEntries
      .map((entry) => String(entry.Path || entry.Name || '').replace(/\\/g, '/'))
      .filter(Boolean),
  );
  const existing = localNames.filter((name) => remoteNames.has(name));
  const missing = localNames.filter((name) => !remoteNames.has(name));

  sendUploadEvent('upload:preflight', {
    jobId,
    intentId: normalized.intentId,
    localCount: localNames.length,
    existing,
    missing,
  });

  sendUploadEvent('upload:start', {
    jobId,
    intentId: normalized.intentId,
    mode: dryRun ? 'dry-run' : 'upload',
    sources: normalized.sources,
  });

  try {
    transferLifecycle.update(jobId, { phase: dryRun ? 'prechecking' : 'uploading' });
    for (let index = 0; index < activePlans.length; index += 1) {
      await waitForTransferLifecycleContinuation(jobId);
      const plan = activePlans[index];
      const source = plan.source;
      const sourceIndex = index + 1;
      const sourceTotal = activePlans.length;
      sendUploadEvent('upload:source-start', {
        jobId,
        intentId: normalized.intentId,
        source,
        sourceIndex,
        sourceTotal,
        mode: dryRun ? 'dry-run' : 'upload',
      });
      const runFrozenSource = (filesFromRawPath = '') => runRclone(
        buildCopyArgs({
          source,
          prefix: normalized.prefix,
          include: normalized.include,
          filterMode: normalized.filterMode,
          publicRead: normalized.publicRead,
          folderUploadMode: normalized.folderUploadMode,
          dryRun,
          profile: normalized.profile,
          filesFromRawPath,
          sourceIsDirectory: plan.isDirectory,
        }),
        {
          jobId,
          intentId: normalized.intentId,
          source,
          sourceIndex,
          sourceTotal,
          mode: dryRun ? 'dry-run' : 'upload',
          profile: normalized.profile,
          redactPaths: filesFromRawPath ? [filesFromRawPath] : [],
        },
      );
      if (plan.isDirectory && plan.entries.length) {
        await withFrozenDirectoryManifest({
          manifestDirectory: MANIFESTS_DIR,
          relativePaths: plan.entries.map((entry) => entry.relativePath),
        }, runFrozenSource);
      } else if (!plan.isDirectory) {
        await runFrozenSource();
      }
      for (const placeholder of plan.placeholderEntries) {
        await waitForTransferLifecycleContinuation(jobId);
        if (remoteNames.has(placeholder.name)) continue;
        await runRclone(buildTouchArgs({
          prefix: [normalized.prefix, placeholder.name].filter(Boolean).join('/'),
          profile: normalized.profile,
          publicRead: normalized.publicRead,
          dryRun,
        }), {
          jobId,
          intentId: normalized.intentId,
          source,
          sourceIndex,
          sourceTotal,
          mode: dryRun ? 'dry-run' : 'upload',
          profile: normalized.profile,
        });
      }
      sendUploadEvent('upload:source-complete', {
        jobId,
        intentId: normalized.intentId,
        source,
        sourceIndex,
        sourceTotal,
        mode: dryRun ? 'dry-run' : 'upload',
      });
    }

    let urls = [];
    let verification = null;
    let checksum = null;
    if (!dryRun) {
      transferLifecycle.update(jobId, { phase: 'verifying' });
      const jsonListing = await runRcloneOnce(
        buildJsonListArgs({ prefix: normalized.prefix, profile: normalized.profile }),
        { jobId, intentId: normalized.intentId, mode: 'verify', profile: normalized.profile },
      );
      await waitForTransferLifecycleContinuation(jobId);
      verification = buildVerificationReport({
        localEntries,
        remoteEntries: JSON.parse(jsonListing.stdout || '[]'),
        expectedSourceCount: normalized.sources.length,
        existingRemoteNames: [...remoteNames],
      });
      checksum = await buildChecksumReport({
        sources: normalized.sources,
        prefix: normalized.prefix,
        localEntries,
        include: normalized.include,
        filterMode: normalized.filterMode,
        mode: normalized.checksum,
        folderUploadMode: normalized.folderUploadMode,
        profile: normalized.profile,
        jobId,
      });
      await waitForTransferLifecycleContinuation(jobId);
      sendUploadEvent('upload:verified', { jobId, intentId: normalized.intentId, verification });
      sendUploadEvent('upload:checksum', { jobId, intentId: normalized.intentId, checksum });
      if (!verification.ok || !checksum.ok) {
        const message = [
          'Upload finished but remote verification failed.',
          `Verified: ${verification.verified.length}`,
          `Missing: ${verification.missing.length}`,
          `Size mismatches: ${verification.sizeMismatch.length}`,
          `Unexpected: ${verification.unexpected?.length || 0}`,
          `Checksum mismatches: ${checksum.mismatched?.length || 0}`,
        ].join(' ');
        const error = new Error(message);
        error.verification = verification;
        error.checksum = checksum;
        throw error;
      }
      urls = verification.verified.map((entry) =>
        buildPublicUrl({ prefix: normalized.prefix, fileName: entry.name, profile: normalized.profile }));
      const completedAt = new Date().toISOString();
      const baseRecord = buildJobRecord({
        ...job,
        status: 'complete',
        completedAt,
        verification,
        checksum,
        urls,
        diagnostics: storedDiagnostics(jobId, 'complete'),
      });
      const notificationPayload = buildNotificationPayload({
        job: baseRecord,
        status: 'complete',
        verification,
        checksum,
        urls,
      });
      transferLifecycle.update(jobId, { phase: 'notifying' });
      const notificationAttempts = await sendNotifications({
        notifications: normalized.notifications,
        payload: notificationPayload,
      });
      await waitForTransferLifecycleContinuation(jobId);
      const finalRecord = buildJobRecord({
        ...baseRecord,
        status: notificationAttempts.some((attempt) => !attempt.ok) ? 'warning' : 'complete',
        notificationAttempts,
        diagnostics: storedDiagnostics(jobId, 'complete'),
      });
      transferLifecycle.update(jobId, { phase: 'persisting' });
      await persistence.writeJobRecord(JOBS_DIR, finalRecord);
      sendUploadEvent('upload:notifications', { jobId, intentId: normalized.intentId, notifications: notificationAttempts });
    } else {
      transferLifecycle.update(jobId, { phase: 'persisting' });
      await persistence.writeJobRecord(JOBS_DIR, buildJobRecord({
        ...job,
        status: 'ready',
        completedAt: new Date().toISOString(),
        diagnostics: storedDiagnostics(jobId, 'complete'),
      }));
    }

    sendUploadEvent('upload:complete', {
      jobId,
      intentId: normalized.intentId,
      dryRun,
      urls,
      verification,
      checksum,
      uploadedRoots,
    });
    return { ok: true, jobId, intentId: normalized.intentId, dryRun, urls, verification, checksum, uploadedRoots };
  } catch (error) {
    let verification = null;
    let checksum = null;
    if (error.paused) throw error;
    if (error.cancelled) {
      const cancelledRecord = buildCancelledJobRecord({
        ...job,
        verification,
        checksum,
        diagnostics: storedDiagnostics(jobId, 'cancelled'),
      }, error.message);
      transferLifecycle.update(jobId, { phase: 'persisting' });
      await persistence.writeJobRecord(JOBS_DIR, cancelledRecord);
      sendUploadEvent('upload:cancelled', { jobId, intentId: normalized.intentId, message: error.message });
      error.terminalPersisted = true;
      throw error;
    }
    if (!dryRun) {
      try {
        transferLifecycle.update(jobId, { phase: 'verifying' });
        const jsonListing = await runRcloneOnce(
          buildJsonListArgs({ prefix: normalized.prefix, profile: normalized.profile }),
          { jobId, intentId: normalized.intentId, mode: 'verify', profile: normalized.profile },
        );
        await waitForTransferLifecycleContinuation(jobId);
        verification = buildVerificationReport({
          localEntries,
          remoteEntries: JSON.parse(jsonListing.stdout || '[]'),
          expectedSourceCount: normalized.sources.length,
          existingRemoteNames: [...remoteNames],
        });
        checksum = await buildChecksumReport({
          sources: normalized.sources,
          prefix: normalized.prefix,
          localEntries,
          include: normalized.include,
          filterMode: normalized.filterMode,
          mode: normalized.checksum,
          folderUploadMode: normalized.folderUploadMode,
          profile: normalized.profile,
          jobId,
        });
        await waitForTransferLifecycleContinuation(jobId);
        sendUploadEvent('upload:verified', { jobId, intentId: normalized.intentId, verification });
        sendUploadEvent('upload:checksum', { jobId, intentId: normalized.intentId, checksum });
        if (verification.ok && checksum.ok) {
          const urls = verification.verified.map((entry) =>
            buildPublicUrl({ prefix: normalized.prefix, fileName: entry.name, profile: normalized.profile }),
          );
          const completedAt = new Date().toISOString();
          const baseRecord = buildJobRecord({
            ...job,
            status: 'complete',
            completedAt,
            verification,
            checksum,
            urls,
            error: `rclone warning after verified upload: ${error.message}`,
            diagnostics: storedDiagnostics(jobId, 'complete'),
          });
          const notificationPayload = buildNotificationPayload({
            job: baseRecord,
            status: 'complete',
            verification,
            checksum,
            urls,
            error: error.message,
          });
          transferLifecycle.update(jobId, { phase: 'notifying' });
          const notificationAttempts = await sendNotifications({
            notifications: normalized.notifications,
            payload: notificationPayload,
          });
          await waitForTransferLifecycleContinuation(jobId);
          transferLifecycle.update(jobId, { phase: 'persisting' });
          await persistence.writeJobRecord(JOBS_DIR, buildJobRecord({
            ...baseRecord,
            status: notificationAttempts.some((attempt) => !attempt.ok) ? 'warning' : 'complete',
            notificationAttempts,
            diagnostics: storedDiagnostics(jobId, 'complete'),
          }));
          sendUploadEvent('upload:notifications', { jobId, intentId: normalized.intentId, notifications: notificationAttempts });
          sendUploadEvent('upload:complete', {
            jobId,
            intentId: normalized.intentId,
            dryRun,
            urls,
            verification,
            checksum,
            warning: error.message,
            uploadedRoots,
          });
          return {
            ok: true,
            jobId,
            intentId: normalized.intentId,
            dryRun,
            urls,
            verification,
            checksum,
            warning: error.message,
            uploadedRoots,
          };
        }
      } catch (verifyError) {
        if (verifyError.cancelled) throw verifyError;
        sendUploadEvent('upload:log', {
          jobId,
          intentId: normalized.intentId,
          mode: 'verify',
          stream: 'stderr',
          text: `Post-failure verification could not run: ${verifyError.message}\n`,
        });
      }
    }
    if (!dryRun) {
      const failedRecord = buildJobRecord({
        ...job,
        status: 'failed',
        completedAt: new Date().toISOString(),
        verification,
        checksum,
        error: error.message,
        diagnostics: storedDiagnostics(jobId, 'failed'),
      });
      const notificationPayload = buildNotificationPayload({
        job: failedRecord,
        status: 'failed',
        verification,
        checksum,
        urls: [],
        error: error.message,
      });
      transferLifecycle.update(jobId, { phase: 'notifying' });
      const notificationAttempts = await sendNotifications({
        notifications: normalized.notifications,
        payload: notificationPayload,
      });
      await waitForTransferLifecycleContinuation(jobId);
      transferLifecycle.update(jobId, { phase: 'persisting' });
      await persistence.writeJobRecord(JOBS_DIR, buildJobRecord({
        ...failedRecord,
        notificationAttempts,
        diagnostics: storedDiagnostics(jobId, 'failed'),
      }));
      sendUploadEvent('upload:notifications', { jobId, intentId: normalized.intentId, notifications: notificationAttempts });
      error.terminalPersisted = true;
    }
    sendUploadEvent('upload:error', {
      jobId,
      intentId: normalized.intentId,
      message: error.message,
      stderr: error.stderr || '',
      verification,
      checksum,
    });
    throw error;
  }
}

async function runUploadQueue(requests = []) {
  const jobs = Array.isArray(requests) ? requests : [];
  if (!jobs.length) {
    return { ok: false, results: [], error: 'No ready queue jobs to upload.' };
  }

  sendUploadEvent('upload:queue-start', { total: jobs.length });
  const results = [];
  for (let index = 0; index < jobs.length; index += 1) {
    const request = jobs[index];
    const clientJobId = request.clientJobId || '';
    sendUploadEvent('upload:queue-job-start', {
      clientJobId,
      index: index + 1,
      total: jobs.length,
      prefix: normalizePrefix(request.prefix),
    });
    try {
      const result = await runUploadRequest(request, { dryRun: false });
      const queueResult = { clientJobId, ...result };
      results.push(queueResult);
      sendUploadEvent('upload:queue-job-complete', queueResult);
    } catch (error) {
      const failure = {
        ok: false,
        code: error.code || '',
        externalLifecycle: error.code === 'ETRANSFERACTIVE',
        cancelled: Boolean(error.cancelled),
        paused: Boolean(error.paused),
        blocked: Boolean(error.blocked),
        clientJobId,
        index: index + 1,
        total: jobs.length,
        prefix: normalizePrefix(request.prefix),
        error: error.message,
        results,
      };
      sendUploadEvent('upload:queue-stopped', failure);
      return failure;
    }
  }
  const complete = { ok: true, results };
  sendUploadEvent('upload:queue-complete', complete);
  return complete;
}

async function runDownloadQueue(requests = []) {
  const jobs = Array.isArray(requests) ? requests : [];
  if (!jobs.length) {
    return { ok: false, results: [], error: 'No ready queue jobs to download.' };
  }

  sendUploadEvent('upload:queue-start', { total: jobs.length, direction: 'download' });
  const results = [];
  for (let index = 0; index < jobs.length; index += 1) {
    const request = jobs[index];
    const clientJobId = request.clientJobId || '';
    sendUploadEvent('upload:queue-job-start', {
      clientJobId,
      index: index + 1,
      total: jobs.length,
      direction: 'download',
      prefix: normalizePrefix(request.prefix),
    });
    try {
      const result = await runDownloadRequest(request, { dryRun: false });
      const queueResult = { clientJobId, ...result };
      results.push(queueResult);
      sendUploadEvent('upload:queue-job-complete', queueResult);
    } catch (error) {
      const failure = {
        ok: false,
        code: error.code || '',
        externalLifecycle: error.code === 'ETRANSFERACTIVE',
        cancelled: Boolean(error.cancelled),
        paused: Boolean(error.paused),
        blocked: Boolean(error.blocked),
        clientJobId,
        index: index + 1,
        total: jobs.length,
        direction: 'download',
        prefix: normalizePrefix(request.prefix),
        error: error.message,
        results,
      };
      sendUploadEvent('upload:queue-stopped', failure);
      return failure;
    }
  }
  const complete = { ok: true, direction: 'download', results };
  sendUploadEvent('upload:queue-complete', complete);
  return complete;
}

async function verifyUploadRequest(request) {
  const normalized = normalizeUploadRequest(request);
  await assertReady(normalized.profile);

  const jobId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const localEntries = normalized.sources.flatMap((source) =>
    collectLocalUploadEntries(source, normalized.include, normalized.filterMode, {
      folderUploadMode: normalized.folderUploadMode,
    }),
  );
  const jsonListing = await runRcloneOnce(buildJsonListArgs({ prefix: normalized.prefix, profile: normalized.profile }));
  const verification = buildVerificationReport({
    localEntries,
    remoteEntries: JSON.parse(jsonListing.stdout || '[]'),
    expectedSourceCount: normalized.sources.length,
  });
  const checksum = await buildChecksumReport({
    sources: normalized.sources,
    prefix: normalized.prefix,
    localEntries,
    include: normalized.include,
    filterMode: normalized.filterMode,
    mode: normalized.checksum,
    folderUploadMode: normalized.folderUploadMode,
    profile: normalized.profile,
  });
  const urls = verification.verified.map((entry) =>
    buildPublicUrl({ prefix: normalized.prefix, fileName: entry.name, profile: normalized.profile }),
  );

  sendUploadEvent('upload:verified', { jobId, verification });
  sendUploadEvent('upload:checksum', { jobId, checksum });
  return {
    ok: verification.ok && checksum.ok,
    jobId,
    prefix: normalized.prefix,
    verification,
    checksum,
    urls,
  };
}

async function setupDigitalOceanProfile(request = {}) {
  return profileMutationInterlock.runExclusive('profile setup', async () => {
    const args = buildRcloneConfigCreateArgs(request);
    const profile = normalizeProfile({
      remote: request.name,
      bucket: request.bucket,
      endpointHost: request.endpoint,
    });
    const remotes = await runRcloneOnce(['listremotes']);
    if (remotes.stdout.split(/\r?\n/).includes(`${profile.remote}:`)) {
      throw new Error(`The rclone profile "${profile.remote}" already exists. Test it or choose another name.`);
    }
    await runRcloneOnce(args);
    const setupToken = crypto.randomUUID();
    profileSetupAttempts.set(setupToken, { name: profile.remote, createdAt: Date.now() });
    return {
      ok: true,
      created: true,
      setupToken,
      profile,
      summary: profileSetupSummary(request),
      redacted: redactProfileSetup(request),
    };
  });
}

function commitDigitalOceanProfileSetup(request = {}) {
  const setupToken = String(request.setupToken || '');
  const attempt = profileSetupAttempts.get(setupToken);
  if (!attempt) return { ok: true, alreadySettled: true };
  if (attempt.name !== String(request.name || '').trim()) {
    throw new Error('The connection setup confirmation is no longer valid.');
  }
  profileSetupAttempts.delete(setupToken);
  return { ok: true };
}

async function rollbackDigitalOceanProfileSetup(request = {}) {
  const setupToken = String(request.setupToken || '');
  const attempt = profileSetupAttempts.get(setupToken);
  if (!attempt || attempt.name !== String(request.name || '').trim()) {
    throw new Error('The connection setup rollback is no longer valid.');
  }
  return profileMutationInterlock.runExclusive('profile setup rollback', async () => {
    await runRcloneOnce(buildRcloneConfigDeleteArgs(attempt.name));
    profileSetupAttempts.delete(setupToken);
    return { ok: true, name: attempt.name };
  });
}

async function exportConnectionDescriptor(request = {}) {
  const descriptor = sanitizeConnection(request.connection || request);
  const encrypted = request.includeKeys === true;
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Space connection settings',
    defaultPath: `${descriptor.name.replace(/[^A-Za-z0-9._-]+/g, '-') || 'space'}.murdawk-connection`,
    filters: [{ name: 'Murdawk connection', extensions: ['murdawk-connection'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
  const connectionPackage = encrypted
    ? encryptConnectionPackage({
      connection: descriptor,
      accessKeyId: request.accessKeyId,
      secretAccessKey: request.secretAccessKey,
    }, request.password)
    : buildPublicConnectionPackage(descriptor);
  const output = Buffer.from(`${JSON.stringify(connectionPackage, null, 2)}\n`, 'utf8');
  try {
    await fs.promises.writeFile(result.filePath, output, { flag: 'w' });
  } finally {
    output.fill(0);
  }
  return { ok: true, encrypted };
}

async function importConnectionDescriptor() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Space connection settings',
    properties: ['openFile'],
    filters: [{ name: 'Murdawk connection', extensions: ['murdawk-connection', 'json'] }],
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, cancelled: true };
  const stat = await fs.promises.stat(result.filePaths[0]);
  if (stat.size > 256 * 1024) throw new Error('Connection settings file is too large.');
  const inspected = inspectConnectionPackage(await fs.promises.readFile(result.filePaths[0], 'utf8'));
  if (!inspected.encrypted) {
    return { ok: true, encrypted: false, connection: inspected.connection };
  }
  const importToken = crypto.randomUUID();
  pendingConnectionImports.set(importToken, {
    packageValue: inspected.value,
    unlocked: null,
    createdAt: Date.now(),
  });
  return { ok: true, encrypted: true, importToken };
}

function pendingConnectionImport(importToken) {
  const token = typeof importToken === 'string' ? importToken : '';
  const attempt = pendingConnectionImports.get(token);
  if (!attempt || Date.now() - attempt.createdAt > 15 * 60 * 1000) {
    pendingConnectionImports.delete(token);
    throw new Error('This connection import expired. Choose the package again.');
  }
  return { token, attempt };
}

function unlockConnectionImport(request = {}) {
  const { attempt } = pendingConnectionImport(request.importToken);
  const unlocked = decryptConnectionPackage(attempt.packageValue, request.password);
  attempt.packageValue = null;
  attempt.unlocked = unlocked;
  return { ok: true, connection: unlocked.connection };
}

async function createProfileFromConnectionImport(request = {}) {
  const { token, attempt } = pendingConnectionImport(request.importToken);
  if (!attempt.unlocked) throw new Error('Unlock the connection package first.');
  const unlocked = attempt.unlocked;
  try {
    const setup = await setupDigitalOceanProfile({
      name: unlocked.connection.remote,
      bucket: unlocked.connection.bucket,
      endpoint: unlocked.connection.endpointHost,
      accessKeyId: unlocked.accessKeyId,
      secretAccessKey: unlocked.secretAccessKey,
      publicRead: unlocked.connection.publicRead,
    });
    return { ok: true, connection: unlocked.connection, setup };
  } finally {
    unlocked.accessKeyId = '';
    unlocked.secretAccessKey = '';
    attempt.unlocked = null;
    pendingConnectionImports.delete(token);
  }
}

function cancelConnectionImport(request = {}) {
  const token = typeof request.importToken === 'string' ? request.importToken : '';
  const attempt = pendingConnectionImports.get(token);
  if (attempt?.unlocked) {
    attempt.unlocked.accessKeyId = '';
    attempt.unlocked.secretAccessKey = '';
    attempt.unlocked = null;
  }
  pendingConnectionImports.delete(token);
  return { ok: true };
}

async function removeRcloneProfile(request = {}) {
  return profileMutationInterlock.runExclusive('profile removal', async () => {
    const requestedConnection = sanitizeConnection(request.connection || {});
    const storedConnection = readSettings(getSettingsPath()).connections.find(
      (connection) => connection.id === requestedConnection.id,
    );
    if (!storedConnection || !connectionProfileMatches(storedConnection, requestedConnection)) {
      throw new Error('The saved Uplink connection does not match this rclone profile.');
    }
    const connection = sanitizeConnection(storedConnection);
    const name = typeof request.name === 'string' ? request.name.trim() : '';
    if (!name || name !== connection.remote || request.confirmation !== name) {
      throw new Error('The exact rclone profile name is required to remove it.');
    }
    const blockers = listConnectionRemovalBlockers({ connection });
    if (blockers.length) {
      throw new Error('The rclone profile has unfinished uploads or checks and cannot be removed.');
    }
    await runRcloneOnce(buildRcloneConfigDeleteArgs(name));
    return { ok: true, name };
  });
}

function listConnectionRemovalBlockers(request = {}) {
  const connection = sanitizeConnection(request.connection || {});
  const settings = readSettings(getSettingsPath());
  return collectConnectionRemovalBlockers({
    connection,
    jobs: [...readJobRecords(JOBS_DIR), ...(Array.isArray(settings.queueJobs) ? settings.queueJobs : [])],
    activeTransfer: activeTransferSnapshot(),
  })
    .map((job) => ({
      jobId: typeof (job.jobId || job.id) === 'string' ? (job.jobId || job.id) : '',
      prefix: redactLogText(typeof job.prefix === 'string' ? job.prefix : ''),
      status: typeof job.status === 'string' ? job.status : 'unfinished',
    }));
}

async function chooseEventManifest() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open event manifest',
    properties: ['openFile'],
    filters: [{ name: 'Event manifest', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, cancelled: true };
  const loaded = await loadEventManifestFile(result.filePaths[0]);
  return { ok: true, ...loaded };
}

async function reconcileEventWorkspaceLocal(request = {}) {
  request = request || {};
  if (!request.manifest) throw new Error('Open an event manifest before reconciling.');
  const manifest = normalizeEventManifest(request.manifest);
  const localRoots = Array.isArray(request.localRoots)
    ? request.localRoots.filter((root) => typeof root === 'string' && root.trim())
    : manifest.localRoots;
  const localScan = await buildLocalEventManifestRecordsAsync({
    manifest,
    localRoots,
    maxFiles: normalizeEventScanMaxFiles(request.maxFiles),
  });
  const localRecords = localScan.records;
  const remoteRecords = await listEventRemoteRecords({
    manifest,
    runRclone: runRcloneOnce,
    assertReady,
  });
  const reconcile = reconcileEventRecords({ localRecords, remoteRecords });
  return {
    manifest,
    localRecords,
    remoteRecords,
    localScan: {
      skipped: localScan.skipped,
      scan: localScan.scan,
    },
    reconcile,
  };
}

function publicConnectionSummary(connection = {}) {
  const safe = sanitizeConnection(connection);
  return {
    id: safe.id,
    name: safe.name,
    remote: safe.remote,
    bucket: safe.bucket,
    endpointHost: safe.endpointHost,
    publicRead: safe.publicRead,
    checksum: safe.checksum,
  };
}

function automationQueueSummary(job = {}) {
  return {
    id: job.id || '',
    intentId: job.intentId || '',
    connectionId: job.connectionId || '',
    sources: Array.isArray(job.sources) ? [...job.sources] : [],
    prefix: job.prefix || '',
    filterMode: job.filterMode || 'all',
    folderUploadMode: job.folderUploadMode || 'package',
    publicRead: job.publicRead !== false,
    checksum: job.checksum || 'size',
    status: job.status || 'queued',
    jobId: job.jobId || '',
    error: job.error || '',
  };
}

function automationConnection(settings, connectionId) {
  const connection = settings.connections.find((candidate) => candidate.id === connectionId);
  if (!connection) {
    const error = new Error('Choose a valid Uplink connection.');
    error.statusCode = 400;
    throw error;
  }
  return sanitizeConnection(connection);
}

function normalizeAutomationSources(value) {
  if (!Array.isArray(value) || !value.length || value.length > 100) {
    throw new Error('Choose between 1 and 100 local files or folders.');
  }
  const sources = value.map((source) => {
    if (typeof source !== 'string' || !path.isAbsolute(source)) {
      throw new Error('Every queued source must be an absolute local path.');
    }
    const resolved = path.resolve(source);
    if (!fs.existsSync(resolved)) throw new Error(`Local source does not exist: ${resolved}`);
    return resolved;
  });
  const inspection = inspectUploadSourcesForCredentialLikePaths(sources);
  if (!inspection.ok) {
    throw new Error(`Blocked credential-like local path: ${inspection.blocked[0]?.path || 'unknown path'}`);
  }
  return sources;
}

async function queueAutomationSources(body = {}) {
  const settings = readSettings(getSettingsPath());
  if (settings.queueJobs.length >= 100) throw new Error('The upload queue is full. Clear completed work before adding more.');
  const connection = automationConnection(settings, body.connectionId);
  const sources = normalizeAutomationSources(body.sources);
  const job = createQueueJob({
    id: `api-${crypto.randomUUID()}`,
    intentId: crypto.randomUUID(),
    sources,
    settings: {
      connections: settings.connections,
      connectionId: connection.id,
      profile: connection,
      profileSnapshot: connection,
      prefix: normalizePrefix(body.prefix || ''),
      filterMode: body.filterMode,
      include: typeof body.include === 'string' ? body.include : '',
      folderUploadMode: body.folderUploadMode,
      publicRead: body.publicRead !== false,
      checksum: body.checksum,
      notifyWebhook: '',
      notifyNtfy: '',
      notifyOn: 'success',
    },
    status: 'queued',
  });
  await persistence.writeSettings(getSettingsPath(), {
    ...settings,
    queueJobs: [...settings.queueJobs, job.persistable],
  });
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('automation:queue-updated', { job: automationQueueSummary(job) });
  }
  return {
    message: 'Queued for review in Murdawk Uplink. No upload was started.',
    job: automationQueueSummary(job),
  };
}

function automationHandlers() {
  return {
    capabilities: async () => ({ capabilities: publicAutomationCapabilities() }),
    connections: async () => {
      const settings = readSettings(getSettingsPath());
      return {
        activeConnectionId: settings.activeConnectionId,
        connections: settings.connections.map(publicConnectionSummary),
      };
    },
    remote: async ({ query }) => {
      const settings = readSettings(getSettingsPath());
      const connection = automationConnection(settings, query.get('connectionId') || settings.activeConnectionId);
      return listRemoteFolder(query.get('prefix') || '', connection);
    },
    queue: async () => {
      const settings = readSettings(getSettingsPath());
      return { jobs: settings.queueJobs.map(automationQueueSummary) };
    },
    queueCreate: async ({ body }) => queueAutomationSources(body),
    activity: async () => ({ records: listActivityRecords() }),
  };
}

function automationStatus() {
  const credentials = automationAuthStore ? automationAuthStore.list() : [];
  return {
    enabled: Boolean(automationServer?.url),
    url: automationServer?.url || '',
    error: automationServerError,
    credentials,
    boundary: 'Local browsing and queueing only. Real uploads and server changes are not exposed.',
  };
}

function notifyAutomationStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('automation:status', automationStatus());
  }
}

async function reconcileAutomationServer() {
  if (!automationAuthStore) return automationStatus();
  const credentials = automationAuthStore.list();
  if (!credentials.length) {
    await automationServer?.stop();
    automationServerError = '';
    notifyAutomationStatus();
    return automationStatus();
  }
  if (!automationServer) {
    automationServer = new AutomationServer({
      authenticate: async (token) => automationAuthStore.authenticate(token),
      handlers: automationHandlers(),
      port: 47819,
    });
  }
  try {
    await automationServer.start();
    automationServerError = '';
  } catch (error) {
    automationServerError = error.code === 'EADDRINUSE'
      ? 'Local automation port 47819 is already in use.'
      : error.message;
    throw new Error(automationServerError);
  } finally {
    notifyAutomationStatus();
  }
  return automationStatus();
}

async function createAutomationAccess(name) {
  const created = automationAuthStore.create(name);
  try {
    const status = await reconcileAutomationServer();
    return { ok: true, ...created, status };
  } catch (error) {
    automationAuthStore.revoke(created.credential.id);
    throw error;
  }
}

async function revokeAutomationAccess(id) {
  const credential = automationAuthStore.revoke(id);
  const status = await reconcileAutomationServer();
  return { ok: true, credential, status };
}

async function createMcpConfiguration(name) {
  const created = await createAutomationAccess(name);
  const adapterPath = path.resolve(__dirname, '..', 'bin', 'murdawk-uplink-mcp.mjs');
  const configuration = {
    mcpServers: {
      'murdawk-uplink': {
        command: process.execPath,
        args: [adapterPath],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          MURDAWK_UPLINK_API_URL: created.status.url,
          MURDAWK_UPLINK_TOKEN: created.token,
        },
      },
    },
  };
  return {
    ok: true,
    credential: created.credential,
    status: created.status,
    configuration: JSON.stringify(configuration, null, 2),
  };
}

function startPrimaryApplication() {
  persistence = new SerializedPersistenceWorker();
  quitCoordinator = createQuitCoordinator({
    app,
    persistence,
    getActiveTransfer: activeTransferSnapshot,
    confirmActiveQuit: async (transfer) => {
      const result = await dialog.showMessageBox(mainWindow, buildCloseGuardMessage(transfer));
      return ['prechecking', 'uploading'].includes(transfer.phase) && result.response === 1
        ? 'pause'
        : result.response === 0
          ? 'keep'
          : 'cancel';
    },
    pauseActiveTransfer: async () => {
      const association = await requestRendererPausePreparation(activeTransferSnapshot());
      return requestActiveTransferPause(association);
    },
    onError: (error) => {
      if (activeJobId) logJobEvent(activeJobId, 'quit:warning', { message: error.message });
    },
  });
  app.whenReady().then(() => {
    app.setName(APP_NAME);
    automationAuthStore = new AutomationAuthStore({
      filePath: getAutomationAccessPath(),
      safeStorage,
    });
    cleanupActivityLogs(LOGS_DIR, { maxAgeDays: 30, maxFiles: 500 });
    scavengeAbandonedManifests({ manifestDirectory: MANIFESTS_DIR });
    try {
      cleanupPreviewCache(getPreviewCacheDirectory());
    } catch (_error) {
      // Preview cache maintenance must never block the application from opening.
    }
    createApplicationMenu();

    ipcMain.handle('settings:load', () => readSettings(getSettingsPath()));
    ipcMain.handle('settings:save', (_event, settings) => persistence.writeSettings(getSettingsPath(), settings));
    ipcMain.handle('queue:persist', (event, acknowledgement = {}) => {
      const pending = rendererPauseAcks.get(acknowledgement.requestId);
      if (!pending || event.sender !== mainWindow?.webContents) {
        return { ok: false, message: 'No matching pause persistence request is pending.' };
      }
      rendererPauseAcks.delete(acknowledgement.requestId);
      if (acknowledgement.ok !== true) {
        pending.reject(new Error(acknowledgement.error || 'The upload queue could not be persisted for pause.'));
        return { ok: false };
      }
      pending.resolve(normalizePauseAssociation(acknowledgement));
      return { ok: true };
    });
    ipcMain.handle('system:check', (_event, profile) => assertReady(profile));
    ipcMain.handle('system:active-transfer', () => activeTransferSnapshot());
    ipcMain.handle('system:recovery-snapshot', () => ({
      activeTransfer: activeTransferSnapshot(),
      records: readJobRecords(JOBS_DIR),
    }));
    ipcMain.handle('jobs:list', () => listActivityRecords());
    ipcMain.handle('jobs:resume-settings', (_event, jobId) => buildActivityResumeSettings(jobId));
    ipcMain.handle('diagnostics:open-job-log', async (_event, jobId) => {
      const target = getLogPath(jobId);
      if (!fs.existsSync(target)) {
        return { ok: false, message: 'No log is available for this transfer run.' };
      }
      const message = await shell.openPath(target);
      return { ok: !message, message };
    });
    ipcMain.handle('automation:capabilities', () => publicAutomationCapabilities());
    ipcMain.handle('automation:status', () => automationStatus());
    ipcMain.handle('automation:create-key', (_event, request = {}) => createAutomationAccess(request.name));
    ipcMain.handle('automation:create-mcp', (_event, request = {}) => createMcpConfiguration(request.name));
    ipcMain.handle('automation:revoke-key', (_event, request = {}) => revokeAutomationAccess(request.id));
    ipcMain.handle('profile:setup-digitalocean', (_event, request) => setupDigitalOceanProfile(request));
    ipcMain.handle('profile:setup-commit', (_event, request) => commitDigitalOceanProfileSetup(request));
    ipcMain.handle('profile:setup-rollback', (_event, request) => rollbackDigitalOceanProfileSetup(request));
    ipcMain.handle('profile:remove', (_event, request) => removeRcloneProfile(request));
    ipcMain.handle('connection:export', (_event, connection) => exportConnectionDescriptor(connection));
    ipcMain.handle('connection:import', () => importConnectionDescriptor());
    ipcMain.handle('connection:import-unlock', (_event, request) => unlockConnectionImport(request));
    ipcMain.handle('connection:import-create-profile', (_event, request) => createProfileFromConnectionImport(request));
    ipcMain.handle('connection:import-cancel', (_event, request) => cancelConnectionImport(request));
    ipcMain.handle('connection:removal-blockers', (_event, request) => listConnectionRemovalBlockers(request));
    ipcMain.handle('event:choose-manifest', () => chooseEventManifest());
    ipcMain.handle('event:reconcile-local', (_event, request) => reconcileEventWorkspaceLocal(request));
    ipcMain.handle('event:queue-missing-preview', (_event, request = {}) => {
      request = request || {};
      if (!request.manifest) throw new Error('Open an event manifest before preparing missing files.');
      const manifest = normalizeEventManifest(request.manifest);
      return buildMissingQueuePlan({ manifest, reconcile: request.reconcile, includeMeta: true });
    });
    ipcMain.handle('dialog:choose-files', async () => {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Choose files to upload',
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: 'Common media and docs', extensions: ['mp4', 'mov', 'm4v', 'jpg', 'jpeg', 'png', 'wav', 'mp3', 'pdf', 'txt', 'csv'] },
          { name: 'All files', extensions: ['*'] },
        ],
      });
      return result.canceled ? [] : result.filePaths;
    });
    ipcMain.handle('dialog:choose-folder', async () => {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Choose a folder to upload',
        properties: ['openDirectory'],
      });
      return result.canceled ? [] : result.filePaths;
    });
    ipcMain.handle('dialog:choose-download-folder', async () => {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Choose where to save the download',
        buttonLabel: 'Save here',
        properties: ['openDirectory', 'createDirectory'],
      });
      return result.canceled ? '' : result.filePaths[0] || '';
    });
    ipcMain.handle('remote:list', (_event, prefix, profile) => listRemoteFolder(prefix, profile));
    ipcMain.handle('preview:prepare', (_event, request) => prepareImagePreview(request));
    ipcMain.handle('preview:clear', () => {
      const result = clearPreviewCache(getPreviewCacheDirectory());
      return { ok: true, removedCount: result.removed.length };
    });
    ipcMain.handle('remote:operation', (_event, request) => runRemoteOperation(request));
    ipcMain.handle('remote:operations', (_event, requests) => runRemoteOperations(requests));
    ipcMain.handle('upload:verify', (_event, request) => verifyUploadRequest(request));
    ipcMain.handle('upload:dry-run', (_event, request) => runUploadRequest(request, { dryRun: true }));
    ipcMain.handle('upload:start', (_event, request) => runUploadRequest(request, { dryRun: false }));
    ipcMain.handle('upload:queue-start', (_event, requests) => runUploadQueue(requests));
    ipcMain.handle('download:dry-run', (_event, request) => runDownloadRequest(request, { dryRun: true }));
    ipcMain.handle('download:start', (_event, request) => runDownloadRequest(request, { dryRun: false }));
    ipcMain.handle('download:queue-start', (_event, requests) => runDownloadQueue(requests));
    ipcMain.handle('upload:pause', (_event, request) => requestActiveTransferPause(request));
    ipcMain.handle('upload:cancel', () => requestActiveTransferCancel());
    ipcMain.handle('clipboard:copy-urls', (_event, urls) => {
      clipboard.writeText(Array.isArray(urls) ? urls.join('\n') : '');
      return { ok: true };
    });
    ipcMain.handle('clipboard:copy-text', (_event, value) => {
      clipboard.writeText(typeof value === 'string' ? value : '');
      return { ok: true };
    });
    ipcMain.handle('diagnostics:copy', (_event, jobId) => {
      if (!jobId || !fs.existsSync(getLogPath(jobId))) {
        return { ok: false, message: 'No diagnostics log is available for this job yet.' };
      }
      clipboard.writeText(buildDiagnosticsText(jobId));
      return { ok: true, message: 'Copied diagnostics log tail to clipboard.' };
    });
    ipcMain.handle('diagnostics:open-folder', async () => {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
      const message = await shell.openPath(LOGS_DIR);
      return { ok: !message, message };
    });

    createWindow();
    void reconcileAutomationServer().catch(() => {
      // The Connections utility shows startup errors without preventing normal app use.
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });

  app.on('before-quit', (event) => {
    void automationServer?.stop();
    try {
      cleanupPreviewCache(getPreviewCacheDirectory());
    } catch (_error) {
      // Preview cache maintenance is best effort during shutdown.
    }
    void quitCoordinator.handleBeforeQuit(event);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}

coordinateSingleInstance({
  app,
  getWindow: () => mainWindow,
  startPrimary: startPrimaryApplication,
});
