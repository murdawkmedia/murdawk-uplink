const AUTOMATION_CAPABILITIES = Object.freeze([
  {
    id: 'capabilities.read',
    label: 'Read available capabilities',
    mode: 'read',
    description: 'List the exact safe actions exposed by this Uplink installation.',
  },
  {
    id: 'connections.read',
    label: 'List Spaces connections',
    mode: 'read',
    description: 'List connection names and server locations without access keys.',
  },
  {
    id: 'queue.read',
    label: 'Read upload queue',
    mode: 'read',
    description: 'Read local queued upload work and its status.',
  },
  {
    id: 'remote.list',
    label: 'List remote folder',
    mode: 'read',
    description: 'List folders and files for the active Spaces profile and prefix.',
  },
  {
    id: 'remote.metadata',
    label: 'Read file metadata',
    mode: 'read',
    description: 'Read safe object metadata already visible in the Explorer.',
  },
  {
    id: 'remote.publicUrl',
    label: 'Create public URL',
    mode: 'read',
    description: 'Build the public DigitalOcean Spaces URL for a selected object.',
  },
  {
    id: 'queue.create',
    label: 'Create upload queue job',
    mode: 'queue',
    description: 'Create a local queued upload request without starting a real upload.',
  },
  {
    id: 'queue.dryRun',
    label: 'Dry-run queued job',
    mode: 'verify',
    description: 'Run rclone dry-run for a queued upload request.',
  },
  {
    id: 'job.status',
    label: 'Read job status',
    mode: 'read',
    description: 'Read safe local upload job state and diagnostics.',
  },
  {
    id: 'event.manifest',
    label: 'Read Event Workspace manifest',
    mode: 'read',
    description: 'Read a safe event manifest.',
  },
  {
    id: 'event.reconcile',
    label: 'Run Event Workspace reconcile',
    mode: 'read',
    description: 'Compare local inventory with remote listings without uploading.',
  },
  {
    id: 'event.queuePreview',
    label: 'Preview missing-file queue',
    mode: 'queue',
    description: 'Build guarded queue candidates under the event recordings prefix.',
  },
].map((item) => Object.freeze(item)));

function cloneCapability(item) {
  return { ...item };
}

function publicAutomationCapabilities() {
  return AUTOMATION_CAPABILITIES.map(cloneCapability);
}

function assertAutomationCapability(id) {
  const found = AUTOMATION_CAPABILITIES.find((item) => item.id === id);
  if (!found) {
    throw new Error(`Automation capability is not exposed: ${id}`);
  }
  return cloneCapability(found);
}

module.exports = {
  AUTOMATION_CAPABILITIES,
  assertAutomationCapability,
  publicAutomationCapabilities,
};
