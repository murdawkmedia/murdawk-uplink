const { contextBridge, ipcRenderer, webUtils } = require('electron');
const { sha256Hex } = require('./connection-digest-core');

contextBridge.exposeInMainWorld('spacesUploader', {
  connectionIdentityDigest(value) {
    return sha256Hex(value);
  },
  getPathForFile(file) {
    return webUtils.getPathForFile(file);
  },
  chooseFiles() {
    return ipcRenderer.invoke('dialog:choose-files');
  },
  chooseFolder() {
    return ipcRenderer.invoke('dialog:choose-folder');
  },
  chooseDownloadFolder() {
    return ipcRenderer.invoke('dialog:choose-download-folder');
  },
  loadSettings() {
    return ipcRenderer.invoke('settings:load');
  },
  saveSettings(settings) {
    return ipcRenderer.invoke('settings:save', settings);
  },
  acknowledgeQueuePause(acknowledgement) {
    return ipcRenderer.invoke('queue:persist', acknowledgement);
  },
  checkSystem(profile) {
    return ipcRenderer.invoke('system:check', profile);
  },
  activeTransfer() {
    return ipcRenderer.invoke('system:active-transfer');
  },
  recoverySnapshot() {
    return ipcRenderer.invoke('system:recovery-snapshot');
  },
  listJobRecords() {
    return ipcRenderer.invoke('jobs:list');
  },
  resumeJobRecord(jobId) {
    return ipcRenderer.invoke('jobs:resume-settings', jobId);
  },
  automationCapabilities() {
    return ipcRenderer.invoke('automation:capabilities');
  },
  automationStatus() {
    return ipcRenderer.invoke('automation:status');
  },
  createAutomationKey(request) {
    return ipcRenderer.invoke('automation:create-key', request);
  },
  createMcpConfiguration(request) {
    return ipcRenderer.invoke('automation:create-mcp', request);
  },
  revokeAutomationKey(request) {
    return ipcRenderer.invoke('automation:revoke-key', request);
  },
  setupDigitalOceanProfile(request) {
    return ipcRenderer.invoke('profile:setup-digitalocean', request);
  },
  commitDigitalOceanProfileSetup(request) {
    return ipcRenderer.invoke('profile:setup-commit', request);
  },
  rollbackDigitalOceanProfileSetup(request) {
    return ipcRenderer.invoke('profile:setup-rollback', request);
  },
  removeRcloneProfile(request) {
    return ipcRenderer.invoke('profile:remove', request);
  },
  exportConnection(request) {
    return ipcRenderer.invoke('connection:export', request);
  },
  importConnection() {
    return ipcRenderer.invoke('connection:import');
  },
  unlockConnectionImport(request) {
    return ipcRenderer.invoke('connection:import-unlock', request);
  },
  createProfileFromConnectionImport(request) {
    return ipcRenderer.invoke('connection:import-create-profile', request);
  },
  cancelConnectionImport(request) {
    return ipcRenderer.invoke('connection:import-cancel', request);
  },
  connectionRemovalBlockers(request) {
    return ipcRenderer.invoke('connection:removal-blockers', request);
  },
  chooseEventManifest() {
    return ipcRenderer.invoke('event:choose-manifest');
  },
  eventReconcileLocal(request) {
    return ipcRenderer.invoke('event:reconcile-local', request);
  },
  eventQueueMissingPreview(request) {
    return ipcRenderer.invoke('event:queue-missing-preview', request);
  },
  listRemote(prefix, profile) {
    return ipcRenderer.invoke('remote:list', prefix, profile);
  },
  preparePreview(request) {
    return ipcRenderer.invoke('preview:prepare', request);
  },
  clearPreviewCache() {
    return ipcRenderer.invoke('preview:clear');
  },
  runRemoteOperation(request) {
    return ipcRenderer.invoke('remote:operation', request);
  },
  runRemoteOperations(requests) {
    return ipcRenderer.invoke('remote:operations', requests);
  },
  verifyUpload(request) {
    return ipcRenderer.invoke('upload:verify', request);
  },
  dryRunUpload(request) {
    return ipcRenderer.invoke('upload:dry-run', request);
  },
  startUpload(request) {
    return ipcRenderer.invoke('upload:start', request);
  },
  startQueueUpload(requests) {
    return ipcRenderer.invoke('upload:queue-start', requests);
  },
  dryRunDownload(request) {
    return ipcRenderer.invoke('download:dry-run', request);
  },
  startDownload(request) {
    return ipcRenderer.invoke('download:start', request);
  },
  startQueueDownload(requests) {
    return ipcRenderer.invoke('download:queue-start', requests);
  },
  cancelUpload() {
    return ipcRenderer.invoke('upload:cancel');
  },
  pauseUpload(request) {
    return ipcRenderer.invoke('upload:pause', request);
  },
  copyUrls(urls) {
    return ipcRenderer.invoke('clipboard:copy-urls', urls);
  },
  copyText(value) {
    return ipcRenderer.invoke('clipboard:copy-text', value);
  },
  copyDiagnostics(jobId) {
    return ipcRenderer.invoke('diagnostics:copy', jobId);
  },
  openLogFolder() {
    return ipcRenderer.invoke('diagnostics:open-folder');
  },
  openJobLog(jobId) {
    return ipcRenderer.invoke('diagnostics:open-job-log', jobId);
  },
  onUploadEvent(callback) {
    const channels = [
      'upload:start',
      'upload:preflight',
      'upload:progress',
      'upload:heartbeat',
      'upload:source-start',
      'upload:source-complete',
      'upload:verified',
      'upload:checksum',
      'upload:notifications',
      'upload:log',
      'upload:complete',
      'upload:queue-start',
      'upload:queue-job-start',
      'upload:queue-job-complete',
      'upload:queue-stopped',
      'upload:queue-complete',
      'upload:error',
      'upload:cancelled',
      'upload:paused',
      'upload:pause-failed',
    ];
    const removers = channels.map((channel) => {
      const listener = (_event, payload) => callback(channel, payload);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    });
    return () => removers.forEach((remove) => remove());
  },
  onBeforePauseClose(callback) {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('before-pause-close', listener);
    return () => ipcRenderer.removeListener('before-pause-close', listener);
  },
  onAutomationStatus(callback) {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('automation:status', listener);
    return () => ipcRenderer.removeListener('automation:status', listener);
  },
  onAutomationQueueUpdated(callback) {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('automation:queue-updated', listener);
    return () => ipcRenderer.removeListener('automation:queue-updated', listener);
  },
});
