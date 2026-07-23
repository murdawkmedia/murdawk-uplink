const api = window.spacesUploader;
const explorerCore = window.explorerUiCore;
const driveShellCore = window.driveShellCore;
const navigationCore = window.navigationCore;
const transferShelfCore = window.transferShelfCore;
const queueRecoveryCore = window.queueRecoveryCore;
const pauseCore = window.pauseCore;
const activityCore = window.activityCore;
const connectionCore = window.connectionCore;

const state = {
  isRunning: false,
  activeQueueJobId: '',
  selectedQueueJobId: '',
  currentJobId: '',
  urls: [],
  queueJobs: [],
  activeProgress: {},
  activeTransfer: {},
  transferShelfHasRelevantWork: false,
  remotePrefix: '',
  remoteEntries: [],
  selectedRemoteIndex: -1,
  selectedRemoteIndexes: new Set(),
  selectionAnchorIndex: -1,
  remoteFocusIndex: -1,
  activeConnectionId: '',
  activeConnectionName: 'Choose a Space',
  connections: [],
  recentPrefixesByConnection: {},
  rootEntriesByConnection: {},
  pinnedPrefixes: [],
  uploadedRoots: [],
  historyRecords: [],
  selectedHistoryJobId: '',
  eventWorkspace: {
    label: 'No manifest loaded',
    manifest: null,
    localRoots: [],
    reconcile: null,
    missingPlan: [],
    localScan: null,
    queueSkipped: null,
  },
  automation: {
    enabled: false,
    url: '',
    error: '',
    credentials: [],
    boundary: '',
  },
  driveShell: driveShellCore.normalizeDriveShellState({
    view: 'files',
    queueDrawerOpen: false,
    inspectorOpen: true,
    search: '',
    sortKey: 'name',
    sortDirection: 'asc',
  }),
};

const LOG_MAX_LINES = 600;
const LOG_MAX_CHARS = 160000;
let pendingRcloneLogText = '';
let rcloneLogFlushTimer = null;
let remoteLoadSequence = 0;
let automaticQueueRunning = false;
let automaticQueuePending = false;
let queueRecoveryEnabled = true;
let schedulingBlockedByExternalLifecycle = false;
let smokeAutomaticQueueTrace = [];
let pauseRequestPromise = null;
const preparedPauses = new Map();
const preparedQueueResumes = new Map();
let cancelRequestPromise = null;
let rendererCancellationClaim = null;
let connectionSwitchPromise = null;
let settingsTransactionTail = Promise.resolve();
let connectionMutationPending = 0;
let connectionExportId = '';
let pendingConnectionImport = null;
let connectionImportReturnFocus = null;
let previewRequestSequence = 0;
let activePreviewKey = '';
let activePreview = null;
const resumeSourceClaims = queueRecoveryCore.createResumeSourceClaims();

const els = {
  health: document.getElementById('health'),
  showExplorerView: document.getElementById('showExplorerView'),
  showActivityView: document.getElementById('showActivityView'),
  showAdvancedView: document.getElementById('showAdvancedView'),
  activityPanel: document.getElementById('activityPanel'),
  activityTitle: document.getElementById('activityTitle'),
  activityList: document.getElementById('activityList'),
  refreshActivity: document.getElementById('refreshActivity'),
  driveChooseFiles: document.getElementById('driveChooseFiles'),
  driveChooseFolder: document.getElementById('driveChooseFolder'),
  downloadRemoteItems: document.getElementById('downloadRemoteItems'),
  driveNewFolder: document.getElementById('driveNewFolder'),
  prefix: document.getElementById('prefix'),
  filterMode: document.getElementById('filterMode'),
  include: document.getElementById('include'),
  folderUploadMode: document.getElementById('folderUploadMode'),
  publicRead: document.getElementById('publicRead'),
  checksum: document.getElementById('checksum'),
  notifyWebhook: document.getElementById('notifyWebhook'),
  notifyNtfy: document.getElementById('notifyNtfy'),
  notifyOn: document.getElementById('notifyOn'),
  profileStatus: document.getElementById('profileStatus'),
  connectionName: document.getElementById('connectionName'),
  profileRemote: document.getElementById('profileRemote'),
  profileBucket: document.getElementById('profileBucket'),
  profileRegion: document.getElementById('profileRegion'),
  profileEndpoint: document.getElementById('profileEndpoint'),
  testProfile: document.getElementById('testProfile'),
  setupAccessKey: document.getElementById('setupAccessKey'),
  setupSecretKey: document.getElementById('setupSecretKey'),
  setupProfile: document.getElementById('setupProfile'),
  dryRun: document.getElementById('dryRun'),
  verify: document.getElementById('verify'),
  upload: document.getElementById('upload'),
  cancel: document.getElementById('cancel'),
  queueTable: document.getElementById('queueTable'),
  checkUploadSelected: document.getElementById('checkUploadSelected'),
  dryRunSelected: document.getElementById('dryRunSelected'),
  uploadSelected: document.getElementById('uploadSelected'),
  clearQueue: document.getElementById('clearQueue'),
  urls: document.getElementById('urls'),
  copyUrls: document.getElementById('copyUrls'),
  log: document.getElementById('log'),
  clearLog: document.getElementById('clearLog'),
  copyDiagnostics: document.getElementById('copyDiagnostics'),
  openLogFolder: document.getElementById('openLogFolder'),
  breadcrumbs: document.getElementById('breadcrumbs'),
  driveSearch: document.getElementById('driveSearch'),
  driveProfileLabel: document.getElementById('driveProfileLabel'),
  openQueueDrawer: document.getElementById('openQueueDrawer'),
  openConnections: document.getElementById('openConnections'),
  queueDrawer: document.getElementById('queueDrawer'),
  queueDrawerTitle: document.getElementById('queueDrawerTitle'),
  transferShelf: document.getElementById('transferShelf'),
  transferShelfActive: document.getElementById('transferShelfActive'),
  transferShelfCounts: document.getElementById('transferShelfCounts'),
  transferShelfEta: document.getElementById('transferShelfEta'),
  transferShelfList: document.getElementById('transferShelfList'),
  transferShelfPauseAll: document.getElementById('transferShelfPauseAll'),
  transferShelfPauseAllHelp: document.getElementById('transferShelfPauseAllHelp'),
  transferShelfPercent: document.getElementById('transferShelfPercent'),
  transferShelfSpeed: document.getElementById('transferShelfSpeed'),
  transferShelfSummary: document.getElementById('transferShelfSummary'),
  transferShelfToggle: document.getElementById('transferShelfToggle'),
  remotePath: document.getElementById('remotePath'),
  goRemotePath: document.getElementById('goRemotePath'),
  refreshRemote: document.getElementById('refreshRemote'),
  newRemoteFolder: document.getElementById('newRemoteFolder'),
  newFolderDialog: document.getElementById('newFolderDialog'),
  newFolderForm: document.getElementById('newFolderForm'),
  newFolderName: document.getElementById('newFolderName'),
  newFolderDestination: document.getElementById('newFolderDestination'),
  newFolderStatus: document.getElementById('newFolderStatus'),
  newFolderCreate: document.getElementById('newFolderCreate'),
  newFolderCancel: document.getElementById('newFolderCancel'),
  newFolderClose: document.getElementById('newFolderClose'),
  pinCurrentFolder: document.getElementById('pinCurrentFolder'),
  connectionSwitcher: document.getElementById('connectionSwitcher'),
  connectionSwitcherStatus: document.getElementById('connectionSwitcherStatus'),
  connectionMenu: document.getElementById('connectionMenu'),
  connectionMenuItems: document.getElementById('connectionMenuItems'),
  addConnection: document.getElementById('addConnection'),
  importConnection: document.getElementById('importConnection'),
  manageConnections: document.getElementById('manageConnections'),
  activeConnectionName: document.getElementById('activeConnectionName'),
  rootFolders: document.getElementById('rootFolders'),
  pinnedFolders: document.getElementById('pinnedFolders'),
  recentFolders: document.getElementById('recentFolders'),
  remotePane: document.querySelector('.remote-pane'),
  remoteTable: document.getElementById('remoteTable'),
  remoteDropHint: document.getElementById('remoteDropHint'),
  selectionSummary: document.getElementById('selectionSummary'),
  remoteNavigationStatus: document.getElementById('remoteNavigationStatus'),
  inspectorTitle: document.getElementById('inspectorTitle'),
  inspectorSubtitle: document.getElementById('inspectorSubtitle'),
  inspectorKind: document.getElementById('inspectorKind'),
  inspectorDetail: document.getElementById('inspectorDetail'),
  inspectorUrl: document.getElementById('inspectorUrl'),
  inspectorPreview: document.getElementById('inspectorPreview'),
  inspectorPreviewStatus: document.getElementById('inspectorPreviewStatus'),
  inspectorPreviewImage: document.getElementById('inspectorPreviewImage'),
  openImagePreview: document.getElementById('openImagePreview'),
  inspectorDownload: document.getElementById('inspectorDownload'),
  imagePreviewDialog: document.getElementById('imagePreviewDialog'),
  imagePreviewTitle: document.getElementById('imagePreviewTitle'),
  imagePreviewImage: document.getElementById('imagePreviewImage'),
  closeImagePreview: document.getElementById('closeImagePreview'),
  dismissImagePreview: document.getElementById('dismissImagePreview'),
  dialogDownload: document.getElementById('dialogDownload'),
  moveTray: document.getElementById('moveTray'),
  closeMoveTray: document.getElementById('closeMoveTray'),
  moveTarget: document.getElementById('moveTarget'),
  moveTargetButtons: document.getElementById('moveTargetButtons'),
  moveIntoFolder: document.getElementById('moveIntoFolder'),
  moveExact: document.getElementById('moveExact'),
  copyRemoteUrl: document.getElementById('copyRemoteUrl'),
  copyInventory: document.getElementById('copyInventory'),
  copyRemoteItem: document.getElementById('copyRemoteItem'),
  renameRemoteItem: document.getElementById('renameRemoteItem'),
  moveRemoteItem: document.getElementById('moveRemoteItem'),
  deleteRemoteItem: document.getElementById('deleteRemoteItem'),
  organizeSection: document.getElementById('organizeSection'),
  organizeSource: document.getElementById('organizeSource'),
  archiveEvent: document.getElementById('archiveEvent'),
  archiveCategory: document.getElementById('archiveCategory'),
  archiveStage: document.getElementById('archiveStage'),
  archiveDay: document.getElementById('archiveDay'),
  archivePackageName: document.getElementById('archivePackageName'),
  archivePreview: document.getElementById('archivePreview'),
  renameUploadedRoot: document.getElementById('renameUploadedRoot'),
  moveUploadedRoot: document.getElementById('moveUploadedRoot'),
  moveSelectedToArchive: document.getElementById('moveSelectedToArchive'),
  archiveSortRemoteItem: document.getElementById('archiveSortRemoteItem'),
  transferMode: document.getElementById('transferMode'),
  checkActivity: document.getElementById('checkActivity'),
  activitySummary: document.getElementById('activitySummary'),
  activeDestination: document.getElementById('activeDestination'),
  activeSource: document.getElementById('activeSource'),
  activeSourceCount: document.getElementById('activeSourceCount'),
  nextJob: document.getElementById('nextJob'),
  activeProcess: document.getElementById('activeProcess'),
  lastOutput: document.getElementById('lastOutput'),
  progressFill: document.getElementById('progressFill'),
  progressPercent: document.getElementById('progressPercent'),
  progressBytes: document.getElementById('progressBytes'),
  progressSpeed: document.getElementById('progressSpeed'),
  progressEta: document.getElementById('progressEta'),
  diagnosticMetrics: document.getElementById('diagnosticMetrics'),
  diagnosticTuning: document.getElementById('diagnosticTuning'),
  diagnosticAction: document.getElementById('diagnosticAction'),
  diagnosticRecommendation: document.getElementById('diagnosticRecommendation'),
  verification: document.getElementById('verification'),
  historyTable: document.getElementById('historyTable'),
  refreshHistory: document.getElementById('refreshHistory'),
  resumeHistory: document.getElementById('resumeHistory'),
  connectionsPanel: document.getElementById('connectionsPanel'),
  connectionsList: document.getElementById('connectionsList'),
  connectionsImportButton: document.getElementById('connectionsImportButton'),
  connectionsAddButton: document.getElementById('connectionsAddButton'),
  connectionEditor: document.getElementById('connectionEditor'),
  connectionNotice: document.getElementById('connectionNotice'),
  connectionExportDialog: document.getElementById('connectionExportDialog'),
  connectionExportForm: document.getElementById('connectionExportForm'),
  connectionExportTitle: document.getElementById('connectionExportTitle'),
  connectionExportSummary: document.getElementById('connectionExportSummary'),
  connectionExportIncludeKeys: document.getElementById('connectionExportIncludeKeys'),
  connectionExportSecrets: document.getElementById('connectionExportSecrets'),
  connectionExportAccessKey: document.getElementById('connectionExportAccessKey'),
  connectionExportSecretKey: document.getElementById('connectionExportSecretKey'),
  connectionExportPassword: document.getElementById('connectionExportPassword'),
  connectionExportPasswordConfirm: document.getElementById('connectionExportPasswordConfirm'),
  connectionExportAcknowledge: document.getElementById('connectionExportAcknowledge'),
  connectionExportStatus: document.getElementById('connectionExportStatus'),
  connectionExportSave: document.getElementById('connectionExportSave'),
  connectionExportCancel: document.getElementById('connectionExportCancel'),
  connectionExportClose: document.getElementById('connectionExportClose'),
  connectionImportDialog: document.getElementById('connectionImportDialog'),
  connectionImportForm: document.getElementById('connectionImportForm'),
  connectionImportTitle: document.getElementById('connectionImportTitle'),
  connectionImportLocked: document.getElementById('connectionImportLocked'),
  connectionImportPassword: document.getElementById('connectionImportPassword'),
  connectionImportUnlock: document.getElementById('connectionImportUnlock'),
  connectionImportPreview: document.getElementById('connectionImportPreview'),
  connectionImportName: document.getElementById('connectionImportName'),
  connectionImportBucket: document.getElementById('connectionImportBucket'),
  connectionImportEndpoint: document.getElementById('connectionImportEndpoint'),
  connectionImportRemote: document.getElementById('connectionImportRemote'),
  connectionImportKeyNote: document.getElementById('connectionImportKeyNote'),
  connectionImportStatus: document.getElementById('connectionImportStatus'),
  connectionImportSave: document.getElementById('connectionImportSave'),
  connectionImportCancel: document.getElementById('connectionImportCancel'),
  connectionImportClose: document.getElementById('connectionImportClose'),
  automationAccess: document.getElementById('automationAccess'),
  automationAccessState: document.getElementById('automationAccessState'),
  automationAccessUrl: document.getElementById('automationAccessUrl'),
  automationKeyName: document.getElementById('automationKeyName'),
  createAutomationKey: document.getElementById('createAutomationKey'),
  createMcpConfiguration: document.getElementById('createMcpConfiguration'),
  automationAccessNotice: document.getElementById('automationAccessNotice'),
  automationOneTimeSecret: document.getElementById('automationOneTimeSecret'),
  automationOneTimeTitle: document.getElementById('automationOneTimeTitle'),
  automationOneTimeHelp: document.getElementById('automationOneTimeHelp'),
  automationOneTimeValue: document.getElementById('automationOneTimeValue'),
  copyAutomationValue: document.getElementById('copyAutomationValue'),
  dismissAutomationValue: document.getElementById('dismissAutomationValue'),
  automationKeyList: document.getElementById('automationKeyList'),
  eventWorkspacePanel: document.getElementById('eventWorkspacePanel'),
  openEventWorkspaceAdvanced: document.getElementById('openEventWorkspaceAdvanced'),
  openEventManifest: document.getElementById('openEventManifest'),
  eventWorkspacePreset: document.getElementById('eventWorkspacePreset'),
  eventManifestSummary: document.getElementById('eventManifestSummary'),
  eventLocalRoots: document.getElementById('eventLocalRoots'),
  addEventLocalRoot: document.getElementById('addEventLocalRoot'),
  runEventReconcile: document.getElementById('runEventReconcile'),
  eventReconcileSummary: document.getElementById('eventReconcileSummary'),
  queueEventMissing: document.getElementById('queueEventMissing'),
  explorerTitle: document.getElementById('explorerTitle'),
  advancedTitle: document.getElementById('advancedTitle'),
  connectionsTitle: document.getElementById('connectionsTitle'),
  eventWorkspaceTitle: document.getElementById('eventWorkspaceTitle'),
};

function focusViewTarget(target) {
  if (!target) return;
  requestAnimationFrame(() => {
    if (!target.hidden && window.getComputedStyle(target).display !== 'none') {
      target.focus();
    }
  });
}

function setViewMode(mode = 'explorer', { focus = false } = {}) {
  const isAdvanced = mode === 'advanced';
  const isActivity = mode === 'activity';
  setDriveShellView('files');
  document.body.classList.toggle('is-advanced-view', isAdvanced);
  document.body.classList.toggle('is-activity-view', isActivity);
  if (els.activityPanel) els.activityPanel.hidden = !isActivity;
  els.showExplorerView?.classList.toggle('is-active', !isAdvanced && !isActivity);
  els.showActivityView?.classList.toggle('is-active', isActivity);
  els.showAdvancedView?.classList.toggle('is-active', isAdvanced);
  if (els.showExplorerView) {
    if (isAdvanced || isActivity) {
      els.showExplorerView.removeAttribute('aria-current');
    } else {
      els.showExplorerView.setAttribute('aria-current', 'page');
    }
  }
  if (els.showActivityView) {
    if (isActivity) {
      els.showActivityView.setAttribute('aria-current', 'page');
    } else {
      els.showActivityView.removeAttribute('aria-current');
    }
  }
  if (els.showAdvancedView) {
    if (isAdvanced) {
      els.showAdvancedView.setAttribute('aria-current', 'page');
    } else {
      els.showAdvancedView.removeAttribute('aria-current');
    }
  }
  if (focus) {
    focusViewTarget(isAdvanced ? els.advancedTitle : isActivity ? els.activityTitle : els.explorerTitle);
  }
}

function currentProfile() {
  const connection = state.connections.find((candidate) => candidate.id === state.activeConnectionId);
  return {
    remote: connection?.remote || '',
    bucket: connection?.bucket || '',
    endpointHost: connection?.endpointHost || '',
  };
}

function draftProfile() {
  return {
    remote: els.profileRemote.value.trim(),
    bucket: els.profileBucket.value.trim(),
    endpointHost: els.profileEndpoint.value.trim(),
  };
}

function activeConnection() {
  return state.connections.find((candidate) => candidate.id === state.activeConnectionId) || null;
}

function hasActiveConnection() {
  const profile = currentProfile();
  return Boolean(state.activeConnectionId && profile.remote && profile.bucket && profile.endpointHost);
}

const DIGITALOCEAN_REGION_ENDPOINTS = {
  nyc3: 'nyc3.digitaloceanspaces.com',
  sfo3: 'sfo3.digitaloceanspaces.com',
  sfo2: 'sfo2.digitaloceanspaces.com',
  ams3: 'ams3.digitaloceanspaces.com',
  sgp1: 'sgp1.digitaloceanspaces.com',
  lon1: 'lon1.digitaloceanspaces.com',
  fra1: 'fra1.digitaloceanspaces.com',
  tor1: 'tor1.digitaloceanspaces.com',
  blr1: 'blr1.digitaloceanspaces.com',
  syd1: 'syd1.digitaloceanspaces.com',
};

function regionFromEndpoint(endpoint = '') {
  const clean = String(endpoint || '').trim().toLowerCase();
  const match = clean.match(/^([a-z0-9-]+)\.digitaloceanspaces\.com$/);
  return DIGITALOCEAN_REGION_ENDPOINTS[match?.[1]] ? match[1] : 'nyc3';
}

function profileLabel(profile = currentProfile()) {
  return profile.remote && profile.bucket ? `${profile.remote}:${profile.bucket}` : 'No Space connected';
}

function updateActiveConnectionDisplay() {
  const connection = activeConnection();
  state.activeConnectionName = connection?.name || 'Choose a Space';
  els.activeConnectionName.textContent = state.activeConnectionName;
  els.connectionSwitcher.title = connection
    ? `Active connection: ${state.activeConnectionName}`
    : 'Choose or add a Spaces connection';
  els.connectionSwitcher.setAttribute('aria-label', connection
    ? `Active connection: ${state.activeConnectionName}. Choose another Space.`
    : 'Choose or add a Spaces connection.');
  renderBreadcrumbs();
  renderFolderGroups();
  if (!els.moveTray.hidden) {
    renderMoveTargetButtons();
  }
}

function updateDriveTopBar() {
  const profile = currentProfile();
  if (!hasActiveConnection()) {
    els.driveProfileLabel.textContent = 'No Space connected';
    els.driveProfileLabel.title = 'Add or import a Spaces connection to begin.';
    els.driveProfileLabel.setAttribute('aria-label', 'No Space connected');
    return;
  }
  const summary = driveShellCore.buildDriveTopBar(profile, state.remotePrefix);
  if (els.driveProfileLabel) {
    els.driveProfileLabel.textContent = `${summary.profileLabel} / ${summary.pathLabel}`;
    els.driveProfileLabel.title = `${summary.profileLabel}/${summary.pathLabel === 'Space root' ? '' : summary.pathLabel}`;
    els.driveProfileLabel.setAttribute('aria-label', `Current server path: ${summary.profileLabel}, ${summary.pathLabel}`);
  }
}

function updateProfileStatus(text = '') {
  els.profileStatus.textContent = text || profileLabel(draftProfile());
}

function setDriveShellView(view = 'files', { focus = false } = {}) {
  state.driveShell = driveShellCore.normalizeDriveShellState({
    ...state.driveShell,
    view,
  });
  document.body.classList.toggle('is-drive-connections-view', state.driveShell.view === 'connections');
  if (els.eventWorkspacePanel) {
    els.eventWorkspacePanel.hidden = state.driveShell.view !== 'event-workspace';
  }
  if (els.connectionsPanel) {
    els.connectionsPanel.hidden = state.driveShell.view !== 'connections';
  }
  if (els.openConnections) {
    els.openConnections.setAttribute('aria-expanded', String(state.driveShell.view === 'connections'));
  }
  if (focus) {
    const targets = {
      files: els.explorerTitle,
      connections: els.connectionsTitle,
      'event-workspace': els.eventWorkspaceTitle,
    };
    focusViewTarget(targets[state.driveShell.view]);
  }
}

function connectionsWithCurrentPreferences(connections = state.connections) {
  const recent = currentRecentPrefixes();
  return connections.map((connection) => connection.id === state.activeConnectionId
    ? connectionCore.sanitizeConnection({
      ...connection,
      publicRead: els.publicRead.checked,
      checksum: els.checksum.value,
      recentPrefixes: recent,
      pinnedPrefixes: state.pinnedPrefixes,
    })
    : connection);
}

function synchronizedRecentPrefixesByConnection(connections = state.connections, source = state.recentPrefixesByConnection) {
  return Object.fromEntries((Array.isArray(connections) ? connections : []).map((connection) => [
    connection.id,
    source && typeof source === 'object' && Object.hasOwn(source, connection.id)
      ? navigationCore.recentPrefixesForConnection(source, connection.id)
      : [...connection.recentPrefixes],
  ]));
}

function updateConnectionMutationControls() {
  const locked = connectionMutationPending > 0 || state.isRunning || schedulingBlockedByExternalLifecycle;
  if (els.connectionSwitcher) els.connectionSwitcher.disabled = locked;
  if (els.connectionsImportButton) els.connectionsImportButton.disabled = locked;
  if (els.connectionsAddButton) els.connectionsAddButton.disabled = locked;
  els.connectionMenu?.querySelectorAll('button').forEach((button) => { button.disabled = locked; });
  els.connectionsList?.querySelectorAll('button').forEach((button) => { button.disabled = locked; });
  els.connectionEditor?.querySelectorAll('input, select, button').forEach((control) => { control.disabled = locked; });
  els.connectionsPanel?.setAttribute('aria-busy', String(locked));
  els.connectionEditor?.setAttribute('aria-busy', String(locked));
}

function enqueueSettingsTransaction(operation, { lockConnections = false } = {}) {
  if (lockConnections) {
    connectionMutationPending += 1;
    closeConnectionMenu();
    updateConnectionMutationControls();
    setRunning(state.isRunning);
  }
  const task = settingsTransactionTail
    .catch(() => undefined)
    .then(operation);
  settingsTransactionTail = task.then(() => undefined, () => undefined);
  return task.finally(() => {
    if (!lockConnections) return;
    connectionMutationPending = Math.max(0, connectionMutationPending - 1);
    updateConnectionMutationControls();
    setRunning(state.isRunning);
  });
}

function runConnectionMutation(operation) {
  return enqueueSettingsTransaction(operation, { lockConnections: true });
}

function updateConnectionChrome() {
  updateActiveConnectionDisplay();
  updateDriveTopBar();
  renderConnectionMenu();
  renderConnectionsPanel();
  setRunning(state.isRunning);
}

function connectionMenuButtons() {
  return [...els.connectionMenu.querySelectorAll('[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled)')];
}

function renderConnectionMenu() {
  if (!els.connectionMenuItems) return;
  els.connectionMenuItems.innerHTML = state.connections.length
    ? state.connections.map((connection) => `
      <button type="button" role="menuitemradio" aria-checked="${connection.id === state.activeConnectionId}" data-connection-id="${escapeHtml(connection.id)}">
        <span>${escapeHtml(connection.name)}</span>
        <small>${escapeHtml(connection.bucket)}</small>
      </button>
    `).join('')
    : '<div class="connection-menu-empty" role="note">No Spaces connected</div>';
  updateConnectionMutationControls();
}

function closeConnectionMenu({ restoreFocus = false } = {}) {
  if (!els.connectionMenu || els.connectionMenu.hidden) return;
  els.connectionMenu.hidden = true;
  els.connectionSwitcher.setAttribute('aria-expanded', 'false');
  if (restoreFocus) els.connectionSwitcher.focus();
}

function openConnectionMenu() {
  showConnectionSwitcherStatus();
  renderConnectionMenu();
  els.connectionMenu.hidden = false;
  els.connectionSwitcher.setAttribute('aria-expanded', 'true');
  const active = els.connectionMenu.querySelector(`[data-connection-id="${CSS.escape(state.activeConnectionId)}"]`);
  (active || connectionMenuButtons()[0])?.focus();
}

function toggleConnectionMenu() {
  if (els.connectionMenu.hidden) openConnectionMenu();
  else closeConnectionMenu({ restoreFocus: true });
}

function showConnectionNotice(message = '', { error = false, jobs = [] } = {}) {
  if (!message) {
    els.connectionNotice.hidden = true;
    els.connectionNotice.innerHTML = '';
    return;
  }
  const list = jobs.length
    ? `<ul>${jobs.map((job) => `<li>${escapeHtml(explorerCore.queueJobDestinationLabel(job))} - ${escapeHtml(job.status || 'unfinished')}</li>`).join('')}</ul>`
    : '';
  els.connectionNotice.classList.toggle('is-error', error);
  els.connectionNotice.innerHTML = `<strong>${escapeHtml(message)}</strong>${list}${jobs.length ? '<button type="button" id="returnToUploads" class="quiet">Return to uploads</button>' : ''}`;
  els.connectionNotice.hidden = false;
}

function showConnectionSwitcherStatus(message = '', { error = false } = {}) {
  if (!els.connectionSwitcherStatus) return;
  els.connectionSwitcherStatus.textContent = message;
  els.connectionSwitcherStatus.classList.toggle('is-error', error);
  els.connectionSwitcherStatus.hidden = !message;
}

function restoreConnectionSwitcherFocus() {
  els.connectionSwitcher?.focus({ preventScroll: true });
  requestAnimationFrame(() => els.connectionSwitcher?.focus({ preventScroll: true }));
}

async function blockersForConnection(connection) {
  const durableBlockers = await api.connectionRemovalBlockers({ connection });
  const localBlockers = connectionCore.collectConnectionRemovalBlockers({
    connection,
    jobs: state.queueJobs,
    activeTransfer: state.activeTransfer,
  });
  return [
    ...localBlockers,
    ...(Array.isArray(durableBlockers) ? durableBlockers.map((job) => ({
      ...job,
      sources: [],
      connectionId: connection.id,
      profile: connection,
    })) : []),
  ].filter((job, index, list) => {
    const key = job.jobId || job.id;
    if (!key) return index === list.findIndex((candidate) => !candidate.jobId && !candidate.id);
    return index === list.findIndex((candidate) => (candidate.jobId || candidate.id) === key);
  });
}

function showConnectionRemovalBlockers(connection, blockers) {
  showConnectionNotice(`${connection.name} has unfinished uploads or checks and cannot be removed.`, {
    error: true,
    jobs: blockers,
  });
}

function renderAutomationAccess(status = state.automation) {
  state.automation = {
    enabled: status?.enabled === true,
    url: typeof status?.url === 'string' ? status.url : '',
    error: typeof status?.error === 'string' ? status.error : '',
    credentials: Array.isArray(status?.credentials) ? status.credentials : [],
    boundary: typeof status?.boundary === 'string' ? status.boundary : '',
  };
  if (!els.automationAccessState) return;
  els.automationAccessState.textContent = state.automation.error
    ? 'Needs attention'
    : state.automation.enabled
      ? 'On'
      : 'Off';
  els.automationAccessState.classList.toggle('is-error', Boolean(state.automation.error));
  els.automationAccessUrl.textContent = state.automation.error
    || (state.automation.url
      ? `${state.automation.url} - ${state.automation.boundary}`
      : 'Create a key to start local automation.');
  els.automationKeyList.innerHTML = state.automation.credentials.length
    ? state.automation.credentials.map((credential) => {
      const created = credential.createdAt ? new Date(credential.createdAt).toLocaleString() : 'Unknown date';
      const used = credential.lastUsedAt ? `Last used ${new Date(credential.lastUsedAt).toLocaleString()}` : 'Not used yet';
      return `
        <div class="automation-key-row">
          <div>
            <strong>${escapeHtml(credential.name)}</strong>
            <span>Created ${escapeHtml(created)} - ${escapeHtml(used)}</span>
          </div>
          <button type="button" class="danger" data-automation-revoke="${escapeHtml(credential.id)}">Revoke</button>
        </div>
      `;
    }).join('')
    : '<div class="empty-state">No API keys yet.</div>';
}

async function loadAutomationStatus() {
  try {
    renderAutomationAccess(await api.automationStatus());
  } catch (error) {
    renderAutomationAccess({ error: error.message, credentials: [] });
  }
}

function showAutomationOneTimeValue({ title, help, value }) {
  els.automationOneTimeTitle.textContent = title;
  els.automationOneTimeHelp.textContent = help;
  els.automationOneTimeValue.value = value;
  els.automationOneTimeSecret.hidden = false;
  requestAnimationFrame(() => {
    els.automationOneTimeValue.focus();
    els.automationOneTimeValue.select();
  });
}

function dismissAutomationOneTimeValue() {
  els.automationOneTimeValue.value = '';
  els.automationOneTimeSecret.hidden = true;
  els.automationKeyName.focus();
}

async function createAutomationCredential({ mcp = false } = {}) {
  const name = els.automationKeyName.value.trim();
  if (!name) {
    showConnectionPackageStatus(els.automationAccessNotice, 'Give this key a recognizable name.', { error: true });
    els.automationKeyName.focus();
    return;
  }
  if (mcp && !window.confirm('The MCP configuration contains an API key that can browse Spaces and add local queue jobs. Store it privately and revoke it when no longer needed.')) {
    return;
  }
  els.createAutomationKey.disabled = true;
  els.createMcpConfiguration.disabled = true;
  showConnectionPackageStatus(els.automationAccessNotice, mcp
    ? 'Creating MCP configuration...'
    : 'Creating protected API key...');
  try {
    const result = mcp
      ? await api.createMcpConfiguration({ name })
      : await api.createAutomationKey({ name });
    if (!result?.ok) throw new Error('Automation access could not be created.');
    els.automationKeyName.value = '';
    renderAutomationAccess(result.status);
    showConnectionPackageStatus(els.automationAccessNotice);
    showAutomationOneTimeValue(mcp
      ? {
        title: 'Save this MCP configuration now',
        help: 'It contains the new API key and is shown only once.',
        value: result.configuration,
      }
      : {
        title: 'Save this API key now',
        help: `Use it with ${result.status.url}. It is shown only once.`,
        value: result.token,
      });
  } catch (error) {
    showConnectionPackageStatus(els.automationAccessNotice, error.message, { error: true });
  } finally {
    els.createAutomationKey.disabled = false;
    els.createMcpConfiguration.disabled = false;
  }
}

async function revokeAutomationCredential(id) {
  const credential = state.automation.credentials.find((candidate) => candidate.id === id);
  if (!credential || !window.confirm(`Revoke ${credential.name}? Any tool using it will lose access immediately.`)) return;
  showConnectionPackageStatus(els.automationAccessNotice, `Revoking ${credential.name}...`);
  try {
    const result = await api.revokeAutomationKey({ id });
    renderAutomationAccess(result.status);
    showConnectionPackageStatus(els.automationAccessNotice, `${credential.name} was revoked.`);
  } catch (error) {
    showConnectionPackageStatus(els.automationAccessNotice, error.message, { error: true });
  }
}

function renderConnectionsPanel() {
  if (!els.connectionsList) return;
  if (!state.connections.length) {
    els.connectionsList.innerHTML = `
      <div class="connections-empty">
        <strong>No Spaces connected</strong>
        <span>Add an existing rclone profile or import connection settings.</span>
      </div>
    `;
    updateConnectionMutationControls();
    return;
  }
  els.connectionsList.innerHTML = state.connections.map((connection) => {
    const active = connection.id === state.activeConnectionId;
    const tested = connection.lastTestedAt
      ? new Date(connection.lastTestedAt).toLocaleString()
      : 'Not tested yet';
    return `
      <article class="connection-card${active ? ' is-active' : ''}" data-connection-card="${escapeHtml(connection.id)}">
        <div class="connection-card-main">
          <div>
            <div class="connection-card-title">
              <h3>${escapeHtml(connection.name)}</h3>
              ${active ? '<span class="active-badge">Active</span>' : ''}
            </div>
            <dl>
              <div><dt>Space</dt><dd>${escapeHtml(connection.bucket)}</dd></div>
              <div><dt>Endpoint</dt><dd>${escapeHtml(connection.endpointHost)}</dd></div>
              <div><dt>rclone profile</dt><dd>${escapeHtml(connection.remote)}</dd></div>
              <div><dt>Last tested</dt><dd>${escapeHtml(tested)}</dd></div>
            </dl>
          </div>
          <div class="connection-card-actions">
            ${active ? '' : `<button type="button" class="primary" data-connection-action="activate" data-connection-id="${escapeHtml(connection.id)}">Use</button>`}
            <button type="button" class="quiet" data-connection-action="test" data-connection-id="${escapeHtml(connection.id)}">Test</button>
            <button type="button" class="quiet" data-connection-action="export" data-connection-id="${escapeHtml(connection.id)}">Export</button>
            <button type="button" class="quiet" data-connection-action="rename" data-connection-id="${escapeHtml(connection.id)}">Rename</button>
            <button type="button" class="danger" data-connection-action="remove" data-connection-id="${escapeHtml(connection.id)}">Remove</button>
          </div>
        </div>
        <details class="connection-advanced-tools">
          <summary>Advanced</summary>
          <p>Remove only the underlying local rclone profile. This does not remove the app connection or any server objects.</p>
          <button type="button" class="danger" data-connection-action="remove-profile" data-connection-id="${escapeHtml(connection.id)}">Remove underlying rclone profile</button>
        </details>
      </article>
    `;
  }).join('');
  updateConnectionMutationControls();
}

async function currentConnectionChangeBlocker() {
  try {
    const transfer = await api.activeTransfer();
    state.activeTransfer = transfer || {};
    return connectionCore.transferBlocksConnectionChange(state.activeTransfer)
      ? { transfer: state.activeTransfer, error: null }
      : null;
  } catch (error) {
    return { transfer: null, error };
  }
}

function showConnectionChangeBlocker(blocker, { switcher = false } = {}) {
  const message = blocker?.error
    ? 'Uplink could not confirm whether another transfer is active. Connection changes are blocked until transfer status is available.'
    : 'A transfer is active. Pause or finish it before changing the connection list or Explorer Space.';
  if (switcher) {
    showConnectionSwitcherStatus(message, { error: true });
    window.alert(message);
  } else {
    const transfer = blocker?.transfer || {};
    showConnectionNotice(message, {
      error: true,
      jobs: blocker?.error ? [] : [{
        id: transfer.intentId || '',
        jobId: transfer.activeJobId || '',
        prefix: transfer.prefix || '',
        status: transfer.phase || 'active',
        sources: [],
      }],
    });
  }
  state.driveShell = driveShellCore.normalizeDriveShellState({ ...state.driveShell, queueDrawerOpen: true });
  renderTransferShelf();
}

async function performActiveConnectionSwitch(connectionId) {
  let target = state.connections.find((connection) => connection.id === connectionId);
  if (!target || target.id === state.activeConnectionId) {
    showConnectionSwitcherStatus();
    closeConnectionMenu({ restoreFocus: true });
    return false;
  }
  const lifecycleBlocker = await currentConnectionChangeBlocker();
  if (lifecycleBlocker) {
    closeConnectionMenu({ restoreFocus: true });
    showConnectionChangeBlocker(lifecycleBlocker, { switcher: true });
    return false;
  }

  const nextConnections = connectionsWithCurrentPreferences();
  target = nextConnections.find((connection) => connection.id === connectionId);
  const nextRecentsByConnection = synchronizedRecentPrefixesByConnection(nextConnections);
  const persisted = await persistSettings({
    connections: nextConnections,
    activeConnectionId: target.id,
    profile: target,
    prefix: '',
    recentPrefixes: target.recentPrefixes,
    pinnedPrefixes: target.pinnedPrefixes,
    publicRead: target.publicRead,
    checksum: target.checksum,
    recentPrefixesByConnection: nextRecentsByConnection,
    replaceRecentPrefixesByConnection: true,
  });
  if (!persisted) {
    closeConnectionMenu({ restoreFocus: true });
    showConnectionSwitcherStatus('The Space was not switched because settings could not be saved. You are still connected to the original Space.', { error: true });
    return false;
  }

  showConnectionSwitcherStatus();
  remoteLoadSequence += 1;
  state.connections = nextConnections;
  state.recentPrefixesByConnection = nextRecentsByConnection;
  state.activeConnectionId = target.id;
  state.remotePrefix = '';
  state.remoteEntries = [];
  state.pinnedPrefixes = [...target.pinnedPrefixes];
  state.driveShell = driveShellCore.normalizeDriveShellState({ ...state.driveShell, search: '' });
  els.driveSearch.value = '';
  els.prefix.value = '';
  els.publicRead.checked = target.publicRead;
  els.checksum.value = target.checksum;
  els.health.textContent = `Opening ${target.name}...`;
  els.health.className = 'health';
  closeConnectionMenu({ restoreFocus: true });
  updateConnectionChrome();
  await loadRemote('');
  return true;
}

function switchActiveConnection(connectionId) {
  if (connectionSwitchPromise) return connectionSwitchPromise;
  const operation = runConnectionMutation(() => performActiveConnectionSwitch(connectionId))
    .finally(() => {
      if (connectionSwitchPromise === operation) connectionSwitchPromise = null;
      setRunning(state.isRunning);
      if (automaticQueuePending) scheduleAutomaticQueue();
    });
  connectionSwitchPromise = operation;
  setRunning(state.isRunning);
  return operation;
}

function openConnectionsView({ add = false } = {}) {
  closeConnectionMenu();
  setViewMode('explorer');
  setDriveShellView('connections', { focus: !add });
  renderConnectionsPanel();
  if (add) {
    els.connectionEditor.open = true;
    requestAnimationFrame(() => els.connectionName.focus());
  }
}

function clearConnectionDraft({ keepProfile = false } = {}) {
  els.connectionName.value = '';
  if (!keepProfile) {
    els.profileRemote.value = '';
    els.profileBucket.value = '';
    els.profileRegion.value = 'nyc3';
    els.profileEndpoint.value = DIGITALOCEAN_REGION_ENDPOINTS.nyc3;
  }
  els.setupAccessKey.value = '';
  els.setupSecretKey.value = '';
  updateProfileStatus('Not connected');
}

function descriptorFromDraft(profile, lastTestedAt = new Date().toISOString()) {
  const existing = state.connections.find((connection) => connectionCore.connectionProfileMatches(connection, profile));
  let id = existing?.id || connectionCore.repairManagedConnectionId(profile.remote, profile);
  let collision = 0;
  while (state.connections.some((connection) => connection.id === id && !connectionCore.connectionProfileMatches(connection, profile))) {
    collision += 1;
    id = connectionCore.repairManagedConnectionId(profile.remote, profile, collision);
  }
  return connectionCore.sanitizeConnection({
    id,
    name: els.connectionName.value.trim() || existing?.name || profile.bucket || profile.remote,
    ...profile,
    publicRead: els.publicRead.checked,
    checksum: els.checksum.value,
    recentPrefixes: existing?.recentPrefixes || [],
    pinnedPrefixes: existing?.pinnedPrefixes || [],
    lastTestedAt,
  });
}

async function persistAddedConnection(descriptor) {
  const sameProfile = state.connections.find((connection) => connectionCore.connectionProfileMatches(connection, descriptor));
  if (sameProfile) {
    descriptor = connectionCore.sanitizeConnection({ ...descriptor, id: sameProfile.id });
  } else if (state.connections.some((connection) => connection.id === descriptor.id)) {
    let collision = 1;
    let id = connectionCore.repairManagedConnectionId(descriptor.id, descriptor, collision);
    while (state.connections.some((connection) => connection.id === id)) {
      collision += 1;
      id = connectionCore.repairManagedConnectionId(descriptor.id, descriptor, collision);
    }
    descriptor = connectionCore.sanitizeConnection({ ...descriptor, id });
  }
  const currentConnections = connectionsWithCurrentPreferences();
  const existingIndex = currentConnections.findIndex((connection) => connection.id === descriptor.id);
  const nextConnections = existingIndex >= 0
    ? currentConnections.map((connection, index) => index === existingIndex ? descriptor : connection)
    : [...currentConnections, descriptor];
  const makeActive = !activeConnection();
  const nextRecentsByConnection = synchronizedRecentPrefixesByConnection(nextConnections, {
    ...state.recentPrefixesByConnection,
    [descriptor.id]: descriptor.recentPrefixes,
  });
  const persisted = await persistSettings({
    connections: nextConnections,
    activeConnectionId: makeActive ? descriptor.id : state.activeConnectionId,
    profile: makeActive ? descriptor : currentProfile(),
    prefix: makeActive ? '' : state.remotePrefix,
    recentPrefixes: makeActive ? descriptor.recentPrefixes : currentRecentPrefixes(),
    pinnedPrefixes: makeActive ? descriptor.pinnedPrefixes : state.pinnedPrefixes,
    publicRead: makeActive ? descriptor.publicRead : els.publicRead.checked,
    checksum: makeActive ? descriptor.checksum : els.checksum.value,
    recentPrefixesByConnection: nextRecentsByConnection,
    replaceRecentPrefixesByConnection: true,
  });
  if (!persisted) throw new Error('The connection could not be saved.');
  state.connections = nextConnections;
  state.recentPrefixesByConnection = nextRecentsByConnection;
  if (makeActive) {
    state.activeConnectionId = descriptor.id;
    state.remotePrefix = '';
    state.pinnedPrefixes = [...descriptor.pinnedPrefixes];
    els.prefix.value = '';
    els.publicRead.checked = descriptor.publicRead;
    els.checksum.value = descriptor.checksum;
  }
  updateConnectionChrome();
  showConnectionNotice(`${descriptor.name} is connected.`);
  clearConnectionDraft();
  els.connectionEditor.open = false;
  if (makeActive) await loadRemote('');
}

function clearConnectionSecrets() {
  els.setupAccessKey.value = '';
  els.setupSecretKey.value = '';
}

function addConnectionFromDraft({ createProfile = false } = {}) {
  const credentials = Object.freeze({
    accessKeyId: String(els.setupAccessKey.value),
    secretAccessKey: String(els.setupSecretKey.value),
  });
  clearConnectionSecrets();
  return runConnectionMutation(async () => {
    let setupAttempt = null;
    let descriptorPersisted = false;
    try {
      const profile = connectionCore.sanitizeConnectionProfile(draftProfile());
      if (createProfile) {
        const setupRequest = Object.freeze({
          name: profile.remote,
          bucket: profile.bucket,
          region: els.profileRegion.value,
          endpoint: profile.endpointHost,
          accessKeyId: credentials.accessKeyId,
          secretAccessKey: credentials.secretAccessKey,
          publicRead: els.publicRead.checked,
        });
        const setup = await api.setupDigitalOceanProfile(setupRequest);
        if (!setup?.ok) throw new Error('The rclone profile was not created.');
        setupAttempt = setup;
      }
      const system = await api.checkSystem(profile);
      const testedProfile = connectionCore.sanitizeConnectionProfile({
        remote: system.remote || profile.remote,
        bucket: system.bucket || profile.bucket,
        endpointHost: system.endpointHost || profile.endpointHost,
      });
      await persistAddedConnection(descriptorFromDraft(testedProfile));
      descriptorPersisted = true;
      if (setupAttempt?.setupToken) {
        await api.commitDigitalOceanProfileSetup({
          setupToken: setupAttempt.setupToken,
          name: profile.remote,
        });
        setupAttempt = null;
      }
    } catch (error) {
      let rollbackError = null;
      if (setupAttempt?.setupToken && !descriptorPersisted) {
        try {
          await api.rollbackDigitalOceanProfileSetup({
            setupToken: setupAttempt.setupToken,
            name: setupAttempt.profile?.remote || setupAttempt.redacted?.name || '',
          });
        } catch (failure) {
          rollbackError = failure;
        }
      }
      const message = rollbackError
        ? `${error.message} The new rclone profile could not be rolled back: ${rollbackError.message}`
        : error.message;
      showConnectionNotice(message, { error: true });
      appendLog(`Connection setup failed: ${message}`, 'error');
    } finally {
      clearConnectionSecrets();
    }
  });
}

function showConnectionPackageStatus(element, message = '', { error = false } = {}) {
  if (!element) return;
  element.textContent = message;
  element.classList.toggle('is-error', error);
  element.hidden = !message;
}

function clearConnectionExportSecrets() {
  if (els.connectionExportAccessKey) els.connectionExportAccessKey.value = '';
  if (els.connectionExportSecretKey) els.connectionExportSecretKey.value = '';
  if (els.connectionExportPassword) els.connectionExportPassword.value = '';
  if (els.connectionExportPasswordConfirm) els.connectionExportPasswordConfirm.value = '';
  if (els.connectionExportAcknowledge) els.connectionExportAcknowledge.checked = false;
}

function closeConnectionExportDialog() {
  clearConnectionExportSecrets();
  connectionExportId = '';
  showConnectionPackageStatus(els.connectionExportStatus);
  if (els.connectionExportDialog?.open) els.connectionExportDialog.close();
}

function openConnectionExportDialog(connection) {
  connectionExportId = connection.id;
  clearConnectionExportSecrets();
  els.connectionExportIncludeKeys.checked = false;
  els.connectionExportSecrets.hidden = true;
  els.connectionExportTitle.textContent = `Export ${connection.name}`;
  els.connectionExportSummary.textContent = `${connection.bucket} at ${connection.endpointHost}`;
  showConnectionPackageStatus(els.connectionExportStatus);
  els.connectionExportDialog.showModal();
  requestAnimationFrame(() => els.connectionExportIncludeKeys.focus());
}

async function submitConnectionExport() {
  const connection = state.connections.find((candidate) => candidate.id === connectionExportId);
  if (!connection) {
    showConnectionPackageStatus(els.connectionExportStatus, 'This connection is no longer available.', { error: true });
    return;
  }
  const includeKeys = els.connectionExportIncludeKeys.checked;
  const request = {
    connection,
    includeKeys,
    accessKeyId: includeKeys ? String(els.connectionExportAccessKey.value) : '',
    secretAccessKey: includeKeys ? String(els.connectionExportSecretKey.value) : '',
    password: includeKeys ? String(els.connectionExportPassword.value) : '',
  };
  const passwordConfirmation = includeKeys ? String(els.connectionExportPasswordConfirm.value) : '';
  const acknowledged = !includeKeys || els.connectionExportAcknowledge.checked;
  clearConnectionExportSecrets();
  if (includeKeys && (!request.accessKeyId.trim() || !request.secretAccessKey.trim())) {
    showConnectionPackageStatus(els.connectionExportStatus, 'Enter both Spaces access keys.', { error: true });
    return;
  }
  if (includeKeys && request.password.length < 12) {
    showConnectionPackageStatus(els.connectionExportStatus, 'Use a package password with at least 12 characters.', { error: true });
    return;
  }
  if (includeKeys && request.password !== passwordConfirmation) {
    showConnectionPackageStatus(els.connectionExportStatus, 'The package passwords do not match.', { error: true });
    return;
  }
  if (!acknowledged) {
    showConnectionPackageStatus(els.connectionExportStatus, 'Confirm that this package grants server access.', { error: true });
    return;
  }
  els.connectionExportSave.disabled = true;
  els.connectionExportDialog.setAttribute('aria-busy', 'true');
  showConnectionPackageStatus(els.connectionExportStatus, includeKeys
    ? 'Encrypting the keys and saving the package...'
    : 'Saving connection settings...');
  try {
    const result = await api.exportConnection(request);
    if (result?.ok) {
      closeConnectionExportDialog();
      showConnectionNotice(includeKeys
        ? `${connection.name} was exported with password-protected access keys.`
        : `${connection.name} settings were exported without keys.`);
    } else if (!result?.cancelled) {
      throw new Error('The connection package was not saved.');
    } else {
      showConnectionPackageStatus(els.connectionExportStatus, 'Export cancelled.');
    }
  } catch (error) {
    showConnectionPackageStatus(els.connectionExportStatus, `Export failed: ${error.message}`, { error: true });
  } finally {
    clearConnectionExportSecrets();
    els.connectionExportSave.disabled = false;
    els.connectionExportDialog.removeAttribute('aria-busy');
  }
}

function renderConnectionImportPreview(connection, { encrypted }) {
  const descriptor = connectionCore.sanitizeConnection(connection);
  els.connectionImportName.textContent = descriptor.name;
  els.connectionImportBucket.textContent = descriptor.bucket;
  els.connectionImportEndpoint.textContent = descriptor.endpointHost;
  els.connectionImportRemote.textContent = descriptor.remote;
  els.connectionImportKeyNote.textContent = encrypted
    ? 'Encrypted access keys are ready. Importing will create the local rclone profile and test the Space.'
    : 'This package has no access keys. Importing adds the settings; the matching rclone profile must already exist or be added afterward.';
  els.connectionImportPreview.hidden = false;
  els.connectionImportLocked.hidden = true;
  els.connectionImportSave.disabled = false;
  pendingConnectionImport.connection = descriptor;
}

function rememberConnectionImportFocus(control) {
  connectionImportReturnFocus = control instanceof HTMLElement && control.isConnected
    ? control
    : els.connectionSwitcher;
}

function restoreConnectionImportFocus() {
  const target = connectionImportReturnFocus?.isConnected
    ? connectionImportReturnFocus
    : els.connectionSwitcher;
  connectionImportReturnFocus = null;
  target?.focus({ preventScroll: true });
  requestAnimationFrame(() => target?.focus({ preventScroll: true }));
}

async function closeConnectionImportDialog() {
  const importToken = pendingConnectionImport?.importToken || '';
  pendingConnectionImport = null;
  if (els.connectionImportPassword) els.connectionImportPassword.value = '';
  showConnectionPackageStatus(els.connectionImportStatus);
  if (els.connectionImportDialog?.open) els.connectionImportDialog.close();
  if (importToken) {
    try {
      await api.cancelConnectionImport({ importToken });
    } catch (_error) {
      // Closing the dialog still clears the renderer copy even if the main process already consumed it.
    }
  }
  restoreConnectionImportFocus();
}

async function importConnectionSettings(returnFocus = els.connectionSwitcher) {
  rememberConnectionImportFocus(returnFocus);
  closeConnectionMenu();
  showConnectionSwitcherStatus();
  try {
    const result = await api.importConnection();
    if (!result?.ok) {
      restoreConnectionImportFocus();
      return;
    }
    pendingConnectionImport = {
      encrypted: result.encrypted === true,
      importToken: result.importToken || '',
      connection: result.connection || null,
    };
    els.connectionImportLocked.hidden = !pendingConnectionImport.encrypted;
    els.connectionImportPreview.hidden = true;
    els.connectionImportSave.disabled = true;
    els.connectionImportPassword.value = '';
    showConnectionPackageStatus(els.connectionImportStatus);
    if (pendingConnectionImport.connection) {
      renderConnectionImportPreview(pendingConnectionImport.connection, { encrypted: false });
    }
    els.connectionImportDialog.showModal();
    requestAnimationFrame(() => (pendingConnectionImport.encrypted
      ? els.connectionImportPassword
      : els.connectionImportSave).focus());
  } catch (error) {
    showConnectionSwitcherStatus(`Import failed: ${error.message}`, { error: true });
    restoreConnectionImportFocus();
  }
}

async function unlockSelectedConnectionImport() {
  if (!pendingConnectionImport?.encrypted || !pendingConnectionImport.importToken) return;
  const importToken = pendingConnectionImport.importToken;
  const password = String(els.connectionImportPassword.value);
  els.connectionImportPassword.value = '';
  els.connectionImportUnlock.disabled = true;
  showConnectionPackageStatus(els.connectionImportStatus, 'Unlocking package...');
  try {
    const result = await api.unlockConnectionImport({
      importToken,
      password,
    });
    if (pendingConnectionImport?.importToken !== importToken) return;
    if (!result?.ok || !result.connection) throw new Error('The connection package could not be unlocked.');
    renderConnectionImportPreview(result.connection, { encrypted: true });
    showConnectionPackageStatus(els.connectionImportStatus);
    requestAnimationFrame(() => els.connectionImportSave.focus());
  } catch (error) {
    showConnectionPackageStatus(els.connectionImportStatus, error.message, { error: true });
    requestAnimationFrame(() => els.connectionImportPassword.focus());
  } finally {
    els.connectionImportUnlock.disabled = false;
  }
}

async function saveSelectedConnectionImport() {
  if (!pendingConnectionImport?.connection) return;
  const selectedImport = pendingConnectionImport;
  els.connectionImportSave.disabled = true;
  els.connectionImportCancel.disabled = true;
  els.connectionImportClose.disabled = true;
  els.connectionImportUnlock.disabled = true;
  els.connectionImportDialog.setAttribute('aria-busy', 'true');
  showConnectionPackageStatus(els.connectionImportStatus, selectedImport.encrypted
    ? 'Creating the local profile and testing the Space...'
    : 'Saving connection settings...');
  try {
    await runConnectionMutation(async () => {
      const lifecycleBlocker = await currentConnectionChangeBlocker();
      if (lifecycleBlocker) {
        throw new Error('A transfer is active. Pause or finish it before importing a connection.');
      }
      if (!selectedImport.encrypted) {
        await persistAddedConnection(selectedImport.connection);
        return;
      }
      let setupAttempt = null;
      let descriptorPersisted = false;
      try {
        const created = await api.createProfileFromConnectionImport({
          importToken: selectedImport.importToken,
        });
        selectedImport.importToken = '';
        if (!created?.ok || !created.setup?.setupToken) {
          throw new Error('The local rclone profile was not created.');
        }
        setupAttempt = created.setup;
        const system = await api.checkSystem(created.connection);
        const descriptor = connectionCore.sanitizeConnection({
          ...created.connection,
          remote: system.remote || created.connection.remote,
          bucket: system.bucket || created.connection.bucket,
          endpointHost: system.endpointHost || created.connection.endpointHost,
          lastTestedAt: new Date().toISOString(),
        });
        await persistAddedConnection(descriptor);
        descriptorPersisted = true;
        await api.commitDigitalOceanProfileSetup({
          setupToken: setupAttempt.setupToken,
          name: descriptor.remote,
        });
        setupAttempt = null;
      } catch (error) {
        if (setupAttempt?.setupToken && !descriptorPersisted) {
          try {
            await api.rollbackDigitalOceanProfileSetup({
              setupToken: setupAttempt.setupToken,
              name: setupAttempt.profile?.remote || '',
            });
          } catch (rollbackError) {
            throw new Error(`${error.message} The new rclone profile could not be rolled back: ${rollbackError.message}`);
          }
        }
        throw error;
      }
    });
    pendingConnectionImport = null;
    connectionImportReturnFocus = null;
    if (els.connectionImportDialog.open) els.connectionImportDialog.close();
    openConnectionsView();
    showConnectionNotice(selectedImport.encrypted
      ? `${selectedImport.connection.name} was imported with its encrypted access keys.`
      : `${selectedImport.connection.name} settings were imported. Test the connection or add its access keys if needed.`);
  } catch (error) {
    if (selectedImport.encrypted && !selectedImport.importToken) {
      pendingConnectionImport = null;
    }
    showConnectionPackageStatus(els.connectionImportStatus, `Import failed: ${error.message}`, { error: true });
  } finally {
    els.connectionImportSave.disabled = !pendingConnectionImport?.connection;
    els.connectionImportCancel.disabled = false;
    els.connectionImportClose.disabled = false;
    els.connectionImportUnlock.disabled = false;
    els.connectionImportDialog.removeAttribute('aria-busy');
  }
}

function testSavedConnection(connection) {
  showConnectionNotice(`Testing ${connection.name}...`);
  return runConnectionMutation(async () => {
  try {
    const latest = state.connections.find((candidate) => candidate.id === connection.id);
    if (!latest) throw new Error('The connection is no longer available.');
    await api.checkSystem(latest);
    const currentConnections = connectionsWithCurrentPreferences();
    const current = currentConnections.find((candidate) => candidate.id === connection.id);
    const updated = connectionCore.sanitizeConnection({
      ...current,
      lastTestedAt: new Date().toISOString(),
    });
    const nextConnections = currentConnections.map((candidate) => candidate.id === connection.id ? updated : candidate);
    if (!await persistSettings({ connections: nextConnections })) {
      throw new Error('The successful test could not be saved.');
    }
    state.connections = nextConnections;
    renderConnectionMenu();
    renderConnectionsPanel();
    showConnectionNotice(`${connection.name} is ready.`);
  } catch (error) {
    showConnectionNotice(`${connection.name} could not connect: ${error.message}`, { error: true });
  }
  });
}

function renameConnectionTo(connectionId, name) {
  return runConnectionMutation(async () => {
  const connection = state.connections.find((candidate) => candidate.id === connectionId);
  if (!connection) return false;
  if (name === null || name.trim() === connection.name) return;
  try {
    const currentConnections = connectionsWithCurrentPreferences();
    const current = currentConnections.find((candidate) => candidate.id === connection.id) || connection;
    const updated = connectionCore.sanitizeConnection({ ...current, name });
    const nextConnections = currentConnections.map((candidate) => candidate.id === connection.id ? updated : candidate);
    if (!await persistSettings({ connections: nextConnections })) throw new Error('The new name could not be saved.');
    state.connections = nextConnections;
    updateConnectionChrome();
    showConnectionNotice(`Renamed to ${updated.name}.`);
  } catch (error) {
    showConnectionNotice(error.message, { error: true });
  }
  return true;
  });
}

function renameConnection(connection) {
  const name = window.prompt('Connection name:', connection.name);
  if (name === null) return Promise.resolve(false);
  return renameConnectionTo(connection.id, name);
}

function removeConnectionDescriptor(connection) {
  return runConnectionMutation(async () => {
  try {
    connection = state.connections.find((candidate) => candidate.id === connection.id);
    if (!connection) return;
    const lifecycleBlocker = await currentConnectionChangeBlocker();
    if (lifecycleBlocker) {
      showConnectionChangeBlocker(lifecycleBlocker);
      return;
    }
    const removingActive = connection.id === state.activeConnectionId;
    const blockers = await blockersForConnection(connection);
    if (blockers.length) {
      showConnectionRemovalBlockers(connection, blockers);
      return;
    }
    if (!window.confirm(`Remove ${connection.name} from Murdawk Uplink?\n\nThis keeps the rclone profile and all server files.`)) return;
    const removal = connectionCore.connectionStateAfterRemoval({
      connections: connectionsWithCurrentPreferences(),
      removeId: connection.id,
      activeConnectionId: state.activeConnectionId,
      jobs: state.queueJobs,
    });
    const nextConnections = [...removal.connections];
    const nextActive = removal.activeConnection;
    const filteredRecentsByConnection = Object.fromEntries(
      Object.entries(state.recentPrefixesByConnection).filter(([id]) => id !== connection.id),
    );
    const nextRecentsByConnection = synchronizedRecentPrefixesByConnection(nextConnections, filteredRecentsByConnection);
    if (!await persistSettings({
      connections: nextConnections,
      activeConnectionId: nextActive?.id || '',
      profile: nextActive || { remote: '', bucket: '', endpointHost: '' },
      prefix: removingActive ? '' : state.remotePrefix,
      recentPrefixes: nextActive?.recentPrefixes || [],
      pinnedPrefixes: nextActive?.pinnedPrefixes || [],
      publicRead: nextActive?.publicRead ?? true,
      checksum: nextActive?.checksum || 'size',
      recentPrefixesByConnection: nextRecentsByConnection,
      replaceRecentPrefixesByConnection: true,
    })) throw new Error('The connection was not removed because settings could not be saved.');
    remoteLoadSequence += 1;
    state.connections = nextConnections;
    state.recentPrefixesByConnection = nextRecentsByConnection;
    state.activeConnectionId = nextActive?.id || '';
    if (removingActive || !nextActive) state.remotePrefix = '';
    state.pinnedPrefixes = [...(nextActive?.pinnedPrefixes || [])];
    els.publicRead.checked = nextActive?.publicRead ?? true;
    els.checksum.value = nextActive?.checksum || 'size';
    updateConnectionChrome();
    showConnectionNotice(`${connection.name} was removed from Uplink.`);
    await loadRemote(state.remotePrefix);
  } catch (error) {
    showConnectionNotice(error.message, { error: true });
  }
  });
}

function removeUnderlyingRcloneProfile(connection) {
  return runConnectionMutation(async () => {
  try {
    connection = state.connections.find((candidate) => candidate.id === connection.id);
    if (!connection) return;
    const lifecycleBlocker = await currentConnectionChangeBlocker();
    if (lifecycleBlocker) {
      showConnectionChangeBlocker(lifecycleBlocker);
      return;
    }
    const blockers = await blockersForConnection(connection);
    if (blockers.length) {
      showConnectionRemovalBlockers(connection, blockers);
      return;
    }
    if (!window.confirm(`Advanced action: remove the local rclone profile "${connection.remote}"?\n\nThis does not remove the Uplink connection or server files.`)) return;
    const confirmation = window.prompt(`Type the exact rclone profile name to continue:\n${connection.remote}`);
    if (confirmation !== connection.remote) {
      showConnectionNotice('The rclone profile was not removed because the confirmation did not match.', { error: true });
      return;
    }
    await api.removeRcloneProfile({ connection, name: connection.remote, confirmation });
    showConnectionNotice(`The local rclone profile ${connection.remote} was removed. The Uplink connection remains listed.`);
  } catch (error) {
    try {
      const blockers = await blockersForConnection(connection);
      if (blockers.length) {
        showConnectionRemovalBlockers(connection, blockers);
        return;
      }
    } catch (_blockerError) {
      // Keep the original profile removal failure visible when the follow-up guard cannot load.
    }
    showConnectionNotice(`The rclone profile could not be removed: ${error.message}`, { error: true });
  }
  });
}

async function handleConnectionAction(action, connectionId) {
  const connection = state.connections.find((candidate) => candidate.id === connectionId);
  if (!connection) return;
  if (action === 'activate') await switchActiveConnection(connection.id);
  if (action === 'test') await testSavedConnection(connection);
  if (action === 'export') openConnectionExportDialog(connection);
  if (action === 'rename') await renameConnection(connection);
  if (action === 'remove') await removeConnectionDescriptor(connection);
  if (action === 'remove-profile') await removeUnderlyingRcloneProfile(connection);
}

function currentSettings() {
  const profile = currentProfile();
  return {
    connectionId: state.activeConnectionId,
    connections: state.connections,
    profile: { ...profile },
    profileSnapshot: { ...profile },
    prefix: els.prefix.value,
    filterMode: els.filterMode.value,
    include: els.include.value,
    folderUploadMode: els.folderUploadMode.value,
    publicRead: els.publicRead.checked,
    checksum: els.checksum.value,
    notifyWebhook: els.notifyWebhook.value,
    notifyNtfy: els.notifyNtfy.value,
    notifyOn: els.notifyOn.value,
    archiveEvent: els.archiveEvent.value,
    archiveCategory: els.archiveCategory.value,
    archiveStage: els.archiveStage.value,
    archiveDay: els.archiveDay.value,
    archivePackageName: els.archivePackageName.value,
  };
}

function hydrateQueueJobs(queueJobs = [], connections = state.connections) {
  return queueJobs.map((job) => explorerCore.createQueueJob({
    id: job.id,
    intentId: job.intentId,
    clientJobId: job.clientJobId,
    sources: job.sources,
    settings: {
      ...job,
      connections,
      notifyWebhook: '',
      notifyNtfy: '',
      notifyOn: job.notifications?.notifyOn || 'success',
    },
    status: job.status,
    jobId: job.jobId,
    urls: job.urls,
    error: job.error,
    verification: job.verification,
  }));
}

function currentRequest(job) {
  return job ? explorerCore.queueJobRequest(job) : {
    sources: [],
    ...currentSettings(),
  };
}

function withProfile(request = {}) {
  return {
    ...request,
    profile: currentProfile(),
  };
}

function appendLog(text, tone = 'normal') {
  const safeText = activityCore.redactLogText(text);
  const line = tone === 'error' ? `[error] ${safeText}` : safeText;
  const bounded = explorerCore.appendBoundedLogText(
    els.log.textContent,
    line,
    { maxLines: LOG_MAX_LINES, maxChars: LOG_MAX_CHARS },
  );
  els.log.textContent = bounded.text;
  els.log.scrollTop = els.log.scrollHeight;
}

function flushPendingRcloneLog() {
  if (!pendingRcloneLogText) return;
  const text = pendingRcloneLogText;
  pendingRcloneLogText = '';
  appendLog(text.trimEnd());
}

function appendRcloneLog(text = '') {
  pendingRcloneLogText = `${pendingRcloneLogText}${text}`;
  if (pendingRcloneLogText.length > 24000) {
    pendingRcloneLogText = pendingRcloneLogText.slice(-24000);
  }
  if (rcloneLogFlushTimer) return;
  rcloneLogFlushTimer = setTimeout(() => {
    rcloneLogFlushTimer = null;
    flushPendingRcloneLog();
  }, 750);
}

function setRunning(isRunning) {
  state.isRunning = isRunning;
  const controlsLocked = isRunning || schedulingBlockedByExternalLifecycle || connectionMutationPending > 0;
  const connectionUnavailable = !hasActiveConnection();
  const hasQueueJobs = state.queueJobs.some((job) => job.status !== 'complete');
  const uploadReadiness = explorerCore.queueCanUploadAll(state.queueJobs);
  const selected = selectedQueueJob();
  els.dryRun.disabled = controlsLocked || !hasQueueJobs;
  els.verify.disabled = controlsLocked || !state.selectedQueueJobId;
  els.upload.disabled = controlsLocked || !uploadReadiness.ok;
  els.checkUploadSelected.disabled = controlsLocked || !selected || selected.status === 'complete';
  els.dryRunSelected.disabled = controlsLocked || !selected || selected.status === 'complete';
  els.uploadSelected.disabled = controlsLocked || !selected || selected.status !== 'ready';
  for (const control of [
    els.driveChooseFiles,
    els.driveChooseFolder,
    els.driveNewFolder,
    els.refreshRemote,
    els.newRemoteFolder,
    els.goRemotePath,
    els.pinCurrentFolder,
  ]) {
    if (control) control.disabled = connectionUnavailable || controlsLocked;
  }
  if (els.remotePath) els.remotePath.disabled = connectionUnavailable || controlsLocked;
  if (els.driveSearch) els.driveSearch.disabled = connectionUnavailable;
  updateRemoteDownloadControls();
  updateConnectionMutationControls();
  updateCancelControl();
  if (els.resumeHistory) {
    const selected = state.historyRecords.find((item) => item.jobId === state.selectedHistoryJobId);
    els.resumeHistory.disabled = controlsLocked || !selected || !historyCanResume(selected);
  }
  updatePauseAllControl();
}

function updateRemoteDownloadControls(items = selectedRemoteItems()) {
  const unavailable = !hasActiveConnection()
    || connectionMutationPending > 0
    || items.length === 0;
  if (els.downloadRemoteItems) els.downloadRemoteItems.disabled = unavailable;
  if (els.inspectorDownload) els.inspectorDownload.disabled = unavailable;
  if (els.dialogDownload) els.dialogDownload.disabled = unavailable;
}

function updateCancelControl() {
  const activeJob = state.queueJobs.find((job) => job.id === state.activeQueueJobId) || null;
  const eligibility = pauseCore.cancelEligibility({
    isRunning: state.isRunning,
    activeTransfer: state.activeTransfer,
    activeJob,
  });
  els.cancel.disabled = !eligibility.enabled;
  els.cancel.title = eligibility.reason;
  els.cancel.setAttribute('aria-label', eligibility.reason);
}

function currentPauseEligibility(activeTransfer = state.activeTransfer) {
  const activeJob = state.queueJobs.find((job) => job.id === state.activeQueueJobId) || null;
  return pauseCore.pauseEligibility({
    activeTransfer,
    activeJob,
    externalLifecycle: schedulingBlockedByExternalLifecycle,
  });
}

function updatePauseAllControl() {
  if (!els.transferShelfPauseAll) return;
  const eligibility = currentPauseEligibility();
  els.transferShelfPauseAll.disabled = !eligibility.enabled;
  els.transferShelfPauseAll.title = eligibility.reason;
  els.transferShelfPauseAll.setAttribute(
    'aria-label',
    eligibility.enabled ? 'Pause active transfer' : `Pause transfer unavailable: ${eligibility.reason}`,
  );
  if (els.transferShelfPauseAllHelp) {
    els.transferShelfPauseAllHelp.textContent = eligibility.reason;
  }
}

function currentQueueLifecycleGate({ ownedLifecycle = false, error = null } = {}) {
  if (connectionMutationPending > 0) {
    return {
      ok: false,
      externalLifecycle: false,
      error: 'Connection settings are changing.',
      message: 'Connection settings are changing. The transfer will start when that finishes.',
    };
  }
  return explorerCore.queueLifecycleGate({
    isRunning: state.isRunning,
    externalLifecycle: schedulingBlockedByExternalLifecycle,
    ownedLifecycle,
    error,
  });
}

function scheduleAutomaticQueue() {
  if (connectionSwitchPromise || connectionMutationPending > 0) {
    automaticQueuePending = true;
    return false;
  }
  if (preparedQueueResumes.size) return false;
  if (!currentQueueLifecycleGate().ok) {
    automaticQueuePending = true;
    return false;
  }
  automaticQueuePending = false;
  queueMicrotask(runAutomaticQueue);
  return true;
}

function prepareQueueResumePersistence(candidate, original = null) {
  const prepared = { candidate, original };
  preparedQueueResumes.set(candidate.id, prepared);
  return prepared;
}

function finishQueueResumePersistence(prepared) {
  const current = state.queueJobs.find((job) => job.id === prepared.candidate.id);
  const ownsCurrentCandidate = preparedQueueResumes.get(prepared.candidate.id) === prepared
    && current === prepared.candidate
    && current.status === 'queued';
  if (preparedQueueResumes.get(prepared.candidate.id) === prepared) {
    preparedQueueResumes.delete(prepared.candidate.id);
  }
  return ownsCurrentCandidate;
}

function rollbackQueueResumePersistence(prepared) {
  const current = state.queueJobs.find((job) => job.id === prepared.candidate.id);
  const ownsCurrentCandidate = preparedQueueResumes.get(prepared.candidate.id) === prepared
    && current === prepared.candidate
    && current.status === 'queued';
  if (preparedQueueResumes.get(prepared.candidate.id) === prepared) {
    preparedQueueResumes.delete(prepared.candidate.id);
  }
  if (!ownsCurrentCandidate) return false;
  state.queueJobs = prepared.original
    ? state.queueJobs.map((job) => job === prepared.candidate ? prepared.original : job)
    : state.queueJobs.filter((job) => job !== prepared.candidate);
  if (!prepared.original && state.selectedQueueJobId === prepared.candidate.id) {
    state.selectedQueueJobId = '';
  }
  renderQueue();
  renderActivity();
  renderHistory();
  return true;
}

async function holdQueueJobForExternalLifecycle(jobId, error = null) {
  const gate = currentQueueLifecycleGate({ error });
  if (!gate.externalLifecycle) return false;
  schedulingBlockedByExternalLifecycle = true;
  automaticQueuePending = true;
  const job = state.queueJobs.find((candidate) => candidate.id === jobId);
  if (job) {
    const waitingStatus = job.status === 'uploading' || job.status === 'ready'
      ? 'ready'
      : job.status === 'queued'
        ? 'queued'
        : gate.waitingStatus;
    await setQueueJobStatus(job.id, waitingStatus, { error: gate.message });
  }
  resetActiveTransferShelfState();
  setRunning(false);
  renderTransferShelf();
  appendLog(gate.message);
  return true;
}

function updateQueueDrawerState() {
  const summary = transferShelfCore.summarizeTransferShelf(state.queueJobs);
  const shouldPersist = transferShelfCore.shelfShouldPersist(state.queueJobs);
  if (shouldPersist && !state.transferShelfHasRelevantWork) {
    state.driveShell = driveShellCore.normalizeDriveShellState({
      ...state.driveShell,
      queueDrawerOpen: true,
    });
  } else if (!shouldPersist && state.transferShelfHasRelevantWork) {
    state.driveShell = driveShellCore.normalizeDriveShellState({
      ...state.driveShell,
      queueDrawerOpen: false,
    });
  }
  state.transferShelfHasRelevantWork = shouldPersist;

  const isExpanded = state.driveShell.queueDrawerOpen;
  const isVisible = shouldPersist || isExpanded;
  els.transferShelf.hidden = !isVisible;
  els.transferShelf.classList.toggle('is-collapsed', !isExpanded);
  els.transferShelfToggle.setAttribute('aria-expanded', String(isExpanded));
  els.transferShelfToggle.setAttribute('aria-label', isExpanded ? 'Collapse transfers' : 'Expand transfers');
  els.transferShelfToggle.title = isExpanded ? 'Collapse transfers' : 'Expand transfers';
  els.transferShelfToggle.textContent = isExpanded ? '\u2212' : '\u2191';
  if (els.openQueueDrawer) {
    els.openQueueDrawer.setAttribute('aria-expanded', String(isVisible && isExpanded));
    els.openQueueDrawer.textContent = 'Transfers';
    els.openQueueDrawer.title = summary.label;
  }
  if (els.queueDrawerTitle) {
    els.queueDrawerTitle.textContent = summary.label;
  }
  els.transferShelfCounts.textContent = summary.label;
  if (els.transferShelfSummary.textContent !== summary.label) {
    els.transferShelfSummary.textContent = summary.label;
  }
}

function transferShelfSourceName(job = {}) {
  if (job.direction === 'download') {
    const first = job.remoteItems?.[0]?.name || sourceDisplayName(job.sources?.[0] || '');
    return (job.remoteItems?.length || 0) > 1 ? `${first} + ${job.remoteItems.length - 1} more` : first;
  }
  const first = job.sources?.[0] || '';
  const name = sourceDisplayName(first);
  return (job.sources?.length || 0) > 1 ? `${name} + ${job.sources.length - 1} more` : name;
}

function transferShelfTechnicalDetail(job = {}, progress = {}, queuePosition = -1, waitingTotal = 0) {
  const sourceIndex = Number(progress.sourceIndex) || 0;
  const sourceTotal = Number(progress.sourceTotal) || 0;
  const chunkSize = job.direction === 'download' ? '' : progress.diagnostics?.tuning?.chunkSize || '';
  return [
    queuePosition >= 0 ? `Queue ${queuePosition + 1} of ${waitingTotal}` : '',
    sourceIndex > 0 && sourceTotal > 0 ? `Source ${sourceIndex} of ${sourceTotal}` : '',
    explorerCore.queueJobCountDetail(job),
    chunkSize ? `chunk ${chunkSize}` : '',
  ].filter(Boolean).join(' / ');
}

function renderTransferShelf() {
  const waitingJobs = state.queueJobs.filter((job) =>
    ['queued', 'ready', 'paused', 'needs-resume-check', 'cancelled'].includes(job.status));

  els.transferShelfList.innerHTML = state.queueJobs.length
    ? state.queueJobs.map((job) => {
      const isOptimisticallyCancelling = rendererCancellationClaim?.clientJobId === job.id;
      const statusLabel = isOptimisticallyCancelling
        ? 'Cancelling'
        : transferShelfCore.transferShelfStatusLabel(job);
      const queuePosition = waitingJobs.findIndex((candidate) => candidate.id === job.id);
      const isActive = job.id === state.activeQueueJobId;
      const percent = isActive ? Math.max(0, Math.min(100, Number(state.activeProgress.percent) || 0)) : 0;
      const detail = transferShelfTechnicalDetail(
        job,
        isActive ? state.activeProgress : {},
        queuePosition,
        waitingJobs.length,
      );
      const destination = explorerCore.queueJobDestinationLabel(job);
      const directionLabel = job.direction === 'download' ? 'Download' : 'Upload';
      const destinationLabel = job.direction === 'download' ? `To: ${destination}` : `To: ${destination}`;
      const recoveryAction = ['failed', 'blocked'].includes(job.status)
        ? { action: 'retry', label: 'Retry' }
        : ['needs-resume-check', 'paused', 'cancelled'].includes(job.status)
          ? { action: 'resume', label: 'Check and resume' }
          : null;
      const problem = recoveryAction && job.error ? job.error : '';
      return `
        <div class="transfer-shelf-row status-${escapeHtml(job.status)}" role="listitem" data-shelf-job-id="${escapeHtml(job.id)}">
          <div class="transfer-shelf-row-head">
            <span class="transfer-shelf-direction direction-${escapeHtml(job.direction)}" aria-label="${directionLabel}">${job.direction === 'download' ? '&darr;' : '&uarr;'}</span>
            <strong title="${escapeHtml(job.sources?.join('\n') || '')}">${escapeHtml(transferShelfSourceName(job))}</strong>
            <span class="transfer-shelf-status">${escapeHtml(statusLabel)}</span>
          </div>
          <div class="transfer-shelf-destination" title="${escapeHtml(destination)}">${escapeHtml(destinationLabel)}</div>
          ${isActive ? '<div class="transfer-shelf-current">Preparing current file</div>' : ''}
          <div class="transfer-shelf-meta">${escapeHtml(detail)}</div>
          ${problem ? `<div class="transfer-shelf-problem">${escapeHtml(problem)}</div>` : ''}
          ${recoveryAction ? `
            <div class="transfer-shelf-recovery">
              <button type="button" class="quiet" data-queue-recovery="${recoveryAction.action}" data-job-id="${escapeHtml(job.id)}">${recoveryAction.label}</button>
            </div>
          ` : ''}
          ${isActive ? `
            <div class="transfer-shelf-row-progress">
              <div class="transfer-shelf-meter" role="progressbar" aria-label="${escapeHtml(transferShelfSourceName(job))} transfer progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}">
                <span style="width: ${percent}%"></span>
              </div>
              <span class="transfer-shelf-row-percent">${percent}%</span>
            </div>
          ` : ''}
        </div>
      `;
    }).join('')
    : '<div class="empty-state">No transfers yet.</div>';
  updateQueueDrawerState();
  updateTransferShelfProgress(state.activeProgress);
  updatePauseAllControl();
  updateCancelControl();
}

function updateTransferShelfProgress(progress = {}) {
  const summary = transferShelfCore.summarizeTransferShelf(state.queueJobs);
  const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
  els.transferShelfPercent.textContent = `${percent}%`;
  const pausedCount = state.queueJobs.filter((job) => job.status === 'paused').length;
  els.transferShelfActive.textContent = summary.active
    ? `${summary.active} active`
    : pausedCount
      ? `${pausedCount} paused`
      : '0 active';
  els.transferShelfSpeed.textContent = progress.speed || '-';
  els.transferShelfEta.textContent = `ETA ${progress.eta || '-'}`;

  const activeRow = Array.from(els.transferShelfList.querySelectorAll('[data-shelf-job-id]'))
    .find((row) => row.dataset.shelfJobId === state.activeQueueJobId);
  const activeJob = state.queueJobs.find((job) => job.id === state.activeQueueJobId);
  const currentSource = progress.currentFile || progress.source || '';
  const currentDetail = activeRow?.querySelector('.transfer-shelf-current');
  const technicalDetail = activeRow?.querySelector('.transfer-shelf-meta');
  if (currentDetail) {
    currentDetail.textContent = currentSource ? `Now: ${sourceDisplayName(currentSource)}` : 'Preparing current file';
    currentDetail.title = currentSource;
  }
  if (technicalDetail && activeJob) {
    technicalDetail.textContent = transferShelfTechnicalDetail(activeJob, progress);
  }
  const meter = activeRow?.querySelector('.transfer-shelf-meter');
  const fill = meter?.querySelector('span');
  if (meter && fill) {
    meter.setAttribute('aria-valuenow', String(percent));
    fill.style.width = `${percent}%`;
    const rowPercent = activeRow.querySelector('.transfer-shelf-row-percent');
    if (rowPercent) rowPercent.textContent = `${percent}%`;
  }
}

function toggleTransferShelf() {
  state.driveShell = driveShellCore.normalizeDriveShellState({
    ...state.driveShell,
    queueDrawerOpen: !state.driveShell.queueDrawerOpen,
  });
  updateQueueDrawerState();
}

const TERMINAL_QUEUE_JOB_STATUSES = new Set(['ready', 'failed', 'cancelled', 'paused', 'complete']);
const PAUSE_CLAIM_REVOKING_STATUSES = new Set(['ready', 'failed', 'blocked', 'cancelled', 'paused', 'complete']);

function resetActiveTransferShelfState() {
  if (!state.activeQueueJobId && !Object.keys(state.activeProgress).length) {
    return false;
  }
  state.activeQueueJobId = '';
  state.activeProgress = {};
  renderQueue();
  updateTransferContext();
  return true;
}

function setQueueJobStatus(jobId, status, patch = {}) {
  if (PAUSE_CLAIM_REVOKING_STATUSES.has(status)) preparedPauses.delete(jobId);
  const previousJob = state.queueJobs.find((job) => job.id === jobId);
  if (status === 'complete' && previousJob?.resumeFromJobId) {
    state.historyRecords = state.historyRecords.map((record) => (
      record.jobId === previousJob.resumeFromJobId
        ? {
          ...record,
          canResume: false,
          detail: 'Completed by a resumed transfer.',
          result: 'Complete',
        }
        : record
    ));
  }
  const shouldResetActiveTransfer = jobId === state.activeQueueJobId && TERMINAL_QUEUE_JOB_STATUSES.has(status);
  state.queueJobs = explorerCore.queueWithJobStatus(state.queueJobs, jobId, status, patch);
  if (shouldResetActiveTransfer) {
    resetActiveTransferShelfState();
  } else {
    renderQueue();
  }
  renderActivity();
  renderHistory();
  if (automaticQueueRunning) {
    const job = state.queueJobs.find((candidate) => candidate.id === jobId);
    traceAutomaticQueue(status, { jobId, prefix: job?.prefix || '' });
  }
  return saveSettings();
}

function restoreQueueJobAfterPauseFailure(prepared, error) {
  if (preparedPauses.get(prepared.clientJobId) !== prepared) return Promise.resolve(false);
  const currentJob = state.queueJobs.find((job) => job.id === prepared.clientJobId);
  if (currentJob?.status !== 'pausing') {
    preparedPauses.delete(prepared.clientJobId);
    return Promise.resolve(false);
  }
  preparedPauses.delete(prepared.clientJobId);
  state.queueJobs = explorerCore.queueWithJobStatus(
    state.queueJobs,
    prepared.clientJobId,
    prepared.previousStatus,
    { error: prepared.previousError },
  );
  renderQueue();
  appendLog(`Pause failed and the transfer is continuing: ${error.message}`, 'error');
  return saveSettings();
}

async function prepareQueuePause(activeTransfer = state.activeTransfer) {
  if (rendererCancellationClaim) {
    throw new Error('Cancellation is already being finalized.');
  }
  state.activeTransfer = activeTransfer || {};
  const eligibility = currentPauseEligibility(state.activeTransfer);
  if (!eligibility.enabled) {
    throw new Error(eligibility.reason);
  }
  const job = state.queueJobs.find((candidate) => candidate.id === eligibility.association.clientJobId);
  const prepared = {
    ...eligibility.association,
    previousStatus: job.status,
    previousError: job.error || '',
  };
  preparedPauses.set(prepared.clientJobId, prepared);
  state.queueJobs = state.queueJobs.map((candidate) =>
    candidate.id === job.id ? queueRecoveryCore.requestPause(candidate) : candidate);
  renderQueue();
  const persisted = await saveSettings();
  if (!persisted) {
    const error = new Error('The pausing queue state could not be persisted.');
    await restoreQueueJobAfterPauseFailure(prepared, error);
    throw error;
  }
  const currentJob = state.queueJobs.find((candidate) => candidate.id === prepared.clientJobId);
  if (preparedPauses.get(prepared.clientJobId) !== prepared || currentJob?.status !== 'pausing') {
    throw new Error('Pause was superseded by a newer transfer state.');
  }
  appendLog(`Pausing ${explorerCore.queueJobDestinationLabel(job)}...`);
  return prepared;
}

function pauseAllUploads() {
  if (pauseRequestPromise) return pauseRequestPromise;
  pauseRequestPromise = (async () => {
    let prepared = null;
    try {
      prepared = await prepareQueuePause();
      return await api.pauseUpload({
        clientJobId: prepared.clientJobId,
        intentId: prepared.intentId,
        jobId: prepared.jobId,
      });
    } catch (error) {
      if (prepared) await restoreQueueJobAfterPauseFailure(prepared, error);
      else appendLog(`Pause unavailable: ${error.message}`, 'error');
      return { ok: false, error: error.message };
    } finally {
      pauseRequestPromise = null;
      updatePauseAllControl();
    }
  })();
  return pauseRequestPromise;
}

function beginRendererCancellation() {
  const activeJob = state.queueJobs.find((job) => job.id === state.activeQueueJobId) || null;
  const eligibility = pauseCore.cancelEligibility({
    isRunning: state.isRunning,
    activeTransfer: state.activeTransfer,
    activeJob,
  });
  if (!eligibility.enabled) throw new Error(eligibility.reason);
  const claim = {
    clientJobId: activeJob?.id || '',
    previousActiveTransfer: { ...state.activeTransfer },
  };
  rendererCancellationClaim = claim;
  state.activeTransfer = {
    ...state.activeTransfer,
    phase: 'cancelling',
    terminalAction: 'cancel-pending',
    cancelPending: true,
    cancelRequested: false,
  };
  renderQueue();
  appendLog('Cancelling upload...');
  return claim;
}

function rollbackRendererCancellation(claim, error) {
  if (rendererCancellationClaim !== claim) return false;
  rendererCancellationClaim = null;
  const stillOwned = state.activeTransfer.terminalAction === 'cancel-pending'
    && state.activeTransfer.phase === 'cancelling';
  if (!stillOwned) {
    renderQueue();
    return false;
  }
  state.activeTransfer = claim.previousActiveTransfer;
  renderQueue();
  appendLog(`Cancellation failed and the transfer is continuing: ${error.message}`, 'error');
  return true;
}

function cancelActiveUpload() {
  if (cancelRequestPromise) return cancelRequestPromise;
  let claim;
  try {
    claim = beginRendererCancellation();
  } catch (error) {
    appendLog(`Cancel unavailable: ${error.message}`, 'error');
    return Promise.resolve({ ok: false, error: error.message });
  }
  const operation = Promise.resolve().then(async () => {
    try {
      const result = await api.cancelUpload();
      if (result?.ok === false) throw new Error(result.message || 'Cancellation was not accepted.');
      if (rendererCancellationClaim === claim) {
        rendererCancellationClaim = null;
        const currentJob = state.queueJobs.find((job) => job.id === claim.clientJobId);
        if (currentJob && !TERMINAL_QUEUE_JOB_STATUSES.has(currentJob.status)) {
          await setQueueJobStatus(claim.clientJobId, 'cancelled');
        }
        state.activeTransfer = {};
      }
      setRunning(false);
      return result;
    } catch (error) {
      rollbackRendererCancellation(claim, error);
      return { ok: false, error: error.message };
    }
  }).finally(() => {
    if (cancelRequestPromise === operation) cancelRequestPromise = null;
    updatePauseAllControl();
    updateCancelControl();
  });
  cancelRequestPromise = operation;
  return operation;
}

function selectedQueueJob() {
  return state.queueJobs.find((job) => job.id === state.selectedQueueJobId) || null;
}

function resetProgress(mode = 'idle') {
  state.activeProgress = {};
  els.transferMode.textContent = mode;
  els.progressFill.style.width = '0%';
  els.progressPercent.textContent = '0%';
  els.progressBytes.textContent = '-';
  els.progressSpeed.textContent = '-';
  els.progressEta.textContent = '-';
  if (mode === 'idle') {
    updateTransferContext();
    renderActivitySummary({});
  }
  updateTransferShelfProgress({});
}

function sourceDisplayName(source = '') {
  return String(source || '').replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || source || '-';
}

function updateTransferContext(payload = {}) {
  const activeJob = state.queueJobs.find((job) => job.id === state.activeQueueJobId);
  const nextJob = explorerCore.queueNextUploadJob(state.queueJobs.filter((job) => job.id !== state.activeQueueJobId));
  const currentSource = payload.currentFile || payload.source || '';
  els.activeDestination.textContent = activeJob
    ? explorerCore.queueJobDestinationLabel(activeJob)
    : 'No active transfer';
  els.activeDestination.title = activeJob ? explorerCore.queueJobDestinationLabel(activeJob) : '';
  els.activeSource.textContent = currentSource ? sourceDisplayName(currentSource) : '-';
  els.activeSource.title = currentSource;
  els.activeSourceCount.textContent = payload.sourceIndex && payload.sourceTotal
    ? `${payload.sourceIndex} of ${payload.sourceTotal}`
    : (activeJob ? `0 of ${activeJob.sources.length}` : '-');
  els.nextJob.textContent = nextJob ? explorerCore.queueJobDestinationLabel(nextJob) : '-';
  els.nextJob.title = nextJob ? explorerCore.queueJobDestinationLabel(nextJob) : '';
}

function updateProgress(progress) {
  state.activeProgress = { ...state.activeProgress, ...progress };
  const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
  if (progress.percent !== undefined) {
    els.progressFill.style.width = `${percent}%`;
    els.progressPercent.textContent = `${percent}%`;
  }
  if (progress.transferred && progress.total) {
    els.progressBytes.textContent = `${progress.transferred} / ${progress.total}`;
  }
  if (progress.speed) {
    els.progressSpeed.textContent = progress.speed;
  }
  if (progress.eta) {
    els.progressEta.textContent = progress.eta;
  }
  if (progress.diagnostics) {
    renderActivitySummary({ diagnostics: progress.diagnostics });
  }
  updateTransferContext(progress);
  updateTransferShelfProgress(state.activeProgress);
}

function renderActivitySummary(transfer = {}) {
  const summary = explorerCore.summarizeActiveTransfer(transfer);
  els.activitySummary.className = `activity-summary activity-${summary.className}`;
  els.activitySummary.innerHTML = `
    <strong>${escapeHtml(summary.label)}</strong>
    <span>${escapeHtml(summary.detail)}</span>
  `;
  els.activeProcess.textContent = summary.process;
  els.lastOutput.textContent = summary.lastOutput;
  els.diagnosticMetrics.textContent = summary.metrics || 'current - | avg - | peak -';
  els.diagnosticTuning.textContent = summary.tuning || 'transfers 4, chunk 64M, concurrency 4';
  els.diagnosticAction.textContent = summary.safeAction || summary.detail || 'Safe to close if no queue job is uploading.';
  els.diagnosticRecommendation.textContent = summary.recommendation || 'Current settings are conservative.';
}

async function checkActivity({ quiet = false } = {}) {
  try {
    if (queueRecoveryEnabled && !automaticQueueRunning && api.recoverySnapshot) {
      const wasBlocked = state.isRunning || schedulingBlockedByExternalLifecycle;
      const snapshot = await api.recoverySnapshot();
      await reconcileQueueFromJobRecords({ ...snapshot, revalidate: false });
      const isBlocked = state.isRunning || schedulingBlockedByExternalLifecycle;
      if (wasBlocked && !isBlocked) scheduleAutomaticQueue();
    }
    const transfer = await api.activeTransfer();
    state.activeTransfer = transfer || {};
    renderActivitySummary(transfer);
    updatePauseAllControl();
    if (!quiet) {
      const summary = explorerCore.summarizeActiveTransfer(transfer);
      appendLog(`Activity: ${summary.label}; last output ${summary.lastOutput}; ${summary.detail}`);
    }
    return transfer;
  } catch (error) {
    if (!quiet) {
      appendLog(`Activity check failed: ${error.message}`, 'error');
    }
    return null;
  }
}

function updateVerification(report) {
  if (!report) {
    els.verification.textContent = 'Verification has not run yet.';
    els.verification.className = 'verification';
    return;
  }

  els.verification.className = report.ok ? 'verification is-ok' : 'verification is-bad';
  els.verification.textContent = report.ok
    ? `Verified ${report.verified.length} file(s) by remote size.`
    : `Verification failed: ${report.missing.length} missing, ${report.sizeMismatch.length} size mismatch, ${report.unexpected?.length || 0} unexpected.`;
}

function updateChecksum(report) {
  if (!report || report.skipped) {
    appendLog('Checksum: skipped (size verification mode).');
    return;
  }
  appendLog(
    report.ok
      ? `Checksum OK. ${report.verified.length} file(s) match SHA-256.`
      : `Checksum failed: ${report.mismatched.length} mismatch(es).`,
    report.ok ? 'normal' : 'error',
  );
}

function logNotifications(attempts = []) {
  if (!attempts.length) {
    return;
  }
  const delivered = attempts.filter((attempt) => attempt.ok).length;
  appendLog(`Notifications: ${delivered}/${attempts.length} delivered.`);
  attempts
    .filter((attempt) => !attempt.ok)
    .forEach((attempt) => appendLog(`${attempt.type} notification failed: ${attempt.error}`, 'error'));
}

function markInputsChanged(event) {
  setRunning(state.isRunning);
  if (['publicRead', 'checksum'].includes(event?.target?.id)) {
    void saveActiveConnectionPreferences({
      connectionId: state.activeConnectionId,
      publicRead: els.publicRead.checked,
      checksum: els.checksum.value,
      pinnedPrefixes: state.pinnedPrefixes,
    });
    return;
  }
  saveSettings();
}

function persistSettings(overrides = {}) {
  const connections = overrides.connections || connectionsWithCurrentPreferences();
  const activeConnectionId = Object.hasOwn(overrides, 'activeConnectionId')
    ? overrides.activeConnectionId
    : state.activeConnectionId;
  const selectedConnection = connections.find((connection) => connection.id === activeConnectionId) || null;
  const recentPrefixes = Object.hasOwn(overrides, 'recentPrefixes')
    ? overrides.recentPrefixes
    : selectedConnection?.recentPrefixes || [];
  const recentPrefixesByConnection = overrides.replaceRecentPrefixesByConnection
    ? { ...(overrides.recentPrefixesByConnection || {}) }
    : {
      ...synchronizedRecentPrefixesByConnection(connections),
      ...(activeConnectionId ? { [activeConnectionId]: recentPrefixes } : {}),
      ...(overrides.recentPrefixesByConnection || {}),
    };
  const profile = overrides.profile || selectedConnection || currentProfile();
  const publicRead = Object.hasOwn(overrides, 'publicRead')
    ? overrides.publicRead
    : selectedConnection?.publicRead ?? els.publicRead.checked;
  const checksum = overrides.checksum || selectedConnection?.checksum || els.checksum.value;
  const pinnedPrefixes = Object.hasOwn(overrides, 'pinnedPrefixes')
    ? overrides.pinnedPrefixes
    : selectedConnection?.pinnedPrefixes || [];
  return api.saveSettings({
    settingsVersion: 2,
    connections,
    activeConnectionId,
    source: '',
    prefix: Object.hasOwn(overrides, 'prefix') ? overrides.prefix : els.prefix.value,
    filterMode: els.filterMode.value,
    include: els.include.value,
    folderUploadMode: els.folderUploadMode.value,
    publicRead,
    checksum,
    notifyWebhook: els.notifyWebhook.value,
    notifyNtfy: els.notifyNtfy.value,
    notifyOn: els.notifyOn.value,
    recentPrefixes,
    recentPrefixesByConnection,
    pinnedPrefixes,
    archiveEvent: els.archiveEvent.value,
    archiveCategory: els.archiveCategory.value,
    archiveStage: els.archiveStage.value,
    archiveDay: els.archiveDay.value,
    archivePackageName: els.archivePackageName.value,
    profile: {
      remote: profile.remote || '',
      bucket: profile.bucket || '',
      endpointHost: profile.endpointHost || '',
    },
    queueJobs: state.queueJobs
      .filter((job) => job.status !== 'complete')
      .map((job) => job.persistable || job),
  })
    .then(() => true)
    .catch((error) => {
      appendLog(error.message, 'error');
      return false;
    });
}

function saveSettings(overrides = {}) {
  return enqueueSettingsTransaction(() => persistSettings(overrides));
}

function saveActiveConnectionPreferences({
  connectionId,
  publicRead,
  checksum,
  pinnedPrefixes,
} = {}) {
  return runConnectionMutation(async () => {
    const committed = state.connections.find((connection) => connection.id === connectionId);
    if (!committed) return false;
    const nextConnections = state.connections.map((connection) => connection.id === connectionId
      ? connectionCore.sanitizeConnection({
        ...connection,
        publicRead,
        checksum,
        recentPrefixes: Object.hasOwn(state.recentPrefixesByConnection, connectionId)
          ? navigationCore.recentPrefixesForConnection(state.recentPrefixesByConnection, connectionId)
          : committed.recentPrefixes,
        pinnedPrefixes,
      })
      : connection);
    const nextRecentsByConnection = synchronizedRecentPrefixesByConnection(nextConnections);
    const persisted = await persistSettings({
      connections: nextConnections,
      recentPrefixesByConnection: nextRecentsByConnection,
      replaceRecentPrefixesByConnection: true,
    });
    if (!persisted) {
      if (state.activeConnectionId === connectionId) {
        els.publicRead.checked = committed.publicRead;
        els.checksum.value = committed.checksum;
        state.pinnedPrefixes = [...committed.pinnedPrefixes];
        renderFolderGroups();
      }
      showConnectionNotice('Connection preferences were not saved and have been restored.', { error: true });
      return false;
    }
    state.connections = nextConnections;
    state.recentPrefixesByConnection = nextRecentsByConnection;
    if (state.activeConnectionId === connectionId) {
      const active = nextConnections.find((connection) => connection.id === connectionId);
      state.pinnedPrefixes = [...active.pinnedPrefixes];
      els.publicRead.checked = active.publicRead;
      els.checksum.value = active.checksum;
      renderFolderGroups();
    }
    renderConnectionMenu();
    renderConnectionsPanel();
    return true;
  });
}

function renderQueue() {
  if (!state.queueJobs.length) {
    els.queueTable.innerHTML = '<div class="empty-state">No destination jobs queued yet.</div>';
    setRunning(state.isRunning);
    renderTransferShelf();
    return;
  }

  const jobSourceSummary = (job) => {
    const first = job.sources[0] || '';
    const name = first.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || first;
    return job.sources.length === 1 ? name : `${job.sources.length} sources`;
  };
  const jobTargetSummary = (job) => explorerCore.queueJobDestinationLabel(job);
  const jobStatusDetails = (job) => {
    return explorerCore.queueJobStatusHint(job);
  };

  els.queueTable.innerHTML = `
    <div class="queue-header">
      <span>Job</span>
      <span>Destination folder</span>
      <span>Status</span>
    </div>
    ${state.queueJobs
      .map(
        (job) => `
          <div class="queue-row ${job.id === state.selectedQueueJobId ? 'is-selected' : ''}" data-job-id="${escapeHtml(job.id)}">
            <span title="${escapeHtml(job.sources.join('\n'))}">${escapeHtml(jobSourceSummary(job))}</span>
            <span class="remote-target" title="${escapeHtml(jobTargetSummary(job))}">${escapeHtml(jobTargetSummary(job))}</span>
            <span class="status status-${escapeHtml(job.status)}">${escapeHtml(explorerCore.queueJobStatusLabel(job.status))}</span>
          </div>
          ${job.id === state.selectedQueueJobId ? `
            <div class="queue-details">
              <strong>${escapeHtml(job.prefix)}</strong>
              <span>${escapeHtml(jobStatusDetails(job))}</span>
              <span>${escapeHtml(explorerCore.queueJobPlacementPreview(job).sourceCount)} source(s): ${escapeHtml(explorerCore.queueJobPlacementPreview(job).fileCount)} file-like, ${escapeHtml(explorerCore.queueJobPlacementPreview(job).folderCount)} folder-like</span>
              <pre>${escapeHtml(explorerCore.queueJobPlacementPreview(job).examples.join('\n'))}</pre>
              <pre>${escapeHtml(job.sources.join('\n'))}</pre>
            </div>
          ` : ''}
        `,
      )
      .join('')}
  `;
  document.querySelectorAll('.queue-row[data-job-id]').forEach((row) => {
    row.addEventListener('click', () => {
      state.selectedQueueJobId = row.dataset.jobId;
      renderQueue();
    });
  });
  setRunning(state.isRunning);
  renderTransferShelf();
}

function historyCanResume(record = {}) {
  return record.canResume === true && !resumeSourceIsBusy(record.jobId);
}

function resumeSourceIsBusy(jobId) {
  return resumeSourceClaims.has(jobId)
    || queueRecoveryCore.queueClaimsResumeSource(state.queueJobs, jobId);
}

function summarizeHistoryRecord(record = {}) {
  return {
    status: record.status || 'unknown',
    prefix: record.destination || '',
    sourceCount: Number(record.sourceCount || 0),
    verifiedCount: Number(record.verifiedCount || 0),
    missingCount: Number(record.missingCount || 0),
    urlCount: 0,
  };
}

function formatActivityTimestamp(value = '') {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString() : 'Not recorded';
}

function formatElapsed(seconds) {
  if (!Number.isFinite(Number(seconds))) return '';
  const total = Math.max(0, Math.round(Number(seconds)));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function renderActivity() {
  if (!els.activityList) return;
  if (!state.historyRecords.length) {
    els.activityList.innerHTML = '<div class="empty-state">No transfer runs yet</div>';
    return;
  }

  els.activityList.innerHTML = state.historyRecords.map((record) => {
    const result = typeof record.result === 'string' && record.result ? record.result : 'Needs attention';
    const transfer = [record.transferred, record.total ? `of ${record.total}` : '', record.speed ? `at ${record.speed}` : '']
      .filter(Boolean)
      .join(' ');
    const verificationDetail = [
      record.verification,
      record.verifiedCount ? `${record.verifiedCount} verified` : '',
      record.missingCount ? `${record.missingCount} missing` : '',
      record.sizeMismatchCount ? `${record.sizeMismatchCount} size mismatch` : '',
    ].filter(Boolean).join(' · ');
    const resumeBusy = record.canResume === true && resumeSourceIsBusy(record.jobId);
    const resumeLabel = resumeSourceClaims.has(record.jobId) ? 'Preparing resume' : 'Resume queued';
    return `
      <article class="activity-row" data-activity-job-id="${escapeHtml(record.jobId)}">
        <div class="activity-row-main">
          <span class="activity-result activity-result-${escapeHtml(result.toLowerCase().replace(/\s+/g, '-'))}">${escapeHtml(result)}</span>
          <div class="activity-source">
            <strong><span class="activity-direction direction-${record.direction === 'download' ? 'download' : 'upload'}">${record.direction === 'download' ? 'Download' : 'Upload'}</span>${escapeHtml(record.title)}</strong>
            <span title="${escapeHtml(record.destination)}">${escapeHtml(record.destination || 'No destination recorded')}</span>
          </div>
        </div>
        <dl class="activity-meta">
          <div><dt>Started</dt><dd>${escapeHtml(formatActivityTimestamp(record.startedAt))}</dd></div>
          <div><dt>Finished</dt><dd>${escapeHtml(formatActivityTimestamp(record.completedAt))}</dd></div>
          <div><dt>Elapsed</dt><dd>${escapeHtml(formatElapsed(record.elapsedSeconds) || 'In progress')}</dd></div>
          <div><dt>Verification</dt><dd>${escapeHtml(verificationDetail)}</dd></div>
          ${transfer ? `<div><dt>Transfer</dt><dd>${escapeHtml(transfer)}</dd></div>` : ''}
        </dl>
        ${record.detail ? `<p class="activity-detail">${escapeHtml(record.detail)}</p>` : ''}
        ${(record.canResume || record.hasLog) ? `
          <div class="activity-actions">
            ${record.canResume ? `<button type="button" class="primary" data-activity-action="resume" data-job-id="${escapeHtml(record.jobId)}" ${resumeBusy ? 'disabled aria-disabled="true"' : ''}>${resumeBusy ? resumeLabel : 'Check and resume'}</button>` : ''}
            ${record.hasLog ? `<button type="button" class="quiet" data-activity-action="log" data-job-id="${escapeHtml(record.jobId)}">Open log</button>` : ''}
          </div>
        ` : ''}
      </article>
    `;
  }).join('');

  els.activityList.querySelectorAll('[data-activity-action]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (button.dataset.activityAction === 'resume') {
        await resumeHistoryJob(button.dataset.jobId);
      } else {
        const result = await api.openJobLog(button.dataset.jobId);
        if (!result.ok && result.message) appendLog(result.message, 'error');
      }
    });
  });
}

function renderHistory() {
  if (!state.historyRecords.length) {
    els.historyTable.innerHTML = '<div class="empty-state">No transfer history yet.</div>';
    els.resumeHistory.disabled = true;
    return;
  }

  els.historyTable.innerHTML = `
    <div class="history-header">
      <span>Status</span>
      <span>Destination</span>
      <span>Files</span>
      <span>Resume</span>
    </div>
    ${state.historyRecords.map((record) => {
    const summary = summarizeHistoryRecord(record);
    return `
        <div class="history-row ${record.jobId === state.selectedHistoryJobId ? 'is-selected' : ''}" data-job-id="${escapeHtml(record.jobId || '')}">
          <span class="status status-${escapeHtml(summary.status)}">${escapeHtml(summary.status)}</span>
          <span title="${escapeHtml(summary.prefix)}">${escapeHtml(summary.prefix)}</span>
          <span>${escapeHtml(`${summary.verifiedCount}/${summary.sourceCount || '?'} verified`)}</span>
          <span>${historyCanResume(record) ? 'Yes' : 'No'}</span>
        </div>
        ${record.jobId === state.selectedHistoryJobId ? `
          <div class="history-details">
            <strong>${escapeHtml(record.jobId || '')}</strong>
            <span>${escapeHtml(summary.urlCount)} URL(s), ${escapeHtml(summary.missingCount)} missing</span>
            ${record.detail ? `<span class="status-failed">${escapeHtml(record.detail)}</span>` : ''}
            <span>${escapeHtml(record.title || '')}</span>
          </div>
        ` : ''}
      `;
  }).join('')}
  `;

  document.querySelectorAll('.history-row[data-job-id]').forEach((row) => {
    row.addEventListener('click', () => {
      state.selectedHistoryJobId = row.dataset.jobId;
      const record = state.historyRecords.find((item) => item.jobId === state.selectedHistoryJobId);
      els.resumeHistory.disabled = !record || !historyCanResume(record) || state.isRunning;
      renderHistory();
    });
  });
  const selected = state.historyRecords.find((item) => item.jobId === state.selectedHistoryJobId);
  els.resumeHistory.disabled = !selected || !historyCanResume(selected) || state.isRunning;
}

function formatEventName(manifest = {}) {
  const event = String(manifest.eventName || '').trim();
  return event ? event.charAt(0).toUpperCase() + event.slice(1) : 'Event';
}

function eventFolderPrefix(destinationPath = '') {
  return String(destinationPath || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .slice(0, -1)
    .join('/');
}

function renderEventManifestSummary() {
  const manifest = state.eventWorkspace.manifest;
  if (!els.eventManifestSummary || !manifest) {
    if (els.eventWorkspacePreset) {
      els.eventWorkspacePreset.textContent = state.eventWorkspace.label;
    }
    if (els.eventManifestSummary) {
      els.eventManifestSummary.textContent = 'Open a local event manifest to begin.';
    }
    return;
  }
  els.eventWorkspacePreset.textContent = state.eventWorkspace.label;
  els.eventManifestSummary.innerHTML = `
    <div><span>Event</span><strong>${escapeHtml(formatEventName(manifest))}</strong></div>
    <div><span>Year / E#</span><strong>${escapeHtml(`${manifest.year || '-'} E${manifest.eventNumber || '-'}`)}</strong></div>
    <div><span>Recordings</span><strong>${escapeHtml(manifest.recordingsPrefix)}</strong></div>
    <div><span>Stages</span><strong>${escapeHtml((manifest.stages || []).join(', '))}</strong></div>
    <div><span>Days</span><strong>${escapeHtml((manifest.days || []).join(', '))}</strong></div>
  `;
}

function renderEventLocalRoots() {
  if (!els.eventLocalRoots) return;
  if (!state.eventWorkspace.localRoots.length) {
    els.eventLocalRoots.textContent = 'No local roots selected.';
    return;
  }
  els.eventLocalRoots.innerHTML = state.eventWorkspace.localRoots
    .map((root) => `<div class="event-root-item">${escapeHtml(root)}</div>`)
    .join('');
}

function renderEventReconcileSummary(message = '') {
  const reconcile = state.eventWorkspace.reconcile;
  if (!els.eventReconcileSummary) return;
  if (message || !reconcile) {
    els.eventReconcileSummary.textContent = message || 'Choose local roots before reconcile.';
    els.queueEventMissing.disabled = true;
    return;
  }
  const summary = reconcile.summary || {};
  const localSkipped = state.eventWorkspace.localScan?.skipped?.summary?.credentialLikeCount || 0;
  const queueSkipped = state.eventWorkspace.queueSkipped?.summary?.credentialLikeCount || 0;
  const warningCount = state.eventWorkspace.localScan?.scan?.warnings?.length || 0;
  els.eventReconcileSummary.innerHTML = `
    <div><span>Local</span><strong>${escapeHtml(summary.localCount || 0)}</strong></div>
    <div><span>Remote</span><strong>${escapeHtml(summary.remoteCount || 0)}</strong></div>
    <div><span>Matched</span><strong>${escapeHtml(summary.matchedCount || 0)}</strong></div>
    <div><span>Missing</span><strong>${escapeHtml(summary.missingCount || 0)}</strong></div>
    <div><span>Size mismatch</span><strong>${escapeHtml(summary.sizeMismatchCount || 0)}</strong></div>
    <div><span>Ambiguous</span><strong>${escapeHtml(summary.ambiguousCount || 0)}</strong></div>
    <div><span>Skipped local</span><strong>${escapeHtml(localSkipped)}</strong></div>
    <div><span>Skipped queue</span><strong>${escapeHtml(queueSkipped)}</strong></div>
    <div><span>Warnings</span><strong>${escapeHtml(warningCount)}</strong></div>
  `;
  els.queueEventMissing.disabled = !state.eventWorkspace.missingPlan.length;
}

function renderEventWorkspace() {
  renderEventManifestSummary();
  renderEventLocalRoots();
  const idleMessage = state.eventWorkspace.manifest
    ? 'Choose local roots before reconcile.'
    : 'Open a manifest before reconcile.';
  renderEventReconcileSummary(state.eventWorkspace.reconcile ? '' : idleMessage);
}

async function chooseAndOpenEventWorkspace() {
  try {
    const result = await api.chooseEventManifest();
    if (!result?.ok) return false;
    state.eventWorkspace = {
      label: result.label || 'Event manifest',
      manifest: result.manifest,
      localRoots: [...(result.manifest.localRoots || [])],
      reconcile: null,
      missingPlan: [],
      localScan: null,
      queueSkipped: null,
    };
    setViewMode('advanced');
    setDriveShellView('event-workspace', { focus: true });
    state.remotePrefix = result.manifest.recordingsPrefix;
    els.remotePath.value = state.remotePrefix;
    els.prefix.value = state.remotePrefix;
    renderEventWorkspace();
    appendLog(`Event Workspace loaded: ${formatEventName(result.manifest)} ${result.manifest.year} E${result.manifest.eventNumber}.`);
    return true;
  } catch (error) {
    setViewMode('advanced');
    setDriveShellView('event-workspace', { focus: true });
    renderEventReconcileSummary(`Event Workspace failed to load: ${error.message}`);
    appendLog(`Event Workspace failed to load: ${error.message}`, 'error');
    return false;
  }
}

async function addEventLocalRoot() {
  const roots = await api.chooseFolder();
  const next = [...new Set([...state.eventWorkspace.localRoots, ...(roots || [])].filter(Boolean))];
  state.eventWorkspace.localRoots = next;
  state.eventWorkspace.reconcile = null;
  state.eventWorkspace.missingPlan = [];
  state.eventWorkspace.localScan = null;
  state.eventWorkspace.queueSkipped = null;
  renderEventWorkspace();
}

async function runEventReconcile() {
  if (!state.eventWorkspace.manifest) {
    renderEventReconcileSummary('Open a manifest before reconcile.');
    appendLog('Open a manifest before reconcile.', 'error');
    return;
  }
  if (!state.eventWorkspace.localRoots.length) {
    renderEventReconcileSummary('Choose local roots before reconcile.');
    appendLog('Choose local roots before reconcile.', 'error');
    return;
  }
  els.runEventReconcile.disabled = true;
  renderEventReconcileSummary('Reconciling local roots with remote recordings...');
  try {
    const result = await api.eventReconcileLocal({
      manifest: state.eventWorkspace.manifest,
      localRoots: state.eventWorkspace.localRoots,
    });
    state.eventWorkspace.manifest = result.manifest;
    state.eventWorkspace.reconcile = result.reconcile;
    state.eventWorkspace.localScan = result.localScan || null;
    const preview = await api.eventQueueMissingPreview({
      manifest: result.manifest,
      reconcile: result.reconcile,
    });
    state.eventWorkspace.missingPlan = Array.isArray(preview) ? preview : (preview.jobs || []);
    state.eventWorkspace.queueSkipped = Array.isArray(preview) ? null : (preview.skipped || null);
    renderEventReconcileSummary();
    const localSkipped = state.eventWorkspace.localScan?.skipped?.summary?.credentialLikeCount || 0;
    const queueSkipped = state.eventWorkspace.queueSkipped?.summary?.credentialLikeCount || 0;
    appendLog(`Event reconcile complete: ${state.eventWorkspace.missingPlan.length} missing queue candidate(s), ${localSkipped + queueSkipped} credential-like file(s) skipped.`);
    for (const warning of state.eventWorkspace.localScan?.scan?.warnings || []) {
      appendLog(`Event scan warning: ${warning.message}`, 'error');
    }
  } catch (error) {
    state.eventWorkspace.reconcile = null;
    state.eventWorkspace.missingPlan = [];
    state.eventWorkspace.localScan = null;
    state.eventWorkspace.queueSkipped = null;
    renderEventReconcileSummary(`Event reconcile failed: ${error.message}`);
    appendLog(`Event reconcile failed: ${error.message}`, 'error');
  } finally {
    els.runEventReconcile.disabled = false;
  }
}

async function queueEventMissing() {
  if (!state.eventWorkspace.manifest) {
    appendLog('Open a manifest before queueing files.', 'error');
    return;
  }
  const plan = state.eventWorkspace.missingPlan || [];
  if (!plan.length) {
    appendLog('No missing Event Workspace files are ready to queue.', 'error');
    return;
  }
  const manifest = state.eventWorkspace.manifest;
  const profile = {
    remote: manifest.remote,
    bucket: manifest.bucket,
    endpointHost: manifest.endpointHost,
  };
  const frozenSettings = currentSettings();
  const jobs = plan
    .filter((candidate) => candidate.sourcePath && candidate.destinationPath)
    .map((candidate) =>
      explorerCore.createQueueJob({
        sources: [candidate.sourcePath],
        settings: {
          ...frozenSettings,
          profile: { ...profile },
          profileSnapshot: { ...profile },
          prefix: eventFolderPrefix(candidate.destinationPath),
          filterMode: 'all',
          include: '',
          folderUploadMode: 'package',
          publicRead: manifest.uploadDefaults?.publicRead !== false,
          checksum: 'size',
        },
        status: 'queued',
      }));
  if (!jobs.length) {
    appendLog('No usable missing Event Workspace records were available to queue.', 'error');
    return;
  }
  const result = await addQueueJobs(jobs, { deduplicate: true, traceEvent: 'event-intake' });
  if (result.added.length) {
    appendLog(`Queued ${result.added.length} missing Event Workspace file(s) for automatic upload.`);
  }
  if (result.duplicates.length) {
    appendLog(`Skipped ${result.duplicates.length} Event Workspace file(s) already in the same destination queue.`);
  }
  return result;
}

async function loadHistory() {
  if (!api.listJobRecords) return;
  try {
    state.historyRecords = (await api.listJobRecords()).sort((left, right) => {
      const leftTime = Date.parse(left.completedAt || left.startedAt || '') || 0;
      const rightTime = Date.parse(right.completedAt || right.startedAt || '') || 0;
      return rightTime - leftTime || String(left.jobId).localeCompare(String(right.jobId));
    });
    renderHistory();
    renderActivity();
  } catch (error) {
    const safeError = activityCore.redactLogText(error);
    els.historyTable.innerHTML = `<div class="empty-state">History failed to load: ${escapeHtml(safeError)}</div>`;
    if (els.activityList) {
      els.activityList.innerHTML = `<div class="empty-state">Activity failed to load: ${escapeHtml(safeError)}</div>`;
    }
    appendLog(`History failed to load: ${error.message}`, 'error');
  }
}

async function resumeSelectedHistoryJob() {
  return resumeHistoryJob(state.selectedHistoryJobId);
}

async function resumeHistoryJob(jobId) {
  const record = state.historyRecords.find((item) => item.jobId === jobId);
  if (!record || record.canResume !== true) {
    appendLog('Select a failed, cancelled, paused, unverified warning, blocked, or stale running job to resume.', 'error');
    return { ok: false, reason: 'not-resumable' };
  }
  if (resumeSourceIsBusy(record.jobId) || !resumeSourceClaims.claim(record.jobId)) {
    appendLog('Check and resume is already preparing or queued for this transfer.', 'error');
    return { ok: false, reason: 'already-claimed' };
  }
  renderActivity();
  renderHistory();
  let queuedJob = null;
  let preparedResume = null;
  try {
    const settings = await api.resumeJobRecord(record.jobId);
    queuedJob = queueRecoveryCore.resumeCandidate(explorerCore.createQueueJob({
      sources: settings.sources,
      settings: { ...settings, connections: state.connections },
      status: 'needs-resume-check',
      resumeFromJobId: record.jobId,
      error: `Resume check required from ${record.jobId}.`,
    }));
    preparedResume = prepareQueueResumePersistence(queuedJob);
    state.queueJobs = [...state.queueJobs, queuedJob];
    state.selectedQueueJobId = queuedJob.id;
    state.driveShell = driveShellCore.normalizeDriveShellState({
      ...state.driveShell,
      queueDrawerOpen: true,
    });
    renderQueue();
    if (!(await saveSettings())) {
      rollbackQueueResumePersistence(preparedResume);
      appendLog('Resume was not queued because the durable queue could not be saved.', 'error');
      return { ok: false, reason: 'persistence-failed' };
    }
    if (!finishQueueResumePersistence(preparedResume)) {
      return { ok: false, reason: 'superseded' };
    }
    appendLog(schedulingBlockedByExternalLifecycle
      ? 'Resume job queued and waiting for the active transfer lifecycle to finish.'
      : 'Resume job queued. Checking what is already remote before resuming automatically.');
    scheduleAutomaticQueue();
    return { ok: true, jobId: queuedJob.id };
  } catch (error) {
    if (preparedResume) rollbackQueueResumePersistence(preparedResume);
    appendLog(`Resume could not be prepared: ${error.message}`, 'error');
    return { ok: false, reason: 'prepare-failed' };
  } finally {
    resumeSourceClaims.release(record.jobId);
    renderActivity();
    renderHistory();
  }
}

async function checkAndUploadSelected() {
  const job = selectedQueueJob();
  if (!job) {
    appendLog('Select a queued job first.', 'error');
    return;
  }
  appendLog(`Checking selected job before upload: ${explorerCore.queueJobDestinationLabel(job)}`);
  await dryRunJobs([job], 'the selected queue job');
  const refreshed = selectedQueueJob();
  if (!refreshed || refreshed.status !== 'ready') {
    appendLog('Selected job is not ready after the check; upload did not start.', 'error');
    return;
  }
  await uploadReadyJobs([refreshed], 'selected checked job');
}

function selectedRemoteItem() {
  return state.remoteEntries[state.selectedRemoteIndex] || null;
}

function selectedRemoteItems() {
  return [...state.selectedRemoteIndexes]
    .map((index) => state.remoteEntries[index])
    .filter(Boolean);
}

function frozenRemoteItem(item = {}) {
  return {
    name: item.name || '',
    path: item.path || '',
    isDir: Boolean(item.isDir),
    size: Math.max(0, Number(item.size || 0)),
    modified: item.modified || '',
  };
}

function closeImagePreviewDialog() {
  if (els.imagePreviewDialog?.open) els.imagePreviewDialog.close();
}

function clearInspectorPreview() {
  previewRequestSequence += 1;
  activePreviewKey = '';
  activePreview = null;
  closeImagePreviewDialog();
  els.inspectorPreview.hidden = true;
  els.inspectorPreviewStatus.hidden = false;
  els.inspectorPreviewStatus.textContent = '';
  els.inspectorPreviewImage.hidden = true;
  els.inspectorPreviewImage.removeAttribute('src');
  els.inspectorPreviewImage.alt = '';
  els.openImagePreview.hidden = true;
}

function showPreviewFailure(message = 'Preview unavailable. You can still download this file.') {
  els.inspectorPreview.hidden = false;
  els.inspectorPreviewStatus.hidden = false;
  els.inspectorPreviewStatus.textContent = message;
  els.inspectorPreviewImage.hidden = true;
  els.inspectorPreviewImage.removeAttribute('src');
  els.openImagePreview.hidden = true;
}

async function renderInspectorPreview(items = []) {
  const item = items.length === 1 ? items[0] : null;
  if (!item || !driveShellCore.isPreviewableImage(item)) {
    clearInspectorPreview();
    return;
  }
  const key = [
    state.activeConnectionId,
    item.path,
    Number(item.size || 0),
    item.modified || '',
  ].join('|');
  if (activePreviewKey === key) return;
  activePreviewKey = key;
  activePreview = null;
  closeImagePreviewDialog();
  const requestId = ++previewRequestSequence;
  els.inspectorPreview.hidden = false;
  els.inspectorPreviewStatus.hidden = false;
  els.inspectorPreviewStatus.textContent = 'Preparing preview...';
  els.inspectorPreviewImage.hidden = true;
  els.inspectorPreviewImage.removeAttribute('src');
  els.inspectorPreviewImage.alt = '';
  els.openImagePreview.hidden = true;

  try {
    const result = await api.preparePreview({
      connectionId: state.activeConnectionId,
      profileSnapshot: currentProfile(),
      item: frozenRemoteItem(item),
    });
    if (requestId !== previewRequestSequence || activePreviewKey !== key) return;
    if (!result?.ok || !result.url) {
      showPreviewFailure(result?.message || 'Preview unavailable. You can still download this file.');
      return;
    }
    activePreview = {
      key,
      url: result.url,
      name: result.name || item.name,
      item: frozenRemoteItem(item),
    };
    els.inspectorPreviewImage.onload = () => {
      if (requestId !== previewRequestSequence || activePreviewKey !== key) return;
      els.inspectorPreviewStatus.hidden = true;
      els.inspectorPreviewImage.hidden = false;
      els.openImagePreview.hidden = false;
    };
    els.inspectorPreviewImage.onerror = () => {
      if (requestId !== previewRequestSequence || activePreviewKey !== key) return;
      activePreview = null;
      showPreviewFailure();
    };
    els.inspectorPreviewImage.alt = `Preview of ${activePreview.name}`;
    els.inspectorPreviewImage.src = activePreview.url;
  } catch (_error) {
    if (requestId !== previewRequestSequence || activePreviewKey !== key) return;
    showPreviewFailure();
  }
}

function openImagePreviewDialog() {
  if (!activePreview?.url || !els.imagePreviewDialog) return;
  els.imagePreviewTitle.textContent = activePreview.name;
  els.imagePreviewImage.src = activePreview.url;
  els.imagePreviewImage.alt = `Preview of ${activePreview.name}`;
  els.imagePreviewDialog.showModal();
  requestAnimationFrame(() => els.closeImagePreview.focus());
}

async function downloadRemoteSelection(items = selectedRemoteItems()) {
  if (!items.length || !hasActiveConnection() || connectionMutationPending > 0) return null;
  const localDestination = await api.chooseDownloadFolder();
  if (!localDestination) return null;
  const remoteItems = items.map(frozenRemoteItem);
  const frozenSettings = currentSettings();
  const job = explorerCore.createQueueJob({
    sources: remoteItems.map((item) => item.path),
    settings: {
      ...frozenSettings,
      profile: { ...frozenSettings.profile },
      prefix: state.remotePrefix,
      direction: 'download',
      localDestination,
      remoteItems,
    },
  });
  const result = await addQueueJobs([job], { traceEvent: 'download-intake' });
  if (result.added.length) {
    appendLog(`Added ${remoteItems.length} server item(s) for checked download to ${localDestination}.`);
  }
  return result.added[0] || null;
}

function renderInspector(items = selectedRemoteItems()) {
  const summary = driveShellCore.buildInspectorSummary(items);
  const url = summary.canCopyUrl
    ? items.find((entry) => entry && !entry.isDir && entry.publicUrl)?.publicUrl || '-'
    : '-';
  els.inspectorTitle.textContent = summary.title;
  els.inspectorSubtitle.textContent = summary.subtitle;
  els.inspectorKind.textContent = summary.kind;
  els.inspectorDetail.textContent = summary.detail;
  els.inspectorUrl.textContent = url;
  void renderInspectorPreview(items);
}

function syncRemoteSelectionUi() {
  const items = selectedRemoteItems();
  const rows = [...document.querySelectorAll('.remote-row')];
  const visibleIndexes = rows.map((row) => Number(row.dataset.index));
  if (!visibleIndexes.includes(state.remoteFocusIndex)) {
    state.remoteFocusIndex = visibleIndexes.includes(state.selectedRemoteIndex)
      ? state.selectedRemoteIndex
      : visibleIndexes[0] ?? -1;
  }
  rows.forEach((row) => {
    const index = Number(row.dataset.index);
    const selected = state.selectedRemoteIndexes.has(Number(row.dataset.index));
    row.classList.toggle('is-selected', selected);
    row.setAttribute('aria-selected', String(selected));
    row.tabIndex = index === state.remoteFocusIndex ? 0 : -1;
  });
  const selectedFiles = items.filter((entry) => !entry.isDir && entry.publicUrl);
  els.copyRemoteUrl.disabled = selectedFiles.length === 0;
  els.copyInventory.disabled = !state.remoteEntries.some((entry) => !entry.isDir);
  els.copyRemoteItem.disabled = items.length === 0;
  els.moveRemoteItem.disabled = items.length === 0;
  els.renameRemoteItem.disabled = items.length !== 1;
  els.archiveSortRemoteItem.disabled = items.length === 0;
  els.deleteRemoteItem.disabled = items.length === 0;
  updateRemoteDownloadControls(items);
  els.selectionSummary.textContent = driveShellCore.remoteListSummary(state.remoteEntries.length, items.length);
  renderInspector(items);
}

function focusRemoteRow(index) {
  state.remoteFocusIndex = index;
  syncRemoteSelectionUi();
  document.querySelector(`.remote-row[data-index="${index}"]`)?.focus();
}

function restoreKeyboardFocusToRemoteGrid() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      const row = els.remoteTable.querySelector('.remote-row[tabindex="0"]');
      (row || els.remoteTable).focus();
      const itemCount = state.remoteEntries.length;
      const location = state.remotePrefix || 'Space root';
      els.remoteNavigationStatus.textContent = `${location} loaded. ${itemCount} item${itemCount === 1 ? '' : 's'}.`;
      resolve();
    });
  });
}

function moveRemoteGridFocus(event, index) {
  const displayedIndexes = displayedRemoteEntries().map((entry) => entry.originalIndex);
  const nextIndex = driveShellCore.nextDisplayedRemoteIndex(displayedIndexes, index, event.key);
  if (nextIndex < 0) return;
  event.preventDefault();
  state.remoteFocusIndex = nextIndex;
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey) {
    syncRemoteSelectionUi();
  } else {
    setRemoteSelection(nextIndex, {
      range: event.shiftKey,
      additive: event.shiftKey && (event.ctrlKey || event.metaKey),
    });
  }
  focusRemoteRow(nextIndex);
}

async function handleRemoteGridKeydown(event, row) {
  const index = Number(row.dataset.index);
  if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
    moveRemoteGridFocus(event, index);
    return;
  }
  if (event.key === ' ') {
    event.preventDefault();
    state.remoteFocusIndex = index;
    setRemoteSelection(index, {
      additive: !event.shiftKey,
      range: event.shiftKey,
    });
    focusRemoteRow(index);
    return;
  }
  if (event.key !== 'Enter') return;

  event.preventDefault();
  const item = state.remoteEntries[index];
  if (!item) return;
  state.remoteFocusIndex = index;
  setRemoteSelection(index);
  if (item.isDir) {
    await loadRemote(item.path, { restoreGridFocus: true });
  } else {
    focusRemoteRow(index);
  }
}

function setRemoteSelection(index, options = {}) {
  if (index < 0) {
    state.selectedRemoteIndex = -1;
    state.selectedRemoteIndexes = new Set();
    state.selectionAnchorIndex = -1;
  } else {
    const selection = driveShellCore.resolveDisplayedRemoteSelection({
      displayedIndexes: displayedRemoteEntries().map((entry) => entry.originalIndex),
      currentIndexes: [...state.selectedRemoteIndexes],
      clickedIndex: index,
      anchorIndex: state.selectionAnchorIndex,
      additive: options.additive,
      range: options.range,
    });
    state.selectedRemoteIndex = selection.selectedIndex;
    state.selectedRemoteIndexes = new Set(selection.selectedIndexes);
    state.selectionAnchorIndex = selection.anchorIndex;
  }
  syncRemoteSelectionUi();
}

function renderBreadcrumbs() {
  const parts = state.remotePrefix.split('/').filter(Boolean);
  const crumbs = [{ label: state.activeConnectionName, prefix: '' }];
  parts.forEach((part, index) => {
    crumbs.push({ label: part, prefix: parts.slice(0, index + 1).join('/') });
  });
  els.breadcrumbs.innerHTML = crumbs
    .map(
      (crumb) =>
        `<button type="button" class="crumb" data-prefix="${escapeHtml(crumb.prefix)}">${escapeHtml(crumb.label)}</button>`,
    )
    .join('<span class="crumb-separator">/</span>');
}

function folderShortcutButton(prefix, label, extraClass = '') {
  return `
    <button type="button" class="folder-shortcut ${extraClass}" data-prefix="${escapeHtml(prefix)}" title="${escapeHtml(prefix)}">
      ${escapeHtml(label || prefix)}
    </button>
  `;
}

function shortFolderLabel(prefix) {
  const parts = explorerCore.normalizeRemotePrefix(prefix).split('/').filter(Boolean);
  return parts.slice(-2).join('/') || prefix;
}

function currentRecentPrefixes() {
  return navigationCore.recentPrefixesForConnection(
    state.recentPrefixesByConnection,
    state.activeConnectionId,
  );
}

function renderFolderGroups() {
  if (!hasActiveConnection()) {
    els.rootFolders.innerHTML = '<div class="rail-title">Space folders</div><div class="rail-note">Choose a Space to browse its folders.</div>';
    els.pinnedFolders.innerHTML = '';
    els.recentFolders.innerHTML = '<div class="rail-title">Recent</div><div class="rail-note">Recent folders stay with each connection.</div>';
    return;
  }
  const rootEntries = state.rootEntriesByConnection[state.activeConnectionId] || [];
  const recentPrefixes = currentRecentPrefixes();
  els.rootFolders.innerHTML = `
    <div class="rail-title">Space folders</div>
    ${folderShortcutButton('', 'Space root', 'drive-home')}
    ${rootEntries
      .map((entry) => folderShortcutButton(entry.path, entry.name, 'is-root-folder'))
      .join('')}
  `;
  els.pinnedFolders.innerHTML = state.pinnedPrefixes.length
    ? `<div class="rail-title">Pinned</div>${state.pinnedPrefixes
      .map((prefix) => folderShortcutButton(prefix, shortFolderLabel(prefix), 'is-pinned'))
      .join('')}`
    : '';
  els.recentFolders.innerHTML = recentPrefixes.length
    ? `<div class="rail-title">Recent</div>${recentPrefixes
      .map((prefix) => folderShortcutButton(prefix, shortFolderLabel(prefix), 'is-recent'))
      .join('')}`
    : '<div class="rail-title">Recent</div><div class="rail-note">Folders you open appear here.</div>';
  bindFolderShortcutDrops();
}

function moveTargetPrefixes() {
  return navigationCore.navigationMoveTargetPrefixes({
    currentPrefix: state.remotePrefix,
    rootEntries: state.rootEntriesByConnection[state.activeConnectionId] || [],
    pinnedPrefixes: state.pinnedPrefixes,
    recentPrefixes: currentRecentPrefixes(),
  });
}

function renderMoveTargetButtons() {
  els.moveTargetButtons.innerHTML = moveTargetPrefixes()
    .map((prefix) => `<button type="button" class="move-target-chip" data-prefix="${escapeHtml(prefix)}">${escapeHtml(shortFolderLabel(prefix))}</button>`)
    .join('');
}

function openMoveTray(defaultTarget = state.remotePrefix) {
  const items = selectedRemoteItems();
  if (!items.length) {
    return;
  }
  els.moveTray.hidden = false;
  els.moveTarget.value = explorerCore.normalizeRemotePrefix(defaultTarget);
  els.moveExact.disabled = items.length !== 1;
  renderMoveTargetButtons();
  els.moveTarget.focus();
  els.moveTarget.select();
}

function closeMoveTray() {
  els.moveTray.hidden = true;
}

function rememberPrefix(prefix, connectionId = state.activeConnectionId) {
  const clean = explorerCore.normalizeRemotePrefix(prefix);
  if (!clean || !connectionId) return Promise.resolve(false);
  return runConnectionMutation(async () => {
    const connection = state.connections.find((candidate) => candidate.id === connectionId);
    if (!connection) return false;
    const nextRecentsByConnection = navigationCore.recordRecentPrefix(
      state.recentPrefixesByConnection,
      connectionId,
      clean,
    );
    const nextConnections = connectionsWithCurrentPreferences().map((candidate) => candidate.id === connectionId
      ? connectionCore.sanitizeConnection({
        ...candidate,
        recentPrefixes: navigationCore.recentPrefixesForConnection(nextRecentsByConnection, connectionId),
      })
      : candidate);
    if (!await persistSettings({
      connections: nextConnections,
      recentPrefixesByConnection: synchronizedRecentPrefixesByConnection(nextConnections, nextRecentsByConnection),
      replaceRecentPrefixesByConnection: true,
    })) return false;
    state.connections = nextConnections;
    state.recentPrefixesByConnection = synchronizedRecentPrefixesByConnection(nextConnections, nextRecentsByConnection);
    if (state.activeConnectionId === connectionId) renderFolderGroups();
    return true;
  });
}

function pinPrefix(prefix) {
  const clean = explorerCore.normalizeRemotePrefix(prefix);
  if (!clean || state.pinnedPrefixes.includes(clean)) {
    return Promise.resolve(false);
  }
  return saveActiveConnectionPreferences({
    connectionId: state.activeConnectionId,
    publicRead: els.publicRead.checked,
    checksum: els.checksum.value,
    pinnedPrefixes: [...state.pinnedPrefixes, clean].slice(0, 8),
  });
}

function rootName(remotePrefix) {
  return explorerCore.normalizeRemotePrefix(remotePrefix).split('/').filter(Boolean).at(-1) || '';
}

function parentPrefix(remotePrefix) {
  return explorerCore.normalizeRemotePrefix(remotePrefix).split('/').filter(Boolean).slice(0, -1).join('/');
}

function currentArchiveDestination() {
  return explorerCore.buildArchiveDestination({
    event: els.archiveEvent.value,
    category: els.archiveCategory.value,
    stage: els.archiveStage.value,
    day: els.archiveDay.value,
  });
}

function currentArchivePackageTarget() {
  return explorerCore.buildArchivePackageTarget({
    event: els.archiveEvent.value,
    category: els.archiveCategory.value,
    stage: els.archiveStage.value,
    day: els.archiveDay.value,
    packageName: els.archivePackageName.value,
  });
}

function updateArchivePreview() {
  const destination = currentArchiveDestination();
  els.archivePreview.textContent = [
    `Archive folder: ${destination}`,
    `Package target: ${currentArchivePackageTarget()}`,
    'Server-side move only. Local files are not changed.',
  ].join('\n');
  saveSettings();
}

function showOrganizePanel(uploadedRoots = []) {
  const folderRoots = uploadedRoots
    .filter((root) => root.rootPrefix && rootName(root.rootPrefix));
  state.uploadedRoots = folderRoots;
  if (!folderRoots.length) {
    els.organizeSection.hidden = true;
    return;
  }
  els.organizeSection.hidden = false;
  els.renameUploadedRoot.disabled = false;
  els.moveUploadedRoot.disabled = false;
  els.moveSelectedToArchive.disabled = true;
  els.renameUploadedRoot.title = '';
  els.moveUploadedRoot.title = '';
  els.moveSelectedToArchive.title = 'Select a server item to use this action.';
  els.organizeSource.textContent = folderRoots.length === 1
    ? rootName(folderRoots[0].rootPrefix)
    : `${folderRoots.length} folders`;
  updateArchivePreview();
}

async function moveUploadedRootTo(targetPrefix) {
  const root = state.uploadedRoots[0];
  if (!root?.rootPrefix) {
    appendLog('No verified uploaded folder is available to organize.', 'error');
    return;
  }
  const item = {
    name: rootName(root.rootPrefix),
    path: root.rootPrefix,
    isDir: true,
  };
  const result = await api.runRemoteOperation({
    action: 'move',
    item,
    targetPrefix,
    profile: currentProfile(),
  });
  if (result.ok) {
    appendLog(`Moved uploaded folder ${item.path} to ${targetPrefix}`);
    state.uploadedRoots = [{ ...root, rootPrefix: targetPrefix }];
    els.organizeSource.textContent = rootName(targetPrefix);
    await loadRemote(parentPrefix(targetPrefix));
  }
}

function showArchiveSortForSelection() {
  const items = selectedRemoteItems();
  if (!items.length) return;
  els.organizeSection.hidden = false;
  els.renameUploadedRoot.disabled = true;
  els.moveUploadedRoot.disabled = true;
  els.moveSelectedToArchive.disabled = false;
  els.renameUploadedRoot.title = 'No verified uploaded folder is available.';
  els.moveUploadedRoot.title = 'No verified uploaded folder is available.';
  els.moveSelectedToArchive.title = '';
  els.organizeSource.textContent = items.length === 1 ? items[0].name : `${items.length} selected`;
  if (items.length === 1) {
    els.archivePackageName.value = rootName(items[0].path) || items[0].name;
  }
  updateArchivePreview();
  els.archivePackageName.focus();
  els.archivePackageName.select();
}

async function moveSelectedToArchive() {
  const items = selectedRemoteItems();
  if (!items.length) {
    appendLog('Select a server file or folder before archive sorting.', 'error');
    return;
  }
  if (items.length === 1) {
    const result = await api.runRemoteOperation({
      action: 'move',
      item: items[0],
      targetPrefix: currentArchivePackageTarget(),
      profile: currentProfile(),
    });
    if (result.ok) {
      appendLog(`Moved ${items[0].path} to ${currentArchivePackageTarget()}`);
      await loadRemote(parentPrefix(items[0].path));
    }
    return;
  }
  await moveRemoteItemsToFolder(items, currentArchiveDestination());
}

async function renameRemoteItem(item, newName) {
  const cleanName = String(newName || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!item || !cleanName || cleanName.includes('/')) {
    appendLog('Rename requires one plain file or folder name.', 'error');
    return;
  }
  const targetPrefix = explorerCore.joinRemotePath(parentPrefix(item.path), cleanName);
  if (targetPrefix === item.path) {
    return;
  }
  const result = await api.runRemoteOperation(withProfile({ action: 'move', item, targetPrefix }));
  if (result.ok) {
    appendLog(`Renamed ${item.path} to ${targetPrefix}`);
    await loadRemote(state.remotePrefix);
  }
}

function displayedRemoteEntries() {
  return driveShellCore.filterAndSortRemoteEntries(
    state.remoteEntries.map((entry, index) => ({ ...entry, originalIndex: index })),
    state.driveShell,
  );
}

function sortHeader(sortKey, label) {
  const active = state.driveShell.sortKey === sortKey;
  const direction = active ? state.driveShell.sortDirection : 'none';
  const ariaSort = active
    ? (state.driveShell.sortDirection === 'asc' ? 'ascending' : 'descending')
    : 'none';
  return `
    <span role="columnheader" aria-sort="${ariaSort}">
      <button type="button" class="remote-sort-button ${active ? 'is-active' : ''}" data-sort-key="${sortKey}">
        <span>${label}</span>
        <span class="sort-indicator" aria-hidden="true">${direction === 'asc' ? '^' : direction === 'desc' ? 'v' : ''}</span>
      </button>
    </span>
  `;
}

function bindRemoteSortControls() {
  document.querySelectorAll('.remote-sort-button[data-sort-key]').forEach((button) => {
    button.addEventListener('click', () => {
      state.driveShell = driveShellCore.nextSortState(state.driveShell, button.dataset.sortKey);
      renderRemoteTable({ preserveSelection: true, resetScroll: true });
    });
  });
}

function restoreRemoteSelectionByPath(paths = []) {
  const wanted = new Set(paths.filter(Boolean));
  const visibleIndexes = new Set(displayedRemoteEntries().map((entry) => entry.originalIndex));
  const indexes = state.remoteEntries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry, index }) => visibleIndexes.has(index) && wanted.has(entry.path || entry.name))
    .map(({ index }) => index);
  state.selectedRemoteIndexes = new Set(indexes);
  state.selectedRemoteIndex = indexes.at(-1) ?? -1;
  state.selectionAnchorIndex = state.selectedRemoteIndex;
  syncRemoteSelectionUi();
}

function renderRemoteTable({ preserveSelection = false, resetScroll = false } = {}) {
  const selectedPaths = preserveSelection
    ? selectedRemoteItems().map((entry) => entry.path || entry.name)
    : [];
  renderBreadcrumbs();
  els.remotePath.value = state.remotePrefix;
  updateDriveTopBar();

  if (!state.remoteEntries.length) {
    state.remoteFocusIndex = -1;
    els.remoteTable.setAttribute('aria-rowcount', '0');
    const placeholderPath = explorerCore.buildFolderPlaceholderPath(state.remotePrefix);
    els.remoteTable.innerHTML = `
      <div class="empty-state empty-folder-state" role="status">
        <strong>No remote objects in this prefix yet.</strong>
        <span>DigitalOcean Spaces shows a folder after it contains an object.</span>
        ${placeholderPath ? `<button type="button" id="createCurrentFolderPlaceholder" class="quiet">Create visible folder marker</button>` : ''}
      </div>
    `;
    const createButton = document.getElementById('createCurrentFolderPlaceholder');
    if (createButton) {
      createButton.addEventListener('click', () => createFolderPlaceholderForPrefix(state.remotePrefix));
    }
    setRemoteSelection(-1);
    return;
  }
  const entries = displayedRemoteEntries();

  if (!entries.length) {
    state.remoteFocusIndex = -1;
    els.remoteTable.setAttribute('aria-rowcount', '1');
    els.remoteTable.innerHTML = `
      <div class="remote-header" role="row">
        ${sortHeader('name', 'Name')}
        ${sortHeader('size', 'Size')}
        ${sortHeader('modified', 'Modified')}
        ${sortHeader('type', 'Type')}
      </div>
      <div class="empty-state" role="status">No remote objects match this search.</div>
      <button type="button" id="clearRemoteSearch" class="quiet empty-search-clear">Clear search</button>
    `;
    bindRemoteSortControls();
    document.getElementById('clearRemoteSearch')?.addEventListener('click', () => {
      state.driveShell = driveShellCore.normalizeDriveShellState({ ...state.driveShell, search: '' });
      els.driveSearch.value = '';
      renderRemoteTable({ preserveSelection: true, resetScroll: true });
      els.driveSearch.focus();
    });
    if (resetScroll) els.remoteTable.scrollTop = 0;
    setRemoteSelection(-1);
    return;
  }

  const displayedIndexes = entries.map((entry) => entry.originalIndex);
  if (!displayedIndexes.includes(state.remoteFocusIndex)) {
    state.remoteFocusIndex = displayedIndexes.includes(state.selectedRemoteIndex)
      ? state.selectedRemoteIndex
      : displayedIndexes[0];
  }
  els.remoteTable.setAttribute('aria-rowcount', String(entries.length + 1));

  els.remoteTable.innerHTML = `
    <div class="remote-header" role="row">
      ${sortHeader('name', 'Name')}
      ${sortHeader('size', 'Size')}
      ${sortHeader('modified', 'Modified')}
      ${sortHeader('type', 'Type')}
    </div>
    ${entries
      .map(
        (entry) => `
          <div class="remote-row ${entry.isDir ? 'remote-folder' : 'remote-file'}" data-index="${entry.originalIndex}" draggable="true" role="row" tabindex="${entry.originalIndex === state.remoteFocusIndex ? '0' : '-1'}" aria-selected="${state.selectedRemoteIndexes.has(entry.originalIndex) ? 'true' : 'false'}" aria-label="${escapeHtml(`${entry.name}, ${entry.isDir ? 'folder' : 'file'}, ${entry.displaySize || 'size unavailable'}, modified ${entry.modified ? entry.modified.slice(0, 19).replace('T', ' ') : 'unknown'}`)}">
            <span class="remote-name" title="${escapeHtml(entry.path)}" role="gridcell">
              <span class="remote-icon" aria-hidden="true">${entry.isDir ? 'DIR' : 'OBJ'}</span>
              <span class="remote-label">${escapeHtml(entry.name)}</span>
            </span>
            <span role="gridcell">${escapeHtml(entry.displaySize)}</span>
            <span role="gridcell">${escapeHtml(entry.modified ? entry.modified.slice(0, 19).replace('T', ' ') : '-')}</span>
            <span role="gridcell"><span class="type-pill">${escapeHtml(entry.type)}</span></span>
          </div>
        `,
      )
      .join('')}
  `;

  if (resetScroll) els.remoteTable.scrollTop = 0;

  bindRemoteSortControls();
  document.querySelectorAll('.remote-row').forEach((row) => {
    row.addEventListener('click', (event) => {
      state.remoteFocusIndex = Number(row.dataset.index);
      setRemoteSelection(Number(row.dataset.index), {
        additive: event.ctrlKey || event.metaKey,
        range: event.shiftKey,
      });
    });
    row.addEventListener('keydown', (event) => handleRemoteGridKeydown(event, row));
    row.addEventListener('dblclick', () => {
      const item = state.remoteEntries[Number(row.dataset.index)];
      if (item?.isDir) {
        loadRemote(item.path);
      } else if (item?.publicUrl) {
        api.copyUrls([item.publicUrl]);
        appendLog(`Copied URL: ${item.publicUrl}`);
      }
    });
    row.addEventListener('dragstart', (event) => {
      const index = Number(row.dataset.index);
      if (!state.selectedRemoteIndexes.has(index)) {
        setRemoteSelection(index);
      }
      const items = selectedRemoteItems();
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('application/x-murdawk-remote', JSON.stringify(items));
      event.dataTransfer.setData('text/plain', items.map((entry) => entry.path).join('\n'));
      row.classList.add('is-drag-source');
    });
    row.addEventListener('dragend', () => {
      clearRemoteDropTargets();
      row.classList.remove('is-drag-source');
    });
    if (state.remoteEntries[Number(row.dataset.index)]?.isDir) {
      row.addEventListener('dragover', (event) => {
        if (!hasUsableDragData(event)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = hasRemoteDragData(event) ? 'move' : 'copy';
        row.classList.add('is-drop-target');
      });
      row.addEventListener('dragleave', () => {
        row.classList.remove('is-drop-target');
      });
      row.addEventListener('drop', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        row.classList.remove('is-drop-target');
        const item = state.remoteEntries[Number(row.dataset.index)];
        await handleFolderDrop(event, item);
      });
    }
  });
  if (preserveSelection) {
    restoreRemoteSelectionByPath(selectedPaths);
  } else {
    setRemoteSelection(-1);
  }
}

async function createFolderPlaceholderForPrefix(prefix) {
  const cleanPrefix = explorerCore.normalizeRemotePrefix(prefix);
  const placeholderPath = explorerCore.buildFolderPlaceholderPath(cleanPrefix);
  if (!placeholderPath) {
    appendLog('Choose a non-root server folder before creating a visible marker.', 'error');
    return;
  }
  try {
    const result = await api.runRemoteOperation(withProfile({ action: 'mkdir', targetPrefix: placeholderPath }));
    if (result.ok) {
      appendLog(`Created visible folder marker ${placeholderPath}`);
      await loadRemote(cleanPrefix);
    }
  } catch (error) {
    appendLog(`Folder marker failed: ${error.message}`, 'error');
  }
}

async function cacheRootFolderShortcuts(profile, connectionId) {
  try {
    const result = await api.listRemote('', profile);
    state.rootEntriesByConnection[connectionId] = navigationCore.rootFolderShortcuts(result.entries);
    if (connectionId === state.activeConnectionId) {
      renderFolderGroups();
    }
    return true;
  } catch (error) {
    appendLog(`Space folder shortcuts unavailable: ${error.message}`, 'error');
    return false;
  }
}

async function loadRemote(prefix = state.remotePrefix, { restoreGridFocus = false } = {}) {
  if (!hasActiveConnection()) {
    remoteLoadSequence += 1;
    state.remotePrefix = '';
    state.remoteEntries = [];
    els.remotePath.value = '';
    els.prefix.value = '';
    els.remoteTable.setAttribute('aria-busy', 'false');
    els.remoteTable.innerHTML = `
      <div class="empty-state empty-folder-state" role="status">
        <strong>No Space connected</strong>
        <span>Choose a Space from the connection menu or add one in Connections.</span>
        <button type="button" id="emptyAddConnection" class="primary">Add connection</button>
      </div>
    `;
    document.getElementById('emptyAddConnection')?.addEventListener('click', () => openConnectionsView({ add: true }));
    renderFolderGroups();
    renderBreadcrumbs();
    updateDriveTopBar();
    setRunning(state.isRunning);
    return false;
  }
  const requestId = ++remoteLoadSequence;
  const connectionId = state.activeConnectionId;
  const profile = currentProfile();
  const listingPlan = navigationCore.navigationListingPlan(
    prefix,
    Object.hasOwn(state.rootEntriesByConnection, connectionId),
  );
  setDriveShellView('files');
  state.remotePrefix = listingPlan.targetPrefix;
  els.remotePath.value = state.remotePrefix;
  els.prefix.value = state.remotePrefix;
  state.remoteEntries = [];
  els.remoteTable.setAttribute('aria-busy', 'true');
  if (restoreGridFocus) {
    els.remoteNavigationStatus.textContent = '';
  }
  els.remoteTable.innerHTML = '<div class="empty-state">Loading remote files...</div>';
  setRemoteSelection(-1);
  setCurrentFolderDropState(false);
  setRunning(state.isRunning);
  appendLog(`Listing remote: ${profile.remote}:${profile.bucket}/${state.remotePrefix}/`);
  try {
    if (listingPlan.shouldPrimeRoot) {
      await cacheRootFolderShortcuts(profile, connectionId);
    }
    if (requestId !== remoteLoadSequence || connectionId !== state.activeConnectionId) return;
    const result = await api.listRemote(state.remotePrefix, profile);
    if (requestId !== remoteLoadSequence || connectionId !== state.activeConnectionId) return;
    state.remotePrefix = navigationCore.normalizePrefix(result.prefix);
    state.remoteEntries = Array.isArray(result.entries) ? result.entries : [];
    els.health.textContent = `Ready: ${profile.remote}:/${profile.bucket}`;
    els.health.className = 'health is-ready';
    if (state.remotePrefix) {
      void rememberPrefix(state.remotePrefix, connectionId);
    } else {
      state.rootEntriesByConnection[connectionId] = navigationCore.rootFolderShortcuts(state.remoteEntries);
      saveSettings();
    }
    renderFolderGroups();
    renderRemoteTable({ resetScroll: true });
    els.remoteTable.setAttribute('aria-busy', 'false');
    if (restoreGridFocus) {
      await restoreKeyboardFocusToRemoteGrid();
    }
  } catch (error) {
    if (requestId !== remoteLoadSequence || connectionId !== state.activeConnectionId) return;
    els.remoteTable.setAttribute('aria-busy', 'false');
    els.remoteTable.innerHTML = `<div class="empty-state">Remote listing failed: ${escapeHtml(error.message)}</div>`;
    els.health.textContent = `${profile.remote}: ${error.message}`;
    els.health.className = 'health is-error';
    appendLog(error.message, 'error');
    if (restoreGridFocus) {
      els.remoteTable.focus();
      els.remoteNavigationStatus.textContent = `${state.remotePrefix || 'Remote folder'} failed to load.`;
    }
  }
}

function setActiveJobStatus(status, patch = {}) {
  if (state.activeQueueJobId) {
    setQueueJobStatus(state.activeQueueJobId, status, patch);
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    const entities = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;',
    };
    return entities[char];
  });
}

function traceAutomaticQueue(event, details = {}) {
  if (!api.smokeMode) return;
  smokeAutomaticQueueTrace.push({
    event,
    details,
    jobs: state.queueJobs.map((job) => ({ id: job.id, status: job.status, prefix: job.prefix })),
    shelfOpen: !els.transferShelf.hidden && state.driveShell.queueDrawerOpen,
  });
}

async function addSources(paths, destinationPrefix = state.remotePrefix) {
  if (!hasActiveConnection()) {
    openConnectionsView({ add: true });
    showConnectionNotice('Choose or add a Space before uploading.', { error: true });
    return null;
  }
  const cleanPaths = [...new Set((paths || []).filter(Boolean))];
  if (!cleanPaths.length) return null;
  const frozenSettings = currentSettings();
  const job = explorerCore.createQueueJob({
    sources: cleanPaths,
    settings: {
      ...frozenSettings,
      profile: { ...frozenSettings.profile },
      prefix: explorerCore.normalizeRemotePrefix(destinationPrefix),
    },
  });
  const result = await addQueueJobs([job], { traceEvent: 'intake' });
  return result.added[0] || job;
}

async function addQueueJobs(jobs = [], { deduplicate = false, traceEvent = 'intake' } = {}) {
  const candidates = jobs.filter(Boolean);
  const result = deduplicate
    ? explorerCore.appendUniqueQueueJobs(state.queueJobs, candidates)
    : { jobs: [...state.queueJobs, ...candidates], added: candidates, duplicates: [] };
  if (!result.added.length) return result;
  state.queueJobs = result.jobs;
  state.selectedQueueJobId = result.added[0].id;
  const persisted = await saveSettings();
  if (!persisted) {
    appendLog('Transfer was not started because the durable queue could not be saved.', 'error');
    renderQueue();
    return result;
  }
  state.driveShell = driveShellCore.normalizeDriveShellState({
    ...state.driveShell,
    queueDrawerOpen: true,
  });
  renderQueue();
  for (const job of result.added) {
    traceAutomaticQueue(traceEvent, { jobId: job.id, prefix: job.prefix });
  }
  if (!scheduleAutomaticQueue()) {
    appendLog('Transfer saved and waiting for the active transfer lifecycle to finish.');
  }
  return result;
}

async function collectDroppedPaths(event) {
  const files = [...event.dataTransfer.files];
  return files.map((file) => api.getPathForFile(file)).filter(Boolean);
}

async function queueDroppedUpload(event) {
  event.preventDefault();
  const paths = await collectDroppedPaths(event);
  if (!paths.length) {
    return;
  }
  await addSources(paths, state.remotePrefix);
  const profile = currentProfile();
  appendLog(`Added ${paths.length} local item(s) for automatic upload to ${profile.remote}:${profile.bucket}/${state.remotePrefix}/`);
}

function hasRemoteDragData(event) {
  return explorerCore.dragHasRemoteItems(event.dataTransfer);
}

function hasUsableDragData(event) {
  return hasRemoteDragData(event) || explorerCore.dragHasLocalFiles(event.dataTransfer);
}

function setCurrentFolderDropState(active) {
  if (!hasActiveConnection()) {
    els.remotePane.classList.remove('is-dragging');
    els.remoteTable.classList.remove('is-dragging');
    els.remoteDropHint.classList.remove('is-dragging');
    els.remoteDropHint.textContent = 'Choose a Space before uploading.';
    els.remotePane.setAttribute('aria-label', 'No Space connected. Choose or add a connection before uploading.');
    return;
  }
  const destination = `${currentProfile().remote}:${currentProfile().bucket}/${state.remotePrefix || ''}/`;
  els.remotePane.classList.toggle('is-dragging', active);
  els.remoteTable.classList.toggle('is-dragging', active);
  els.remoteDropHint.classList.toggle('is-dragging', active);
  els.remoteDropHint.textContent = active
    ? `Drop here to check, upload, and verify in ${destination}`
    : `Current folder intake: ${destination}`;
  els.remotePane.setAttribute(
    'aria-label',
    active
      ? `Drop files or folders to upload to ${destination}`
      : `Files in ${destination}. Drop files or folders here to upload.`,
  );
}

function clearRemoteDropTargets() {
  document.querySelectorAll('.remote-row.is-drop-target').forEach((row) => {
    row.classList.remove('is-drop-target');
  });
}

function remoteDragItems(event) {
  try {
    return JSON.parse(event.dataTransfer.getData('application/x-murdawk-remote') || '[]');
  } catch (_error) {
    return [];
  }
}

async function queueUploadToPrefix(event, targetPrefix) {
  const paths = await collectDroppedPaths(event);
  if (!paths.length) {
    return;
  }
  const destinationPrefix = explorerCore.normalizeRemotePrefix(targetPrefix);
  await addSources(paths, destinationPrefix);
  const profile = currentProfile();
  appendLog(`Added ${paths.length} local item(s) for automatic upload to ${profile.remote}:${profile.bucket}/${destinationPrefix}/`);
}

async function moveRemoteItemsToFolder(items, folderPath) {
  const plan = explorerCore.buildRemoteMovePlan({ items, targetFolderPath: folderPath });
  await runMoveOperations(plan);
}

async function runMoveOperations(plan) {
  for (const skipped of plan.skipped) {
    appendLog(`Skipped ${skipped.item?.path || 'item'}: ${skipped.reason}`);
  }
  if (!plan.operations.length) {
    return;
  }

  appendLog(`Preparing ${plan.operations.length} server move(s)...`);
  const batchResult = await api.runRemoteOperations(plan.operations.map((operation) => ({
    ...operation,
    profile: currentProfile(),
  })));
  if (batchResult.ok) {
    for (const operation of plan.operations) {
      appendLog(`Moved ${operation.item.path} to ${operation.targetPrefix}`);
    }
  } else {
    appendLog(`Move cancelled for ${plan.operations.length} selected item(s).`);
    return;
  }
  closeMoveTray();
  await loadRemote(state.remotePrefix);
}

async function moveSelectedWithMode(mode) {
  const target = explorerCore.normalizeRemotePrefix(els.moveTarget.value);
  if (!target) {
    appendLog('Move target is required.', 'error');
    return;
  }
  const plan = explorerCore.resolveMoveTargets({
    items: selectedRemoteItems(),
    target,
    mode,
  });
  await runMoveOperations(plan);
}

async function handleFolderDrop(event, folder) {
  if (!folder?.isDir) {
    return;
  }

  if (hasRemoteDragData(event)) {
    await moveRemoteItemsToFolder(remoteDragItems(event), folder.path);
    return;
  }

  await queueUploadToPrefix(event, folder.path);
}

function bindFolderShortcutDrops() {
  document.querySelectorAll('.folder-shortcut').forEach((button) => {
    button.onclick = () => {
      loadRemote(button.dataset.prefix);
    };
    button.ondragover = (event) => {
      if (!hasUsableDragData(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = hasRemoteDragData(event) ? 'move' : 'copy';
      button.classList.add('is-drop-target');
    };
    button.ondragleave = () => {
      button.classList.remove('is-drop-target');
    };
    button.ondrop = async (event) => {
      event.preventDefault();
      button.classList.remove('is-drop-target');
      const targetPrefix = button.dataset.prefix;
      if (hasRemoteDragData(event)) {
        await moveRemoteItemsToFolder(remoteDragItems(event), targetPrefix);
        return;
      }
      await queueUploadToPrefix(event, targetPrefix);
    };
  });
}

function dryRunQueuedJob(job) {
  const request = currentRequest(job);
  return job.direction === 'download'
    ? api.dryRunDownload(request)
    : api.dryRunUpload(request);
}

function startQueuedJob(job, request) {
  return job.direction === 'download'
    ? api.startQueueDownload([request])
    : api.startQueueUpload([request]);
}

async function dryRunJobs(jobs, label = 'queued transfer jobs') {
  const lifecycleGate = currentQueueLifecycleGate({ ownedLifecycle: automaticQueueRunning });
  if (!lifecycleGate.ok) {
    appendLog(lifecycleGate.message);
    return { ok: false, externalLifecycle: lifecycleGate.externalLifecycle, error: lifecycleGate.message };
  }
  const targets = jobs.filter((item) => item && item.status !== 'complete');
  if (!targets.length) {
    appendLog('Pre-check skipped: no selected transfer jobs need a check.', 'error');
    return;
  }
  setRunning(true);
  resetProgress('dry-run');
  updateVerification(null);
  appendLog(`Starting pre-check for ${label}...`);
  try {
    for (const job of targets) {
      state.activeQueueJobId = job.id;
      setQueueJobStatus(job.id, 'prechecking', { error: '' });
      appendLog(`${job.direction === 'download' ? 'Checking download' : 'Checking upload'}: ${explorerCore.queueJobDestinationLabel(job)}`);
      const result = await dryRunQueuedJob(job);
      state.currentJobId = result.jobId || state.currentJobId;
      els.copyDiagnostics.disabled = !state.currentJobId;
      setQueueJobStatus(job.id, 'ready', {
        jobId: result.jobId || '',
        verification: result.verification || null,
      });
    }
    appendLog('Pre-check complete. Ready transfers can start now.');
  } catch (error) {
    if (await holdQueueJobForExternalLifecycle(state.activeQueueJobId, error)) {
      return { ok: false, externalLifecycle: true, error: error.message };
    }
    if (state.activeQueueJobId) {
      setQueueJobStatus(state.activeQueueJobId, 'failed', { error: error.message });
    }
    appendLog(error.message, 'error');
  } finally {
    resetActiveTransferShelfState();
    setRunning(false);
    if (automaticQueuePending) {
      automaticQueuePending = false;
      setTimeout(runAutomaticQueue, 0);
    }
  }
}

async function runDryRun() {
  await dryRunJobs(state.queueJobs.filter((item) => item.status !== 'complete'), 'all queued destination jobs');
}

async function runSelectedDryRun() {
  const job = selectedQueueJob();
  if (!job) {
    appendLog('Select a queued job first.', 'error');
    return;
  }
  await dryRunJobs([job], 'the selected queue job');
}

function removeSelectedQueueJob() {
  const job = selectedQueueJob();
  if (!job || state.isRunning) return;
  state.queueJobs = state.queueJobs.filter((item) => item.id !== job.id);
  state.selectedQueueJobId = '';
  renderQueue();
  renderActivity();
  renderHistory();
  saveSettings();
  appendLog(`Removed queued job for ${explorerCore.queueJobDestinationLabel(job)}`);
}

function clearCompletedQueueJobs() {
  const before = state.queueJobs.length;
  state.queueJobs = state.queueJobs.filter((job) => job.status !== 'complete');
  if (!state.queueJobs.some((job) => job.id === state.selectedQueueJobId)) {
    state.selectedQueueJobId = '';
  }
  renderQueue();
  renderActivity();
  renderHistory();
  saveSettings();
  appendLog(`Cleared ${before - state.queueJobs.length} completed job(s).`);
}

async function readRecoverySnapshot() {
  if (api.recoverySnapshot) return api.recoverySnapshot();
  const [activeTransfer, records] = await Promise.all([
    api.activeTransfer(),
    api.listJobRecords(),
  ]);
  return { activeTransfer, records };
}

async function reconcileQueueFromJobRecords({ records, activeTransfer, revalidate = true } = {}) {
  if (!api.listJobRecords || !api.activeTransfer) {
    return true;
  }
  try {
    const recoveryInputsProvided = Array.isArray(records) && Boolean(activeTransfer);
    if (!recoveryInputsProvided) {
      ({ records, activeTransfer } = await readRecoverySnapshot());
    }
    const before = state.queueJobs.map((job) => `${job.id}:${job.status}:${job.jobId}`).join('|');
    state.queueJobs = explorerCore.reconcileQueueJobsWithRecords(
      state.queueJobs,
      records,
      { activeTransfer },
    );
    if (revalidate) {
      const latest = await readRecoverySnapshot();
      records = latest.records;
      activeTransfer = latest.activeTransfer;
      state.queueJobs = explorerCore.reconcileQueueJobsWithRecords(
        state.queueJobs,
        records,
        { activeTransfer },
      );
    }
    state.activeTransfer = activeTransfer || {};
    const after = state.queueJobs.map((job) => `${job.id}:${job.status}:${job.jobId}`).join('|');
    const activeQueueJob = state.queueJobs.find((job) =>
      ['prechecking', 'uploading', 'verifying', 'pausing'].includes(job.status)
      && queueRecoveryCore.activeTransferMatchesJob(job, activeTransfer));
    if (activeQueueJob) {
      state.activeQueueJobId = activeQueueJob.id;
      state.currentJobId = activeQueueJob.jobId;
      state.selectedQueueJobId = activeQueueJob.id;
      setRunning(true);
      renderActivitySummary(activeTransfer);
      schedulingBlockedByExternalLifecycle = false;
    } else {
      state.activeQueueJobId = '';
      state.currentJobId = '';
      schedulingBlockedByExternalLifecycle = activeTransfer?.isRunning === true;
      setRunning(false);
      if (schedulingBlockedByExternalLifecycle) renderActivitySummary(activeTransfer);
    }
    const restoredUrls = state.queueJobs
      .filter((job) => job.status === 'complete')
      .flatMap((job) => job.urls || []);
    if (restoredUrls.length) {
      state.urls = [...new Set([...state.urls, ...restoredUrls])];
      els.urls.value = state.urls.join('\n');
      els.urls.placeholder = 'Verified public URLs are listed here.';
      els.copyUrls.disabled = state.urls.length === 0;
    }
    if (before !== after) {
      appendLog(activeQueueJob
        ? 'Queue reattached to the live rclone transfer.'
        : 'Queue reconciled with verified job records.');
      renderQueue();
      if (!await saveSettings()) return false;
    }
    return !schedulingBlockedByExternalLifecycle;
  } catch (error) {
    appendLog(`Queue reconciliation skipped: ${error.message}`, 'error');
    return false;
  }
}

async function uploadReadyJobs(jobs, label = 'queue') {
  const lifecycleGate = currentQueueLifecycleGate({ ownedLifecycle: automaticQueueRunning });
  if (!lifecycleGate.ok) {
    appendLog(lifecycleGate.message);
    return { ok: false, externalLifecycle: lifecycleGate.externalLifecycle, error: lifecycleGate.message };
  }
  const pending = jobs.filter((job) => job.status !== 'complete');
  const blocked = pending.find((job) => job.status !== 'ready');
  if (!pending.length) {
    appendLog('Transfer blocked: no selected ready jobs are available.', 'error');
    return { ok: false, error: 'No selected ready jobs are available.' };
  }
  if (blocked) {
    appendLog(`Transfer blocked: ${explorerCore.queueJobDestinationLabel(blocked)} is ${explorerCore.queueJobStatusLabel(blocked).toLowerCase()}.`, 'error');
    return { ok: false, clientJobId: blocked.id, error: `Job is ${blocked.status}.` };
  }
  const requests = explorerCore.queueUploadRequests(jobs);
  if (!requests.length) {
    appendLog('Transfer blocked: no ready jobs are available.', 'error');
    return { ok: false, error: 'No ready jobs are available.' };
  }
  setRunning(true);
  const hasUploads = pending.some((job) => job.direction !== 'download');
  if (hasUploads) {
    state.urls = [];
    els.urls.value = '';
    els.urls.placeholder = 'Uploading now. Public URLs appear after upload and verification complete.';
    els.copyUrls.disabled = true;
  }
  resetProgress(pending[0]?.direction === 'download' ? 'download' : 'upload');
  updateVerification(null);
  appendLog(`Starting ${label} with ${requests.length} ready transfer job(s)...`);
  try {
    const completed = [];
    for (const request of requests) {
      const job = pending.find((candidate) => candidate.id === request.clientJobId);
      const result = await startQueuedJob(job, request);
      if (!result.ok) {
        if (await holdQueueJobForExternalLifecycle(result.clientJobId || state.activeQueueJobId, result)) {
          return { ...result, externalLifecycle: true, results: completed };
        }
        appendLog(`Queue stopped: ${result.error || 'unknown error'}`, 'error');
        if (result.clientJobId) {
          const status = result.paused ? 'paused' : result.cancelled ? 'cancelled' : result.blocked ? 'blocked' : 'failed';
          setQueueJobStatus(result.clientJobId, status, { error: result.error || 'Queue stopped.' });
        }
        return { ...result, results: [...completed, ...(result.results || [])] };
      }
      completed.push(...(result.results || []));
    }
    appendLog('Transfer queue complete. Completed jobs remain visible until Clear completed.');
    return { ok: true, results: completed };
  } catch (error) {
    if (await holdQueueJobForExternalLifecycle(state.activeQueueJobId, error)) {
      return { ok: false, externalLifecycle: true, clientJobId: state.activeQueueJobId, error: error.message };
    }
    if (state.activeQueueJobId) {
      setQueueJobStatus(
        state.activeQueueJobId,
        error.paused ? 'paused' : 'failed',
        { error: error.paused ? '' : error.message },
      );
    }
    appendLog('Queue stopped after a failed job. Remaining transfers did not start.', 'error');
    appendLog(error.message, 'error');
    return { ok: false, clientJobId: state.activeQueueJobId, error: error.message };
  } finally {
    resetActiveTransferShelfState();
    setRunning(false);
    if (automaticQueuePending) {
      automaticQueuePending = false;
      setTimeout(runAutomaticQueue, 0);
    }
  }
}

async function runUpload() {
  const readiness = explorerCore.queueCanUploadAll(state.queueJobs);
  if (!readiness.ok) {
    appendLog(`Upload all blocked: ${readiness.reason}`, 'error');
    return;
  }
  await uploadReadyJobs(state.queueJobs, 'overnight queue');
}

async function runSelectedUpload() {
  const job = selectedQueueJob();
  if (!job) {
    appendLog('Select a ready queue job first.', 'error');
    return;
  }
  await uploadReadyJobs([job], 'selected job');
}

function isPrecheckTransferMode(mode = '') {
  return mode === 'dry-run' || mode === 'download-check';
}

function handleUploadEvent(channel, payload = {}) {
  if (channel === 'upload:start') {
    state.currentJobId = payload.jobId || state.currentJobId;
    els.copyDiagnostics.disabled = !state.currentJobId;
    els.transferMode.textContent = payload.mode;
    state.activeTransfer = {
      ...state.activeTransfer,
      isRunning: true,
      isLifecycleActive: true,
      activeJobId: payload.jobId || state.activeTransfer.activeJobId || '',
      intentId: payload.intentId || state.activeTransfer.intentId || '',
      phase: isPrecheckTransferMode(payload.mode) ? 'prechecking' : 'uploading',
    };
    updatePauseAllControl();
  }
  if (channel === 'upload:preflight') {
    if (payload.direction === 'download') {
      appendLog(`Download check: ${payload.selectedCount} selected, ${payload.existingCount} already local, ${payload.pendingCount} to download.`);
      if (payload.mismatchCount) appendLog(`${payload.mismatchCount} local item(s) will be replaced because the size differs.`);
    } else {
      appendLog(
        `Preflight: ${payload.localCount} local match(es), ${payload.existing.length} already remote, ${payload.missing.length} new.`,
      );
      if (payload.existing.length) {
        appendLog(`Already remote:\n${payload.existing.map((name) => `  - ${name}`).join('\n')}`);
      }
    }
  }
  if (channel === 'upload:source-start') {
    setActiveJobStatus(isPrecheckTransferMode(payload.mode) ? 'prechecking' : 'uploading');
    updateTransferContext(payload);
    state.activeTransfer = {
      ...state.activeTransfer,
      isRunning: true,
      isLifecycleActive: true,
      activeJobId: payload.jobId || state.activeTransfer.activeJobId || '',
      intentId: payload.intentId || state.activeTransfer.intentId || '',
      phase: isPrecheckTransferMode(payload.mode) ? 'prechecking' : 'uploading',
    };
    updatePauseAllControl();
  }
  if (channel === 'upload:progress') {
    updateProgress(payload);
    renderActivitySummary({
      isRunning: true,
      activeJobId: payload.jobId || state.currentJobId,
      source: payload.source || '',
      sourceIndex: payload.sourceIndex || 0,
      sourceTotal: payload.sourceTotal || 0,
      mode: payload.mode || els.transferMode.textContent,
      currentFile: payload.currentFile || '',
      lastOutputAt: new Date().toISOString(),
      lastProgressAt: new Date().toISOString(),
    });
  }
  if (channel === 'upload:heartbeat') {
    state.activeTransfer = payload;
    renderActivitySummary(payload);
    updateTransferContext(payload);
    if (payload.transferred && payload.total) {
      updateProgress(payload);
    }
    updatePauseAllControl();
  }
  if (channel === 'upload:source-complete') {
    if (!isPrecheckTransferMode(payload.mode)) {
      setActiveJobStatus('verifying');
      state.activeTransfer = { ...state.activeTransfer, phase: 'verifying', hasChildProcess: false };
      updatePauseAllControl();
    }
  }
  if (channel === 'upload:verified') {
    els.urls.placeholder = payload.direction === 'download'
      ? 'Download verification complete.'
      : 'Verification complete. Generating public URLs...';
    updateVerification(payload.verification);
    if (payload.verification?.ok) {
      appendLog(payload.direction === 'download'
        ? `Verified ${payload.verification.verified.length} downloaded item(s).`
        : `Verified ${payload.verification.verified.length} remote file(s) by size.`);
    }
  }
  if (channel === 'upload:checksum') {
    updateChecksum(payload.checksum);
  }
  if (channel === 'upload:notifications') {
    logNotifications(payload.notifications);
  }
  if (channel === 'upload:queue-start') {
    appendLog(`Queue runner started with ${payload.total} job(s).`);
  }
  if (channel === 'upload:queue-job-start') {
    state.activeQueueJobId = payload.clientJobId || '';
    state.activeProgress = {};
    state.selectedQueueJobId = payload.clientJobId || state.selectedQueueJobId;
    setActiveJobStatus('uploading', { error: '' });
    const startedJob = state.queueJobs.find((job) => job.id === payload.clientJobId);
    const direction = payload.direction === 'download' || startedJob?.direction === 'download'
      ? 'Download'
      : 'Upload';
    const destination = startedJob
      ? explorerCore.queueJobDestinationLabel(startedJob)
      : explorerCore.queueJobDestinationLabel({ prefix: payload.prefix, profile: currentProfile() });
    appendLog(`${direction} ${payload.index}/${payload.total}: ${destination}`);
    updateTransferContext();
  }
  if (channel === 'upload:queue-job-complete') {
    flushPendingRcloneLog();
    const completedJob = state.queueJobs.find((job) => job.id === payload.clientJobId);
    const isDownload = payload.direction === 'download' || completedJob?.direction === 'download';
    const jobUrls = payload.urls || [];
    if (!isDownload) {
      state.urls = [...new Set([...state.urls, ...jobUrls])];
      els.urls.value = state.urls.join('\n');
      els.urls.placeholder = state.urls.length
        ? 'Verified public URLs are listed here.'
        : 'Upload verified, but no public URLs were generated.';
      els.copyUrls.disabled = state.urls.length === 0;
    }
    if (payload.clientJobId) {
      setQueueJobStatus(payload.clientJobId, 'complete', {
        jobId: payload.jobId || '',
        urls: jobUrls,
        verification: payload.verification || null,
        error: '',
      });
    }
    if (isDownload) {
      const localDestination = payload.localDestination || completedJob?.localDestination || 'the selected local folder';
      appendLog(`Download complete and verified in ${localDestination}.`);
    } else {
      showOrganizePanel(payload.uploadedRoots || []);
      appendLog(`Upload complete. ${jobUrls.length} verified URL(s) available.`);
    }
    updateTransferContext();
    void loadHistory();
  }
  if (channel === 'upload:queue-stopped') {
    flushPendingRcloneLog();
    if (explorerCore.queueLifecycleGate({ error: payload }).externalLifecycle) {
      void holdQueueJobForExternalLifecycle(payload.clientJobId, payload);
      return;
    }
    if (payload.clientJobId) {
      const status = payload.paused ? 'paused' : payload.cancelled ? 'cancelled' : payload.blocked ? 'blocked' : 'failed';
      setQueueJobStatus(payload.clientJobId, status, {
        error: payload.paused ? '' : payload.error || 'Queue stopped.',
      });
      if (rendererCancellationClaim?.clientJobId === payload.clientJobId) {
        rendererCancellationClaim = null;
      }
      preparedPauses.delete(payload.clientJobId);
    }
    state.activeTransfer = {};
    resetActiveTransferShelfState();
    setRunning(false);
    appendLog(
      payload.paused ? 'Queue paused safely.' : `Queue stopped: ${payload.error || 'unknown error'}`,
      payload.paused ? 'normal' : 'error',
    );
  }
  if (channel === 'upload:queue-complete') {
    flushPendingRcloneLog();
    resetActiveTransferShelfState();
    setRunning(false);
    state.activeTransfer = {};
    appendLog('Queue runner finished all ready jobs.');
    scheduleAutomaticQueue();
  }
  if (channel === 'upload:complete') {
    if (!payload.dryRun) {
      if (state.activeQueueJobId) {
        setActiveJobStatus('complete', {
          jobId: payload.jobId || '',
          urls: payload.urls || [],
          verification: payload.verification || null,
          error: '',
        });
      } else {
        resetActiveTransferShelfState();
      }
    }
    if (payload.warning) {
      appendLog(`${payload.direction === 'download' ? 'Download' : 'Upload'} verified after rclone warning: ${payload.warning}`);
    }
  }
  if (channel === 'upload:log' && payload.text) {
    appendRcloneLog(payload.text);
  }
  if (channel === 'upload:error') {
    flushPendingRcloneLog();
    if (payload.jobId) {
      state.currentJobId = payload.jobId;
      els.copyDiagnostics.disabled = false;
    }
    appendLog(payload.message || 'Transfer failed.', 'error');
    if (payload.verification) {
      updateVerification(payload.verification);
    }
    if (payload.checksum) {
      updateChecksum(payload.checksum);
    }
    if (state.activeQueueJobId) {
      setActiveJobStatus('failed', { error: payload.message || 'Transfer failed.' });
    } else {
      resetActiveTransferShelfState();
    }
  }
  if (channel === 'upload:cancelled') {
    const clientJobId = rendererCancellationClaim?.clientJobId
      || state.activeQueueJobId
      || state.queueJobs.find((job) => pauseCore.canonicalIntent(job) === payload.intentId)?.id
      || '';
    rendererCancellationClaim = null;
    preparedPauses.delete(clientJobId);
    if (clientJobId) void setQueueJobStatus(clientJobId, 'cancelled');
    state.activeTransfer = {};
    setRunning(false);
    appendLog('Transfer cancelled.');
  }
  if (channel === 'upload:paused') {
    const clientJobId = payload.clientJobId || state.activeQueueJobId;
    preparedPauses.delete(clientJobId);
    if (clientJobId) {
      void setQueueJobStatus(clientJobId, 'paused', {
        jobId: payload.jobId || state.currentJobId || '',
        error: '',
      });
    }
    state.activeTransfer = {};
    resetActiveTransferShelfState();
    setRunning(false);
    appendLog('Transfer paused. Check and resume will compare the source and destination before continuing.');
  }
  if (channel === 'upload:pause-failed') {
    const clientJobId = payload.clientJobId || state.activeQueueJobId;
    state.activeTransfer = {
      ...state.activeTransfer,
      phase: payload.phase || state.activeTransfer.phase,
      terminalAction: payload.terminalAction || '',
      pausePending: Boolean(payload.pausePending),
      pauseRequested: Boolean(payload.pauseRequested),
    };
    const prepared = preparedPauses.get(clientJobId);
    if (prepared) {
      void restoreQueueJobAfterPauseFailure(prepared, new Error(payload.message || 'Pause persistence failed.'));
    }
  }
}

function automaticQueueFailureStatus(error, jobId) {
  if (error?.blocked === true || error?.status === 'blocked' || /(No local files matched|Blocked credential-like local path|could not be safely inspected|credential path scan exceeded)/i.test(error?.message || '')) {
    return 'blocked';
  }
  const current = state.queueJobs.find((job) => job.id === jobId);
  return current?.status === 'blocked' ? 'blocked' : 'failed';
}

async function runAutomaticQueue() {
  if (automaticQueueRunning) return null;
  if (connectionSwitchPromise || connectionMutationPending > 0) {
    automaticQueuePending = true;
    return null;
  }
  if (preparedQueueResumes.size) return null;
  if (!currentQueueLifecycleGate().ok) {
    automaticQueuePending = true;
    return null;
  }
  automaticQueueRunning = true;

  try {
    while (true) {
      const nextAction = explorerCore.queueNextAutomaticAction(state.queueJobs);
      if (!nextAction) return null;
      const nextJob = nextAction.job;

      state.activeQueueJobId = nextJob.id;
      state.selectedQueueJobId = nextJob.id;
      setRunning(true);

      try {
        if (nextAction.type === 'precheck') {
          resetProgress('dry-run');
          updateVerification(null);
          const precheckingPersisted = await setQueueJobStatus(nextJob.id, 'prechecking', { error: '' });
          if (!precheckingPersisted) {
            appendLog('Automatic pre-check stopped because the queue state could not be persisted.', 'error');
            return null;
          }

          appendLog(`Automatic pre-check: ${explorerCore.queueJobDestinationLabel(nextJob)}`);
          const precheckResult = await dryRunQueuedJob(nextJob);
          if (!precheckResult || precheckResult.ok === false) {
            const error = new Error(precheckResult?.error || 'Pre-check did not complete successfully.');
            if (precheckResult?.blocked) error.blocked = true;
            throw error;
          }

          state.currentJobId = precheckResult.jobId || state.currentJobId;
          els.copyDiagnostics.disabled = !state.currentJobId;
          const readyPersisted = await setQueueJobStatus(nextJob.id, 'ready', {
            jobId: precheckResult.jobId || '',
            verification: precheckResult.verification || null,
            error: '',
          });
          if (!readyPersisted) {
            appendLog('Automatic transfer stopped because the ready queue state could not be persisted.', 'error');
            return null;
          }
        }

        const readyJob = state.queueJobs.find((job) => job.id === nextJob.id);
        const uploadResult = await uploadReadyJobs([readyJob], 'automatic queue job');
        if (!uploadResult?.ok) {
          if (uploadResult?.paused) {
            await setQueueJobStatus(nextJob.id, 'paused', { error: '' });
            return null;
          }
          if (uploadResult?.cancelled) {
            await setQueueJobStatus(nextJob.id, 'cancelled', { error: uploadResult.error || 'Transfer cancelled.' });
            return null;
          }
          const error = new Error(uploadResult?.error || 'Automatic upload failed.');
          if (uploadResult?.blocked) error.blocked = true;
          throw error;
        }

        const completedResult = uploadResult.results?.find((result) => result.clientJobId === nextJob.id)
          || uploadResult.results?.[0]
          || null;
        if (!completedResult || completedResult.verification?.ok !== true || completedResult.checksum?.ok === false) {
          throw new Error(`${nextJob.direction === 'download' ? 'Download' : 'Upload'} verification did not complete successfully.`);
        }
        const currentJob = state.queueJobs.find((job) => job.id === nextJob.id);
        traceAutomaticQueue('result-confirmed', {
          jobId: nextJob.id,
          prefix: nextJob.prefix,
          eventComplete: currentJob?.status === 'complete',
        });
        if (currentJob?.status !== 'complete') {
          await setQueueJobStatus(nextJob.id, 'complete', {
            jobId: completedResult?.jobId || currentJob?.jobId || '',
            urls: completedResult?.urls || currentJob?.urls || [],
            verification: completedResult?.verification || currentJob?.verification || null,
            error: '',
          });
        }
      } catch (error) {
        if (await holdQueueJobForExternalLifecycle(nextJob.id, error)) return null;
        const currentStatus = state.queueJobs.find((job) => job.id === nextJob.id)?.status;
        if (error?.paused || currentStatus === 'paused' || currentStatus === 'pausing') {
          await setQueueJobStatus(nextJob.id, 'paused', { error: '' });
          return null;
        }
        if (error?.cancelled || currentStatus === 'cancelled') {
          await setQueueJobStatus(nextJob.id, 'cancelled', { error: error.message || 'Transfer cancelled.' });
          return null;
        }
        const failureStatus = automaticQueueFailureStatus(error, nextJob.id);
        await setQueueJobStatus(nextJob.id, failureStatus, { error: error.message });
        appendLog(`Automatic queue stopped: ${error.message}`, 'error');
        return null;
      }
    }
  } finally {
    automaticQueueRunning = false;
    resetActiveTransferShelfState();
    setRunning(false);
  }
}

api.onUploadEvent(handleUploadEvent);
api.onAutomationStatus?.((status) => renderAutomationAccess(status));
api.onAutomationQueueUpdated?.(async ({ job } = {}) => {
  try {
    const settings = await api.loadSettings();
    state.queueJobs = hydrateQueueJobs(settings.queueJobs || [], state.connections);
    state.selectedQueueJobId = job?.id || state.selectedQueueJobId || state.queueJobs[0]?.id || '';
    state.driveShell = driveShellCore.normalizeDriveShellState({
      ...state.driveShell,
      queueDrawerOpen: true,
    });
    renderQueue();
    appendLog('A local automation tool added a job for review. No upload was started.');
  } catch (error) {
    appendLog(`Automation queue refresh failed: ${error.message}`, 'error');
  }
});
api.onBeforePauseClose?.(async ({ requestId, activeTransfer } = {}) => {
  try {
    const prepared = await prepareQueuePause(activeTransfer);
    await api.acknowledgeQueuePause({
      requestId,
      ok: true,
      clientJobId: prepared.clientJobId,
      intentId: prepared.intentId,
      jobId: prepared.jobId,
    });
  } catch (error) {
    appendLog(`Pause and close stopped: ${error.message}`, 'error');
    await api.acknowledgeQueuePause({ requestId, ok: false, error: error.message });
  }
});

els.remotePane.addEventListener('dragenter', (event) => {
  if (!hasUsableDragData(event)) return;
  event.preventDefault();
  setCurrentFolderDropState(true);
});

els.remotePane.addEventListener('dragover', (event) => {
  if (!hasUsableDragData(event)) return;
  event.preventDefault();
  event.stopPropagation();
  event.dataTransfer.dropEffect = hasRemoteDragData(event) ? 'move' : 'copy';
  setCurrentFolderDropState(true);
});

els.remotePane.addEventListener('dragleave', (event) => {
  if (els.remotePane.contains(event.relatedTarget)) return;
  setCurrentFolderDropState(false);
});

els.remotePane.addEventListener('drop', async (event) => {
  event.preventDefault();
  event.stopPropagation();
  setCurrentFolderDropState(false);
  if (hasRemoteDragData(event)) {
    await moveRemoteItemsToFolder(remoteDragItems(event), state.remotePrefix);
    return;
  }
  await queueDroppedUpload(event);
});

els.refreshRemote.addEventListener('click', () => loadRemote());
els.driveSearch?.addEventListener('input', () => {
  state.driveShell = driveShellCore.normalizeDriveShellState({
    ...state.driveShell,
    search: els.driveSearch.value,
  });
  renderRemoteTable({ preserveSelection: true, resetScroll: true });
});
els.openQueueDrawer?.addEventListener('click', () => {
  toggleTransferShelf();
});
els.transferShelfToggle?.addEventListener('click', toggleTransferShelf);
els.transferShelfPauseAll?.addEventListener('click', pauseAllUploads);
els.transferShelfList?.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-queue-recovery]');
  if (!button || state.isRunning) return;
  const job = state.queueJobs.find((candidate) => candidate.id === button.dataset.jobId);
  if (!job || preparedQueueResumes.has(job.id)) return;
  const candidate = queueRecoveryCore.resumeCandidate(job);
  if (candidate === job) return;
  const preparedResume = prepareQueueResumePersistence(candidate, job);
  state.selectedQueueJobId = job.id;
  state.driveShell = driveShellCore.normalizeDriveShellState({
    ...state.driveShell,
    queueDrawerOpen: true,
  });
  state.queueJobs = state.queueJobs.map((item) => item.id === job.id ? candidate : item);
  renderQueue();
  const persisted = await saveSettings();
  if (!persisted) {
    if (rollbackQueueResumePersistence(preparedResume)) {
      appendLog('Check and resume was not queued because the durable queue could not be saved.', 'error');
    }
    return;
  }
  if (!finishQueueResumePersistence(preparedResume)) return;
  appendLog(schedulingBlockedByExternalLifecycle
    ? `${explorerCore.queueJobDestinationLabel(job)} is saved and waiting for the active transfer lifecycle to finish.`
    : button.dataset.queueRecovery === 'retry'
      ? `Retrying ${explorerCore.queueJobDestinationLabel(job)} from a fresh pre-check.`
      : `Checking ${explorerCore.queueJobDestinationLabel(job)} before resuming.`);
  scheduleAutomaticQueue();
});
async function toggleConnectionsPanel(returnFocus) {
  const isConnectionsOpen = state.driveShell.view === 'connections';
  closeConnectionMenu();
  setViewMode('explorer');
  if (isConnectionsOpen) {
    await loadRemote(state.remotePrefix);
    returnFocus?.focus();
    return;
  }
  setDriveShellView('connections', { focus: true });
}

els.openConnections?.addEventListener('click', (event) => toggleConnectionsPanel(event.currentTarget));
els.connectionSwitcher?.addEventListener('click', toggleConnectionMenu);
els.connectionMenu?.addEventListener('click', async (event) => {
  const connectionButton = event.target.closest('[data-connection-id]');
  if (connectionButton) {
    await switchActiveConnection(connectionButton.dataset.connectionId);
    return;
  }
  if (event.target.closest('#addConnection')) openConnectionsView({ add: true });
  if (event.target.closest('#importConnection')) await importConnectionSettings(els.connectionSwitcher);
  if (event.target.closest('#manageConnections')) openConnectionsView();
});
els.connectionMenu?.addEventListener('keydown', (event) => {
  const buttons = connectionMenuButtons();
  const index = buttons.indexOf(document.activeElement);
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? buttons.length - 1
        : event.key === 'ArrowDown'
          ? (index + 1 + buttons.length) % buttons.length
          : (index - 1 + buttons.length) % buttons.length;
    buttons[nextIndex]?.focus();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    closeConnectionMenu({ restoreFocus: true });
  } else if (event.key === 'Tab') {
    closeConnectionMenu();
  }
});
document.addEventListener('pointerdown', (event) => {
  if (!els.connectionMenu.hidden && !event.target.closest('.connection-switcher-wrap')) {
    closeConnectionMenu();
  }
});
els.connectionsAddButton?.addEventListener('click', () => openConnectionsView({ add: true }));
els.connectionsImportButton?.addEventListener('click', async () => {
  await importConnectionSettings(els.connectionsImportButton);
});
els.connectionsList?.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-connection-action]');
  if (button) await handleConnectionAction(button.dataset.connectionAction, button.dataset.connectionId);
});
els.connectionExportIncludeKeys?.addEventListener('change', () => {
  els.connectionExportSecrets.hidden = !els.connectionExportIncludeKeys.checked;
  showConnectionPackageStatus(els.connectionExportStatus);
  if (!els.connectionExportIncludeKeys.checked) clearConnectionExportSecrets();
});
els.connectionExportForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  await submitConnectionExport();
});
els.connectionExportCancel?.addEventListener('click', closeConnectionExportDialog);
els.connectionExportClose?.addEventListener('click', closeConnectionExportDialog);
els.connectionExportDialog?.addEventListener('cancel', (event) => {
  event.preventDefault();
  closeConnectionExportDialog();
});
els.connectionImportUnlock?.addEventListener('click', unlockSelectedConnectionImport);
els.connectionImportForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  await saveSelectedConnectionImport();
});
els.connectionImportCancel?.addEventListener('click', closeConnectionImportDialog);
els.connectionImportClose?.addEventListener('click', closeConnectionImportDialog);
els.connectionImportDialog?.addEventListener('cancel', (event) => {
  event.preventDefault();
  closeConnectionImportDialog();
});
els.createAutomationKey?.addEventListener('click', () => createAutomationCredential());
els.createMcpConfiguration?.addEventListener('click', () => createAutomationCredential({ mcp: true }));
els.copyAutomationValue?.addEventListener('click', async () => {
  if (!els.automationOneTimeValue.value) return;
  await api.copyText(els.automationOneTimeValue.value);
  showConnectionPackageStatus(els.automationAccessNotice, 'Copied.');
});
els.dismissAutomationValue?.addEventListener('click', dismissAutomationOneTimeValue);
els.automationKeyList?.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-automation-revoke]');
  if (button) await revokeAutomationCredential(button.dataset.automationRevoke);
});
els.connectionNotice?.addEventListener('click', (event) => {
  if (!event.target.closest('#returnToUploads')) return;
  setDriveShellView('files');
  state.driveShell = driveShellCore.normalizeDriveShellState({ ...state.driveShell, queueDrawerOpen: true });
  renderTransferShelf();
  els.transferShelf?.focus?.();
});
bindFolderShortcutDrops();
els.pinCurrentFolder.addEventListener('click', () => pinPrefix(state.remotePrefix));

let newFolderReturnFocus = null;

function showNewFolderStatus(message = '', { error = false } = {}) {
  els.newFolderStatus.hidden = !message;
  els.newFolderStatus.textContent = message;
  els.newFolderStatus.classList.toggle('is-error', error);
}

function openNewFolderDialog(trigger) {
  newFolderReturnFocus = trigger || document.activeElement;
  els.newFolderName.value = '';
  els.newFolderDestination.textContent = `Inside ${explorerCore.queueJobDestinationLabel({
    prefix: state.remotePrefix,
    profile: state.profile,
  })}`;
  showNewFolderStatus();
  els.newFolderDialog.showModal();
  requestAnimationFrame(() => els.newFolderName.focus());
}

function closeNewFolderDialog() {
  if (els.newFolderDialog.open) els.newFolderDialog.close();
  const returnFocus = newFolderReturnFocus;
  newFolderReturnFocus = null;
  requestAnimationFrame(() => returnFocus?.focus());
}

async function submitNewFolder(event) {
  event.preventDefault();
  const folderName = explorerCore.normalizeNewFolderName(els.newFolderName.value);
  const placeholderPath = explorerCore.buildNewFolderPlaceholderPath({
    currentPrefix: state.remotePrefix,
    folderName,
  });
  const target = explorerCore.joinRemotePath(state.remotePrefix, folderName);
  if (!placeholderPath) {
    showNewFolderStatus('Enter a usable folder name.', { error: true });
    els.newFolderName.focus();
    return;
  }
  els.newFolderDialog.setAttribute('aria-busy', 'true');
  els.newFolderCreate.disabled = true;
  els.newFolderCancel.disabled = true;
  els.newFolderClose.disabled = true;
  showNewFolderStatus('Creating folder...');
  try {
    const result = await api.runRemoteOperation(withProfile({ action: 'mkdir', targetPrefix: placeholderPath }));
    if (result.ok) {
      appendLog(`Created folder ${target} using placeholder ${placeholderPath}`);
      closeNewFolderDialog();
      await loadRemote(state.remotePrefix);
      const visibleFolderPath = explorerCore.joinRemotePath(state.remotePrefix, folderName.split('/')[0]);
      const folderVisible = state.remoteEntries.some((entry) =>
        entry.isDir && (entry.path === target || entry.path === visibleFolderPath));
      if (!folderVisible) {
        appendLog(`Folder placeholder was created, but ${target} is not visible yet. Refresh or open ${placeholderPath}.`, 'error');
      }
    }
  } catch (error) {
    appendLog(`New folder failed: ${error.message}`, 'error');
    showNewFolderStatus(`Could not create the folder: ${error.message}`, { error: true });
  } finally {
    els.newFolderDialog.removeAttribute('aria-busy');
    els.newFolderCreate.disabled = false;
    els.newFolderCancel.disabled = false;
    els.newFolderClose.disabled = false;
  }
}

els.newRemoteFolder.addEventListener('click', (event) => openNewFolderDialog(event.currentTarget));
els.newFolderForm.addEventListener('submit', submitNewFolder);
els.newFolderCancel.addEventListener('click', closeNewFolderDialog);
els.newFolderClose.addEventListener('click', closeNewFolderDialog);
els.newFolderDialog.addEventListener('cancel', () => {
  const returnFocus = newFolderReturnFocus;
  newFolderReturnFocus = null;
  requestAnimationFrame(() => returnFocus?.focus());
});
els.goRemotePath.addEventListener('click', () => loadRemote(els.remotePath.value));
els.remotePath.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    loadRemote(els.remotePath.value);
  }
});
els.breadcrumbs.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-prefix]');
  if (button) {
    loadRemote(button.dataset.prefix);
  }
});
els.downloadRemoteItems?.addEventListener('click', () => downloadRemoteSelection());
els.inspectorDownload?.addEventListener('click', () => downloadRemoteSelection());
els.dialogDownload?.addEventListener('click', () => downloadRemoteSelection());
els.openImagePreview?.addEventListener('click', openImagePreviewDialog);
els.closeImagePreview?.addEventListener('click', closeImagePreviewDialog);
els.dismissImagePreview?.addEventListener('click', closeImagePreviewDialog);
els.imagePreviewDialog?.addEventListener('cancel', (event) => {
  event.preventDefault();
  closeImagePreviewDialog();
});
els.copyRemoteUrl.addEventListener('click', async () => {
  const urls = selectedRemoteItems()
    .filter((item) => !item.isDir && item.publicUrl)
    .map((item) => item.publicUrl);
  if (urls.length) {
    await api.copyUrls(urls);
    appendLog(`Copied ${urls.length} URL(s).`);
  }
});
els.copyInventory.addEventListener('click', async () => {
  const selectedFiles = selectedRemoteItems().filter((item) => !item.isDir);
  const files = selectedFiles.length
    ? selectedFiles
    : state.remoteEntries.filter((item) => !item.isDir);
  const report = explorerCore.formatInventoryReport({
    prefix: state.remotePrefix,
    entries: files,
  });
  await api.copyUrls([report]);
  appendLog(`Copied inventory report for ${files.length} file(s).`);
});
els.copyRemoteItem.addEventListener('click', async () => {
  const items = selectedRemoteItems();
  if (!items.length) return;
  const defaultTarget = items.length === 1
    ? items[0].path.replace(/(\.[^/.]+)?$/, '_copy$1')
    : state.remotePrefix;
  const target = window.prompt(
    items.length === 1 ? 'Copy to remote path:' : 'Copy selected into remote folder:',
    defaultTarget,
  );
  if (!target) return;
  if (items.length === 1) {
    const result = await api.runRemoteOperation(withProfile({ action: 'copy', item: items[0], targetPrefix: target }));
    if (result.ok) {
      appendLog(`Copied ${items[0].path} to ${target}`);
      await loadRemote();
    }
    return;
  }
  for (const item of items) {
    const targetPrefix = explorerCore.joinRemotePath(target, item.name);
    const result = await api.runRemoteOperation(withProfile({ action: 'copy', item, targetPrefix }));
    if (result.ok) {
      appendLog(`Copied ${item.path} to ${targetPrefix}`);
    }
  }
  await loadRemote();
});
els.moveRemoteItem.addEventListener('click', async () => {
  const items = selectedRemoteItems();
  if (!items.length) return;
  openMoveTray(state.remotePrefix);
});
els.closeMoveTray.addEventListener('click', closeMoveTray);
els.moveTargetButtons.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-prefix]');
  if (button) {
    els.moveTarget.value = button.dataset.prefix;
  }
});
els.moveIntoFolder.addEventListener('click', () => moveSelectedWithMode('folder'));
els.moveExact.addEventListener('click', () => moveSelectedWithMode('exact'));
els.moveTarget.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    moveSelectedWithMode(event.ctrlKey ? 'exact' : 'folder');
  }
});
els.deleteRemoteItem.addEventListener('click', async () => {
  const items = selectedRemoteItems();
  if (!items.length) return;
  for (const item of items) {
    const result = await api.runRemoteOperation(withProfile({ action: 'delete', item }));
    if (result.ok) {
      appendLog(`Deleted ${item.path}`);
    } else {
      appendLog(`Delete cancelled for ${item.path}.`);
    }
  }
  await loadRemote();
});
els.clearQueue.addEventListener('click', () => {
  clearCompletedQueueJobs();
});
els.clearLog.addEventListener('click', () => {
  els.log.textContent = '';
});
els.copyDiagnostics.addEventListener('click', async () => {
  const result = await api.copyDiagnostics(state.currentJobId);
  appendLog(result.ok ? 'Copied diagnostics log to clipboard.' : result.message, result.ok ? 'normal' : 'error');
});
els.openLogFolder.addEventListener('click', async () => {
  const result = await api.openLogFolder();
  if (!result.ok && result.message) {
    appendLog(result.message, 'error');
  }
});
els.checkActivity.addEventListener('click', () => checkActivity());
els.driveChooseFiles?.addEventListener('click', async () => addSources(await api.chooseFiles(), state.remotePrefix));
els.driveChooseFolder?.addEventListener('click', async () => addSources(await api.chooseFolder(), state.remotePrefix));
els.driveNewFolder?.addEventListener('click', (event) => openNewFolderDialog(event.currentTarget));
els.showExplorerView?.addEventListener('click', () => {
  const wasConnectionsOpen = state.driveShell.view === 'connections';
  setViewMode('explorer', { focus: true });
  if (wasConnectionsOpen) {
    loadRemote(state.remotePrefix);
  }
});
els.showActivityView?.addEventListener('click', async () => {
  setViewMode('activity');
  await loadHistory();
  els.activityTitle?.focus();
});
els.showAdvancedView?.addEventListener('click', () => setViewMode('advanced', { focus: true }));
els.openEventWorkspaceAdvanced?.addEventListener('click', chooseAndOpenEventWorkspace);
els.openEventManifest?.addEventListener('click', chooseAndOpenEventWorkspace);
els.addEventLocalRoot?.addEventListener('click', addEventLocalRoot);
els.runEventReconcile?.addEventListener('click', runEventReconcile);
els.queueEventMissing?.addEventListener('click', queueEventMissing);
els.refreshHistory.addEventListener('click', loadHistory);
els.refreshActivity?.addEventListener('click', loadHistory);
els.resumeHistory.addEventListener('click', resumeSelectedHistoryJob);
els.dryRun.addEventListener('click', runDryRun);
els.checkUploadSelected.addEventListener('click', checkAndUploadSelected);
els.dryRunSelected.addEventListener('click', runSelectedDryRun);
els.verify.addEventListener('click', removeSelectedQueueJob);
els.upload.addEventListener('click', runUpload);
els.uploadSelected.addEventListener('click', runSelectedUpload);
els.cancel.addEventListener('click', cancelActiveUpload);
els.copyUrls.addEventListener('click', async () => {
  await api.copyUrls(state.urls);
  appendLog('Copied URLs to clipboard.');
});
els.prefix.addEventListener('input', markInputsChanged);
els.filterMode.addEventListener('change', () => {
  els.include.disabled = els.filterMode.value !== 'custom';
  if (els.filterMode.value !== 'custom') {
    els.include.value = '';
  }
  markInputsChanged();
});
els.include.addEventListener('input', markInputsChanged);
els.folderUploadMode.addEventListener('change', markInputsChanged);
els.publicRead.addEventListener('change', markInputsChanged);
els.checksum.addEventListener('change', markInputsChanged);
els.notifyWebhook.addEventListener('input', markInputsChanged);
els.notifyNtfy.addEventListener('input', markInputsChanged);
els.notifyOn.addEventListener('change', markInputsChanged);
els.profileRemote.addEventListener('input', () => {
  updateProfileStatus();
});
els.profileBucket.addEventListener('input', () => {
  updateProfileStatus();
});
els.profileRegion.addEventListener('change', () => {
  els.profileEndpoint.value = DIGITALOCEAN_REGION_ENDPOINTS[els.profileRegion.value] || DIGITALOCEAN_REGION_ENDPOINTS.nyc3;
  updateProfileStatus();
});
els.profileEndpoint.addEventListener('input', () => {
  updateProfileStatus();
});
els.testProfile.addEventListener('click', () => addConnectionFromDraft({ createProfile: false }));
els.setupProfile.addEventListener('click', () => addConnectionFromDraft({ createProfile: true }));
els.archiveEvent.addEventListener('input', updateArchivePreview);
els.archiveCategory.addEventListener('change', updateArchivePreview);
els.archiveStage.addEventListener('input', updateArchivePreview);
els.archiveDay.addEventListener('input', updateArchivePreview);
els.archivePackageName.addEventListener('input', updateArchivePreview);
els.archiveSortRemoteItem.addEventListener('click', showArchiveSortForSelection);
els.moveSelectedToArchive.addEventListener('click', moveSelectedToArchive);
els.renameRemoteItem.addEventListener('click', async () => {
  const item = selectedRemoteItem();
  if (!item) return;
  const newName = window.prompt('Rename to:', item.name);
  if (newName) {
    await renameRemoteItem(item, newName);
  }
});
els.renameUploadedRoot.addEventListener('click', async () => {
  const root = state.uploadedRoots[0];
  if (!root?.rootPrefix) return;
  const newName = window.prompt('Rename uploaded folder to:', rootName(root.rootPrefix));
  if (!newName) return;
  const targetPrefix = explorerCore.joinRemotePath(parentPrefix(root.rootPrefix), newName);
  await moveUploadedRootTo(targetPrefix);
});
els.moveUploadedRoot.addEventListener('click', async () => {
  const root = state.uploadedRoots[0];
  if (!root?.rootPrefix) return;
  await moveUploadedRootTo(explorerCore.joinRemotePath(currentArchiveDestination(), rootName(root.rootPrefix)));
});

if (api.smokeMode) {
  window.murdawkUplinkSmoke = {
    seed({ jobs = [], activeJobId = '', activeTransfer = null, selectedJobId = '', progress = null, urls = [] } = {}) {
      smokeAutomaticQueueTrace = [];
      state.queueJobs = jobs.map((job) =>
        explorerCore.createQueueJob({
          id: job.id,
          sources: job.sources,
          settings: job.settings || job,
          status: job.status || 'queued',
          jobId: job.jobId || '',
          urls: job.urls || [],
          error: job.error || '',
          verification: job.verification || null,
        }));
      state.activeQueueJobId = activeJobId;
      state.activeTransfer = activeTransfer || {};
      state.activeProgress = {};
      state.selectedQueueJobId = selectedJobId || activeJobId || state.queueJobs[0]?.id || '';
      state.urls = urls;
      els.urls.value = urls.join('\n');
      els.copyUrls.disabled = urls.length === 0;
      renderQueue();
      updateTransferContext(progress || {});
      if (progress) {
        updateProgress(progress);
        state.activeTransfer = { ...state.activeTransfer, ...progress };
      }
      api.setActiveTransferMock?.(state.activeTransfer);
      updatePauseAllControl();
    },
    progress(progress = {}) {
      updateProgress(progress);
    },
    terminal(jobId, status) {
      setQueueJobStatus(jobId, status);
    },
    openEventWorkspace() {
      return chooseAndOpenEventWorkspace();
    },
    eventWorkspaceSnapshot() {
      return JSON.parse(JSON.stringify(state.eventWorkspace));
    },
    uploadEvent(channel, payload = {}) {
      handleUploadEvent(channel, payload);
    },
    dryRun(jobId) {
      const job = state.queueJobs.find((candidate) => candidate.id === jobId);
      return dryRunJobs(job ? [job] : [], 'the smoke queue job');
    },
    intake(paths = [], destinationPrefix = state.remotePrefix) {
      return addSources(paths, destinationPrefix);
    },
    setCurrentFolder(prefix = '') {
      state.remotePrefix = explorerCore.normalizeRemotePrefix(prefix);
      els.prefix.value = state.remotePrefix;
    },
    setProfile(profile = {}) {
      els.profileRemote.value = profile.remote || els.profileRemote.value;
      els.profileBucket.value = profile.bucket || els.profileBucket.value;
      els.profileEndpoint.value = profile.endpointHost || els.profileEndpoint.value;
    },
    switchConnection(connectionId) {
      return switchActiveConnection(connectionId);
    },
    renameConnection(connectionId, name) {
      return renameConnectionTo(connectionId, name);
    },
    removeConnection(connectionId) {
      const connection = state.connections.find((candidate) => candidate.id === connectionId);
      return connection ? removeConnectionDescriptor(connection) : Promise.resolve(false);
    },
    async connectionTransactionsSettled() {
      while (true) {
        const pending = settingsTransactionTail;
        await pending;
        if (pending === settingsTransactionTail) return;
      }
    },
    connectionSnapshot() {
      return JSON.parse(JSON.stringify({
        connections: state.connections,
        activeConnectionId: state.activeConnectionId,
        recentPrefixesByConnection: state.recentPrefixesByConnection,
        pinnedPrefixes: state.pinnedPrefixes,
        publicRead: els.publicRead.checked,
        checksum: els.checksum.value,
        remotePrefix: state.remotePrefix,
        mutationPending: connectionMutationPending,
      }));
    },
    eventIntake({ manifest = {}, candidates = [] } = {}) {
      state.eventWorkspace.manifest = { ...manifest };
      state.eventWorkspace.missingPlan = candidates.map((candidate) => ({ ...candidate }));
      return queueEventMissing();
    },
    automaticQueue() {
      return runAutomaticQueue();
    },
    pauseAll() {
      return pauseAllUploads();
    },
    cancel() {
      return cancelActiveUpload();
    },
    running(isRunning) {
      setRunning(Boolean(isRunning));
    },
    beforePauseClose(activeTransfer = state.activeTransfer) {
      return api.triggerBeforePauseClose?.({ requestId: 'mock-pause-close', activeTransfer });
    },
    automaticQueueSnapshot() {
      return {
        connectionMutationPending,
        connectionSwitchPending: Boolean(connectionSwitchPromise),
        schedulingBlockedByExternalLifecycle,
        automaticQueuePending,
        automaticQueueRunning,
        jobs: state.queueJobs.map((job) => ({
          id: job.id,
          status: job.status,
          prefix: job.prefix,
          sources: [...job.sources],
          connectionId: job.connectionId,
          profile: { ...job.profile },
          error: job.error,
        })),
        queueDrawerOpen: state.driveShell.queueDrawerOpen,
        shelfHidden: els.transferShelf.hidden,
        currentPrefix: state.remotePrefix,
        isRunning: state.isRunning,
        activeQueueJobId: state.activeQueueJobId,
        trace: smokeAutomaticQueueTrace,
      };
    },
    configureQueueMock(options = {}) {
      return api.configureQueueMock?.(options);
    },
    queueMockSnapshot() {
      return api.queueMockSnapshot?.() || { calls: [] };
    },
  };
}

(async function init() {
  setViewMode('explorer');
  if (els.driveSearch) {
    els.driveSearch.disabled = false;
    els.driveSearch.value = state.driveShell.search;
    els.driveSearch.title = '';
  }
  if (els.openQueueDrawer) {
    els.openQueueDrawer.disabled = false;
    els.openQueueDrawer.setAttribute('aria-controls', 'transferShelf');
  }
  if (els.openConnections) {
    els.openConnections.disabled = false;
    els.openConnections.setAttribute('aria-controls', 'connectionsPanel');
  }
  setDriveShellView(state.driveShell.view);
  updateQueueDrawerState();
  const [settingsResult, recoveryResult] = await Promise.allSettled([
    api.loadSettings(),
    readRecoverySnapshot(),
  ]);
  const settings = settingsResult.status === 'fulfilled' ? settingsResult.value : {
    settingsVersion: 2,
    connections: [],
    activeConnectionId: '',
    prefix: els.prefix.value,
    filterMode: els.filterMode.value,
    include: els.include.value,
    folderUploadMode: els.folderUploadMode.value,
    publicRead: els.publicRead.checked,
    checksum: els.checksum.value,
    notifyWebhook: '',
    notifyNtfy: '',
    notifyOn: els.notifyOn.value,
    profile: { remote: '', bucket: '', endpointHost: '' },
    recentPrefixes: [],
    recentPrefixesByConnection: {},
    pinnedPrefixes: [],
    archiveEvent: els.archiveEvent.value,
    archiveCategory: els.archiveCategory.value,
    archiveStage: els.archiveStage.value,
    archiveDay: els.archiveDay.value,
    archivePackageName: els.archivePackageName.value,
    queueJobs: [],
  };
  if (settingsResult.status === 'rejected') {
    appendLog(`Settings could not be loaded: ${settingsResult.reason?.message || settingsResult.reason}`, 'error');
  }
  queueRecoveryEnabled = recoveryResult.status === 'fulfilled';
  if (!queueRecoveryEnabled) {
    appendLog(`Queue recovery is disabled: ${recoveryResult.reason?.message || recoveryResult.reason}`, 'error');
  }
  state.remotePrefix = navigationCore.normalizePrefix(settings.prefix);
  els.prefix.value = state.remotePrefix;
  els.filterMode.value = settings.filterMode;
  els.include.value = settings.include;
  els.include.disabled = els.filterMode.value !== 'custom';
  els.folderUploadMode.value = settings.folderUploadMode;
  els.publicRead.checked = settings.publicRead;
  els.checksum.value = settings.checksum;
  els.notifyWebhook.value = settings.notifyWebhook;
  els.notifyNtfy.value = settings.notifyNtfy;
  els.notifyOn.value = settings.notifyOn;
  state.connections = Array.isArray(settings.connections) ? settings.connections : [];
  state.activeConnectionId = typeof settings.activeConnectionId === 'string'
    ? settings.activeConnectionId
    : '';
  const activeConnection = state.connections.find((connection) => connection.id === state.activeConnectionId);
  if (activeConnection) {
    state.activeConnectionName = activeConnection.name;
  } else {
    state.activeConnectionId = '';
    state.remotePrefix = '';
    els.prefix.value = '';
  }
  els.profileRemote.value = '';
  els.profileBucket.value = '';
  els.profileEndpoint.value = DIGITALOCEAN_REGION_ENDPOINTS.nyc3;
  els.profileRegion.value = 'nyc3';
  updateProfileStatus('Not connected');
  els.archiveEvent.value = settings.archiveEvent;
  els.archiveCategory.value = settings.archiveCategory;
  els.archiveStage.value = settings.archiveStage;
  els.archiveDay.value = settings.archiveDay;
  els.archivePackageName.value = settings.archivePackageName;
  state.recentPrefixesByConnection = settings.recentPrefixesByConnection
    && typeof settings.recentPrefixesByConnection === 'object'
    ? settings.recentPrefixesByConnection
    : {};
  if (!Object.hasOwn(state.recentPrefixesByConnection, state.activeConnectionId)) {
    state.recentPrefixesByConnection = (settings.recentPrefixes || []).reduceRight(
      (value, prefix) => navigationCore.recordRecentPrefix(value, state.activeConnectionId, prefix),
      state.recentPrefixesByConnection,
    );
  }
  state.pinnedPrefixes = activeConnection?.pinnedPrefixes || settings.pinnedPrefixes || [];
  state.queueJobs = hydrateQueueJobs(settings.queueJobs || [], state.connections);
  const recoveryPersisted = queueRecoveryEnabled
    ? await reconcileQueueFromJobRecords(recoveryResult.value)
    : false;
  updateConnectionChrome();
  updateArchivePreview();

  if (hasActiveConnection()) {
    try {
      const system = await api.checkSystem(currentProfile());
      els.health.textContent = `Ready: ${system.remote}:/${system.bucket}`;
      els.health.className = 'health is-ready';
    } catch (error) {
      els.health.textContent = error.message;
      els.health.className = 'health is-error';
      appendLog(error.message, 'error');
    }
  } else {
    els.health.textContent = 'Add a connection to begin';
    els.health.className = 'health';
  }

  renderQueue();
  await loadAutomationStatus();
  resetProgress('idle');
  await checkActivity({ quiet: true });
  setInterval(() => {
    checkActivity({ quiet: true });
  }, 5000);
  await loadHistory();
  await loadRemote(state.remotePrefix);
  if (recoveryPersisted) {
    automaticQueuePending = true;
    setTimeout(scheduleAutomaticQueue, 0);
  }
})();
