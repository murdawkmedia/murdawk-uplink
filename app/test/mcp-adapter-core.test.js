const test = require('node:test');
const assert = require('node:assert/strict');
const { buildApiRequest, toolDefinitions } = require('../src/mcp-adapter-core');

test('MCP exposes only read and human-review queue tools', () => {
  const names = toolDefinitions().map((tool) => tool.name);
  assert.deepEqual(names, [
    'list_capabilities',
    'list_connections',
    'list_remote_folder',
    'read_upload_queue',
    'queue_local_sources',
    'read_activity',
  ]);
  assert.equal(names.some((name) => /delete|move|credential|export|start_upload/.test(name)), false);
});

test('maps tools only to allowlisted loopback API routes', () => {
  assert.deepEqual(buildApiRequest('list_connections'), { method: 'GET', path: '/v1/connections' });
  assert.deepEqual(buildApiRequest('queue_local_sources', {
    connectionId: 'media',
    sources: ['C:\\media\\talk.mov'],
    prefix: 'sample-event/recordings/edits/Main',
  }), {
    method: 'POST',
    path: '/v1/queue',
    body: {
      connectionId: 'media',
      sources: ['C:\\media\\talk.mov'],
      prefix: 'sample-event/recordings/edits/Main',
      filterMode: 'all',
      include: '',
      folderUploadMode: 'package',
      publicRead: true,
      checksum: 'size',
    },
  });
  assert.throws(() => buildApiRequest('delete_remote', {}), /Unknown/);
});
