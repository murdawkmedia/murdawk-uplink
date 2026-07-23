const http = require('node:http');
const https = require('node:https');
const { redactTarget, shouldNotify } = require('./job-core');

function normalizeNtfyTarget(target = '') {
  const clean = String(target || '').trim();
  if (!clean) return '';
  if (/^https?:\/\//i.test(clean)) return clean;
  return `https://ntfy.sh/${encodeURIComponent(clean)}`;
}

function buildWebhookRequest({ target, payload }) {
  return {
    url: target,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

function buildNtfyRequest({
  target,
  title = 'Murdawk Uplink',
  message,
  priority = 3,
  tags = [],
}) {
  return {
    url: normalizeNtfyTarget(target),
    method: 'POST',
    headers: {
      Title: title,
      Priority: String(priority),
      Tags: tags.join(','),
    },
    body: message,
  };
}

function buildNotificationPayload({
  job,
  status,
  verification,
  checksum,
  urls = [],
  error = '',
}) {
  return {
    app: 'Murdawk Uplink',
    jobId: job.jobId,
    status,
    source: job.sources?.[0] || '',
    sources: job.sources || [],
    prefix: job.prefix,
    urls,
    sizeVerification: verification,
    checksumVerification: checksum,
    errors: error ? [error] : [],
    completedAt: job.completedAt || new Date().toISOString(),
  };
}

function buildNtfyMessage(payload) {
  const firstUrl = payload.urls?.[0] ? `\n${payload.urls[0]}` : '';
  const errorText = payload.errors?.length ? `\n${payload.errors.join('\n')}` : '';
  return [
    `${payload.status.toUpperCase()}: ${payload.prefix}`,
    `Job: ${payload.jobId}`,
    `Verified: ${payload.sizeVerification?.verified?.length || 0}`,
    firstUrl,
    errorText,
  ].filter(Boolean).join('\n');
}

function sendHttpRequest(request) {
  return new Promise((resolve, reject) => {
    const url = new URL(request.url);
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(url, {
      method: request.method || 'POST',
      headers: {
        'Content-Length': Buffer.byteLength(request.body || ''),
        ...(request.headers || {}),
      },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk.toString();
      });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ ok: true, statusCode: res.statusCode, body });
        } else {
          reject(new Error(`Notification request failed with HTTP ${res.statusCode}`));
        }
      });
    });
    req.on('error', reject);
    req.write(request.body || '');
    req.end();
  });
}

async function sendNotifications({ notifications = {}, payload }) {
  const status = payload.status;
  if (!shouldNotify({ notifyOn: notifications.notifyOn, status })) {
    return [];
  }

  const attempts = [];

  if (notifications.webhook) {
    const target = notifications.webhook;
    try {
      const response = await sendHttpRequest(buildWebhookRequest({ target, payload }));
      attempts.push({ type: 'webhook', target: redactTarget(target), ok: true, statusCode: response.statusCode });
    } catch (error) {
      attempts.push({ type: 'webhook', target: redactTarget(target), ok: false, error: error.message });
    }
  }

  if (notifications.ntfy) {
    const target = normalizeNtfyTarget(notifications.ntfy);
    try {
      const response = await sendHttpRequest(buildNtfyRequest({
        target,
        title: ['verified', 'complete'].includes(payload.status) ? 'Murdawk Uplink verified' : 'Murdawk Uplink needs attention',
        message: buildNtfyMessage(payload),
        priority: ['verified', 'complete'].includes(payload.status) ? 3 : 4,
        tags: ['verified', 'complete'].includes(payload.status) ? ['white_check_mark', 'arrow_up'] : ['warning', 'arrow_up'],
      }));
      attempts.push({ type: 'ntfy', target: redactTarget(target), ok: true, statusCode: response.statusCode });
    } catch (error) {
      attempts.push({ type: 'ntfy', target: redactTarget(target), ok: false, error: error.message });
    }
  }

  return attempts;
}

module.exports = {
  buildNotificationPayload,
  buildNtfyMessage,
  buildNtfyRequest,
  buildWebhookRequest,
  normalizeNtfyTarget,
  sendNotifications,
};
