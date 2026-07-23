const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { matchAutomationRoute } = require('../src/automation-router-core');
const { AutomationServer } = require('../src/automation-server');

test('allows only explicit read and local queue routes', () => {
  assert.equal(matchAutomationRoute('GET', '/v1/capabilities').capability, 'capabilities.read');
  assert.equal(matchAutomationRoute('GET', '/v1/remote').capability, 'remote.list');
  assert.equal(matchAutomationRoute('POST', '/v1/queue').capability, 'queue.create');
  assert.equal(matchAutomationRoute('POST', '/v1/upload'), null);
  assert.equal(matchAutomationRoute('DELETE', '/v1/remote'), null);
});

function requestJson(url, { path = '/v1/capabilities', token = '', method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(path, url);
    const request = http.request(target, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    request.on('error', reject);
    if (body) request.write(JSON.stringify(body));
    request.end();
  });
}

test('loopback API requires a bearer key and never exposes unlisted routes', async () => {
  const server = new AutomationServer({
    authenticate: async (token) => token === 'a'.repeat(43) ? { id: 'test' } : null,
    handlers: { capabilities: async () => ({ capabilities: ['safe'] }) },
    port: 0,
  });
  const { url } = await server.start();
  try {
    const denied = await requestJson(url);
    assert.equal(denied.status, 401);
    const allowed = await requestJson(url, { token: 'a'.repeat(43) });
    assert.equal(allowed.status, 200);
    assert.deepEqual(allowed.body.capabilities, ['safe']);
    assert.equal(allowed.headers['cache-control'], 'no-store');
    const destructive = await requestJson(url, { path: '/v1/upload', token: 'a'.repeat(43), method: 'POST', body: {} });
    assert.equal(destructive.status, 404);
  } finally {
    await server.stop();
  }
});
