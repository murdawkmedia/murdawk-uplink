#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  compareChecksumEntries,
  computeFileSha256,
  normalizeChecksumMode,
  skippedChecksumReport,
} = require('../src/checksum-core');
const {
  buildJobRecord,
  createJobId,
  readJobRecord,
  readJobRecords,
  writeJobRecord,
} = require('../src/job-core');
const {
  buildNotificationPayload,
  sendNotifications,
} = require('../src/notification-core');
const {
  buildCopyArgs,
  buildExplorerListArgs,
  buildJsonListArgs,
  buildListArgs,
  buildRemotePath,
  buildPublicUrl,
  buildVerificationReport,
  collectLocalUploadEntries,
  DEFAULT_PROFILE,
  normalizeProfile,
  parseExplorerEntries,
  sourceDestinationPrefix,
} = require('../src/upload-core');
const {
  buildDefaultEventManifest,
  buildHelp,
  buildMissingQueuePlan,
  buildStatusSummary,
  describeLocalSource,
  findMatchingStatusRecord,
  formatEventReconcileReport,
  formatExplorerTable,
  formatInventoryReport,
  formatUrls,
  formatVerificationSummary,
  normalizeEventCliOptions,
  normalizeUploadOptions,
  parseCliArgs,
  statusDiagnosticsFromRecord,
  summarizeProfile,
} = require('../src/cli-core');
const {
  buildLocalEventManifestRecordsAsync,
  listEventRemoteRecords,
} = require('../src/event-workspace-runtime');
const {
  normalizeEventManifest,
} = require('../src/event-manifest-core');
const {
  reconcileEventRecords,
} = require('../src/event-reconcile-core');

const JOBS_DIR = path.resolve(__dirname, '..', '..', '.runs', 'jobs');
const LOGS_DIR = path.resolve(__dirname, '..', '..', '.runs', 'logs');

function getLogPath(jobId) {
  return path.join(LOGS_DIR, `${jobId}.log`);
}

function appendJobLog(jobId, text) {
  if (!jobId || !text) return;
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  fs.appendFileSync(getLogPath(jobId), text.endsWith('\n') ? text : `${text}\n`, 'utf8');
}

function logJobEvent(jobId, label, payload = {}) {
  appendJobLog(jobId, `[${new Date().toISOString()}] ${label} ${JSON.stringify(payload)}\n`);
}

function runRclone(args, { stream = false, stdoutTarget = 'stdout', jobId = '' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('rclone', args, { windowsHide: true, shell: false });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      appendJobLog(jobId, text);
      if (stream) {
        const target = stdoutTarget === 'stderr' ? process.stderr : process.stdout;
        target.write(text);
      }
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      appendJobLog(jobId, text);
      if (stream) process.stderr.write(text);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const error = new Error(`rclone exited with code ${code}`);
        error.code = code;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}

function hashRemoteObject(remotePath) {
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

async function assertReady(profile = DEFAULT_PROFILE) {
  const activeProfile = normalizeProfile(profile);
  await runRclone(['version']);
  const remotes = await runRclone(['listremotes']);
  if (!remotes.stdout.split(/\r?\n/).includes(`${activeProfile.remote}:`)) {
    throw new Error(`The rclone remote "${activeProfile.remote}" is not configured.`);
  }
  return summarizeProfile(activeProfile);
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
}

function writeJsonFile(filePath, value) {
  const target = path.resolve(filePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function checkCommand({ json, profile }) {
  const activeProfile = await assertReady(profile);
  if (json) {
    printJson({ ok: true, profile: activeProfile });
    return;
  }
  process.stdout.write(
    `Ready: ${activeProfile.remote}:/${activeProfile.bucket} via ${activeProfile.endpointHost}\n`,
  );
}

async function listCommand({ prefix = '', json, profile }) {
  const activeProfile = await assertReady(profile);
  const listing = await runRclone(buildExplorerListArgs({ prefix, profile: activeProfile }));
  const entries = parseExplorerEntries({
    prefix,
    profile: activeProfile,
    rawEntries: JSON.parse(listing.stdout || '[]'),
  });
  if (json) {
    printJson({ ok: true, prefix, entries });
    return;
  }
  process.stdout.write(`${formatExplorerTable(entries)}\n`);
}

async function inventoryCommand({ prefix = '', json, profile }) {
  const activeProfile = await assertReady(profile);
  const normalizedPrefix = prefix || DEFAULT_PROFILE.defaultPrefix;
  const listing = await runRclone(buildJsonListArgs({ prefix: normalizedPrefix, profile: activeProfile }));
  const entries = parseExplorerEntries({
    prefix: normalizedPrefix,
    profile: activeProfile,
    rawEntries: JSON.parse(listing.stdout || '[]'),
  });
  if (json) {
    printJson({ ok: true, prefix: normalizedPrefix, files: entries.filter((entry) => !entry.isDir) });
    return;
  }
  process.stdout.write(`${formatInventoryReport({ prefix: normalizedPrefix, entries })}\n`);
}

async function urlsCommand({ prefix = DEFAULT_PROFILE.defaultPrefix, include, filterMode, json, profile }) {
  const activeProfile = await assertReady(profile);
  const normalizedPrefix = prefix || DEFAULT_PROFILE.defaultPrefix;
  const listing = await runRclone(buildListArgs({ prefix: normalizedPrefix, include, filterMode, profile: activeProfile }));
  const names = listing.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const urls = formatUrls({ prefix: normalizedPrefix, names, profile: activeProfile });
  if (json) {
    printJson({ ok: true, prefix: normalizedPrefix, urls });
    return;
  }
  process.stdout.write(`${urls.join('\n')}\n`);
}

async function eventManifestCommand(options) {
  const manifest = buildDefaultEventManifest();
  if (options.outputPath) {
    writeJsonFile(options.outputPath, manifest);
  }
  if (options.json) {
    printJson({ ok: true, manifest, outputPath: options.outputPath || '' });
    return;
  }
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  if (options.outputPath) {
    process.stderr.write(`Event manifest written: ${path.resolve(options.outputPath)}\n`);
  }
}

async function eventReconcileCommand(options) {
  if (!options.manifestPath) {
    throw new Error('event reconcile requires --manifest <path>.');
  }
  if (!options.localRoots.length) {
    throw new Error('event reconcile requires at least one --local-root <path>.');
  }
  const manifest = normalizeEventManifest(readJsonFile(options.manifestPath));
  const localScan = await buildLocalEventManifestRecordsAsync({ manifest, localRoots: options.localRoots });
  const localRecords = localScan.records;
  const remoteRecords = await listEventRemoteRecords({ manifest, runRclone, assertReady });
  const reconcile = reconcileEventRecords({ localRecords, remoteRecords });
  const payload = {
    ok: reconcile.summary.missingCount === 0 && reconcile.summary.sizeMismatchCount === 0,
    manifest,
    localRecords,
    remoteRecords,
    localScan: {
      skipped: localScan.skipped,
      scan: localScan.scan,
    },
    reconcile,
  };

  if (options.outputDirectory) {
    const outputDirectory = path.resolve(options.outputDirectory);
    fs.mkdirSync(outputDirectory, { recursive: true });
    writeJsonFile(path.join(outputDirectory, 'event-manifest.json'), manifest);
    writeJsonFile(path.join(outputDirectory, 'local-manifest.json'), localRecords);
    writeJsonFile(path.join(outputDirectory, 'local-scan.json'), payload.localScan);
    writeJsonFile(path.join(outputDirectory, 'remote-manifest.json'), remoteRecords);
    writeJsonFile(path.join(outputDirectory, 'reconcile.json'), reconcile);
    payload.outputDirectory = outputDirectory;
  }

  if (options.json) {
    printJson(payload);
  } else {
    process.stdout.write(`${formatEventReconcileReport(reconcile)}\n`);
    const skippedCount = localScan.skipped.summary.credentialLikeCount || 0;
    if (skippedCount) {
      process.stdout.write(`Skipped credential-like local files: ${skippedCount}\n`);
    }
    for (const warning of localScan.scan.warnings || []) {
      process.stdout.write(`Scan warning: ${warning.message}\n`);
    }
    if (payload.outputDirectory) {
      process.stderr.write(`Reconcile files written: ${payload.outputDirectory}\n`);
    }
  }

  if (reconcile.summary.missingCount > 0 || reconcile.summary.sizeMismatchCount > 0) {
    process.exitCode = 2;
  }
}

async function eventQueueMissingCommand(options) {
  if (!options.manifestPath) {
    throw new Error('event queue-missing requires --manifest <path>.');
  }
  if (!options.reconcilePath) {
    throw new Error('event queue-missing requires --reconcile <path>.');
  }
  const manifest = normalizeEventManifest(readJsonFile(options.manifestPath));
  const reconcile = readJsonFile(options.reconcilePath);
  const queuePlan = buildMissingQueuePlan({ manifest, reconcile, includeMeta: true });
  const jobs = queuePlan.jobs;
  const payload = {
    ok: true,
    dryRun: options.dryRun,
    jobCount: jobs.length,
    jobs,
    skipped: queuePlan.skipped,
  };

  if (options.dryRun) {
    await assertReady({ remote: manifest.remote, bucket: manifest.bucket });
    for (const job of jobs) {
      await runRclone([
        'copyto',
        job.sourcePath,
        job.rcloneDestination,
        '--size-only',
        '--dry-run',
        '--transfers',
        String(manifest.uploadDefaults.transfers),
        '--s3-chunk-size',
        manifest.uploadDefaults.chunkSize,
        '--s3-upload-concurrency',
        String(manifest.uploadDefaults.uploadConcurrency),
        '--retries',
        String(manifest.uploadDefaults.retries),
        '--retries-sleep',
        manifest.uploadDefaults.retriesSleep,
        '--low-level-retries',
        String(manifest.uploadDefaults.lowLevelRetries),
      ], { stream: true, stdoutTarget: options.json ? 'stderr' : 'stdout' });
    }
  }

  if (options.json) {
    printJson(payload);
    return;
  }
  process.stdout.write(`Missing-file queue candidates: ${jobs.length}\n`);
  const skippedCount = queuePlan.skipped.summary.credentialLikeCount || 0;
  if (skippedCount) {
    process.stdout.write(`Skipped credential-like queue candidates: ${skippedCount}\n`);
  }
  if (!jobs.length) return;
  for (const job of jobs) {
    process.stdout.write(`${job.sourcePath} -> ${job.rcloneDestination}\n`);
  }
  if (!options.dryRun) {
    process.stdout.write('No upload was performed. Add --dry-run to validate rclone commands, then use normal upload flow for real transfers.\n');
  }
}

async function eventCommand(rawOptions) {
  const options = normalizeEventCliOptions(rawOptions);
  if (options.action === 'help') {
    process.stdout.write(`${buildHelp()}\n`);
  } else if (options.action === 'manifest') {
    await eventManifestCommand(options);
  } else if (options.action === 'reconcile') {
    await eventReconcileCommand(options);
  } else if (options.action === 'queue-missing') {
    await eventQueueMissingCommand(options);
  }
}

function localPathForEntry(source, entryName, folderUploadMode = 'package') {
  const stat = fs.statSync(source);
  if (stat.isFile()) return source;
  let localEntryName = entryName;
  if (folderUploadMode === 'package') {
    const rootName = path.basename(source);
    if (localEntryName === rootName || localEntryName.startsWith(`${rootName}/`)) {
      localEntryName = localEntryName.slice(rootName.length).replace(/^\/+/, '');
    }
  }
  return path.join(source, localEntryName.replace(/\//g, path.sep));
}

async function buildChecksumReport({ sources, prefix, localEntries, include, filterMode, folderUploadMode, mode, profile }) {
  const activeProfile = normalizeProfile(profile);
  const checksumMode = normalizeChecksumMode(mode);
  if (checksumMode === 'size') {
    return skippedChecksumReport('size');
  }

  const checksumEntries = [];
  for (const source of sources) {
    const sourceEntries = collectLocalUploadEntries(source, include || DEFAULT_PROFILE.defaultInclude, filterMode, { folderUploadMode });
    for (const entry of sourceEntries) {
      if (!localEntries.some((local) => local.name === entry.name)) continue;
      const localPath = localPathForEntry(source, entry.name, folderUploadMode);
      const remoteKey = [prefix, entry.name].filter(Boolean).join('/');
      checksumEntries.push({
        name: entry.name,
        localSha256: await computeFileSha256(localPath),
        remoteSha256: await hashRemoteObject(buildRemotePath(remoteKey, activeProfile, { trailingSlash: false })),
      });
    }
  }
  return compareChecksumEntries(checksumEntries);
}

async function verifyRequest(options) {
  const activeProfile = await assertReady(options.profile);
  const request = normalizeUploadOptions(options);
  request.profile = activeProfile;
  const localEntries = request.sources.flatMap((source) =>
    collectLocalUploadEntries(source, request.include, request.filterMode, { folderUploadMode: request.folderUploadMode }),
  );
  const listing = await runRclone(buildJsonListArgs({ prefix: request.prefix, profile: activeProfile }));
  const report = buildVerificationReport({
    localEntries,
    remoteEntries: JSON.parse(listing.stdout || '[]'),
    expectedSourceCount: request.sources.length,
  });
  const checksum = await buildChecksumReport({
    sources: request.sources,
    prefix: request.prefix,
    localEntries,
    include: request.include,
    filterMode: request.filterMode,
    folderUploadMode: request.folderUploadMode,
    mode: options.checksum,
    profile: activeProfile,
  });

  return { request, report, checksum };
}

async function verifyCommand(options) {
  const { request, report, checksum } = await verifyRequest(options);

  if (options.json) {
    printJson({ ok: report.ok && checksum.ok, prefix: request.prefix, verification: report, checksum });
  } else {
    process.stdout.write(`${formatVerificationSummary(report)}\n`);
    if (checksum.mode === 'sha256') {
      process.stdout.write(`Checksum ${checksum.ok ? 'OK' : 'FAILED'} verified=${checksum.verified.length} mismatched=${checksum.mismatched.length}\n`);
    }
  }

  if (!report.ok || !checksum.ok) {
    process.exitCode = 2;
  }
}

async function statusCommand(options) {
  if (options.job) {
    const record = readJobRecord(JOBS_DIR, options.job);
    printJson({
      ...record,
      diagnostics: statusDiagnosticsFromRecord(record),
    });
    return;
  }

  const activeProfile = await assertReady(options.profile);
  const request = normalizeUploadOptions(options);
  request.profile = activeProfile;
  const localEntries = request.sources.flatMap((source) =>
    collectLocalUploadEntries(source, request.include, request.filterMode, { folderUploadMode: request.folderUploadMode }),
  );
  const explorerListing = await runRclone(buildExplorerListArgs({ prefix: request.prefix, profile: activeProfile }));
  const entries = parseExplorerEntries({
    prefix: request.prefix,
    profile: activeProfile,
    rawEntries: JSON.parse(explorerListing.stdout || '[]'),
  });
  const jsonListing = await runRclone(buildJsonListArgs({ prefix: request.prefix, profile: activeProfile }));
  const verification = buildVerificationReport({
    localEntries,
    remoteEntries: JSON.parse(jsonListing.stdout || '[]'),
    expectedSourceCount: request.sources.length,
  });
  const checksum = await buildChecksumReport({
    sources: request.sources,
    prefix: request.prefix,
    localEntries,
    include: request.include,
    filterMode: request.filterMode,
    folderUploadMode: request.folderUploadMode,
    mode: options.checksum,
    profile: activeProfile,
  });
  const urls = verification.verified.map((entry) =>
    buildPublicUrl({ prefix: request.prefix, fileName: entry.name, profile: activeProfile }),
  );
  const payload = {
    ok: verification.ok && checksum.ok,
    prefix: request.prefix,
    entries,
    verification,
    checksum,
    urls,
  };
  const matchingRecord = findMatchingStatusRecord(readJobRecords(JOBS_DIR), request);
  payload.job = matchingRecord ? {
    jobId: matchingRecord.jobId || '',
    status: matchingRecord.status || 'unknown',
    startedAt: matchingRecord.startedAt || '',
    completedAt: matchingRecord.completedAt || '',
  } : null;
  payload.diagnostics = matchingRecord ? statusDiagnosticsFromRecord(matchingRecord) : null;

  if (options.json) {
    printJson(payload);
  } else {
    process.stdout.write(`${buildStatusSummary(payload)}\n`);
  }

  if (!verification.ok || !checksum.ok) {
    process.exitCode = 2;
  }
}

async function transferCommand(options, { dryRun }) {
  const activeProfile = await assertReady(options.profile);
  const request = normalizeUploadOptions(options);
  request.profile = activeProfile;
  const job = buildJobRecord({
    jobId: createJobId(dryRun ? 'dryrun' : 'upload'),
    sources: request.sources,
    prefix: request.prefix,
    include: request.include,
    filterMode: request.filterMode,
    checksumMode: options.checksum,
    profile: activeProfile,
    notifications: options.notifications,
    status: dryRun ? 'dry-run' : 'running',
  });
  writeJobRecord(JOBS_DIR, job);
  logJobEvent(job.jobId, 'job:start', {
    status: job.status,
    prefix: request.prefix,
    filterMode: request.filterMode,
    include: request.include,
  });

  try {
    const preflightEntries = request.sources.flatMap((source) =>
      collectLocalUploadEntries(source, request.include, request.filterMode, { folderUploadMode: request.folderUploadMode }),
    );
    if (!preflightEntries.length) {
      const error = new Error('No local files matched the active upload filter.');
      writeJobRecord(JOBS_DIR, buildJobRecord({
        ...job,
        status: 'blocked',
        completedAt: new Date().toISOString(),
        error: error.message,
      }));
      logJobEvent(job.jobId, 'job:blocked', { error: error.message });
      throw error;
    }

    for (const source of request.sources) {
      process.stderr.write(
        `${dryRun ? 'Dry run' : 'Upload'}: ${describeLocalSource(source)} -> ${activeProfile.remote}:${activeProfile.bucket}/${sourceDestinationPrefix(source, request.prefix, request.folderUploadMode)}/\n`,
      );
      await runRclone(
        buildCopyArgs({
          source,
          prefix: request.prefix,
          include: request.include,
          filterMode: request.filterMode,
          publicRead: request.publicRead,
          folderUploadMode: request.folderUploadMode,
          dryRun,
          profile: activeProfile,
        }),
        { stream: true, stdoutTarget: options.json ? 'stderr' : 'stdout', jobId: job.jobId },
      );
    }

    if (dryRun) {
      const record = buildJobRecord({
        ...job,
        status: 'ready',
        completedAt: new Date().toISOString(),
      });
      writeJobRecord(JOBS_DIR, record);
      logJobEvent(job.jobId, 'job:ready', { prefix: request.prefix, sourceCount: request.sources.length });
      if (options.json) {
        printJson({ ok: true, dryRun: true, jobId: job.jobId, prefix: request.prefix, sources: request.sources });
      }
      process.stderr.write('Dry run complete. No upload was performed.\n');
      return;
    }

    const localEntries = request.sources.flatMap((source) =>
      collectLocalUploadEntries(source, request.include, request.filterMode, { folderUploadMode: request.folderUploadMode }),
    );
    const remoteJson = await runRclone(buildJsonListArgs({ prefix: request.prefix, profile: activeProfile }));
    const report = buildVerificationReport({
      localEntries,
      remoteEntries: JSON.parse(remoteJson.stdout || '[]'),
      expectedSourceCount: request.sources.length,
    });
    const checksum = await buildChecksumReport({
      sources: request.sources,
      prefix: request.prefix,
      localEntries,
      include: request.include,
      filterMode: request.filterMode,
      folderUploadMode: request.folderUploadMode,
      mode: options.checksum,
      profile: activeProfile,
    });
    const urls = report.verified.map((entry) =>
      buildPublicUrl({ prefix: request.prefix, fileName: entry.name, profile: activeProfile }),
    );
    const status = report.ok && checksum.ok ? 'complete' : 'failed';
    const completedAt = new Date().toISOString();
    const baseRecord = buildJobRecord({
      ...job,
      status,
      completedAt,
      verification: report,
      checksum,
      urls,
    });
    const notificationPayload = buildNotificationPayload({
      job: baseRecord,
      status,
      verification: report,
      checksum,
      urls,
    });
    const notificationAttempts = await sendNotifications({
      notifications: options.notifications,
      payload: notificationPayload,
    });
    const finalStatus = status === 'complete' && notificationAttempts.some((attempt) => !attempt.ok)
      ? 'warning'
      : status;
    const finalRecord = buildJobRecord({
      ...baseRecord,
      status: finalStatus,
      notificationAttempts,
    });
    writeJobRecord(JOBS_DIR, finalRecord);
    logJobEvent(job.jobId, 'job:complete', {
      status: finalStatus,
      verified: report.verified.length,
      urls: urls.length,
    });

    if (options.json) {
      printJson({
        ok: report.ok && checksum.ok,
        jobId: job.jobId,
        prefix: request.prefix,
        verification: report,
        checksum,
        notifications: notificationAttempts,
        urls,
      });
    } else {
      process.stdout.write(`${formatVerificationSummary(report)}\n`);
      if (checksum.mode === 'sha256') {
        process.stdout.write(`Checksum ${checksum.ok ? 'OK' : 'FAILED'} verified=${checksum.verified.length} mismatched=${checksum.mismatched.length}\n`);
      }
      if (notificationAttempts.length) {
        process.stdout.write(`Notifications: ${notificationAttempts.filter((attempt) => attempt.ok).length}/${notificationAttempts.length} delivered\n`);
      }
      if (urls.length) {
        process.stdout.write(`${urls.join('\n')}\n`);
      }
    }

    if (!report.ok || !checksum.ok) {
      process.exitCode = 2;
    }
  } catch (error) {
    const completedAt = new Date().toISOString();
    const failedRecord = buildJobRecord({
      ...job,
      status: 'failed',
      completedAt,
      error: error.message,
    });
    const notificationPayload = buildNotificationPayload({
      job: failedRecord,
      status: 'failed',
      verification: null,
      checksum: null,
      urls: [],
      error: error.message,
    });
    const notificationAttempts = await sendNotifications({
      notifications: options.notifications,
      payload: notificationPayload,
    });
    writeJobRecord(JOBS_DIR, buildJobRecord({
      ...failedRecord,
      notificationAttempts,
    }));
    logJobEvent(job.jobId, 'job:failed', { error: error.message });
    throw error;
  }
}

async function main() {
  const { command, options } = parseCliArgs(process.argv.slice(2));

  if (command === 'help') {
    process.stdout.write(`${buildHelp()}\n`);
  } else if (command === 'check') {
    await checkCommand(options);
  } else if (command === 'list') {
    await listCommand(options);
  } else if (command === 'inventory') {
    await inventoryCommand(options);
  } else if (command === 'urls') {
    await urlsCommand(options);
  } else if (command === 'verify') {
    await verifyCommand(options);
  } else if (command === 'status') {
    await statusCommand(options);
  } else if (command === 'dry-run') {
    await transferCommand(options, { dryRun: true });
  } else if (command === 'upload') {
    await transferCommand(options, { dryRun: false });
  } else if (command === 'event') {
    await eventCommand(options);
  }
}

main().catch((error) => {
  process.stderr.write(`[murdawk-uplink] ${error.message}\n`);
  process.exit(1);
});
