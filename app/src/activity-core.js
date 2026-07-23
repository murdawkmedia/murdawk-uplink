(function attachActivityCore(root, factory) {
  const core = factory(
    typeof require === 'function' ? require('node:fs') : null,
    typeof require === 'function' ? require('node:path') : null,
  );
  if (typeof module === 'object' && module.exports) {
    module.exports = core;
  }
  if (root && !root.activityCore) {
    root.activityCore = core;
  }
})(typeof window !== 'undefined' ? window : undefined, function createActivityCore(nodeFs, nodePath) {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const UNPRINTABLE_LOG_VALUE = '[Unprintable log value]';
  const KNOWN_STATUSES = new Set([
    'blocked', 'cancelled', 'complete', 'created', 'dry-run', 'failed', 'paused',
    'ready', 'running', 'verified', 'warning',
  ]);

  function stringifyLogValue(value) {
    try {
      if (typeof value === 'string') return value;
      if (value instanceof Error) return `${value.name || 'Error'}: ${value.message || ''}`.trim();
      if (value === null || value === undefined) return String(value ?? '');
      if (typeof value !== 'object') return String(value);

      const enumerableKeys = Object.keys(value);
      if (
        value.toString !== Object.prototype.toString
        && (enumerableKeys.length === 0 || (enumerableKeys.length === 1 && enumerableKeys[0] === 'toString'))
      ) {
        return String(value);
      }

      const seen = new WeakSet();
      const serialized = JSON.stringify(value, (_key, nested) => {
        if (typeof nested === 'bigint') return String(nested);
        if (nested && typeof nested === 'object') {
          if (seen.has(nested)) return '[Circular]';
          seen.add(nested);
        }
        return nested;
      });
      return typeof serialized === 'string' ? serialized : UNPRINTABLE_LOG_VALUE;
    } catch {
      return UNPRINTABLE_LOG_VALUE;
    }
  }

  function redactLogText(value) {
    try {
      let text = stringifyLogValue(value);

      text = text.replace(
        /(["']authorization["']\s*:\s*)(?:"[^"\r\n]*"|'[^'\r\n]*')/gi,
        (_match, prefix) => `${prefix}"REDACTED"`,
      );
      text = text.replace(
        /(\bauthorization[ \t]*:[ \t]*)[^\r\n]*/gi,
        (_match, prefix) => `${prefix}REDACTED`,
      );
      text = text.replace(
        /(["']?authorization["']?\s*=\s*)((?:(?!%26)[^&\r\n}])*)/gi,
        (_match, prefix) => `${prefix}REDACTED`,
      );
      text = text.replace(
        /(["']?webhook(?:[-_]?(?:url|uri))?["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;\r\n}]+)/gi,
        (_match, prefix) => `${prefix}REDACTED`,
      );
      text = text.replace(
        /((?:x(?:[-_]|%2d)?amz(?:[-_]|%2d)?(?:credential|signature|security(?:[-_]|%2d)?token)|aws(?:[-_]|%2d)?access(?:[-_]|%2d)?key(?:[-_]|%2d)?id)(?:\s*[:=]\s*|%3d))(?:"([^"\r\n]*)"|'([^'\r\n]*)'|((?:(?!%26)[^\s,&;\r\n}])+))/gi,
        (_match, prefix, doubleQuoted, singleQuoted) => {
          if (doubleQuoted !== undefined) return `${prefix}"REDACTED"`;
          if (singleQuoted !== undefined) return `${prefix}'REDACTED'`;
          return `${prefix}REDACTED`;
        },
      );
      text = text.replace(
        /(["']?(?:secret(?:[-_]?(?:access[-_]?key|key))?|access[-_]?key(?:[-_]?(?:id|secret))?|api[-_]?(?:key|token)|token)["']?\s*[:=]\s*)(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s,&;\r\n}]+))/gi,
        (_match, prefix, doubleQuoted, singleQuoted) => {
          if (doubleQuoted !== undefined) return `${prefix}"REDACTED"`;
          if (singleQuoted !== undefined) return `${prefix}'REDACTED'`;
          return `${prefix}REDACTED`;
        },
      );
      return text;
    } catch {
      return UNPRINTABLE_LOG_VALUE;
    }
  }

  function createLogStreamRedactor(transformBeforeRedaction) {
    let pending = '';
    let sensitiveHeaderContinuation = false;

    function sanitize(segment) {
      try {
        const transformed = typeof transformBeforeRedaction === 'function'
          ? transformBeforeRedaction(segment)
          : segment;
        const text = typeof transformed === 'string' ? transformed : stringifyLogValue(transformed);
        const ending = text.match(/(?:\r\n|\r|\n)$/)?.[0] || '';
        const body = ending ? text.slice(0, -ending.length) : text;
        const continuation = /^[ \t]/.test(body);
        if (sensitiveHeaderContinuation && continuation) {
          const indentation = body.match(/^[ \t]*/)?.[0] || '';
          return `${indentation}REDACTED${ending}`;
        }
        sensitiveHeaderContinuation = /^[ \t]*authorization[ \t]*:/i.test(body);
        return redactLogText(text);
      } catch {
        sensitiveHeaderContinuation = false;
        return UNPRINTABLE_LOG_VALUE;
      }
    }

    function push(value) {
      let incoming;
      try {
        incoming = typeof value === 'string' ? value : String(value ?? '');
      } catch {
        return UNPRINTABLE_LOG_VALUE;
      }
      pending += incoming;
      let safe = '';
      let recordStart = 0;
      for (let index = 0; index < pending.length; index += 1) {
        const character = pending[index];
        if (character !== '\r' && character !== '\n') continue;
        if (character === '\r' && index + 1 === pending.length) break;
        const recordEnd = character === '\r' && pending[index + 1] === '\n'
          ? index + 2
          : index + 1;
        safe += sanitize(pending.slice(recordStart, recordEnd));
        recordStart = recordEnd;
        if (recordEnd === index + 2) index += 1;
      }
      pending = pending.slice(recordStart);
      return safe;
    }

    function flush() {
      if (!pending) return '';
      const remainder = pending;
      pending = '';
      return sanitize(remainder);
    }

    return { flush, push };
  }

  function createChildLogCoordinator({ transformBeforeRedaction, onSafeText } = {}) {
    const streams = {
      stdout: createLogStreamRedactor(transformBeforeRedaction),
      stderr: createLogStreamRedactor(transformBeforeRedaction),
    };
    let firstError = null;
    let closed = false;

    function emit(stream, text) {
      if (text && typeof onSafeText === 'function') onSafeText(stream, text);
      return text;
    }

    function push(stream, value) {
      if (closed || !Object.hasOwn(streams, stream)) return '';
      return emit(stream, streams[stream].push(value));
    }

    function noteError(error) {
      if (!firstError) firstError = error;
      return firstError;
    }

    function close(code) {
      if (closed) return null;
      closed = true;
      emit('stdout', streams.stdout.flush());
      emit('stderr', streams.stderr.flush());
      return { code, error: firstError };
    }

    return { close, noteError, push };
  }

  function basename(source = '') {
    const parts = String(source).replace(/\\/g, '/').split('/').filter(Boolean);
    return parts.at(-1) || '';
  }

  function hasVerifiedCompletion(record = {}) {
    const verification = record.verification || {};
    const checksum = record.checksum || {};
    return verification.ok === true
      && (!Array.isArray(verification.missing) || verification.missing.length === 0)
      && (!Array.isArray(verification.sizeMismatch) || verification.sizeMismatch.length === 0)
      && checksum.ok !== false;
  }

  function completedTimestamp(record = {}) {
    const time = Date.parse(record.completedAt || '');
    return Number.isFinite(time) ? time : null;
  }

  function hasCompletedDryRun(record = {}) {
    return record.status === 'dry-run' && completedTimestamp(record) !== null;
  }

  function activityResult(record = {}) {
    if (['complete', 'verified', 'ready'].includes(record.status)) return 'Complete';
    if (record.status === 'dry-run') return hasCompletedDryRun(record) ? 'Complete' : 'Interrupted';
    if (record.status === 'warning' && hasVerifiedCompletion(record)) return 'Complete';
    if (['paused', 'cancelled'].includes(record.status)) return 'Paused';
    if (['running', 'created'].includes(record.status)) return 'Interrupted';
    return 'Needs attention';
  }

  function activityCanResume(record = {}) {
    if (record.supersededByJobId) return false;
    if (['failed', 'cancelled', 'paused', 'running', 'blocked'].includes(record.status)) return true;
    if (record.status === 'dry-run') return !hasCompletedDryRun(record);
    return record.status === 'warning' && !hasVerifiedCompletion(record);
  }

  function summarizeActivityRecord(record = {}) {
    const direction = record.direction === 'download' ? 'download' : 'upload';
    const sources = Array.isArray(record.sources)
      ? record.sources.filter((source) => typeof source === 'string' && source)
      : [];
    const firstTitle = basename(sources[0]);
    const startedMs = Date.parse(record.startedAt || '');
    const completedMs = Date.parse(record.completedAt || '');
    const verification = record.verification && typeof record.verification === 'object'
      ? record.verification
      : null;
    const transferState = record.transferState && typeof record.transferState === 'object'
      ? record.transferState
      : {};
    const speed = transferState.speed
      || record.diagnostics?.speed?.current
      || record.diagnostics?.speed?.rollingAverage
      || '';
    const verifiedCount = Array.isArray(verification?.verified) ? verification.verified.length : 0;
    const missingCount = Array.isArray(verification?.missing) ? verification.missing.length : 0;
    const sizeMismatchCount = Array.isArray(verification?.sizeMismatch) ? verification.sizeMismatch.length : 0;
    const status = KNOWN_STATUSES.has(record.status) ? record.status : 'unknown';

    return {
      jobId: typeof record.jobId === 'string' ? record.jobId : '',
      direction,
      title: redactLogText(firstTitle
        ? `${firstTitle}${sources.length > 1 ? ` + ${sources.length - 1} more` : ''}`
        : `Transfer ${typeof record.jobId === 'string' ? record.jobId : ''}`.trim()),
      sourceCount: sources.length,
      destination: redactLogText(direction === 'download'
        ? (typeof record.localDestination === 'string' ? record.localDestination : '')
        : (typeof record.prefix === 'string' ? record.prefix : '')),
      result: record.supersededByJobId ? 'Complete' : activityResult(record),
      status,
      startedAt: Number.isFinite(startedMs) ? new Date(startedMs).toISOString() : '',
      completedAt: Number.isFinite(completedMs) ? new Date(completedMs).toISOString() : '',
      elapsedSeconds: Number.isFinite(startedMs) && Number.isFinite(completedMs)
        ? Math.max(0, Math.round((completedMs - startedMs) / 1000))
        : null,
      verification: hasVerifiedCompletion(record)
        ? 'Verified'
        : verification ? 'Needs review' : 'Not run',
      verifiedCount,
      missingCount,
      sizeMismatchCount,
      transferred: redactLogText(typeof transferState.transferred === 'string' ? transferState.transferred : ''),
      total: redactLogText(typeof transferState.total === 'string' ? transferState.total : ''),
      speed: redactLogText(typeof speed === 'string' ? speed : ''),
      canResume: activityCanResume(record),
      hasLog: record.hasLog === true,
      detail: record.supersededByJobId
        ? 'Completed by a resumed transfer.'
        : redactLogText(typeof record.error === 'string' ? record.error : ''),
    };
  }

  function findSuccessfulResumeSupersessions(records = []) {
    const safeRecords = Array.isArray(records) ? records : [];
    const byId = new Map(safeRecords
      .filter((record) => typeof record?.jobId === 'string' && record.jobId)
      .map((record) => [record.jobId, record]));
    const superseded = new Map();
    for (const record of safeRecords) {
      const successful = ['complete', 'verified'].includes(record?.status)
        || (record?.status === 'warning' && hasVerifiedCompletion(record));
      if (!successful || typeof record.resumeFromJobId !== 'string' || !record.resumeFromJobId) continue;
      const visited = new Set([record.jobId]);
      let ancestorId = record.resumeFromJobId;
      while (ancestorId && !visited.has(ancestorId)) {
        visited.add(ancestorId);
        if (!superseded.has(ancestorId)) superseded.set(ancestorId, record.jobId);
        const ancestor = byId.get(ancestorId);
        ancestorId = typeof ancestor?.resumeFromJobId === 'string' ? ancestor.resumeFromJobId : '';
      }
    }
    return superseded;
  }

  function summarizeActivityRecords(records = []) {
    const superseded = findSuccessfulResumeSupersessions(records);
    return (Array.isArray(records) ? records : []).map((record) => summarizeActivityRecord({
      ...record,
      supersededByJobId: superseded.get(record?.jobId) || '',
    }));
  }

  function appendRedactedLogFile(target, value) {
    if (!nodeFs || !nodePath || !target) return '';
    const text = redactLogText(value);
    if (!text) return '';
    nodeFs.mkdirSync(nodePath.dirname(target), { recursive: true });
    const line = text.endsWith('\n') ? text : `${text}\n`;
    nodeFs.appendFileSync(target, line, 'utf8');
    return line;
  }

  function cleanupActivityLogs(logsDir, options = {}) {
    const result = { scanned: 0, kept: [], removed: [], errors: [] };
    if (!nodeFs || !nodePath || !logsDir) return result;
    const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
    const maxAgeDays = Number.isFinite(Number(options.maxAgeDays))
      ? Math.max(0, Number(options.maxAgeDays))
      : 30;
    const maxFiles = Number.isFinite(Number(options.maxFiles))
      ? Math.max(0, Math.floor(Number(options.maxFiles)))
      : 500;
    let entries;
    try {
      entries = nodeFs.readdirSync(logsDir, { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT') result.errors.push(redactLogText(error));
      return result;
    }

    const files = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.log')) continue;
      const target = nodePath.join(logsDir, entry.name);
      try {
        const stat = nodeFs.statSync(target);
        files.push({ target, name: entry.name, mtimeMs: stat.mtimeMs });
      } catch (error) {
        result.errors.push(`${entry.name}: ${redactLogText(error)}`);
      }
    }
    result.scanned = files.length;

    const orderedFiles = files
      .sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name));
    const cutoff = now - maxAgeDays * DAY_MS;
    const expired = orderedFiles.filter((file) => file.mtimeMs < cutoff);
    const retained = orderedFiles
      .filter((file) => file.mtimeMs >= cutoff)
      .sort((left, right) => right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name));
    const excess = retained.slice(maxFiles);
    const removalTargets = [...expired, ...excess]
      .sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name));
    const removalSet = new Set(removalTargets.map((file) => file.target));

    for (const file of removalTargets) {
      try {
        nodeFs.unlinkSync(file.target);
        result.removed.push(file.target);
      } catch (error) {
        result.errors.push(`${file.name}: ${redactLogText(error)}`);
      }
    }
    result.kept = retained.filter((file) => !removalSet.has(file.target)).map((file) => file.target);
    return result;
  }

  return {
    appendRedactedLogFile,
    cleanupActivityLogs,
    createChildLogCoordinator,
    createLogStreamRedactor,
    findSuccessfulResumeSupersessions,
    redactLogText,
    summarizeActivityRecord,
    summarizeActivityRecords,
  };
});
