(function attachExplorerUiCore(root, factory) {
  const core = factory(root);
  if (typeof module === 'object' && module.exports) {
    module.exports = core;
  }
  if (root) {
    root.explorerUiCore = core;
  }
})(typeof window !== 'undefined' ? window : globalThis, function createExplorerUiCore(root) {
  const queueRecoveryCore = root?.queueRecoveryCore
    || (typeof require === 'function' ? require('../queue-recovery-core') : null);
  const connectionCore = root?.connectionCore
    || (typeof require === 'function' ? require('../connection-core') : null);
  const DEFAULT_COMPATIBILITY_PROFILE = {
    remote: 'media',
    bucket: 'media',
    endpointHost: 'media.nyc3.digitaloceanspaces.com',
  };

  function normalizeRemotePrefix(prefix = '') {
    return String(prefix || '')
      .replace(/\\/g, '/')
      .replace(/^\/+|\/+$/g, '')
      .replace(/\/{2,}/g, '/');
  }

  function joinRemotePath(...parts) {
    return parts
      .map((part) => normalizeRemotePrefix(part))
      .filter(Boolean)
      .join('/');
  }

  function normalizeNewFolderName(name = '') {
    return normalizeRemotePrefix(String(name || '').trim())
      .split('/')
      .filter((part) => part && part !== '.' && part !== '..')
      .join('/');
  }

  function buildNewFolderPlaceholderPath({
    currentPrefix = '',
    folderName = '',
  } = {}) {
    const cleanName = normalizeNewFolderName(folderName);
    if (!cleanName) {
      return '';
    }
    return joinRemotePath(currentPrefix, cleanName, '.keep');
  }

  function buildFolderPlaceholderPath(prefix = '') {
    const cleanPrefix = normalizeRemotePrefix(prefix);
    if (!cleanPrefix) {
      return '';
    }
    return joinRemotePath(cleanPrefix, '.keep');
  }

  function queueJobId() {
    return `queue-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function queueJobStatusLabel(statusOrJob = 'queued') {
    const status = typeof statusOrJob === 'object' ? statusOrJob?.status || 'queued' : statusOrJob;
    const direction = typeof statusOrJob === 'object' ? statusOrJob?.direction || 'upload' : 'upload';
    const labels = {
      queued: 'Queued',
      'dry-run': 'Dry run',
      prechecking: 'Checking',
      ready: 'Ready',
      uploading: 'Uploading',
      verifying: 'Verifying',
      pausing: 'Pausing',
      paused: 'Paused',
      complete: 'Complete',
      failed: 'Failed',
      blocked: 'Blocked',
      cancelled: 'Cancelled',
      'needs-resume-check': 'Needs resume check',
    };
    if (direction === 'download' && status === 'uploading') return 'Downloading';
    if (direction === 'download' && status === 'prechecking') return 'Checking download';
    return labels[status] || status;
  }

  function normalizeRemoteItems(items = []) {
    if (!Array.isArray(items)) return [];
    return items.slice(0, 1_000).map((item) => ({
      name: typeof item?.name === 'string' ? item.name.trim() : '',
      path: normalizeRemotePrefix(item?.path || ''),
      isDir: Boolean(item?.isDir),
      size: Math.max(0, Number(item?.size || 0)),
      modified: typeof item?.modified === 'string' ? item.modified : '',
    })).filter((item) => item.name && item.path && !/[\\/]/.test(item.name));
  }

  function normalizeSourceList(sources = []) {
    return Array.isArray(sources)
      ? sources
        .filter((source) => typeof source === 'string' && source.trim())
        .map((source) => source.replace(/\\/g, '/').toLowerCase())
        .sort()
      : [];
  }

  function sameSources(left = [], right = []) {
    const a = normalizeSourceList(left);
    const b = normalizeSourceList(right);
    return a.length === b.length && a.every((source, index) => source === b[index]);
  }

  function destinationProfileIdentity(profile = {}) {
    const normalized = connectionCore.normalizeConnectionProfile(profile);
    return normalized.remote && normalized.bucket && normalized.endpointHost
      ? connectionCore.canonicalConnectionTuple(normalized)
      : '';
  }

  function recordProfileMatchesJob(record = {}, job = {}) {
    const jobIdentity = destinationProfileIdentity(job.profile);
    if (record.profile === undefined || record.profile === null) {
      return jobIdentity === destinationProfileIdentity(DEFAULT_COMPATIBILITY_PROFILE);
    }
    const recordIdentity = destinationProfileIdentity(record.profile);
    return Boolean(recordIdentity) && recordIdentity === jobIdentity;
  }

  function recordAssociationMatchesJob(record = {}, job = {}) {
    const recordIntentId = queueRecoveryCore.canonicalQueueIntent(record);
    if (recordIntentId) {
      return recordIntentId === queueRecoveryCore.canonicalQueueIntent(job);
    }
    return Boolean(job.jobId) && record.jobId === job.jobId;
  }

  function findMatchingJobRecord(job = {}, records = [], predicate = () => true) {
    return records.find((record) =>
      record
      && (record.direction === 'download' ? 'download' : 'upload') === (job.direction === 'download' ? 'download' : 'upload')
      && normalizeRemotePrefix(record.prefix || '') === normalizeRemotePrefix(job.prefix || '')
      && sameSources(record.sources || [], job.sources || [])
      && recordProfileMatchesJob(record, job)
      && recordAssociationMatchesJob(record, job)
      && predicate(record));
  }

  function createQueueJob({
    id = '',
    intentId = '',
    clientJobId = '',
    sources = [],
    settings = {},
    status = 'queued',
    jobId = '',
    resumeFromJobId = '',
    urls = [],
    error = '',
    verification = null,
  } = {}) {
    const cleanSources = Array.isArray(sources)
      ? sources.filter((source) => typeof source === 'string' && source.trim())
      : [];
    const notifications = {
      webhook: typeof settings.notifyWebhook === 'string' ? settings.notifyWebhook.trim() : '',
      ntfy: typeof settings.notifyNtfy === 'string' ? settings.notifyNtfy.trim() : '',
      notifyOn: ['success', 'failure', 'always'].includes(settings.notifyOn) ? settings.notifyOn : 'success',
    };
    const queueId = id || queueJobId();
    const rawProfile = {
      remote: settings.profileSnapshot?.remote || settings.profile?.remote || settings.remote || 'media',
      bucket: settings.profileSnapshot?.bucket || settings.profile?.bucket || settings.bucket || 'media',
      endpointHost: settings.profileSnapshot?.endpointHost || settings.profile?.endpointHost || settings.endpointHost || 'media.nyc3.digitaloceanspaces.com',
    };
    const binding = connectionCore.resolveConnectionBinding({
      connections: settings.connections,
      connectionId: settings.connectionId,
      profile: rawProfile,
    });
    const profile = Object.freeze({ ...binding.profile });
    const profileSnapshot = Object.freeze({ ...binding.profile });
    const job = {
      id: queueId,
      intentId: String(intentId || settings.intentId || '').trim().slice(0, 256),
      clientJobId: String(clientJobId || settings.clientJobId || '').trim().slice(0, 256),
      sources: cleanSources,
      connectionId: binding.connectionId,
      profile,
      profileSnapshot,
      prefix: normalizeRemotePrefix(settings.prefix || ''),
      filterMode: ['all', 'videos-images', 'media-docs', 'custom'].includes(settings.filterMode)
        ? settings.filterMode
        : 'all',
      include: typeof settings.include === 'string' ? settings.include.trim() : '',
      folderUploadMode: settings.folderUploadMode === 'contents' ? 'contents' : 'package',
      publicRead: settings.publicRead !== false,
      checksum: ['size', 'sha256'].includes(settings.checksum) ? settings.checksum : 'sha256',
      notifications,
      status,
      jobId,
      resumeFromJobId: String(resumeFromJobId || settings.resumeFromJobId || '').trim().slice(0, 256),
      urls: Array.isArray(urls) ? urls : [],
      error,
      verification,
      direction: settings.direction === 'download' ? 'download' : 'upload',
      localDestination: settings.direction === 'download' ? String(settings.localDestination || '').trim() : '',
      remoteItems: settings.direction === 'download' ? normalizeRemoteItems(settings.remoteItems) : [],
    };
    job.persistable = {
      ...job,
      notifications: {
        webhook: '',
        ntfy: '',
        notifyOn: notifications.notifyOn,
      },
      persistable: undefined,
    };
    return job;
  }

  function createHistoryResumeQueueJob(record = {}, fallbackProfile = DEFAULT_COMPATIBILITY_PROFILE) {
    return createQueueJob({
      sources: Array.isArray(record.sources) ? record.sources : [],
      settings: {
        connectionId: record.connectionId || '',
        profileSnapshot: record.profileSnapshot || record.profile || fallbackProfile,
        profile: record.profileSnapshot || record.profile || fallbackProfile,
        prefix: record.prefix,
        filterMode: record.filterMode || 'all',
        include: record.include || '',
        checksum: record.checksumMode || 'sha256',
        folderUploadMode: record.folderUploadMode || 'package',
        publicRead: record.publicRead !== false,
        direction: record.direction === 'download' ? 'download' : 'upload',
        localDestination: record.localDestination || '',
        remoteItems: record.remoteItems || [],
      },
      status: 'queued',
      resumeFromJobId: record.jobId || '',
      error: `Resume check required from ${record.jobId || 'history job'}.`,
    });
  }

  function queueJobRequest(job = {}) {
    return {
      intentId: queueRecoveryCore.canonicalQueueIntent(job),
      resumeFromJobId: job.resumeFromJobId || '',
      sources: Array.isArray(job.sources) ? job.sources : [],
      connectionId: job.connectionId || '',
      profileSnapshot: job.profileSnapshot || job.profile || { remote: 'media', bucket: 'media', endpointHost: 'media.nyc3.digitaloceanspaces.com' },
      profile: job.profileSnapshot || job.profile || { remote: 'media', bucket: 'media', endpointHost: 'media.nyc3.digitaloceanspaces.com' },
      prefix: job.prefix,
      filterMode: job.filterMode,
      include: job.include,
      folderUploadMode: job.folderUploadMode,
      publicRead: job.publicRead,
      checksum: job.checksum,
      notifyWebhook: job.notifications?.webhook || '',
      notifyNtfy: job.notifications?.ntfy || '',
      notifyOn: job.notifications?.notifyOn || 'success',
      direction: job.direction === 'download' ? 'download' : 'upload',
      localDestination: job.direction === 'download' ? job.localDestination || '' : '',
      remoteItems: job.direction === 'download' ? normalizeRemoteItems(job.remoteItems) : [],
    };
  }

  function queueUploadRequests(jobs = []) {
    return jobs
      .filter((job) => job.status === 'ready')
      .map((job) => ({
        clientJobId: job.id,
        ...queueJobRequest(job),
      }));
  }

  function queueSourceName(source = '') {
    return String(source || '').replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || '';
  }

  function sourceLooksLikeFile(source = '') {
    const name = queueSourceName(source);
    return /\.[^./\\]+$/.test(name);
  }

  function queueJobDestinationLabel(job = {}, profile = job.profile || { remote: 'media', bucket: 'media' }) {
    if (job.direction === 'download') return job.localDestination || 'Choose local folder';
    const prefix = normalizeRemotePrefix(job.prefix || '');
    return `${profile.remote}:${profile.bucket}/${prefix}${prefix ? '/' : ''}`;
  }

  function queueJobPlacementPreview(job = {}, limit = 8) {
    if (job.direction === 'download') {
      const remoteItems = normalizeRemoteItems(job.remoteItems);
      const root = String(job.localDestination || '').replace(/[\\/]+$/g, '');
      return {
        destination: root,
        sourceCount: remoteItems.length,
        fileCount: remoteItems.filter((item) => !item.isDir).length,
        folderCount: remoteItems.filter((item) => item.isDir).length,
        examples: remoteItems.slice(0, limit).map((item) => `${item.path} -> ${root}\\${item.name}${item.isDir ? '\\...' : ''}`),
      };
    }
    const prefix = normalizeRemotePrefix(job.prefix || '');
    const sources = Array.isArray(job.sources) ? job.sources : [];
    let fileCount = 0;
    let folderCount = 0;
    const examples = [];

    for (const source of sources) {
      const name = queueSourceName(source);
      if (!name) continue;
      const isFile = sourceLooksLikeFile(source);
      if (isFile) {
        fileCount += 1;
      } else {
        folderCount += 1;
      }
      if (examples.length < limit) {
        if (job.folderUploadMode === 'contents') {
          examples.push(`${name} -> ${prefix}/...`);
        } else if (isFile) {
          examples.push(`${name} -> ${joinRemotePath(prefix, name)}`);
        } else {
          examples.push(`${name} -> ${joinRemotePath(prefix, name)}/...`);
        }
      }
    }

    return {
      destination: prefix,
      sourceCount: sources.length,
      fileCount,
      folderCount,
      examples,
    };
  }

  function queueJobCountDetail(job = {}) {
    const sourceCount = Array.isArray(job.sources) ? job.sources.length : 0;
    const sourceNoun = job.direction === 'download' ? 'remote item' : 'job source';
    const sourceDetail = `${sourceCount} ${sourceNoun}${sourceCount === 1 ? '' : 's'}`;
    const verification = job.verification;
    const countGroups = ['verified', 'missing', 'sizeMismatch'];
    const hasExpandedCount = verification
      && countGroups.some((key) => Array.isArray(verification[key]));

    if (!hasExpandedCount) return sourceDetail;

    const fileCount = countGroups.reduce(
      (total, key) => total + (Array.isArray(verification[key]) ? verification[key].length : 0),
      0,
    );
    return `${sourceDetail} / ${fileCount} actual file${fileCount === 1 ? '' : 's'}`;
  }

  function queueWithJobStatus(jobs = [], jobId = '', status = 'queued', patch = {}) {
    return jobs.map((job) =>
      job.id === jobId
        ? {
          ...job,
          ...patch,
          status,
          persistable: {
            ...(job.persistable || job),
            ...patch,
            status,
            notifications: {
              webhook: '',
              ntfy: '',
              notifyOn: job.notifications?.notifyOn || 'success',
            },
            persistable: undefined,
          },
        }
        : job);
  }

  function queueCanUploadAll(jobs = []) {
    const pending = jobs.filter((job) => job.status !== 'complete');
    if (!pending.length) {
      return { ok: false, reason: 'No queued jobs are ready.' };
    }
    const blocked = pending.find((job) => job.status !== 'ready');
    if (blocked?.status === 'needs-resume-check') {
      return {
        ok: false,
        reason: 'A previous upload stopped mid-job. Use Check and resume before continuing.',
      };
    }
    return blocked
      ? { ok: false, reason: `Job ${blocked.id} is ${queueJobStatusLabel(blocked.status).toLowerCase()}.` }
      : { ok: true, reason: '' };
  }

  function queueNextUploadJob(jobs = []) {
    return jobs.find((job) => job.status === 'ready') || null;
  }

  function queueLifecycleGate({
    isRunning = false,
    externalLifecycle = false,
    ownedLifecycle = false,
    error = null,
  } = {}) {
    const errorCode = String(error?.code || '');
    const errorMessage = String(error?.message || error || '');
    const externalConflict = externalLifecycle
      || error?.externalLifecycle === true
      || errorCode === 'ETRANSFERACTIVE'
      || /ETRANSFERACTIVE|transfer lifecycle .*already active/i.test(errorMessage);
    if (externalConflict) {
      return {
        ok: false,
        externalLifecycle: true,
        waitingStatus: 'needs-resume-check',
        message: 'Waiting for another transfer lifecycle to finish.',
      };
    }
    if (isRunning && !ownedLifecycle) {
      return {
        ok: false,
        externalLifecycle: false,
        waitingStatus: '',
        message: 'Another transfer lifecycle is active.',
      };
    }
    return { ok: true, externalLifecycle: false, waitingStatus: '', message: '' };
  }

  function queueNextAutomaticAction(jobs = []) {
    if (jobs.some((job) => ['failed', 'blocked'].includes(job.status))) return null;
    if (jobs.some((job) => ['prechecking', 'uploading', 'verifying', 'pausing'].includes(job.status))) return null;
    const job = jobs.find((candidate) => candidate.status !== 'complete') || null;
    if (!job) return null;
    if (job.status === 'ready') return { type: 'upload', job };
    if (job.status === 'queued') return { type: 'precheck', job };
    return null;
  }

  function queueNextPrecheckJob(jobs = []) {
    const action = queueNextAutomaticAction(jobs);
    return action?.type === 'precheck' ? action.job : null;
  }

  function queueJobIdentity(job = {}) {
    return JSON.stringify({
      direction: job.direction === 'download' ? 'download' : 'upload',
      sources: job.direction === 'download'
        ? (Array.isArray(job.sources) ? job.sources.slice().sort() : [])
        : normalizeSourceList(job.sources),
      prefix: normalizeRemotePrefix(job.prefix || ''),
      destination: destinationProfileIdentity(job.profile || {}),
      localDestination: job.direction === 'download' ? String(job.localDestination || '').toLowerCase() : '',
    });
  }

  function appendUniqueQueueJobs(jobs = [], candidates = []) {
    const identities = new Set(jobs.map(queueJobIdentity));
    const intents = new Set(jobs.map(queueRecoveryCore.canonicalQueueIntent).filter(Boolean));
    const added = [];
    const duplicates = [];
    for (const candidate of candidates) {
      const identity = queueJobIdentity(candidate);
      const intent = queueRecoveryCore.canonicalQueueIntent(candidate);
      if (identities.has(identity) || (intent && intents.has(intent))) {
        duplicates.push(candidate);
        continue;
      }
      identities.add(identity);
      if (intent) intents.add(intent);
      added.push(candidate);
    }
    return { jobs: [...jobs, ...added], added, duplicates };
  }

  function queueJobStatusHint(job = {}) {
    if (job.status === 'uploading') {
      return 'Live rclone process is attached. Check activity before closing the app.';
    }
    if (job.status === 'needs-resume-check') {
      return 'Stopped without a matching active transfer. Use Check and resume to inspect this job; rclone will skip matching files with --size-only.';
    }
    if (job.status === 'paused') {
      return 'Paused safely. Check and resume will inspect remote files before continuing.';
    }
    if (job.error) return job.error;
    if (job.verification?.verified) return `${job.verification.verified.length} verified`;
    if (job.urls?.length) return `${job.urls.length} URL(s)`;
    return `${job.filterMode}, ${job.folderUploadMode}`;
  }

  function reconcileQueueJobsWithRecords(jobs = [], records = [], options = {}) {
    const activeTransfer = options.activeTransfer || options.activeJobId || null;
    const activeJobId = typeof activeTransfer === 'string'
      ? activeTransfer
      : activeTransfer?.activeJobId || '';
    return jobs.map((job) => {
      const hasModernActiveIdentity = activeTransfer
        && typeof activeTransfer === 'object'
        && queueRecoveryCore.canonicalQueueIntent(activeTransfer);
      if (hasModernActiveIdentity && queueRecoveryCore.activeTransferMatchesJob(job, activeTransfer)) {
        const livePhase = typeof activeTransfer === 'object' ? activeTransfer?.phase : '';
        const liveStatus = ['prechecking', 'uploading', 'verifying', 'pausing'].includes(livePhase)
          ? livePhase
          : ['prechecking', 'uploading', 'verifying', 'pausing'].includes(job.status)
            ? job.status
            : 'uploading';
        return {
          ...job,
          status: liveStatus,
          jobId: activeJobId || job.jobId,
          error: '',
          persistable: {
            ...(job.persistable || job),
            status: liveStatus,
            jobId: activeJobId || job.jobId,
            error: '',
            notifications: {
              webhook: '',
              ntfy: '',
              notifyOn: job.notifications?.notifyOn || 'success',
            },
            persistable: undefined,
          },
        };
      }
      const recovered = queueRecoveryCore.recoverPersistedJob(job, activeTransfer);
      const completed = findMatchingJobRecord(recovered, records, (record) =>
        ['complete', 'warning'].includes(record.status)
        && record.verification?.ok === true
        && Array.isArray(record.verification?.missing)
        && record.verification.missing.length === 0);
      if (completed) {
        return {
          ...recovered,
          status: 'complete',
          jobId: completed.jobId || recovered.jobId,
          urls: Array.isArray(completed.urls) ? completed.urls : [],
          verification: completed.verification || null,
          error: '',
          persistable: {
            ...(recovered.persistable || recovered),
            status: 'complete',
            jobId: completed.jobId || recovered.jobId,
            urls: Array.isArray(completed.urls) ? completed.urls : [],
            verification: completed.verification || null,
            error: '',
            notifications: {
              webhook: '',
              ntfy: '',
              notifyOn: recovered.notifications?.notifyOn || 'success',
            },
            persistable: undefined,
          },
        };
      }

      const paused = findMatchingJobRecord(recovered, records, (record) => record.status === 'paused');
      if (paused) {
        return {
          ...recovered,
          status: 'paused',
          jobId: paused.jobId || recovered.jobId,
          error: '',
          persistable: {
            ...(recovered.persistable || recovered),
            status: 'paused',
            jobId: paused.jobId || recovered.jobId,
            error: '',
            notifications: {
              webhook: '',
              ntfy: '',
              notifyOn: recovered.notifications?.notifyOn || 'success',
            },
            persistable: undefined,
          },
        };
      }

      const running = findMatchingJobRecord(recovered, records, (record) => record.status === 'running');
      const activeMatches = running && running.jobId === activeJobId && (
        options.activeTransfer
          ? queueRecoveryCore.activeTransferMatchesJob(recovered, activeTransfer)
          : true
      );
      if (activeMatches) {
        const livePhase = typeof activeTransfer === 'object' ? activeTransfer?.phase : '';
        const liveStatus = ['prechecking', 'uploading', 'verifying', 'pausing'].includes(livePhase)
          ? livePhase
          : ['prechecking', 'uploading', 'verifying', 'pausing'].includes(recovered.status)
            ? recovered.status
            : 'uploading';
        return {
          ...recovered,
          status: liveStatus,
          jobId: running.jobId || recovered.jobId,
          error: '',
          persistable: {
            ...(recovered.persistable || recovered),
            status: liveStatus,
            jobId: running.jobId || recovered.jobId,
            error: '',
            notifications: {
              webhook: '',
              ntfy: '',
              notifyOn: recovered.notifications?.notifyOn || 'success',
            },
            persistable: undefined,
          },
        };
      }
      if (running && !activeMatches) {
        const interruptedError = recovered.error
          || 'Upload job record was running, but no matching active transfer is attached.';
        return {
          ...recovered,
          status: 'needs-resume-check',
          jobId: running.jobId || recovered.jobId,
          error: interruptedError,
          persistable: {
            ...(recovered.persistable || recovered),
            status: 'needs-resume-check',
            jobId: running.jobId || recovered.jobId,
            error: interruptedError,
            notifications: {
              webhook: '',
              ntfy: '',
              notifyOn: recovered.notifications?.notifyOn || 'success',
            },
            persistable: undefined,
          },
        };
      }

      const cancelled = findMatchingJobRecord(recovered, records, (record) => record.status === 'cancelled');
      if (cancelled) {
        return {
          ...recovered,
          status: 'cancelled',
          jobId: cancelled.jobId || recovered.jobId,
          error: cancelled.error || 'Upload cancelled.',
          verification: cancelled.verification || recovered.verification || null,
          persistable: {
            ...(recovered.persistable || recovered),
            status: 'cancelled',
            jobId: cancelled.jobId || recovered.jobId,
            error: cancelled.error || 'Upload cancelled.',
            verification: cancelled.verification || recovered.verification || null,
            notifications: {
              webhook: '',
              ntfy: '',
              notifyOn: recovered.notifications?.notifyOn || 'success',
            },
            persistable: undefined,
          },
        };
      }

      const failed = findMatchingJobRecord(recovered, records, (record) => ['failed', 'blocked'].includes(record.status));
      if (failed
        && ['queued', 'needs-resume-check'].includes(recovered.status)
        && recovered.resumeFromJobId === failed.jobId) {
        return recovered;
      }
      if (failed) {
        return {
          ...recovered,
          status: 'failed',
          jobId: failed.jobId || recovered.jobId,
          error: failed.error || 'Upload failed.',
          verification: failed.verification || recovered.verification || null,
          persistable: {
            ...(recovered.persistable || recovered),
            status: 'failed',
            jobId: failed.jobId || recovered.jobId,
            error: failed.error || 'Upload failed.',
            verification: failed.verification || recovered.verification || null,
            notifications: {
              webhook: '',
              ntfy: '',
              notifyOn: recovered.notifications?.notifyOn || 'success',
            },
            persistable: undefined,
          },
        };
      }

      return recovered;
    });
  }

  function isSameOrDescendantFolder(sourcePath, targetFolderPath) {
    const source = normalizeRemotePrefix(sourcePath);
    const target = normalizeRemotePrefix(targetFolderPath);
    return source && (target === source || target.startsWith(`${source}/`));
  }

  function buildRemoteMovePlan({ items = [], targetFolderPath = '' } = {}) {
    const targetFolder = normalizeRemotePrefix(targetFolderPath);
    const operations = [];
    const skipped = [];

    for (const item of items) {
      if (!item || !item.path || !item.name) {
        skipped.push({ item, reason: 'Missing remote item path.' });
        continue;
      }

      if (item.isDir && isSameOrDescendantFolder(item.path, targetFolder)) {
        skipped.push({ item, reason: 'Cannot move a folder into itself.' });
        continue;
      }

      const targetPrefix = joinRemotePath(targetFolder, item.name);
      if (normalizeRemotePrefix(item.path) === targetPrefix) {
        skipped.push({ item, reason: 'Already in this folder.' });
        continue;
      }

      operations.push({
        action: 'move',
        item,
        targetPrefix,
      });
    }

    return { operations, skipped };
  }

  function hasDragType(types = [], targetType = '') {
    return [...types].some((type) => String(type).toLowerCase() === targetType.toLowerCase());
  }

  function dragHasLocalFiles(dataTransfer = {}) {
    const fileCount = dataTransfer.files?.length || 0;
    return fileCount > 0 || hasDragType(dataTransfer.types || [], 'Files');
  }

  function dragHasRemoteItems(dataTransfer = {}) {
    return hasDragType(dataTransfer.types || [], 'application/x-murdawk-remote');
  }

  function resolveSelectionIndexes({
    currentIndexes = [],
    clickedIndex = -1,
    anchorIndex = -1,
    total = 0,
    additive = false,
    range = false,
  } = {}) {
    const current = new Set(currentIndexes);
    const clicked = Number(clickedIndex);
    const max = Number(total) - 1;

    if (!Number.isInteger(clicked) || clicked < 0 || clicked > max) {
      return { selectedIndexes: [], selectedIndex: -1, anchorIndex: -1 };
    }

    if (range) {
      const anchor = Number.isInteger(anchorIndex) && anchorIndex >= 0 && anchorIndex <= max
        ? anchorIndex
        : clicked;
      const start = Math.min(anchor, clicked);
      const end = Math.max(anchor, clicked);
      const next = additive ? new Set(current) : new Set();
      for (let index = start; index <= end; index += 1) {
        next.add(index);
      }
      return {
        selectedIndexes: [...next].sort((a, b) => a - b),
        selectedIndex: clicked,
        anchorIndex: anchor,
      };
    }

    if (additive) {
      if (current.has(clicked)) {
        current.delete(clicked);
      } else {
        current.add(clicked);
      }
      const selectedIndexes = [...current].sort((a, b) => a - b);
      return {
        selectedIndexes,
        selectedIndex: selectedIndexes.at(-1) ?? -1,
        anchorIndex: clicked,
      };
    }

    return {
      selectedIndexes: [clicked],
      selectedIndex: clicked,
      anchorIndex: clicked,
    };
  }

  function resolveMoveTargets({ items = [], target = '', mode = 'folder' } = {}) {
    if (mode === 'exact' && items.length === 1) {
      const cleanTarget = normalizeRemotePrefix(target);
      if (!cleanTarget) {
        return { operations: [], skipped: [{ item: items[0], reason: 'Target path is required.' }] };
      }
      if (items[0].isDir && isSameOrDescendantFolder(items[0].path, cleanTarget)) {
        return { operations: [], skipped: [{ item: items[0], reason: 'Cannot move a folder into itself.' }] };
      }
      return {
        operations: [{
          action: 'move',
          item: items[0],
          targetPrefix: cleanTarget,
        }],
        skipped: [],
      };
    }

    return buildRemoteMovePlan({ items, targetFolderPath: target });
  }

  function mergeRecentPrefixes(existing = [], nextPrefix = '', limit = 6) {
    const next = normalizeRemotePrefix(nextPrefix);
    return [next, ...existing]
      .map((prefix) => normalizeRemotePrefix(prefix))
      .filter(Boolean)
      .filter((prefix, index, list) => list.indexOf(prefix) === index)
      .slice(0, limit);
  }

  function classifyRemotePath(prefix = '') {
    const clean = normalizeRemotePrefix(prefix);
    if (clean.includes('/edits/livestream/')) {
      return { label: 'Livestream-ready', className: 'badge-livestream' };
    }
    if (clean.includes('/edits/youtube/')) {
      return { label: 'YouTube-ready', className: 'badge-youtube' };
    }
    if (clean.includes('/edits/talks/')) {
      return { label: 'Talks-ready', className: 'badge-youtube' };
    }
    if (clean.includes('/raw/') || clean.endsWith('/raw')) {
      return { label: 'Archive / Raw', className: 'badge-raw' };
    }
    if (clean.includes('/stage-2') || clean.endsWith('/stage-2')) {
      return { label: 'Stage 2', className: 'badge-stage' };
    }
    return { label: 'Unclassified', className: 'badge-unknown' };
  }

  function formatInventoryReport({ prefix = '', entries = [] } = {}) {
    const files = entries.filter((entry) => !entry.isDir);
    const lines = [
      `Remote folder: ${normalizeRemotePrefix(prefix) || '(root)'}`,
      '',
      '| File location | Size | Public URL |',
      '|---|---:|---|',
    ];
    if (!files.length) {
      lines.push('| No files selected | - | - |');
      return lines.join('\n');
    }
    for (const entry of files) {
      lines.push(`| ${entry.path || entry.name || ''} | ${entry.displaySize || '-'} | ${entry.publicUrl || '-'} |`);
    }
    return lines.join('\n');
  }

  function secondsSince(timestamp = '', now = Date.now()) {
    const time = Date.parse(timestamp);
    if (!Number.isFinite(time)) {
      return null;
    }
    return Math.max(0, Math.round((Number(now) - time) / 1000));
  }

  function formatAge(seconds) {
    if (seconds === null) return '-';
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    if (minutes < 60) return `${minutes}m ${rest}s ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m ago`;
  }

  function appendBoundedLogText(existing = '', next = '', { maxLines = 600, maxChars = 160000 } = {}) {
    const combined = `${String(existing || '')}${String(next || '').endsWith('\n') ? next : `${next}\n`}`;
    let text = combined;
    let trimmedLines = 0;
    let trimmedChars = 0;

    const lines = text.split(/\r?\n/);
    const hadTrailingNewline = lines.at(-1) === '';
    const contentLines = hadTrailingNewline ? lines.slice(0, -1) : lines;
    if (contentLines.length > maxLines) {
      trimmedLines = contentLines.length - maxLines;
      text = [
        `[trimmed ${trimmedLines} older log line(s)]`,
        ...contentLines.slice(-maxLines),
      ].join('\n');
      text = `${text}\n`;
    }

    if (text.length > maxChars) {
      trimmedChars = text.length - maxChars;
      text = `[trimmed older log text]\n${text.slice(-maxChars)}`;
      if (!text.endsWith('\n')) text = `${text}\n`;
    }

    return { text, trimmedLines, trimmedChars };
  }

  function summarizeDiagnosticsFallback(diagnostics = {}) {
    const state = diagnostics.state || 'healthy';
    const labels = {
      quiet: 'Still uploading (quiet)',
      slow: 'Uploading slowly',
      stalled: diagnostics.isRunning ? 'Possible stall' : 'Needs resume check',
      verifying: 'Verifying upload',
      complete: 'Upload complete',
      failed: 'Upload failed',
      cancelled: 'Upload cancelled',
      healthy: diagnostics.isRunning
        ? `rclone running${diagnostics.pid ? ` (PID ${diagnostics.pid})` : ''}`
        : 'No active rclone transfer',
    };
    const speed = diagnostics.speed || {};
    const tuning = diagnostics.tuning || {};
    return {
      label: labels[state] || labels.healthy,
      detail: diagnostics.currentFile
        ? `${diagnostics.currentFile} - ${diagnostics.safeAction || ''}`.trim()
        : diagnostics.safeAction || 'Safe to close if no queue job is uploading.',
      lastOutput: formatAge(diagnostics.lastOutputAgeSeconds),
      process: diagnostics.mode || (diagnostics.isRunning ? 'upload' : '-'),
      className: state === 'healthy' ? 'running' : state,
      metrics: [
        `current ${speed.current || '-'}`,
        `avg ${speed.rollingAverage || '-'}`,
        `peak ${speed.peak || '-'}`,
      ].join(' | '),
      tuning: `transfers ${tuning.transfers || 4}, chunk ${tuning.chunkSize || '64M'}, concurrency ${tuning.uploadConcurrency || 4}`,
      safeAction: diagnostics.safeAction || '',
      recommendation: diagnostics.recommendation || '',
    };
  }

  function summarizeDiagnostics(diagnostics = {}) {
    const helper = root?.transferDiagnosticsCore?.summarizeDiagnosticsForDisplay;
    return typeof helper === 'function'
      ? helper(diagnostics)
      : summarizeDiagnosticsFallback(diagnostics);
  }

  function summarizeActiveTransfer(transfer = {}, now = Date.now()) {
    if (transfer?.diagnostics) {
      return summarizeDiagnostics(transfer.diagnostics);
    }
    if (!transfer?.isRunning && !transfer?.activeJobId) {
      return {
        label: 'No active rclone transfer',
        detail: 'Safe to close if no queue job is uploading.',
        lastOutput: '-',
        process: '-',
        className: 'idle',
        metrics: 'current - | avg - | peak -',
        tuning: 'transfers 4, chunk 64M, concurrency 4',
        safeAction: 'Safe to close if no queue job is uploading.',
        recommendation: 'Current settings are conservative.',
      };
    }
    const lastOutputSeconds = secondsSince(transfer.lastOutputAt || transfer.lastProgressAt || transfer.startedAt, now);
    if (!transfer.isRunning) {
      return {
        label: 'Needs resume check',
        detail: `No live rclone process found for ${transfer.activeJobId || 'the running job'}.`,
        lastOutput: formatAge(lastOutputSeconds),
        process: transfer.mode || 'upload',
        className: 'stale',
        metrics: 'current - | avg - | peak -',
        tuning: 'transfers 4, chunk 64M, concurrency 4',
        safeAction: 'Run a resume check before retrying.',
        recommendation: 'Do not retry blindly; verify what committed first.',
      };
    }

    const label = lastOutputSeconds !== null && lastOutputSeconds >= 60
      ? 'Still uploading (quiet)'
      : `rclone running${transfer.pid ? ` (PID ${transfer.pid})` : ''}`;
    const detail = lastOutputSeconds !== null && lastOutputSeconds >= 60
      ? `No recent output, but rclone PID ${transfer.pid || '?'} is still running.`
      : transfer.currentFile || transfer.source || transfer.activeJobId || 'Active transfer';
    return {
      label,
      detail,
      lastOutput: formatAge(lastOutputSeconds),
      process: transfer.mode || 'upload',
      className: lastOutputSeconds !== null && lastOutputSeconds >= 60 ? 'quiet' : 'running',
      metrics: `current ${transfer.speed || '-'} | avg - | peak -`,
      tuning: 'transfers 4, chunk 64M, concurrency 4',
      safeAction: lastOutputSeconds !== null && lastOutputSeconds >= 60
        ? 'Keep uploading if the rclone process is still alive.'
        : 'Keep uploading; verification is still the source of truth.',
      recommendation: 'Current settings are conservative.',
    };
  }

  function slugPart(value, fallback) {
    const clean = String(value || fallback || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return clean || fallback;
  }

  function compactNumberedPart(value, fallbackPrefix, fallbackNumber) {
    const clean = String(value || '').trim().toLowerCase();
    const number = clean.match(/\d+/)?.[0] || fallbackNumber;
    return `${fallbackPrefix}${number}`;
  }

  function buildArchiveDestination({
    event = 'archive-event',
    category = 'raw',
    stage = 'stage1',
    day = 'day1',
  } = {}) {
    const eventPart = slugPart(event, 'archive-event');
    const stagePart = compactNumberedPart(stage, 'stage', '1');
    const dayPart = compactNumberedPart(day, 'day', '1');
    if (category === 'livestream') {
      return `${eventPart}/recordings/edits/livestream/${stagePart}/${dayPart}`;
    }
    if (category === 'talks') {
      return `${eventPart}/recordings/edits/talks/${stagePart}/${dayPart}`;
    }
    return `${eventPart}/recordings/raw/${stagePart}/${dayPart}`;
  }

  function buildArchivePackageTarget(options = {}) {
    const packageName = slugPart(options.packageName, 'package');
    return joinRemotePath(buildArchiveDestination(options), packageName);
  }

  return {
    appendUniqueQueueJobs,
    buildArchiveDestination,
    buildArchivePackageTarget,
    buildFolderPlaceholderPath,
    buildNewFolderPlaceholderPath,
    appendBoundedLogText,
    buildRemoteMovePlan,
    classifyRemotePath,
    createHistoryResumeQueueJob,
    createQueueJob,
    dragHasLocalFiles,
    dragHasRemoteItems,
    formatInventoryReport,
    summarizeActiveTransfer,
    joinRemotePath,
    mergeRecentPrefixes,
    normalizeNewFolderName,
    normalizeRemotePrefix,
    queueCanUploadAll,
    queueJobCountDetail,
    queueJobDestinationLabel,
    queueJobPlacementPreview,
    queueJobRequest,
    queueLifecycleGate,
    queueJobStatusHint,
    queueJobStatusLabel,
    queueNextAutomaticAction,
    queueNextPrecheckJob,
    queueNextUploadJob,
    queueUploadRequests,
    reconcileQueueJobsWithRecords,
    queueWithJobStatus,
    resolveSelectionIndexes,
    resolveMoveTargets,
  };
});
