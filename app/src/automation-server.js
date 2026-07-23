const http = require('node:http');
const { URL } = require('node:url');
const { matchAutomationRoute } = require('./automation-router-core');

const MAX_BODY_BYTES = 1024 * 1024;

function sendJson(response, statusCode, value) {
  const body = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

function bearerToken(request) {
  const value = typeof request.headers.authorization === 'string'
    ? request.headers.authorization
    : '';
  const match = value.match(/^Bearer ([A-Za-z0-9_-]{32,})$/);
  return match?.[1] || '';
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        const error = new Error('Request body is too large.');
        error.statusCode = 413;
        reject(error);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (_error) {
        const error = new Error('Request body must be valid JSON.');
        error.statusCode = 400;
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

class AutomationServer {
  constructor({ authenticate, handlers, port = 47819 }) {
    this.authenticate = authenticate;
    this.handlers = handlers;
    this.port = port;
    this.server = null;
    this.url = '';
  }

  async handle(request, response) {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const route = matchAutomationRoute(request.method, url.pathname);
      if (!route) return sendJson(response, 404, { ok: false, error: 'Route not found.' });
      const token = bearerToken(request);
      const credential = token ? await this.authenticate(token) : null;
      if (!credential) return sendJson(response, 401, { ok: false, error: 'A valid Murdawk Uplink API key is required.' });
      const handler = this.handlers[route.handler];
      if (typeof handler !== 'function') return sendJson(response, 501, { ok: false, error: 'Capability is not available.' });
      const body = request.method === 'POST' ? await readJsonBody(request) : {};
      const result = await handler({ body, query: url.searchParams, credential, capability: route.capability });
      return sendJson(response, route.handler === 'queueCreate' ? 202 : 200, { ok: true, ...result });
    } catch (error) {
      return sendJson(response, Number(error.statusCode || 400), {
        ok: false,
        error: error.message || 'Automation request failed.',
      });
    }
  }

  start() {
    if (this.server) return Promise.resolve({ url: this.url });
    this.server = http.createServer((request, response) => void this.handle(request, response));
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server = null;
        reject(error);
      };
      this.server.once('error', onError);
      this.server.listen(this.port, '127.0.0.1', () => {
        this.server.off('error', onError);
        const address = this.server.address();
        this.url = `http://127.0.0.1:${address.port}`;
        resolve({ url: this.url });
      });
    });
  }

  stop() {
    if (!this.server) return Promise.resolve();
    const server = this.server;
    this.server = null;
    this.url = '';
    return new Promise((resolve) => server.close(() => resolve()));
  }
}

module.exports = { AutomationServer, bearerToken, MAX_BODY_BYTES, readJsonBody, sendJson };
