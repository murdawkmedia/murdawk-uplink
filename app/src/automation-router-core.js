const ROUTES = new Map([
  ['GET /v1/capabilities', { capability: 'capabilities.read', handler: 'capabilities' }],
  ['GET /v1/connections', { capability: 'connections.read', handler: 'connections' }],
  ['GET /v1/remote', { capability: 'remote.list', handler: 'remote' }],
  ['GET /v1/queue', { capability: 'queue.read', handler: 'queue' }],
  ['POST /v1/queue', { capability: 'queue.create', handler: 'queueCreate' }],
  ['GET /v1/activity', { capability: 'job.status', handler: 'activity' }],
]);

function matchAutomationRoute(method, pathname) {
  return ROUTES.get(`${String(method || '').toUpperCase()} ${pathname}`) || null;
}

module.exports = { matchAutomationRoute, ROUTES };
