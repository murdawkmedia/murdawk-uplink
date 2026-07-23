(function attachTransferShelfCore(root, factory) {
  const core = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = core;
  }
  if (root && !root.transferShelfCore) {
    root.transferShelfCore = core;
  }
})(typeof window !== 'undefined' ? window : undefined, function createTransferShelfCore() {
  const ACTIVE_STATUSES = new Set(['prechecking', 'uploading', 'verifying', 'pausing']);
  const WAITING_STATUSES = new Set(['queued', 'ready', 'paused', 'needs-resume-check', 'cancelled']);
  const COMPLETE_STATUSES = new Set(['complete']);
  const ATTENTION_STATUSES = new Set(['failed', 'blocked']);
  const INTERRUPTED_STATUSES = new Set(['interrupted']);
  const PAUSED_STATUSES = new Set(['paused', 'needs-resume-check', 'cancelled']);

  const STATUS_LABELS = {
    prechecking: 'Checking',
    queued: 'Waiting',
    ready: 'Waiting',
    uploading: 'Uploading',
    pausing: 'Pausing',
    paused: 'Paused',
    'needs-resume-check': 'Paused',
    interrupted: 'Paused',
    cancelled: 'Paused',
    verifying: 'Verifying',
    complete: 'Complete',
    failed: 'Needs attention',
    blocked: 'Needs attention',
  };

  function normalizedStatus(jobOrStatus) {
    const status = typeof jobOrStatus === 'string' ? jobOrStatus : jobOrStatus?.status;
    return String(status || '').trim().toLowerCase();
  }

  function transferShelfStatusLabel(status) {
    const normalized = normalizedStatus(status);
    if (status?.direction === 'download') {
      if (normalized === 'uploading') return 'Downloading';
      if (normalized === 'prechecking') return 'Checking download';
    }
    return STATUS_LABELS[normalized] || 'Waiting';
  }

  function summarizeTransferShelf(jobs = []) {
    const summary = {
      active: 0,
      waiting: 0,
      complete: 0,
      needsAttention: 0,
      label: '',
    };
    let interrupted = 0;
    let paused = 0;

    for (const job of Array.isArray(jobs) ? jobs : []) {
      const status = normalizedStatus(job);
      if (ACTIVE_STATUSES.has(status)) {
        summary.active += 1;
      } else if (WAITING_STATUSES.has(status)) {
        summary.waiting += 1;
        if (PAUSED_STATUSES.has(status)) paused += 1;
      } else if (COMPLETE_STATUSES.has(status)) {
        summary.complete += 1;
      } else if (ATTENTION_STATUSES.has(status)) {
        summary.needsAttention += 1;
      } else if (INTERRUPTED_STATUSES.has(status)) {
        interrupted += 1;
      }
    }

    const parts = [
      summary.active ? `${summary.active} active` : '',
      paused ? `${paused} paused` : '',
      summary.waiting - paused ? `${summary.waiting - paused} waiting` : '',
      summary.complete ? `${summary.complete} complete` : '',
      summary.needsAttention
        ? `${summary.needsAttention} ${summary.needsAttention === 1 ? 'needs' : 'need'} attention`
        : '',
    ].filter(Boolean);
    summary.label = parts.join(', ') || (interrupted ? 'Transfer paused' : 'No transfers');
    return summary;
  }

  function shelfShouldPersist(jobs = []) {
    return (Array.isArray(jobs) ? jobs : []).some((job) => {
      const status = normalizedStatus(job);
      return ACTIVE_STATUSES.has(status)
        || WAITING_STATUSES.has(status)
        || COMPLETE_STATUSES.has(status)
        || ATTENTION_STATUSES.has(status)
        || INTERRUPTED_STATUSES.has(status);
    });
  }

  return {
    shelfShouldPersist,
    summarizeTransferShelf,
    transferShelfStatusLabel,
  };
});
