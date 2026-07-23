const TOOL_DEFINITIONS = Object.freeze([
  { name: 'list_capabilities', description: 'List the safe actions exposed by this Murdawk Uplink installation.' },
  { name: 'list_connections', description: 'List configured DigitalOcean Spaces connections without access keys.' },
  { name: 'list_remote_folder', description: 'List files and folders in one connected Space.' },
  { name: 'read_upload_queue', description: 'Read local upload queue jobs and their current status.' },
  { name: 'queue_local_sources', description: 'Add local files or folders to the Uplink queue for human review without uploading.' },
  { name: 'read_activity', description: 'Read recent Uplink transfer activity and safe diagnostics.' },
].map((tool) => Object.freeze(tool)));

function toolDefinitions() {
  return TOOL_DEFINITIONS.map((tool) => ({ ...tool }));
}

function requireString(value, label, { optional = false } = {}) {
  if ((value === undefined || value === '') && optional) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) {
    throw new Error(`${label} is invalid.`);
  }
  return value.trim();
}

function buildApiRequest(name, input = {}) {
  if (!TOOL_DEFINITIONS.some((tool) => tool.name === name)) throw new Error(`Unknown Uplink tool: ${name}`);
  if (name === 'list_capabilities') return { method: 'GET', path: '/v1/capabilities' };
  if (name === 'list_connections') return { method: 'GET', path: '/v1/connections' };
  if (name === 'read_upload_queue') return { method: 'GET', path: '/v1/queue' };
  if (name === 'read_activity') return { method: 'GET', path: '/v1/activity' };
  if (name === 'list_remote_folder') {
    const query = new URLSearchParams();
    const connectionId = requireString(input.connectionId, 'Connection id', { optional: true });
    const prefix = typeof input.prefix === 'string' ? input.prefix.trim() : '';
    if (connectionId) query.set('connectionId', connectionId);
    if (prefix) query.set('prefix', prefix);
    return { method: 'GET', path: `/v1/remote${query.size ? `?${query}` : ''}` };
  }
  if (!Array.isArray(input.sources) || !input.sources.length || input.sources.length > 100
    || input.sources.some((source) => typeof source !== 'string' || !source.trim())) {
    throw new Error('Choose between 1 and 100 absolute local source paths.');
  }
  return {
    method: 'POST',
    path: '/v1/queue',
    body: {
      connectionId: requireString(input.connectionId, 'Connection id'),
      sources: input.sources.map((source) => source.trim()),
      prefix: typeof input.prefix === 'string' ? input.prefix.trim() : '',
      filterMode: ['all', 'videos-images', 'media-docs', 'custom'].includes(input.filterMode) ? input.filterMode : 'all',
      include: typeof input.include === 'string' ? input.include.trim() : '',
      folderUploadMode: input.folderUploadMode === 'contents' ? 'contents' : 'package',
      publicRead: input.publicRead !== false,
      checksum: input.checksum === 'sha256' ? 'sha256' : 'size',
    },
  };
}

module.exports = { buildApiRequest, toolDefinitions, TOOL_DEFINITIONS };
