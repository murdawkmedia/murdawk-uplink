const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { app, BrowserWindow } = require('electron');

const rootDir = path.resolve(__dirname, '..', '..');
const appDir = path.resolve(__dirname, '..');
const outDir = path.join(rootDir, '.runs', 'ui-smoke');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function waitForSmokeHook(window) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const ready = await window.webContents.executeJavaScript('Boolean(window.murdawkUplinkSmoke)');
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Smoke hook did not initialize.');
}

async function waitForWindowCondition(window, expression, label, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const ready = await window.webContents.executeJavaScript(`Boolean(${expression})`);
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function waitForPaint(window) {
  await window.webContents.executeJavaScript(`
    new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  `);
}

function imageHash(image) {
  return createHash('sha256').update(image.toPNG()).digest('hex');
}

function imageHasContrast(image) {
  const bitmap = image.toBitmap();
  let darkest = 255;
  let lightest = 0;
  for (let offset = 0; offset < bitmap.length; offset += 4) {
    darkest = Math.min(darkest, bitmap[offset], bitmap[offset + 1], bitmap[offset + 2]);
    lightest = Math.max(lightest, bitmap[offset], bitmap[offset + 1], bitmap[offset + 2]);
  }
  return lightest - darkest >= 48;
}

async function ensureExplorerView(window) {
  await window.webContents.executeJavaScript("document.getElementById('showExplorerView')?.click()");
  await waitForWindowCondition(
    window,
    `!document.body.classList.contains('is-advanced-view') &&
      document.getElementById('connectionsPanel')?.hidden === true &&
      document.getElementById('eventWorkspacePanel')?.hidden === true &&
      getComputedStyle(document.querySelector('.explorer-section')).display !== 'none' &&
      document.activeElement?.id === 'explorerTitle'`,
    'the focused Explorer view',
  );
}

async function setShelfCollapsed(window, collapsed) {
  await window.webContents.executeJavaScript(`(() => {
    const shelf = document.getElementById('transferShelf');
    if (shelf && shelf.classList.contains('is-collapsed') !== ${Boolean(collapsed)}) {
      document.getElementById('transferShelfToggle')?.click();
    }
    window.scrollTo(0, 0);
  })()`);
  await waitForWindowCondition(
    window,
    `document.getElementById('transferShelf')?.classList.contains('is-collapsed') === ${Boolean(collapsed)}`,
    collapsed ? 'collapsed transfer shelf' : 'expanded transfer shelf',
  );
}

async function inspectShelfGeometry(window) {
  return window.webContents.executeJavaScript(`(() => {
    const shelf = document.getElementById('transferShelf');
    const shelfRect = shelf?.getBoundingClientRect();
    const isVisible = (element) => {
      if (!element || shelf?.contains(element)) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' &&
        rect.width > 0 && rect.height > 0;
    };
    const overlaps = (left, right) => Boolean(
      left && right &&
      Math.min(left.right, right.right) - Math.max(left.left, right.left) > 1 &&
      Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) > 1
    );
    const interactive = [...document.querySelectorAll(
      'button, input, select, textarea, [role="row"][tabindex], [tabindex="0"]'
    )].filter(isVisible);
    const regions = [...document.querySelectorAll(
      '.drive-topbar, .explorer-head, .path-row, .folder-rail, .remote-table, .drive-inspector'
    )].filter(isVisible);
    const targets = [...new Set([...interactive, ...regions])];
    const overlapTargets = targets
      .filter((element) => overlaps(shelfRect, element.getBoundingClientRect()))
      .map((element) => element.id || element.getAttribute('aria-label') || element.className || element.tagName);
    const visibleButtons = [...document.querySelectorAll('button')].filter((button) => {
      const style = getComputedStyle(button);
      const rect = button.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    });
    return {
      collapsed: shelf?.classList.contains('is-collapsed') === true,
      inline: shelf?.parentElement?.classList.contains('transfer-shelf-region') === true &&
        getComputedStyle(shelf).position === 'relative',
      overlapTargets,
      shelfInViewport: Boolean(
        shelfRect && shelfRect.left >= -1 && shelfRect.top >= -1 &&
        shelfRect.right <= document.documentElement.clientWidth + 1 &&
        shelfRect.bottom <= document.documentElement.clientHeight + 1
      ),
      shelfHeight: shelfRect?.height || 0,
      horizontalOverflow: document.body.scrollWidth > document.documentElement.clientWidth + 2,
      clippedButtons: visibleButtons
        .filter((button) => button.scrollWidth > button.clientWidth + 1 || button.scrollHeight > button.clientHeight + 1)
        .map((button) => button.id || button.textContent.trim()),
      rovingTabStops: document.querySelectorAll('.remote-row[tabindex="0"]').length,
    };
  })()`);
}

const adversarialJob = {
  id: "job-\"'><img data-shelf-attack=\"id\">",
  sources: ["C:/Hostile/<img data-shelf-attack=\"source\" onerror=\"window.shelfInjected=true\">.mov"],
  settings: {
    profile: {
      remote: 'media',
      bucket: 'media',
      endpointHost: 'media.nyc3.digitaloceanspaces.com',
    },
    prefix: "hostile/\"'><img data-shelf-attack=\"destination\">",
    filterMode: 'all',
    include: '',
    folderUploadMode: 'package',
    publicRead: true,
    checksum: 'size',
    notifyOn: 'success',
  },
  status: 'complete',
};

async function runScenario({ width, height, name }) {
  const window = new BrowserWindow({
    width,
    height,
    useContentSize: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, 'ui-smoke-preload.js'),
    },
  });

  await window.loadFile(path.join(appDir, 'src', 'renderer', 'index.html'), {
    query: { smoke: '1' },
  });
  await waitForSmokeHook(window);
  await window.webContents.executeJavaScript(`
    window.murdawkUplinkSmoke.seed({
      jobs: [
        {
          id: 'job-mix',
          sources: [
            'C:/Austria Mix/day-2/logs',
            'C:/Austria Mix/day-2/austria-main - 28 May 2026 - 01-08-26 PM - 00000.mp4'
          ],
          settings: {
            profile: {
              remote: 'media',
              bucket: 'media',
              endpointHost: 'media.nyc3.digitaloceanspaces.com'
            },
            prefix: 'archive-event/recordings/raw/stage1/day2/mix',
            filterMode: 'all',
            include: '',
            folderUploadMode: 'package',
            publicRead: true,
            checksum: 'size',
            notifyOn: 'success'
          },
          status: 'uploading'
        },
        {
          id: 'job-next',
          sources: ['C:/Austria Mix/c100 RAW-day 1/00003.MTS'],
          settings: {
            profile: {
              remote: 'media',
              bucket: 'media',
              endpointHost: 'media.nyc3.digitaloceanspaces.com'
            },
            prefix: 'archive-event/recordings/raw/stage1/day1/c100',
            filterMode: 'all',
            include: '',
            folderUploadMode: 'package',
            publicRead: true,
            checksum: 'size',
            notifyOn: 'success'
          },
          status: 'ready'
        },
        ${JSON.stringify(adversarialJob)}
      ],
      activeJobId: 'job-mix',
      activeTransfer: {
        isRunning: true,
        isLifecycleActive: true,
        activeJobId: 'mock-upload-job-mix',
        intentId: 'job-mix',
        phase: 'uploading',
        profile: {
          remote: 'media',
          bucket: 'media',
          endpointHost: 'media.nyc3.digitaloceanspaces.com'
        }
      },
      progress: {
        source: 'C:/Austria Mix/day-2/austria-main - 28 May 2026 - 01-08-26 PM - 00000.mp4',
        sourceIndex: 2,
        sourceTotal: 32,
        percent: 18,
        transferred: '94.062 MiB',
        total: '526.703 MiB',
        speed: '7.839 MiB/s',
        eta: '55s',
        diagnostics: {
          state: 'slow',
          isRunning: true,
          pid: 4242,
          mode: 'upload',
          currentFile: 'austria-main - 28 May 2026 - 01-08-26 PM - 00000.mp4',
          lastOutputAgeSeconds: 5,
          speed: {
            current: '7.8 MiB/s',
            rollingAverage: '7.4 MiB/s',
            peak: '12.1 MiB/s'
          },
          tuning: {
            transfers: 4,
            chunkSize: '64M',
            uploadConcurrency: 4
          },
          safeAction: 'Keep uploading; use this speed evidence to choose future tuning after verification completes.',
          recommendation: 'Observed speed is low for a sustained period.'
        }
      }
    });
  `);

  await waitForWindowCondition(window, "document.querySelectorAll('.remote-row').length > 0", 'remote rows');
  const driveShellBehavior = await window.webContents.executeJavaScript(`(() => {
    const labels = () => [...document.querySelectorAll('.remote-row .remote-label')].map((node) => node.textContent.trim());
    const driveSearch = document.getElementById('driveSearch');
    const queueButton = document.getElementById('openQueueDrawer');
    const transferShelf = document.getElementById('transferShelf');
    const shelfToggle = document.getElementById('transferShelfToggle');
    const remoteTable = document.getElementById('remoteTable');
    const searchEvent = new Event('input', { bubbles: true });
    const beforeSearchLabels = labels();
    const fileFormats = [...document.querySelectorAll('.remote-row .type-pill')].map((node) => node.textContent.trim());
    remoteTable.scrollTop = 80;

    driveSearch.value = 'range';
    driveSearch.dispatchEvent(searchEvent);
    const scrollAfterSearch = remoteTable.scrollTop;
    const rangeLabels = labels();
    const rangeRows = [...document.querySelectorAll('.remote-row')];
    rangeRows[0]?.click();
    rangeRows[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    const rangeSelectionSummary = document.getElementById('selectionSummary')?.textContent || '';
    const rangeSelectedLabels = [...document.querySelectorAll('.remote-row.is-selected .remote-label')].map((node) => node.textContent.trim());

    driveSearch.value = 'logs';
    driveSearch.dispatchEvent(searchEvent);
    const filteredLabels = labels();
    document.querySelector('.remote-row')?.click();
    const selectedAfterSearch = document.querySelector('.remote-row.is-selected .remote-label')?.textContent.trim() || '';

    driveSearch.value = '';
    driveSearch.dispatchEvent(searchEvent);
    const clearedLabels = labels();
    const selectedAfterClear = document.querySelector('.remote-row.is-selected .remote-label')?.textContent.trim() || '';
    const rowByLabel = (label) => [...document.querySelectorAll('.remote-row')]
      .find((row) => row.querySelector('.remote-label')?.textContent.trim() === label);
    rowByLabel('logs')?.click();
    rowByLabel('speaker-card.png')?.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    const downloadButton = document.getElementById('downloadRemoteItems');
    const mixedDownloadEnabled = Boolean(downloadButton && !downloadButton.disabled);
    rowByLabel('speaker-card.png')?.click();
    rowByLabel('logs')?.click();

    const nameSortBefore = document.querySelector('[data-sort-key="name"]')?.closest('[role="columnheader"]')?.getAttribute('aria-sort') || '';
    document.querySelector('[data-sort-key="size"]')?.click();
    const sizeSortAfterFirstClick = document.querySelector('[data-sort-key="size"]')?.closest('[role="columnheader"]')?.getAttribute('aria-sort') || '';
    document.querySelector('[data-sort-key="size"]')?.click();
    const sizeSortAfterSecondClick = document.querySelector('[data-sort-key="size"]')?.closest('[role="columnheader"]')?.getAttribute('aria-sort') || '';
    const labelsAfterSort = labels();
    const gridRole = remoteTable?.getAttribute('role') || '';
    const headerRows = [...remoteTable?.querySelectorAll('.remote-header[role="row"]') || []];
    const sortableHeaders = [...remoteTable?.querySelectorAll('[role="columnheader"]') || []];
    const gridRows = [...remoteTable?.querySelectorAll('.remote-row[role="row"]') || []];
    const firstRowCells = [...(gridRows[0]?.querySelectorAll('[role="gridcell"]') || [])];
    const activeSortableHeader = remoteTable?.querySelector('[role="columnheader"][aria-sort="descending"] [data-sort-key="size"].is-active');

    const shelfInitiallyExpanded = !transferShelf.hidden &&
      !transferShelf.classList.contains('is-collapsed') &&
      shelfToggle.getAttribute('aria-expanded') === 'true';
    shelfToggle.click();
    const shelfCollapsed = !transferShelf.hidden &&
      transferShelf.classList.contains('is-collapsed') &&
      shelfToggle.getAttribute('aria-expanded') === 'false';
    queueButton.click();
    const shelfReopened = !transferShelf.hidden &&
      !transferShelf.classList.contains('is-collapsed') &&
      queueButton.getAttribute('aria-expanded') === 'true';
    const shelfListVisibleWhenExpanded = window.getComputedStyle(document.getElementById('transferShelfList')).display !== 'none';

    return {
      beforeSearchLabels,
      fileFormats,
      scrollAfterSearch,
      rangeLabels,
      rangeSelectionSummary,
      rangeSelectedLabels,
      filteredLabels,
      clearedLabels,
      selectedAfterSearch,
      selectedAfterClear,
      nameSortBefore,
      sizeSortAfterFirstClick,
      sizeSortAfterSecondClick,
      labelsAfterSort,
      gridRole,
      headerRowCount: headerRows.length,
      sortableHeaderCount: sortableHeaders.length,
      gridRowCount: gridRows.length,
      firstRowCellCount: firstRowCells.length,
      hasActiveSortableHeader: Boolean(activeSortableHeader),
      stickyHeader: getComputedStyle(headerRows[0]).position === 'sticky',
      downloadControlExists: Boolean(downloadButton),
      mixedDownloadEnabled,
      inspectorPreviewExists: Boolean(document.getElementById('inspectorPreview')),
      largerPreviewDialogExists: Boolean(document.getElementById('imagePreviewDialog')),
      shelfInitiallyExpanded,
      shelfCollapsed,
      shelfReopened,
      shelfListVisibleWhenExpanded,
    };
  })()`);
  assert(driveShellBehavior.beforeSearchLabels.length >= 2, 'Remote fixture should render multiple rows before search.');
  assert(driveShellBehavior.fileFormats.includes('PNG'), 'PNG objects should render a PNG Type label.');
  assert(driveShellBehavior.fileFormats.includes('AVIF'), 'AVIF objects should render an AVIF Type label.');
  assert(driveShellBehavior.scrollAfterSearch === 0, 'Search should reset the remote list to the top.');
  assert(
    JSON.stringify(driveShellBehavior.rangeLabels) === JSON.stringify(['range-alpha.txt', 'range-omega.txt']),
    'Range search should show only the two range fixture rows.',
  );
  assert(driveShellBehavior.rangeSelectionSummary.includes('2 selected'), 'Shift range should select two visible rows.');
  assert(!driveShellBehavior.rangeSelectionSummary.includes('hidden-gap'), 'Shift range should not include hidden backing rows.');
  assert(
    JSON.stringify(driveShellBehavior.rangeSelectedLabels) === JSON.stringify(['range-alpha.txt', 'range-omega.txt']),
    'Shift range selection should mark only visible range rows.',
  );
  assert(driveShellBehavior.filteredLabels.length === 1, 'Drive search should filter the remote table to one row.');
  assert(driveShellBehavior.filteredLabels[0] === 'logs', 'Drive search should filter to the logs fixture row.');
  assert(driveShellBehavior.clearedLabels.length >= 2, 'Clearing Drive search should restore remote rows.');
  assert(driveShellBehavior.selectedAfterSearch === 'logs', 'Search result row should be selectable.');
  assert(driveShellBehavior.selectedAfterClear === 'logs', 'Clearing search should preserve selected item by path.');
  assert(driveShellBehavior.nameSortBefore === 'ascending', 'Name sort should start as active ascending.');
  assert(driveShellBehavior.sizeSortAfterFirstClick === 'ascending', 'Clicking Size should activate ascending size sort.');
  assert(driveShellBehavior.sizeSortAfterSecondClick === 'descending', 'Clicking Size again should toggle descending size sort.');
  assert(driveShellBehavior.gridRole === 'grid', 'Remote table should expose a coherent grid role.');
  assert(driveShellBehavior.headerRowCount === 1, 'Remote grid should expose one header row.');
  assert(driveShellBehavior.sortableHeaderCount === 4, 'Remote grid should expose four sortable column headers.');
  assert(driveShellBehavior.gridRowCount >= 2, 'Remote grid should expose data rows with row roles.');
  assert(driveShellBehavior.firstRowCellCount === 4, 'Remote grid rows should expose four grid cells.');
  assert(driveShellBehavior.hasActiveSortableHeader, 'Remote grid should expose the active sorted header state.');
  assert(driveShellBehavior.stickyHeader, 'Remote column headers should remain sticky while the list scrolls.');
  assert(driveShellBehavior.downloadControlExists, 'Explorer should expose a Download command.');
  assert(driveShellBehavior.mixedDownloadEnabled, 'Download should enable for a mixed file and folder selection.');
  assert(driveShellBehavior.inspectorPreviewExists, 'Inspector should expose an image preview region.');
  assert(driveShellBehavior.largerPreviewDialogExists, 'Explorer should include a larger image preview dialog.');
  assert(driveShellBehavior.shelfInitiallyExpanded, 'Relevant upload work should open the transfer shelf automatically.');
  assert(driveShellBehavior.shelfCollapsed, 'Transfer shelf collapse control should retain a compact visible shelf.');
  assert(driveShellBehavior.shelfReopened, 'Transfers top-bar control should reopen the transfer shelf.');
  assert(driveShellBehavior.shelfListVisibleWhenExpanded, 'Transfer shelf job list should be visible when expanded.');

  const keyboardBehavior = await window.webContents.executeJavaScript(`(() => {
    const rows = () => [...document.querySelectorAll('.remote-row')];
    const send = (row, key, options = {}) => row.dispatchEvent(new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      ...options,
    }));
    const initialPath = document.getElementById('remotePath').value;
    const initialRows = rows();
    const initialTabStops = initialRows.filter((row) => row.tabIndex === 0).length;
    initialRows[0].focus();
    send(initialRows[0], 'ArrowDown');
    const arrowFocus = document.activeElement?.querySelector('.remote-label')?.textContent.trim() || '';
    const arrowSelected = document.activeElement?.getAttribute('aria-selected') || '';
    const selectionBeforeCtrlMove = [...document.querySelectorAll('.remote-row[aria-selected="true"] .remote-label')]
      .map((label) => label.textContent.trim());
    send(document.activeElement, 'ArrowDown', { ctrlKey: true });
    const ctrlArrowFocus = document.activeElement?.querySelector('.remote-label')?.textContent.trim() || '';
    const selectionAfterCtrlMove = [...document.querySelectorAll('.remote-row[aria-selected="true"] .remote-label')]
      .map((label) => label.textContent.trim());
    send(document.activeElement, 'ArrowDown', { shiftKey: true });
    const shiftRangeCount = document.querySelectorAll('.remote-row[aria-selected="true"]').length;
    send(document.activeElement, 'End');
    const endFocus = document.activeElement?.querySelector('.remote-label')?.textContent.trim() || '';
    send(document.activeElement, 'Home');
    const homeRow = document.activeElement;
    const homeFocus = homeRow?.querySelector('.remote-label')?.textContent.trim() || '';
    send(homeRow, ' ');
    const spaceToggledOff = homeRow?.getAttribute('aria-selected') === 'false';
    send(homeRow, ' ');
    const spaceToggledOn = homeRow?.getAttribute('aria-selected') === 'true';

    const fileRow = rows().find((row) => row.classList.contains('remote-file'));
    fileRow?.focus();
    send(fileRow, 'Enter');
    const inspectedFile = document.getElementById('inspectorTitle')?.textContent || '';
    const fileLabel = fileRow?.querySelector('.remote-label')?.textContent.trim() || '';

    const folderRow = rows().find((row) => row.classList.contains('remote-folder'));
    const folderTarget = folderRow?.querySelector('.remote-name')?.title || '';
    folderRow?.focus();
    send(folderRow, 'Enter');
    return {
      initialPath,
      initialTabStops,
      arrowFocus,
      arrowSelected,
      ctrlArrowFocus,
      selectionBeforeCtrlMove,
      selectionAfterCtrlMove,
      shiftRangeCount,
      endFocus,
      homeFocus,
      spaceToggledOff,
      spaceToggledOn,
      inspectedFile,
      fileLabel,
      folderTarget,
      rowRolesCorrect: initialRows.every((row) =>
        row.getAttribute('role') === 'row' &&
        Boolean(row.getAttribute('aria-label')) &&
        row.querySelectorAll('[role="gridcell"]').length === 4),
    };
  })()`);
  assert(keyboardBehavior.initialTabStops === 1, 'Remote grid should expose exactly one roving tab stop.');
  assert(keyboardBehavior.arrowFocus && keyboardBehavior.arrowSelected === 'true', 'Arrow Down should move grid focus and selection.');
  assert(
    keyboardBehavior.ctrlArrowFocus &&
      JSON.stringify(keyboardBehavior.selectionAfterCtrlMove) === JSON.stringify(keyboardBehavior.selectionBeforeCtrlMove),
    'Ctrl+Arrow should move grid focus without replacing selection.',
  );
  assert(keyboardBehavior.shiftRangeCount >= 2, 'Shift+Arrow should extend the remote row selection.');
  assert(keyboardBehavior.endFocus, 'End should move focus to the final remote row.');
  assert(keyboardBehavior.homeFocus, 'Home should move focus to the first remote row.');
  assert(keyboardBehavior.spaceToggledOff && keyboardBehavior.spaceToggledOn, 'Space should toggle the focused row selection.');
  assert(keyboardBehavior.inspectedFile === keyboardBehavior.fileLabel, 'Enter should inspect the focused file.');
  assert(keyboardBehavior.rowRolesCorrect, 'Remote rows and cells need coherent ARIA roles and accessible row names.');
  await waitForWindowCondition(
    window,
    `document.getElementById('remotePath')?.value === ${JSON.stringify(keyboardBehavior.folderTarget)} &&
      document.querySelectorAll('.remote-row').length > 0 &&
      document.activeElement?.matches('.remote-row[tabindex="0"]') === true &&
      document.getElementById('remoteNavigationStatus')?.textContent.includes('loaded')`,
    'folder activation from the remote grid',
  );
  const keyboardFolderNavigation = await window.webContents.executeJavaScript(`(() => ({
    focusedRovingRow: document.activeElement?.matches('.remote-row[tabindex="0"]') === true,
    focusedRowLabel: document.activeElement?.querySelector('.remote-label')?.textContent.trim() || '',
    announcement: document.getElementById('remoteNavigationStatus')?.textContent.trim() || '',
  }))()`);
  assert(keyboardFolderNavigation.focusedRovingRow, 'Keyboard folder navigation should restore focus to the new grid roving row.');
  assert(keyboardFolderNavigation.focusedRowLabel, 'The focused row after keyboard folder navigation should have a readable label.');
  assert(
    keyboardFolderNavigation.announcement.includes('loaded'),
    'Keyboard folder navigation should announce the newly loaded remote folder.',
  );
  await window.webContents.executeJavaScript(`
    document.getElementById('remotePath').value = ${JSON.stringify(keyboardBehavior.initialPath)};
    document.getElementById('goRemotePath').click();
  `);
  await waitForWindowCondition(
    window,
    `document.getElementById('remotePath')?.value === ${JSON.stringify(keyboardBehavior.initialPath)} &&
      document.querySelectorAll('.remote-row').length > 0`,
    'restored remote folder after keyboard coverage',
  );
  const mouseFolderTarget = await window.webContents.executeJavaScript(`(() => {
    const focusSentinel = document.getElementById('openQueueDrawer');
    const folderRow = [...document.querySelectorAll('.remote-row')]
      .find((row) => row.classList.contains('remote-folder'));
    const target = folderRow?.querySelector('.remote-name')?.title || '';
    focusSentinel.focus();
    folderRow?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return target;
  })()`);
  await waitForWindowCondition(
    window,
    `document.getElementById('remotePath')?.value === ${JSON.stringify(mouseFolderTarget)} &&
      document.querySelectorAll('.remote-row').length > 0 &&
      document.activeElement?.id === 'openQueueDrawer'`,
    'mouse folder navigation without grid focus restoration',
  );
  await window.webContents.executeJavaScript(`
    document.getElementById('remotePath').value = ${JSON.stringify(keyboardBehavior.initialPath)};
    document.getElementById('goRemotePath').click();
  `);
  await waitForWindowCondition(
    window,
    `document.getElementById('remotePath')?.value === ${JSON.stringify(keyboardBehavior.initialPath)} &&
      document.querySelectorAll('.remote-row').length > 0`,
    'restored remote folder after mouse coverage',
  );
  await window.webContents.executeJavaScript(`(() => {
    const search = document.getElementById('driveSearch');
    search.value = 'logs';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.remote-row')?.click();
    search.value = '';
    search.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);

  const eventWorkspaceBehavior = await window.webContents.executeJavaScript(`(async () => {
    const waitFor = async (predicate, label) => {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        if (predicate()) return;
        await new Promise(requestAnimationFrame);
      }
      throw new Error('Timed out waiting for ' + label);
    };
    const smoke = window.murdawkUplinkSmoke;
    const hookExists = typeof smoke.openEventWorkspace === 'function';
    if (!hookExists) return { hookExists };

    smoke.configureQueueMock({ eventManifestResult: { ok: false, cancelled: true }, resetCalls: true });
    const cancelled = await smoke.openEventWorkspace() === false;

    smoke.configureQueueMock({
      eventManifestError: 'Mocked invalid manifest',
      resetCalls: true,
    });
    const invalidRejected = await smoke.openEventWorkspace() === false;
    const invalidMessage = document.getElementById('eventReconcileSummary')?.innerText || '';

    smoke.configureQueueMock({
      eventManifestError: '',
      eventManifestResult: {
        ok: true,
        label: 'sample-event.json',
        manifest: {
          client: 'Example Organization',
          eventName: 'sample-event',
          eventPrefix: 'sample-event',
          year: 2026,
          eventNumber: 1,
          remote: 'media',
          bucket: 'media-archive',
          endpointHost: 'media-archive.nyc3.digitaloceanspaces.com',
          recordingsPrefix: 'sample-event/recordings',
          stages: ['Main', 'Talk', 'Workshop'],
          days: ['Day 1', 'Day 2', 'Day 3'],
          localRoots: [],
          uploadDefaults: { publicRead: true, sizeOnly: true },
        },
      },
      resetCalls: true,
    });
    const opened = await smoke.openEventWorkspace();
    await waitFor(() => document.activeElement?.id === 'eventWorkspaceTitle', 'Event Workspace focus');
    const panel = document.getElementById('eventWorkspacePanel');
    const summary = document.getElementById('eventManifestSummary')?.innerText || '';
    const visible = panel && !panel.hidden && window.getComputedStyle(panel).display !== 'none';
    const openedInAdvanced = document.body.classList.contains('is-advanced-view');
    const focusTarget = document.activeElement?.id || '';
    const panelIsAdvancedOnly = panel?.classList.contains('advanced-only') === true;
    const manifestLabel = document.getElementById('eventWorkspacePreset')?.textContent || '';
    const stateSnapshot = smoke.eventWorkspaceSnapshot();
    const snapshotHasLocalPath = JSON.stringify(stateSnapshot).includes('C:\\\\');
    const pickerCalled = smoke.queueMockSnapshot().calls.some((call) => call.type === 'choose-event-manifest');
    document.getElementById('runEventReconcile')?.click();
    await waitFor(
      () => document.getElementById('eventReconcileSummary')?.innerText.includes('Choose local roots before reconcile.'),
      'no-roots reconcile state',
    );
    const noRootsMessage = document.getElementById('eventReconcileSummary')?.innerText || '';

    document.getElementById('showAdvancedView')?.click();
    await waitFor(() => document.activeElement?.id === 'advancedTitle', 'Advanced focus');
    const advancedWorkspace = document.querySelector('.workspace.advanced-only');
    const advancedVisible = advancedWorkspace && window.getComputedStyle(advancedWorkspace).display !== 'none';
    const workflowControlsRemain = ['openEventManifest', 'addEventLocalRoot', 'runEventReconcile', 'queueEventMissing']
      .every((id) => Boolean(document.getElementById(id)));
    const advancedEntryControl = Boolean(document.getElementById('openEventWorkspaceAdvanced'));
    const advancedFocusTarget = document.activeElement?.id || '';
    document.getElementById('showExplorerView')?.click();
    await waitFor(
      () => document.activeElement?.id === 'explorerTitle' && panel?.hidden === true,
      'Explorer focus after Event Workspace',
    );
    const hiddenAfterExplorer = panel?.hidden === true || window.getComputedStyle(panel).display === 'none';
    const explorerFocusTarget = document.activeElement?.id || '';

    return {
      hookExists, cancelled, invalidRejected, invalidMessage, opened,
      panelExists: Boolean(panel), visible, openedInAdvanced, focusTarget, panelIsAdvancedOnly,
      summary, manifestLabel, stateSnapshot, snapshotHasLocalPath, pickerCalled, noRootsMessage,
      advancedVisible, advancedEntryControl, advancedFocusTarget, hiddenAfterExplorer,
      explorerFocusTarget, workflowControlsRemain,
    };
  })()`);
  assert(eventWorkspaceBehavior.hookExists, 'Smoke harness should expose Event Workspace manifest loading.');
  assert(eventWorkspaceBehavior.cancelled, 'Cancelling the event manifest picker should leave the workspace unchanged.');
  assert(eventWorkspaceBehavior.invalidRejected && eventWorkspaceBehavior.invalidMessage.includes('failed to load'), 'Invalid event manifests should show a useful error.');
  assert(eventWorkspaceBehavior.opened && eventWorkspaceBehavior.panelExists && eventWorkspaceBehavior.visible, 'A selected event manifest should open Event Workspace.');
  assert(eventWorkspaceBehavior.openedInAdvanced, 'Event Workspace must open inside the Advanced top-level view.');
  assert(eventWorkspaceBehavior.focusTarget === 'eventWorkspaceTitle', 'Event Workspace should focus its visible heading.');
  assert(eventWorkspaceBehavior.panelIsAdvancedOnly, 'Event Workspace must be marked as Advanced-only UI.');
  assert(eventWorkspaceBehavior.summary.includes('Sample-event') && eventWorkspaceBehavior.summary.includes('2026 E1'), 'The selected manifest summary should show the fictional sample event.');
  assert(eventWorkspaceBehavior.manifestLabel === 'sample-event.json', 'Event Workspace should show the selected manifest filename.');
  assert(eventWorkspaceBehavior.stateSnapshot.manifest.eventPrefix === 'sample-event', 'Event Workspace should retain the normalized selected manifest.');
  assert(!eventWorkspaceBehavior.snapshotHasLocalPath, 'Event Workspace state must not retain the manifest path.');
  assert(eventWorkspaceBehavior.pickerCalled, 'Event Workspace should use the native manifest picker.');
  assert(eventWorkspaceBehavior.noRootsMessage.includes('Choose local roots before reconcile.'), 'Event reconcile without local roots should show a friendly message.');
  assert(eventWorkspaceBehavior.advancedVisible && eventWorkspaceBehavior.advancedEntryControl, 'Advanced needs a visible Event Workspace manifest action.');
  assert(eventWorkspaceBehavior.advancedFocusTarget === 'advancedTitle', 'Advanced should focus its visible view heading.');
  assert(eventWorkspaceBehavior.hiddenAfterExplorer, 'Returning to Explorer must hide Event Workspace.');
  assert(eventWorkspaceBehavior.explorerFocusTarget === 'explorerTitle', 'Explorer should focus its visible view heading.');
  assert(eventWorkspaceBehavior.workflowControlsRemain, 'Event Workspace controls should remain regression-tested in the DOM.');

  await ensureExplorerView(window);
  await setShelfCollapsed(window, false);
  const expandedExplorerGeometry = await inspectShelfGeometry(window);
  await setShelfCollapsed(window, true);
  const collapsedExplorerGeometry = await inspectShelfGeometry(window);
  await setShelfCollapsed(window, false);
  for (const [stateName, geometry] of [
    ['expanded', expandedExplorerGeometry],
    ['collapsed', collapsedExplorerGeometry],
  ]) {
    assert(geometry.inline, `The ${stateName} transfer shelf should reserve inline app space at ${width}px.`);
    assert(geometry.overlapTargets.length === 0, `The ${stateName} transfer shelf overlaps visible controls at ${width}px: ${geometry.overlapTargets.join(', ')}`);
    assert(geometry.shelfInViewport, `The ${stateName} transfer shelf should remain in the ${width}px viewport.`);
    assert(!geometry.horizontalOverflow, `The ${stateName} transfer shelf should not cause horizontal overflow at ${width}px.`);
    assert(geometry.clippedButtons.length === 0, `Visible button labels should fit at ${width}px: ${geometry.clippedButtons.join(', ')}`);
    assert(geometry.rovingTabStops === 1, 'Remote grid should retain one tab stop through shelf state changes.');
  }
  assert(expandedExplorerGeometry.shelfHeight >= 175 && expandedExplorerGeometry.shelfHeight <= 195, 'Expanded shelf should keep a stable bounded height.');
  assert(collapsedExplorerGeometry.shelfHeight >= 47 && collapsedExplorerGeometry.shelfHeight <= 49, 'Collapsed shelf should keep a stable 48px height.');

  const checks = await window.webContents.executeJavaScript(`(() => {
    window.scrollTo(0, 0);
    const text = document.body.innerText;
    const rawText = document.body.textContent;
    const destination = document.querySelector('.remote-target')?.textContent || '';
    const publicUrls = document.getElementById('urls')?.placeholder || '';
    const activeDestination = document.getElementById('activeDestination')?.textContent || '';
    const activeSource = document.getElementById('activeSource')?.textContent || '';
    const nextJob = document.getElementById('nextJob')?.textContent || '';
    const diagnosticMetrics = document.getElementById('diagnosticMetrics')?.textContent || '';
    const diagnosticTuning = document.getElementById('diagnosticTuning')?.textContent || '';
    const diagnosticAction = document.getElementById('diagnosticAction')?.textContent || '';
    const diagnosticRecommendation = document.getElementById('diagnosticRecommendation')?.textContent || '';
    const profileStatus = document.getElementById('profileStatus')?.textContent || '';
    const history = document.getElementById('historyTable')?.innerText || '';
    const historyRows = [...document.querySelectorAll('.history-row')].map((row) => row.innerText);
    const selectedRemoteText = document.querySelector('.remote-row.is-selected')?.innerText || '';
    const selectionSummary = document.getElementById('selectionSummary')?.textContent || '';
    const inspectorTitle = document.getElementById('inspectorTitle')?.textContent || '';
    const inspectorSubtitle = document.getElementById('inspectorSubtitle')?.textContent || '';
    const inspectorKind = document.getElementById('inspectorKind')?.textContent || '';
    const inspectorDetail = document.getElementById('inspectorDetail')?.textContent || '';
    const advancedDom = document.querySelector('.credential-setup')?.textContent || '';
    const connectionsText = document.getElementById('connectionsPanel')?.textContent || '';
    const railTitles = [...document.querySelectorAll('.rail-title')].map((title) => title.textContent.trim());
    const rootFolderLabels = [...document.querySelectorAll('#rootFolders .folder-shortcut')]
      .map((button) => button.textContent.trim());
    const recentFolderPrefixes = [...document.querySelectorAll('#recentFolders .folder-shortcut')]
      .map((button) => button.dataset.prefix || '');
    const driveTopbar = document.querySelector('.drive-topbar');
    const explorerSection = document.querySelector('.explorer-section');
    const driveInspector = document.querySelector('.drive-inspector');
    const queueDrawer = document.getElementById('queueDrawer');
    const progressSection = document.querySelector('.progress-section');
    const transferShelf = document.getElementById('transferShelf');
    const shelfList = document.getElementById('transferShelfList');
    const shelfPauseAll = document.getElementById('transferShelfPauseAll');
    const shelfPauseAllHelp = document.getElementById('transferShelfPauseAllHelp');
    const shelfToggle = document.getElementById('transferShelfToggle');
    const remotePane = document.querySelector('.remote-pane');
    const remoteTable = document.getElementById('remoteTable');
    const selectedRemoteName = document.querySelector('.remote-row.is-selected .remote-name');
    const selectedRemoteLabel = document.querySelector('.remote-row.is-selected .remote-label');
    const driveTopbarStyle = driveTopbar ? window.getComputedStyle(driveTopbar) : null;
    const explorerSectionStyle = explorerSection ? window.getComputedStyle(explorerSection) : null;
    const driveInspectorStyle = driveInspector ? window.getComputedStyle(driveInspector) : null;
    const queueDrawerStyle = queueDrawer ? window.getComputedStyle(queueDrawer) : null;
    const progressSectionStyle = progressSection ? window.getComputedStyle(progressSection) : null;
    const transferShelfStyle = transferShelf ? window.getComputedStyle(transferShelf) : null;
    const shelfListStyle = shelfList ? window.getComputedStyle(shelfList) : null;
    const remotePaneStyle = remotePane ? window.getComputedStyle(remotePane) : null;
    const driveTopbarRect = driveTopbar?.getBoundingClientRect();
    const explorerSectionRect = explorerSection?.getBoundingClientRect();
    const driveInspectorRect = driveInspector?.getBoundingClientRect();
    const queueDrawerRect = queueDrawer?.getBoundingClientRect();
    const transferShelfRect = transferShelf?.getBoundingClientRect();
    const shelfPauseAllRect = shelfPauseAll?.getBoundingClientRect();
    const shelfToggleRect = shelfToggle?.getBoundingClientRect();
    const remoteTableRect = remoteTable?.getBoundingClientRect();
    const selectedRemoteNameRect = selectedRemoteName?.getBoundingClientRect();
    const selectedRemoteLabelRect = selectedRemoteLabel?.getBoundingClientRect();
    const advancedTab = document.getElementById('showAdvancedView');
    const explorerTab = document.getElementById('showExplorerView');
    const standaloneDropZone = document.getElementById('dropZone');
    const driveChooseFiles = document.getElementById('driveChooseFiles');
    const driveChooseFolder = document.getElementById('driveChooseFolder');
    const isVisibleBox = (element, style, rect) => Boolean(
      element &&
        style?.display !== 'none' &&
        style?.visibility !== 'hidden' &&
        style?.opacity !== '0' &&
        rect &&
        rect.width > 0 &&
        rect.height > 0
    );
    const isInViewport = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        isVisibleBox(element, style, rect) &&
        rect.left >= -1 &&
        rect.top >= -1 &&
        rect.right <= document.documentElement.clientWidth + 1 &&
        rect.bottom <= document.documentElement.clientHeight + 1
      );
    };
    const isVisible = (element) => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return isVisibleBox(element, style, rect);
    };
    const visibleControlLabelsFit = [...document.querySelectorAll('button')]
      .filter(isVisible)
      .every((button) => button.scrollWidth <= button.clientWidth + 1 && button.scrollHeight <= button.clientHeight + 1);
    const siblingsDoNotOverlap = (parent) => {
      const boxes = [...(parent?.children || [])]
        .filter(isVisible)
        .map((element) => element.getBoundingClientRect());
      return boxes.every((box, index) => boxes.slice(index + 1).every((other) => {
        const horizontal = Math.min(box.right, other.right) - Math.max(box.left, other.left);
        const vertical = Math.min(box.bottom, other.bottom) - Math.max(box.top, other.top);
        return horizontal <= 1 || vertical <= 1;
      }));
    };
    const rectsOverlap = (left, right) => Boolean(
      left &&
        right &&
        Math.min(left.right, right.right) - Math.max(left.left, right.left) > 1 &&
        Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) > 1
    );
    const visibleExplorerCommandRects = [...document.querySelectorAll('.explorer-actions button')]
      .filter(isVisible)
      .map((button) => button.getBoundingClientRect());
    const driveShellSelectors = {
      driveTopbar: Boolean(driveTopbar),
      driveTopbarVisible: isVisibleBox(driveTopbar, driveTopbarStyle, driveTopbarRect),
      driveTopbarSpansShell: Boolean(driveTopbarRect && driveTopbarRect.width >= window.innerWidth * 0.9),
      driveSearch: Boolean(document.getElementById('driveSearch')),
      openQueueDrawer: Boolean(document.getElementById('openQueueDrawer')),
      openConnections: Boolean(document.getElementById('openConnections')),
      driveProfileLabel: Boolean(document.getElementById('driveProfileLabel')),
      driveInspector: Boolean(driveInspector),
      driveInspectorVisible: isVisibleBox(driveInspector, driveInspectorStyle, driveInspectorRect),
      driveInspectorReadableWidth: Boolean(driveInspectorRect && driveInspectorRect.width >= 220),
      queueDrawer: Boolean(queueDrawer),
      queueDrawerHiddenInExplorer: queueDrawerStyle?.display === 'none',
      diagnosticsHiddenInExplorer: progressSectionStyle?.display === 'none',
      explorerUsesFullShellWidth: Boolean(explorerSectionRect && driveTopbarRect && explorerSectionRect.width >= driveTopbarRect.width - 2),
      transferShelf: Boolean(transferShelf),
      transferShelfVisible: isVisibleBox(transferShelf, transferShelfStyle, transferShelfRect),
      transferShelfExpanded: transferShelf?.classList.contains('is-collapsed') === false,
      transferShelfInViewport: Boolean(
        transferShelfRect &&
          transferShelfRect.left >= -1 &&
          transferShelfRect.right <= document.documentElement.clientWidth + 1 &&
          transferShelfRect.bottom <= document.documentElement.clientHeight + 1
      ),
      transferShelfConstrained: Boolean(transferShelfRect && transferShelfRect.height <= Math.min(window.innerHeight * 0.7, 680) + 1),
      shelfListScrollable: shelfListStyle?.overflowY === 'auto',
      shelfControlsInBounds: [shelfPauseAllRect, shelfToggleRect].every((rect) =>
        rect && transferShelfRect && rect.left >= transferShelfRect.left && rect.right <= transferShelfRect.right),
      shelfPauseAllDisabled: shelfPauseAll?.disabled === true,
      shelfPauseAllEnabled: shelfPauseAll?.disabled === false,
      shelfPauseAllDescribedBy: shelfPauseAll?.getAttribute('aria-describedby') || '',
      shelfPauseAllHelpText: shelfPauseAllHelp?.textContent.trim() || '',
      shelfPauseAllHelpPersisted: Boolean(
        shelfPauseAllHelp &&
          window.getComputedStyle(shelfPauseAllHelp).display !== 'none' &&
          window.getComputedStyle(shelfPauseAllHelp).visibility !== 'hidden'
      ),
      shelfToggleNamed: shelfToggle?.getAttribute('aria-label') === 'Collapse transfers' && Boolean(shelfToggle?.title),
      shelfText: transferShelf?.innerText || '',
      shelfProgress: transferShelf?.querySelector('.transfer-shelf-meter')?.getAttribute('aria-valuenow') || '',
      hostileIdPreserved: document.querySelectorAll('[data-shelf-job-id]')[2]?.dataset.shelfJobId || '',
      hostileText: document.querySelectorAll('[data-shelf-job-id]')[2]?.textContent || '',
      hostileElementCount: transferShelf?.querySelectorAll('[data-shelf-attack], script').length || 0,
      hostileAttributeCount: [...(transferShelf?.querySelectorAll('*') || [])].filter((element) =>
        [...element.attributes].some((attribute) => /^on/i.test(attribute.name))).length,
      driveSearchDisabled: document.getElementById('driveSearch')?.disabled === true,
      openQueueDrawerDisabled: document.getElementById('openQueueDrawer')?.disabled === true,
      openConnectionsDisabled: document.getElementById('openConnections')?.disabled === true,
      driveSearchInViewport: isInViewport('#driveSearch'),
      openQueueDrawerInViewport: isInViewport('#openQueueDrawer'),
      openConnectionsInViewport: isInViewport('#openConnections'),
      driveProfileLabelInViewport: isInViewport('#driveProfileLabel'),
      selectedRemoteNameReadable: Boolean(
        selectedRemoteNameRect &&
          selectedRemoteNameRect.width >= 120 &&
          selectedRemoteNameRect.height > 0 &&
          selectedRemoteNameRect.left >= -1 &&
          selectedRemoteNameRect.right <= document.documentElement.clientWidth + 1
      ),
      selectedRemoteLabelVisible: Boolean(
        selectedRemoteLabel &&
          selectedRemoteLabel.textContent.trim() === 'logs' &&
          selectedRemoteLabelRect &&
          selectedRemoteLabelRect.width >= 28 &&
          selectedRemoteLabelRect.height > 0
      ),
      selectedRemoteNameWidth: selectedRemoteNameRect?.width || 0,
      selectedRemoteLabelWidth: selectedRemoteLabelRect?.width || 0,
      remotePaneColumns: remotePaneStyle?.gridTemplateColumns || '',
      remoteTableWidth: remoteTableRect?.width || 0,
      rootFolderLabels,
      recentFolderPrefixes,
      normalExplorerText: explorerSection?.innerText || '',
      folderRailText: document.querySelector('.folder-rail')?.innerText || '',
      advancedIsTopLevelView: advancedTab?.closest('nav')?.getAttribute('aria-label') === 'Primary views',
      explorerIsCurrentView: explorerTab?.getAttribute('aria-current') === 'page',
      standaloneDropZoneAbsent: standaloneDropZone === null,
      remotePaneIsDropTarget: remotePane?.dataset.dropTarget === 'current-folder' && Boolean(remotePane?.getAttribute('aria-label')),
      uploadFilesKeyboardAccessible: driveChooseFiles?.tagName === 'BUTTON' && driveChooseFiles.tabIndex === 0 && driveChooseFiles.getAttribute('aria-describedby') === 'remoteDropHint',
      uploadFolderKeyboardAccessible: driveChooseFolder?.tagName === 'BUTTON' && driveChooseFolder.tabIndex === 0 && driveChooseFolder.getAttribute('aria-describedby') === 'remoteDropHint',
      shelfPauseUsesNamedIcon: shelfPauseAll?.classList.contains('icon-button') === true && Boolean(shelfPauseAll?.title) && Boolean(shelfPauseAll?.getAttribute('aria-label')),
      shelfToggleUsesNamedIcon: shelfToggle?.classList.contains('icon-button') === true && Boolean(shelfToggle?.title) && Boolean(shelfToggle?.getAttribute('aria-label')),
      visibleControlLabelsFit,
      topbarControlsDoNotOverlap: siblingsDoNotOverlap(driveTopbar),
      shelfControlsDoNotOverlap: siblingsDoNotOverlap(transferShelf?.querySelector('.transfer-shelf-head')),
      shelfAvoidsTopbar: !rectsOverlap(transferShelfRect, driveTopbarRect),
      shelfAvoidsExplorerCommands: visibleExplorerCommandRects.every((rect) => !rectsOverlap(transferShelfRect, rect)),
      mobileExpandedShelfIsInline: transferShelf?.parentElement?.classList.contains('transfer-shelf-region') === true && transferShelfStyle?.position === 'relative',
      mobileExpandedShelfIsFullWidth: Boolean(
        transferShelfRect && driveTopbarRect && transferShelfRect.width >= driveTopbarRect.width - 2
      ),
      mobileExpandedShelfHasStableHeight: Boolean(
        transferShelfRect && transferShelfRect.height >= 175 && transferShelfRect.height <= 195
      ),
      mobileExpandedShelfHasNoHorizontalOverflow: Boolean(
        transferShelf && transferShelf.scrollWidth <= transferShelf.clientWidth + 1
      ),
      mobileShelfHeaderTextFits: [
        transferShelf?.querySelector('.transfer-shelf-heading h2'),
        transferShelf?.querySelector('.transfer-shelf-heading span'),
      ].every((element) => element && element.scrollWidth <= element.clientWidth + 1),
    };
    const bodyOverflow = document.body.scrollWidth > document.documentElement.clientWidth + 2;
    return { text, rawText, destination, publicUrls, activeDestination, activeSource, nextJob, diagnosticMetrics, diagnosticTuning, diagnosticAction, diagnosticRecommendation, profileStatus, history, historyRows, selectedRemoteText, selectionSummary, inspectorTitle, inspectorSubtitle, inspectorKind, inspectorDetail, advancedDom, connectionsText, railTitles, driveShellSelectors, bodyOverflow };
  })()`);

  assert(checks.rawText.includes('Space root'), 'Drive-first Space root navigation is missing.');
  assert(checks.rawText.includes('Murdawk Uplink'), 'Drive shell title is missing.');
  assert(checks.rawText.includes('Search Spaces'), 'Drive shell search label is missing.');
  assert(checks.rawText.includes('Inspector'), 'Drive shell inspector is missing.');
  assert(checks.rawText.includes('Transfer Queue'), 'Drive shell transfer queue title is missing.');
  assert(checks.rawText.includes('Connections'), 'Drive shell connections control is missing.');
  assert(checks.rawText.includes('Space folders'), 'Drive shell Space folders label is missing.');
  assert(checks.driveShellSelectors.driveTopbar, 'Drive shell topbar selector is missing.');
  assert(checks.driveShellSelectors.driveTopbarVisible, 'Drive shell topbar should be visible.');
  assert(checks.driveShellSelectors.driveTopbarSpansShell, 'Drive shell topbar should span the app shell.');
  assert(checks.driveShellSelectors.driveSearch, 'Drive shell search input selector is missing.');
  assert(checks.driveShellSelectors.openQueueDrawer, 'Drive shell queue drawer control selector is missing.');
  assert(checks.driveShellSelectors.openConnections, 'Drive shell connections control selector is missing.');
  assert(checks.driveShellSelectors.driveProfileLabel, 'Drive shell profile label selector is missing.');
  assert(checks.driveShellSelectors.driveSearchInViewport, 'Drive shell search should be visible within the viewport.');
  assert(checks.driveShellSelectors.openQueueDrawerInViewport, 'Drive shell queue control should be visible within the viewport.');
  assert(checks.driveShellSelectors.openConnectionsInViewport, 'Drive shell connections control should be visible within the viewport.');
  assert(checks.driveShellSelectors.driveProfileLabelInViewport, 'Drive shell profile label should be visible within the viewport.');
  assert(checks.driveShellSelectors.driveInspector, 'Drive shell inspector selector is missing.');
  assert(checks.driveShellSelectors.driveInspectorVisible, 'Drive shell inspector should be visible in this skeleton slice.');
  assert(checks.driveShellSelectors.driveInspectorReadableWidth, 'Drive shell inspector should have readable width.');
  assert(checks.driveShellSelectors.queueDrawer, 'Advanced transfer queue selector is missing.');
  assert(checks.driveShellSelectors.queueDrawerHiddenInExplorer, 'Advanced transfer queue should not create a permanent Explorer column.');
  assert(checks.driveShellSelectors.diagnosticsHiddenInExplorer, 'Transfer diagnostics should not create a permanent Explorer column.');
  assert(checks.driveShellSelectors.explorerUsesFullShellWidth, 'Explorer should use the width released by the diagnostics column.');
  assert(checks.driveShellSelectors.transferShelf, 'Transfer shelf selector is missing.');
  assert(checks.driveShellSelectors.transferShelfVisible, 'Active transfer shelf should be visible.');
  assert(checks.driveShellSelectors.transferShelfExpanded, 'Active transfer shelf should be expanded for the desktop scenario.');
  assert(checks.driveShellSelectors.transferShelfInViewport, 'Transfer shelf should stay inside the viewport.');
  assert(checks.driveShellSelectors.transferShelfConstrained, 'Transfer shelf should respect its stable maximum height.');
  assert(checks.driveShellSelectors.shelfListScrollable, 'Transfer shelf item list should scroll independently.');
  assert(checks.driveShellSelectors.shelfControlsInBounds, 'Transfer shelf controls should stay inside the shelf.');
  assert(checks.driveShellSelectors.shelfPauseAllEnabled, 'Pause All should be enabled for this window-owned uploading lifecycle.');
  assert(
    checks.driveShellSelectors.shelfPauseAllDescribedBy === 'transferShelfPauseAllHelp',
    'Disabled Pause All should reference persistent explanatory text with aria-describedby.',
  );
  assert(
    checks.driveShellSelectors.shelfPauseAllHelpPersisted &&
      checks.driveShellSelectors.shelfPauseAllHelpText === 'Pause active transfer',
    'Enabled Pause All should expose its status to assistive technology.',
  );
  assert(checks.driveShellSelectors.shelfToggleNamed, 'Transfer shelf collapse control needs an accessible name and tooltip.');
  assert(checks.driveShellSelectors.shelfText.includes('Uploading'), 'Transfer shelf should show a text upload status.');
  assert(checks.driveShellSelectors.shelfText.includes('Queue 1 of 1'), 'Transfer shelf should show waiting queue position.');
  assert(checks.driveShellSelectors.shelfText.includes('2 job sources'), 'Transfer shelf should show source count detail.');
  assert(checks.driveShellSelectors.shelfProgress === '18', 'Transfer shelf should expose active progress.');
  assert(
    checks.driveShellSelectors.hostileIdPreserved === 'job-\"\'><img data-shelf-attack=\"id\">',
    'Transfer shelf should preserve an adversarial job ID as inert attribute text.',
  );
  assert(
    checks.driveShellSelectors.hostileText.includes('<img data-shelf-attack=\"source\" onerror=\"window.shelfInjected=true\">.mov') &&
      checks.driveShellSelectors.hostileText.includes('hostile/\"\'><img data-shelf-attack=\"destination\">'),
    'Transfer shelf should render adversarial source and destination values as exact text.',
  );
  assert(checks.driveShellSelectors.hostileElementCount === 0, 'Transfer shelf values must not inject elements or data attributes.');
  assert(checks.driveShellSelectors.hostileAttributeCount === 0, 'Transfer shelf values must not inject event-handler attributes.');
  assert(!checks.driveShellSelectors.driveSearchDisabled, 'Drive shell search should be enabled.');
  assert(!checks.driveShellSelectors.openQueueDrawerDisabled, 'Drive shell queue drawer control should be enabled.');
  assert(!checks.driveShellSelectors.openConnectionsDisabled, 'Drive shell connections control should be enabled.');
  assert(checks.rawText.includes('Upload files'), 'Drive-first file upload action is missing.');
  assert(checks.rawText.includes('Upload folder'), 'Drive-first folder upload action is missing.');
  assert(checks.rawText.includes('Advanced'), 'Advanced view entry is missing.');
  assert(checks.railTitles.includes('Space folders'), 'Space folders rail section is missing.');
  assert(checks.driveShellSelectors.rootFolderLabels.includes('Long Production Archive Folder'), 'Explorer should show actual root Space folders.');
  assert(
    checks.driveShellSelectors.recentFolderPrefixes.includes('archive-event/recordings/raw/stage1/day2/mix') &&
      !checks.driveShellSelectors.recentFolderPrefixes.includes('other-connection/private-recent'),
    'Explorer recents should be visible and scoped to the active connection.',
  );
  assert(!checks.driveShellSelectors.folderRailText.includes('Event Workspace'), 'Normal Explorer rail must not show Event Workspace shortcuts.');
  assert(!checks.driveShellSelectors.folderRailText.includes('Archive Presets'), 'Normal Explorer rail must not show archive presets.');
  assert(!checks.driveShellSelectors.folderRailText.includes('Sample Event'), 'Normal Explorer rail must not show hard-coded event presets.');
  assert(!checks.text.includes('Event Workspace'), 'Event Workspace must be absent from the visible normal Explorer view.');
  assert(!checks.text.includes('Archive Presets'), 'Archive presets must be absent from the visible normal Explorer view.');
  assert(checks.driveShellSelectors.advancedIsTopLevelView, 'Advanced must be a clearly labelled top-level view.');
  assert(checks.driveShellSelectors.explorerIsCurrentView, 'Explorer should expose the current top-level view semantically.');
  assert(checks.driveShellSelectors.standaloneDropZoneAbsent, 'The standalone drop zone element must not exist.');
  assert(checks.driveShellSelectors.remotePaneIsDropTarget, 'The Explorer file area must identify itself as the current-folder drop target.');
  assert(checks.driveShellSelectors.uploadFilesKeyboardAccessible, 'Upload files must be a keyboard-accessible Explorer control.');
  assert(checks.driveShellSelectors.uploadFolderKeyboardAccessible, 'Upload folder must be a keyboard-accessible Explorer control.');
  assert(checks.driveShellSelectors.shelfPauseUsesNamedIcon, 'Pause control needs a familiar icon, accessible label, and tooltip.');
  assert(checks.driveShellSelectors.shelfToggleUsesNamedIcon, 'Shelf collapse control needs a familiar icon, accessible label, and tooltip.');
  assert(checks.driveShellSelectors.visibleControlLabelsFit, 'Visible control labels must fit their controls.');
  assert(checks.driveShellSelectors.topbarControlsDoNotOverlap, 'Top-level controls must not overlap.');
  assert(checks.driveShellSelectors.shelfControlsDoNotOverlap, 'Transfer shelf header controls must not overlap.');
  if (width === 760) {
    assert(checks.driveShellSelectors.shelfAvoidsTopbar, 'Expanded 760px shelf must not overlap the wrapped topbar.');
    assert(checks.driveShellSelectors.shelfAvoidsExplorerCommands, 'Expanded 760px shelf must not obscure Explorer commands.');
    assert(checks.driveShellSelectors.mobileExpandedShelfIsInline, 'Expanded 760px shelf should use the inline mobile drawer layout.');
    assert(checks.driveShellSelectors.mobileExpandedShelfIsFullWidth, 'Expanded 760px shelf should span the Explorer width.');
    assert(checks.driveShellSelectors.mobileExpandedShelfHasStableHeight, 'Expanded 760px shelf should keep a stable bounded height.');
    assert(checks.driveShellSelectors.mobileExpandedShelfHasNoHorizontalOverflow, 'Expanded 760px shelf must not overflow horizontally.');
    assert(checks.driveShellSelectors.mobileShelfHeaderTextFits, 'Expanded 760px shelf header text must fit without clipping.');
    const mobileExplorerImage = await window.webContents.capturePage();
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'compact-760-explorer-shelf.png'), mobileExplorerImage.toPNG());
  }
  assert(checks.selectedRemoteText.includes('logs'), 'Selected remote row is not readable.');
  assert(
    checks.driveShellSelectors.selectedRemoteNameReadable,
    `Selected remote row name column should remain readable. Name width: ${checks.driveShellSelectors.selectedRemoteNameWidth}, label width: ${checks.driveShellSelectors.selectedRemoteLabelWidth}, table width: ${checks.driveShellSelectors.remoteTableWidth}, pane columns: ${checks.driveShellSelectors.remotePaneColumns}.`,
  );
  assert(checks.driveShellSelectors.selectedRemoteLabelVisible, 'Selected remote row label should be visibly rendered.');
  assert(
    checks.selectionSummary.includes('1 selected') && checks.selectionSummary.includes('8 items'),
    `Selection summary should clearly show the selected and visible item counts. Actual: ${checks.selectionSummary}`,
  );
  assert(checks.inspectorTitle === 'logs', 'Inspector title should update to the selected remote item.');
  assert(
    checks.inspectorSubtitle.includes('archive-event/recordings/raw/stage1/day2/mix/logs'),
    'Inspector subtitle should show the exact selected remote path.',
  );
  assert(checks.inspectorKind === 'Folder', 'Inspector kind should reflect the selected folder.');
  assert(checks.inspectorDetail === '-', 'Inspector detail should reflect the selected folder size.');
  assert(checks.destination === 'media:media/archive-event/recordings/raw/stage1/day2/mix/', 'Queue destination is misleading.');
  assert(!checks.destination.includes('/logs'), 'Queue row implies the whole job goes into logs.');
  assert(checks.rawText.includes('logs -> archive-event/recordings/raw/stage1/day2/mix/logs/...'), 'Expanded placement preview is missing logs mapping.');
  assert(checks.activeDestination.includes('day2/mix'), 'Active destination is not visible.');
  assert(checks.activeSource.includes('00000.mp4'), 'Current source file is not visible.');
  assert(checks.nextJob.includes('day1/c100'), 'Next job is not visible.');
  assert(checks.diagnosticMetrics.includes('avg 7.4 MiB/s'), 'Rolling throughput diagnostic is not visible.');
  assert(checks.diagnosticTuning.includes('transfers 4'), 'rclone tuning diagnostic is not visible.');
  assert(checks.diagnosticAction.includes('Keep uploading'), 'Safe next action diagnostic is not visible.');
  assert(checks.diagnosticRecommendation.includes('Observed speed'), 'Recommendation diagnostic is not visible.');
  assert(checks.publicUrls.includes('after upload and verification'), 'Public URL empty state is unclear.');
  assert(checks.driveShellSelectors.driveProfileLabel, 'Active connection status is not visible.');
  assert(checks.history.includes('failed'), 'History panel does not show failed job state.');
  assert(checks.history.includes('Yes'), 'History panel does not show resumable jobs.');
  assert(
    checks.historyRows.some((row) => row.includes('warning') && row.includes('No')),
    'Verified warning history rows should not offer resume.',
  );
  assert(checks.rawText.includes('Check + upload selected'), 'Forgotten-file selected upload shortcut is missing.');
  assert(checks.advancedDom.includes('Create the rclone profile with Spaces keys'), 'DigitalOcean profile setup is missing from the DOM.');
  assert(checks.connectionsText.includes('DigitalOcean Spaces'), 'Connections management content is not present.');
  assert(checks.rawText.includes('History records live in'), 'History persistence guidance is missing.');
  assert(checks.rawText.toLowerCase().includes('check activity'), 'Activity check control is missing.');
  assert(!checks.bodyOverflow, 'Body has horizontal overflow.');

  const shelfProgressBehavior = await window.webContents.executeJavaScript(`(() => {
    const activeRow = document.querySelector('[data-shelf-job-id="job-mix"]');
    const batchSummary = document.getElementById('transferShelfSummary');
    const beforeText = activeRow?.innerText || '';
    const batchSummaryBefore = batchSummary?.textContent || '';
    const progressHookExists = typeof window.murdawkUplinkSmoke.progress === 'function';
    if (progressHookExists) {
      window.murdawkUplinkSmoke.progress({
        currentFile: 'nested/camera-b-progress.mov',
        source: 'C:/Austria Mix/day-2/camera-b',
        sourceIndex: 3,
        sourceTotal: 32,
        percent: 27,
        speed: '9.1 MiB/s',
        eta: '44s',
        diagnostics: {
          state: 'slow',
          isRunning: true,
          pid: 4242,
          mode: 'upload',
          currentFile: 'nested/camera-b-progress.mov',
          lastOutputAgeSeconds: 1,
          speed: {
            current: '9.1 MiB/s',
            rollingAverage: '7.4 MiB/s',
            peak: '12.1 MiB/s'
          },
          tuning: {
            transfers: 4,
            chunkSize: '128M',
            uploadConcurrency: 4
          },
          safeAction: 'Keep uploading; use this speed evidence to choose future tuning after verification completes.',
          recommendation: 'Observed speed is low for a sustained period.'
        }
      });
    }
    const updatedRow = document.querySelector('[data-shelf-job-id="job-mix"]');
    const currentDetail = updatedRow?.querySelector('.transfer-shelf-current');
    const technicalDetail = updatedRow?.querySelector('.transfer-shelf-meta');
    return {
      progressHookExists,
      beforeText,
      afterText: updatedRow?.innerText || '',
      currentDetail: currentDetail?.textContent || '',
      technicalDetail: technicalDetail?.textContent || '',
      progressValue: updatedRow?.querySelector('.transfer-shelf-meter')?.getAttribute('aria-valuenow') || '',
      batchSummaryUnchanged: batchSummaryBefore === (batchSummary?.textContent || ''),
      batchSummaryIsLive: batchSummary?.getAttribute('aria-live') === 'polite',
      rowDetailsAreNotLive: [currentDetail, technicalDetail].every((node) => node && !node.closest('[aria-live]')),
    };
  })()`);
  assert(shelfProgressBehavior.progressHookExists, 'Smoke hook should expose targeted transfer shelf progress updates.');
  assert(!shelfProgressBehavior.beforeText.includes('camera-b-progress.mov'), 'Progress fixture should start before the changed current file.');
  assert(shelfProgressBehavior.currentDetail.includes('camera-b-progress.mov'), 'Progress should update the active shelf row current file.');
  assert(shelfProgressBehavior.technicalDetail.includes('Source 3 of 32'), 'Progress should update source index and total detail.');
  assert(shelfProgressBehavior.technicalDetail.includes('2 job sources'), 'Progress should retain active job source-count detail.');
  assert(shelfProgressBehavior.technicalDetail.includes('chunk 128M'), 'Progress should update active chunk detail.');
  assert(shelfProgressBehavior.progressValue === '27', 'Progress should update only the active shelf row meter.');
  assert(shelfProgressBehavior.batchSummaryUnchanged, 'Per-file progress should not rewrite the batch live summary.');
  assert(shelfProgressBehavior.batchSummaryIsLive, 'Batch status summary should remain the shelf live region.');
  assert(shelfProgressBehavior.rowDetailsAreNotLive, 'Per-file and chunk details must not be live regions.');

  const lifecycleSequenceBehavior = await window.webContents.executeJavaScript(`(async () => {
    const smoke = window.murdawkUplinkSmoke;
    const eventHookExists = typeof smoke.uploadEvent === 'function';
    const dryRunHookExists = typeof smoke.dryRun === 'function';
    if (!eventHookExists || !dryRunHookExists) return { eventHookExists, dryRunHookExists };
    const job = {
      id: 'job-sequence',
      sources: ['C:/Sequence/source-one.mov', 'C:/Sequence/source-two.mov'],
      settings: {
        profile: {
          remote: 'media',
          bucket: 'media',
          endpointHost: 'media.nyc3.digitaloceanspaces.com'
        },
        prefix: 'terminal/sequencing',
        filterMode: 'all',
        include: '',
        folderUploadMode: 'package',
        publicRead: true,
        checksum: 'size',
        notifyOn: 'success'
      },
      status: 'prechecking'
    };
    smoke.seed({
      jobs: [job],
      activeJobId: job.id,
      progress: {
        currentFile: 'source-one.mov',
        sourceIndex: 1,
        sourceTotal: 2,
        percent: 50,
        speed: '4.0 MiB/s',
        eta: '12s'
      }
    });
    smoke.uploadEvent('upload:source-complete', { mode: 'dry-run', sourceIndex: 1, sourceTotal: 2 });
    const afterFirstSourceRow = document.querySelector('[data-shelf-job-id="job-sequence"]');
    const afterFirstSource = {
      status: afterFirstSourceRow?.querySelector('.transfer-shelf-status')?.textContent || '',
      hasProgress: Boolean(afterFirstSourceRow?.querySelector('.transfer-shelf-meter')),
      activeCount: document.getElementById('transferShelfActive')?.textContent || '',
    };
    smoke.uploadEvent('upload:progress', {
      mode: 'dry-run',
      currentFile: 'nested/source-two.mov',
      source: 'C:/Sequence/source-two.mov',
      sourceIndex: 2,
      sourceTotal: 2,
      percent: 75,
      speed: '5.0 MiB/s',
      eta: '5s'
    });
    const secondSourceRow = document.querySelector('[data-shelf-job-id="job-sequence"]');
    const secondSource = {
      current: secondSourceRow?.querySelector('.transfer-shelf-current')?.textContent || '',
      detail: secondSourceRow?.querySelector('.transfer-shelf-meta')?.textContent || '',
      progress: secondSourceRow?.querySelector('.transfer-shelf-meter')?.getAttribute('aria-valuenow') || '',
    };
    await smoke.dryRun(job.id);
    const readyRow = document.querySelector('[data-shelf-job-id="job-sequence"]');
    const afterDryRunResolution = {
      status: readyRow?.querySelector('.transfer-shelf-status')?.textContent || '',
      hasProgress: Boolean(readyRow?.querySelector('.transfer-shelf-meter')),
      activeCount: document.getElementById('transferShelfActive')?.textContent || '',
    };

    smoke.seed({
      jobs: [{ ...job, status: 'uploading' }],
      activeJobId: job.id,
      progress: {
        currentFile: 'source-two.mov',
        sourceIndex: 2,
        sourceTotal: 2,
        percent: 96,
        speed: '8.0 MiB/s',
        eta: '1s'
      }
    });
    smoke.uploadEvent('upload:source-complete', { mode: 'upload', sourceIndex: 2, sourceTotal: 2 });
    smoke.uploadEvent('upload:verified', { verification: { ok: true, verified: ['source-two.mov'] } });
    const verifiedRow = document.querySelector('[data-shelf-job-id="job-sequence"]');
    const afterVerified = {
      status: verifiedRow?.querySelector('.transfer-shelf-status')?.textContent || '',
      current: verifiedRow?.querySelector('.transfer-shelf-current')?.textContent || '',
      progress: verifiedRow?.querySelector('.transfer-shelf-meter')?.getAttribute('aria-valuenow') || '',
      activeCount: document.getElementById('transferShelfActive')?.textContent || '',
      speed: document.getElementById('transferShelfSpeed')?.textContent || '',
    };
    smoke.uploadEvent('upload:complete', {
      jobId: 'upload-sequence',
      dryRun: false,
      urls: [],
      verification: { ok: true, verified: ['source-two.mov'] },
      checksum: { ok: true },
      uploadedRoots: []
    });
    const completeRow = document.querySelector('[data-shelf-job-id="job-sequence"]');
    const afterComplete = {
      status: completeRow?.querySelector('.transfer-shelf-status')?.textContent || '',
      hasProgress: Boolean(completeRow?.querySelector('.transfer-shelf-meter')),
      activeCount: document.getElementById('transferShelfActive')?.textContent || '',
      speed: document.getElementById('transferShelfSpeed')?.textContent || '',
    };
    return {
      eventHookExists,
      dryRunHookExists,
      afterFirstSource,
      secondSource,
      afterDryRunResolution,
      afterVerified,
      afterComplete,
    };
  })()`);
  assert(lifecycleSequenceBehavior.eventHookExists, 'Smoke harness should expose the real upload event handler.');
  assert(lifecycleSequenceBehavior.dryRunHookExists, 'Smoke harness should expose whole-job dry-run resolution.');
  assert(lifecycleSequenceBehavior.afterFirstSource.status === 'Checking', 'Per-source dry-run completion must remain Checking.');
  assert(lifecycleSequenceBehavior.afterFirstSource.hasProgress, 'Per-source dry-run completion must retain the active row.');
  assert(lifecycleSequenceBehavior.afterFirstSource.activeCount === '1 active', 'Per-source dry-run completion must retain its active count.');
  assert(lifecycleSequenceBehavior.secondSource.current.includes('source-two.mov'), 'Later dry-run source progress must update the same active row.');
  assert(lifecycleSequenceBehavior.secondSource.detail.includes('Source 2 of 2'), 'Later dry-run source progress must retain source sequencing.');
  assert(lifecycleSequenceBehavior.secondSource.progress === '75', 'Later dry-run source progress must retain its progress meter.');
  assert(lifecycleSequenceBehavior.afterDryRunResolution.status === 'Waiting', 'Whole-job dry-run resolution should transition to Waiting.');
  assert(!lifecycleSequenceBehavior.afterDryRunResolution.hasProgress, 'Whole-job dry-run resolution should clear active progress.');
  assert(lifecycleSequenceBehavior.afterDryRunResolution.activeCount === '0 active', 'Whole-job dry-run resolution should clear active count.');
  assert(lifecycleSequenceBehavior.afterVerified.status === 'Verifying', 'Verified transfer should remain Verifying until operation completion.');
  assert(lifecycleSequenceBehavior.afterVerified.current.includes('source-two.mov'), 'Verified transfer should retain current source detail until completion.');
  assert(lifecycleSequenceBehavior.afterVerified.progress === '96', 'Verified transfer should retain active progress until completion.');
  assert(lifecycleSequenceBehavior.afterVerified.activeCount === '1 active', 'Verified transfer should remain active until completion.');
  assert(lifecycleSequenceBehavior.afterVerified.speed === '8.0 MiB/s', 'Verified transfer should retain compact speed until completion.');
  assert(lifecycleSequenceBehavior.afterComplete.status === 'Complete', 'Full operation completion should transition to Complete.');
  assert(!lifecycleSequenceBehavior.afterComplete.hasProgress, 'Full operation completion should clear active progress.');
  assert(lifecycleSequenceBehavior.afterComplete.activeCount === '0 active', 'Full operation completion should clear active count.');
  assert(lifecycleSequenceBehavior.afterComplete.speed === '-', 'Full operation completion should clear compact speed.');

  const terminalShelfBehavior = await window.webContents.executeJavaScript(`(() => {
    const smoke = window.murdawkUplinkSmoke;
    const terminalHookExists = typeof smoke.terminal === 'function';
    if (!terminalHookExists) return { terminalHookExists, transitions: {} };
    const job = {
      id: 'job-terminal',
      sources: ['C:/Terminal/current-file.mov'],
      settings: {
        profile: {
          remote: 'media',
          bucket: 'media',
          endpointHost: 'media.nyc3.digitaloceanspaces.com'
        },
        prefix: 'terminal/transitions',
        filterMode: 'all',
        include: '',
        folderUploadMode: 'package',
        publicRead: true,
        checksum: 'size',
        notifyOn: 'success'
      },
      status: 'uploading'
    };
    const progress = {
      currentFile: 'nested/current-file.mov',
      sourceIndex: 1,
      sourceTotal: 1,
      percent: 73,
      speed: '11.2 MiB/s',
      eta: '9s',
      diagnostics: { tuning: { chunkSize: '64M' } }
    };
    const capture = (status) => {
      smoke.seed({ jobs: [{ ...job }], activeJobId: job.id, progress });
      smoke.terminal(job.id, status);
      const row = document.querySelector('[data-shelf-job-id="job-terminal"]');
      return {
        statusText: row?.querySelector('.transfer-shelf-status')?.textContent || '',
        hasCurrentFile: Boolean(row?.querySelector('.transfer-shelf-current')),
        hasProgressMeter: Boolean(row?.querySelector('.transfer-shelf-meter')),
        compactPercent: document.getElementById('transferShelfPercent')?.textContent || '',
        compactActive: document.getElementById('transferShelfActive')?.textContent || '',
        compactSpeed: document.getElementById('transferShelfSpeed')?.textContent || '',
        compactEta: document.getElementById('transferShelfEta')?.textContent || '',
        shelfHidden: document.getElementById('transferShelf')?.hidden === true,
      };
    };
    const transitions = {
      ready: capture('ready'),
      failed: capture('failed'),
      cancelled: capture('cancelled'),
    };
    smoke.seed({
      jobs: [{ ...job }],
      activeJobId: job.id,
      progress: {
        ...progress,
        diagnostics: {
          state: 'slow',
          isRunning: true,
          speed: {
            current: '11.2 MiB/s',
            rollingAverage: '7.4 MiB/s',
            peak: '12.1 MiB/s'
          },
          tuning: { transfers: 4, chunkSize: '64M', uploadConcurrency: 4 },
          safeAction: 'Keep uploading after terminal transition coverage.',
          recommendation: 'Observed speed is low for a sustained period.'
        }
      }
    });
    return { terminalHookExists, transitions };
  })()`);
  assert(terminalShelfBehavior.terminalHookExists, 'Smoke harness should expose terminal transfer transitions.');
  for (const [status, transition] of Object.entries(terminalShelfBehavior.transitions)) {
    assert(!transition.hasCurrentFile, `${status} transition should clear stale current-file detail.`);
    assert(!transition.hasProgressMeter, `${status} transition should clear the active progress meter.`);
    assert(transition.compactPercent === '0%', `${status} transition should reset compact percent.`);
    assert(transition.compactActive === '0 active', `${status} transition should reset compact active count.`);
    assert(transition.compactSpeed === '-', `${status} transition should reset compact speed.`);
    assert(transition.compactEta === 'ETA -', `${status} transition should reset compact ETA.`);
    assert(!transition.shelfHidden, `${status} terminal work should keep the shelf visible.`);
  }
  assert(terminalShelfBehavior.transitions.ready.statusText === 'Waiting', 'Ready terminal work should remain labelled Waiting.');
  assert(terminalShelfBehavior.transitions.failed.statusText === 'Needs attention', 'Failed terminal work should remain labelled Needs attention.');
  assert(terminalShelfBehavior.transitions.cancelled.statusText === 'Paused', 'Cancelled terminal work should remain labelled Paused.');

  const connectionsBehavior = await window.webContents.executeJavaScript(`(async () => {
    const waitFor = async (predicate, label) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (predicate()) return;
        await new Promise(requestAnimationFrame);
      }
      throw new Error('Timed out waiting for ' + label);
    };
    const panel = document.getElementById('connectionsPanel');
    const explorerSection = document.querySelector('.explorer-section');
    const advancedWorkspace = document.querySelector('.workspace.advanced-only');
    const eventPanel = document.getElementById('eventWorkspacePanel');
    const button = document.getElementById('openConnections');
    const explorerTab = document.getElementById('showExplorerView');
    const advancedTab = document.getElementById('showAdvancedView');
    const profileCard = panel?.querySelector('.connection-card');
    button?.click();
    await waitFor(
      () => panel && !panel.hidden && document.activeElement?.id === 'connectionsTitle',
      'Connections view and focus',
    );
    const panelVisible = panel && !panel.hidden && window.getComputedStyle(panel).display !== 'none';
    const explorerHidden = window.getComputedStyle(explorerSection).display === 'none';
    const buttonExpandedOpen = button?.getAttribute('aria-expanded') || '';
    const connectionsViewClassOpen = document.body.classList.contains('is-drive-connections-view');
    const connectionsFocusTarget = document.activeElement?.id || '';
    const profileCardRect = profileCard?.getBoundingClientRect();
    const profileCardVisible = Boolean(
      profileCard &&
        window.getComputedStyle(profileCard).display !== 'none' &&
        profileCardRect &&
        profileCardRect.width > 0 &&
        profileCardRect.height > 0 &&
        profileCardRect.top >= -1 &&
        profileCardRect.left >= -1 &&
        profileCardRect.right <= document.documentElement.clientWidth + 1
    );
    const eventPanelHidden = eventPanel?.hidden === true || window.getComputedStyle(eventPanel).display === 'none';
    const text = panel?.textContent || '';

    button?.click();
    await waitFor(
      () => panel?.hidden === true && document.activeElement === button,
      'Connections close and trigger focus',
    );
    const panelHiddenAfterToggleClose = panel?.hidden === true || window.getComputedStyle(panel).display === 'none';
    const explorerVisibleAfterToggleClose = window.getComputedStyle(explorerSection).display !== 'none';
    const buttonExpandedAfterToggleClose = button?.getAttribute('aria-expanded') || '';
    const connectionsClassAfterToggleClose = document.body.classList.contains('is-drive-connections-view');
    const closeFocusTarget = document.activeElement?.id || '';

    button?.click();
    await waitFor(() => document.activeElement?.id === 'connectionsTitle', 'reopened Connections focus');
    explorerTab?.click();
    await waitFor(
      () => panel?.hidden === true && document.activeElement?.id === 'explorerTitle',
      'Explorer view and focus',
    );
    const panelHiddenAfterExplorer = panel?.hidden === true || window.getComputedStyle(panel).display === 'none';
    const explorerVisibleAfterExplorer = window.getComputedStyle(explorerSection).display !== 'none';
    const remoteTableVisibleAfterExplorer = window.getComputedStyle(document.getElementById('remoteTable')).display !== 'none';
    const buttonExpandedAfterExplorer = button?.getAttribute('aria-expanded') || '';
    const connectionsClassAfterExplorer = document.body.classList.contains('is-drive-connections-view');
    const explorerFocusTarget = document.activeElement?.id || '';

    button?.click();
    await waitFor(() => document.activeElement?.id === 'connectionsTitle', 'Connections before Advanced');
    window.murdawkUplinkSmoke.progress({
      percent: 73,
      speed: '11.2 MiB/s',
      eta: '9s',
      diagnostics: {
        state: 'slow',
        isRunning: true,
        speed: {
          current: '11.2 MiB/s',
          rollingAverage: '7.4 MiB/s',
          peak: '12.1 MiB/s'
        },
        tuning: { transfers: 4, chunkSize: '64M', uploadConcurrency: 4 },
        safeAction: 'Keep uploading after terminal transition coverage.',
        recommendation: 'Observed speed is low for a sustained period.'
      }
    });
    await waitFor(
      () => document.getElementById('diagnosticMetrics')?.textContent.includes('avg 7.4 MiB/s'),
      'deterministic diagnostics state',
    );
    advancedTab?.click();
    await waitFor(
      () => document.body.classList.contains('is-advanced-view') && document.activeElement?.id === 'advancedTitle',
      'Advanced view and focus',
    );
    const panelHiddenAfterAdvanced = panel?.hidden === true || window.getComputedStyle(panel).display === 'none';
    const advancedVisibleAfterAdvanced = window.getComputedStyle(advancedWorkspace).display !== 'none';
    const advancedQueueVisible = window.getComputedStyle(document.getElementById('queueDrawer')).display !== 'none';
    const advancedDiagnosticsVisible = window.getComputedStyle(document.querySelector('.progress-section')).display !== 'none';
    const advancedLogVisible = window.getComputedStyle(document.querySelector('.log-section')).display !== 'none';
    const advancedSettingsVisible = window.getComputedStyle(document.querySelector('.settings-panel')).display !== 'none';
    const advancedManualControlsVisible = ['dryRun', 'verify', 'upload', 'cancel']
      .every((id) => window.getComputedStyle(document.getElementById(id)).display !== 'none');
    const shelfRectAfterAdvanced = document.getElementById('transferShelf')?.getBoundingClientRect();
    const shelfVisibleAfterAdvanced = Boolean(
      shelfRectAfterAdvanced && shelfRectAfterAdvanced.width > 0 && shelfRectAfterAdvanced.height > 0
    );
    const advancedDiagnosticsText = document.querySelector('.progress-section')?.innerText || '';
    const buttonExpandedAfterAdvanced = button?.getAttribute('aria-expanded') || '';
    const connectionsClassAfterAdvanced = document.body.classList.contains('is-drive-connections-view');
    const advancedFocusTarget = document.activeElement?.id || '';
    const intersectsViewport = (element) => {
      const rect = element?.getBoundingClientRect();
      return Boolean(
        rect && rect.width > 0 && rect.height > 0 &&
        rect.bottom > 0 && rect.top < window.innerHeight &&
        rect.right > 0 && rect.left < window.innerWidth
      );
    };
    const advancedKeyControlVisibility = Object.fromEntries(
      ['advancedTitle', 'prefix', 'dryRun', 'progressTitle', 'checkActivity']
        .map((id) => [id, intersectsViewport(document.getElementById(id))]),
    );
    const advancedKeyControlsInViewport = Object.values(advancedKeyControlVisibility).every(Boolean);
    const workspaceRect = advancedWorkspace?.getBoundingClientRect();
    const diagnosticsRect = document.querySelector('.progress-section')?.getBoundingClientRect();
    const advancedPrimaryColumnsAligned = Boolean(
      workspaceRect && diagnosticsRect &&
      Math.abs(workspaceRect.top - diagnosticsRect.top) <= 2 &&
      workspaceRect.left < diagnosticsRect.left
    );
    return {
      buttonExists: Boolean(button),
      buttonDisabled: button?.disabled === true,
      buttonExpanded: buttonExpandedOpen,
      panelExists: Boolean(panel),
      panelVisible,
      explorerHidden,
      connectionsViewClass: connectionsViewClassOpen,
      connectionsFocusTarget,
      profileCardVisible,
      eventPanelHidden,
      text,
      remoteRowCount: document.querySelectorAll('.remote-row').length,
      panelHiddenAfterToggleClose,
      explorerVisibleAfterToggleClose,
      buttonExpandedAfterToggleClose,
      connectionsClassAfterToggleClose,
      closeFocusTarget,
      panelHiddenAfterExplorer,
      explorerVisibleAfterExplorer,
      remoteTableVisibleAfterExplorer,
      buttonExpandedAfterExplorer,
      connectionsClassAfterExplorer,
      explorerFocusTarget,
      panelHiddenAfterAdvanced,
      advancedVisibleAfterAdvanced,
      advancedQueueVisible,
      advancedDiagnosticsVisible,
      advancedLogVisible,
      advancedSettingsVisible,
      advancedManualControlsVisible,
      shelfVisibleAfterAdvanced,
      advancedDiagnosticsText,
      buttonExpandedAfterAdvanced,
      connectionsClassAfterAdvanced,
      advancedFocusTarget,
      advancedKeyControlsInViewport,
      advancedKeyControlVisibility,
      advancedPrimaryColumnsAligned,
    };
  })()`);
  assert(connectionsBehavior.buttonExists, 'Connections button is missing.');
  assert(!connectionsBehavior.buttonDisabled, 'Connections button should be enabled.');
  assert(connectionsBehavior.buttonExpanded === 'true', 'Connections button should expose aria-expanded=true when open.');
  assert(connectionsBehavior.panelExists, 'Connections panel is missing.');
  assert(connectionsBehavior.panelVisible, 'Connections panel should be visible after clicking Connections.');
  assert(connectionsBehavior.connectionsViewClass, 'Connections view class should remain active after opening.');
  assert(connectionsBehavior.connectionsFocusTarget === 'connectionsTitle', 'Connections should focus its visible view heading.');
  assert(connectionsBehavior.explorerHidden, 'Connections view should replace the Explorer panel.');
  assert(connectionsBehavior.profileCardVisible, 'Connections profile card should be visibly rendered in the viewport.');
  assert(connectionsBehavior.eventPanelHidden, 'Opening Connections should hide Event Workspace panel.');
  assert(connectionsBehavior.text.includes('Connections'), 'Connections panel title is missing.');
  assert(connectionsBehavior.text.includes('Media Archive'), 'Connections panel should list Media Archive.');
  assert(connectionsBehavior.text.includes('Archive Space'), 'Connections panel should list the second Space.');
  assert(connectionsBehavior.text.includes('Add a DigitalOcean Space'), 'Connections panel should include connection setup.');
  assert(
    connectionsBehavior.text.includes('Secrets will not be stored') ||
      connectionsBehavior.text.includes('never written to Uplink settings'),
    'Connections panel should repeat the credential boundary.',
  );
  assert(connectionsBehavior.remoteRowCount >= 2, 'Opening Connections should not break the Explorer remote table.');
  assert(connectionsBehavior.panelHiddenAfterToggleClose, 'Second Connections click should hide Connections panel.');
  assert(connectionsBehavior.explorerVisibleAfterToggleClose, 'Second Connections click should restore the Explorer panel.');
  assert(connectionsBehavior.buttonExpandedAfterToggleClose === 'false', 'Second Connections click should collapse Connections aria state.');
  assert(!connectionsBehavior.connectionsClassAfterToggleClose, 'Second Connections click should clear Connections view class.');
  assert(connectionsBehavior.closeFocusTarget === 'openConnections', 'Closing Connections should return focus to its toggle.');
  assert(connectionsBehavior.panelHiddenAfterExplorer, 'Explorer tab should hide Connections panel.');
  assert(connectionsBehavior.explorerVisibleAfterExplorer, 'Explorer tab should restore the Explorer panel.');
  assert(connectionsBehavior.remoteTableVisibleAfterExplorer, 'Explorer tab should restore the remote file table.');
  assert(connectionsBehavior.buttonExpandedAfterExplorer === 'false', 'Explorer tab should collapse Connections aria state.');
  assert(!connectionsBehavior.connectionsClassAfterExplorer, 'Explorer tab should clear Connections view class.');
  assert(connectionsBehavior.explorerFocusTarget === 'explorerTitle', 'Explorer tab should focus the Explorer heading.');
  assert(connectionsBehavior.panelHiddenAfterAdvanced, 'Advanced tab should hide Connections panel.');
  assert(connectionsBehavior.advancedVisibleAfterAdvanced, 'Advanced tab should show Advanced upload content.');
  assert(connectionsBehavior.advancedQueueVisible, 'Advanced tab should expose detailed queue controls.');
  assert(connectionsBehavior.advancedDiagnosticsVisible, 'Advanced tab should expose transfer diagnostics.');
  assert(connectionsBehavior.advancedLogVisible, 'Advanced tab should expose transfer logs.');
  assert(connectionsBehavior.advancedSettingsVisible, 'Advanced tab should retain specialist upload settings.');
  assert(connectionsBehavior.advancedManualControlsVisible, 'Advanced tab should retain manual transfer controls.');
  assert(connectionsBehavior.shelfVisibleAfterAdvanced, 'Active transfer shelf should persist when switching to Advanced.');
  assert(connectionsBehavior.advancedDiagnosticsText.includes('Transfer Diagnostics'), 'Advanced diagnostics need a clear visible label.');
  assert(connectionsBehavior.advancedDiagnosticsText.includes('avg 7.4 MiB/s'), 'Advanced diagnostics should preserve rolling throughput detail.');
  assert(connectionsBehavior.buttonExpandedAfterAdvanced === 'false', 'Advanced tab should collapse Connections aria state.');
  assert(!connectionsBehavior.connectionsClassAfterAdvanced, 'Advanced tab should clear Connections view class.');
  assert(connectionsBehavior.advancedFocusTarget === 'advancedTitle', 'Advanced tab should focus the Advanced heading.');
  if (width >= 1281) {
    assert(
      connectionsBehavior.advancedKeyControlsInViewport,
      `Advanced primary controls should intersect the viewport when opened at ${width}px: ${JSON.stringify(connectionsBehavior.advancedKeyControlVisibility)}`,
    );
    assert(connectionsBehavior.advancedPrimaryColumnsAligned, `Advanced settings and diagnostics should share the primary row at ${width}px.`);
  }

  await setShelfCollapsed(window, false);
  const expandedAdvancedGeometry = await inspectShelfGeometry(window);
  await setShelfCollapsed(window, true);
  const collapsedAdvancedGeometry = await inspectShelfGeometry(window);
  for (const [stateName, geometry] of [
    ['expanded', expandedAdvancedGeometry],
    ['collapsed', collapsedAdvancedGeometry],
  ]) {
    assert(geometry.overlapTargets.length === 0, `The ${stateName} Advanced shelf overlaps visible controls at ${width}px: ${geometry.overlapTargets.join(', ')}`);
    assert(!geometry.horizontalOverflow, `The ${stateName} Advanced shelf should not overflow horizontally at ${width}px.`);
    assert(geometry.clippedButtons.length === 0, `Advanced button labels should fit at ${width}px: ${geometry.clippedButtons.join(', ')}`);
  }

  const activityBehavior = await window.webContents.executeJavaScript(`(async () => {
    window.murdawkUplinkSmoke.seed({ jobs: [] });
    const activityButton = document.getElementById('showActivityView');
    activityButton.click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const panel = document.getElementById('activityPanel');
    const rows = [...document.querySelectorAll('.activity-row')];
    const populated = {
      panelVisible: panel && window.getComputedStyle(panel).display !== 'none' && !panel.hidden,
      focusTarget: document.activeElement?.id || '',
      rowTitles: rows.map((row) => row.querySelector('.activity-source strong')?.textContent || ''),
      text: panel?.innerText || '',
      terminalHidden: window.getComputedStyle(document.querySelector('.log-section')).display === 'none',
      hasResume: Boolean(panel?.querySelector('[data-activity-action="resume"]')),
      hasOpenLog: Boolean(panel?.querySelector('[data-activity-action="log"]')),
      interruptedText: panel?.querySelector('[data-activity-job-id="dry-run-interrupted"]')?.innerText || '',
      interruptedCanResume: Boolean(panel?.querySelector('[data-activity-job-id="dry-run-interrupted"] [data-activity-action="resume"]')),
      completedDryRunText: panel?.querySelector('[data-activity-job-id="dry-run-complete"]')?.innerText || '',
      completedDryRunCanResume: Boolean(panel?.querySelector('[data-activity-job-id="dry-run-complete"] [data-activity-action="resume"]')),
      supersededText: panel?.querySelector('[data-activity-job-id="upload-superseded"]')?.innerText || '',
      supersededCanResume: Boolean(panel?.querySelector('[data-activity-job-id="upload-superseded"] [data-activity-action="resume"]')),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      clippedButtons: [...panel.querySelectorAll('button')]
        .filter((button) => button.offsetParent !== null)
        .filter((button) => button.scrollWidth > button.clientWidth + 1)
        .map((button) => button.textContent.trim()),
    };
    panel?.querySelector('[data-activity-action="log"]')?.click();
    const resumeButton = panel?.querySelector('[data-activity-job-id="dry-run-interrupted"] [data-activity-action="resume"]');
    resumeButton?.click();
    resumeButton?.click();
    const resumeDisabledImmediately = Boolean(
      panel?.querySelector('[data-activity-job-id="dry-run-interrupted"] [data-activity-action="resume"]')?.disabled
    );
    await new Promise((resolve) => setTimeout(resolve, 120));
    const completedResumeText = panel?.querySelector('[data-activity-job-id="dry-run-interrupted"]')?.innerText || '';
    const completedResumeCanResume = Boolean(
      panel?.querySelector('[data-activity-job-id="dry-run-interrupted"] [data-activity-action="resume"]')
    );
    window.spacesUploader.configureQueueMock({
      saveOutcomes: [{ ok: false, error: 'Mocked Activity resume persistence failure' }],
      resetCalls: false,
    });
    panel?.querySelector('[data-activity-job-id="upload-stale"] [data-activity-action="resume"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const resumeReleasedAfterSaveFailure = !panel?.querySelector(
      '[data-activity-job-id="upload-stale"] [data-activity-action="resume"]'
    )?.disabled;
    const calls = window.spacesUploader.queueMockSnapshot().calls;
    window.spacesUploader.setActivityRecordsMock([]);
    document.getElementById('refreshActivity').click();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const emptyText = document.getElementById('activityList')?.innerText?.trim() || '';
    window.spacesUploader.setActivityRecordsMock(null);
    return {
      ...populated,
      calls,
      completedResumeCanResume,
      completedResumeText,
      emptyText,
      resumeDisabledImmediately,
      resumeReleasedAfterSaveFailure,
    };
  })()`);
  assert(activityBehavior.panelVisible, 'Activity should open as a visible top-level view.');
  assert(activityBehavior.focusTarget === 'activityTitle', `Activity should focus its visible heading, got ${activityBehavior.focusTarget || 'none'}.`);
  assert(activityBehavior.rowTitles[0]?.includes('interrupted-precheck.mov'), 'Activity should render the newest durable run first.');
  assert(activityBehavior.text.includes('Complete'), 'Activity should show a clear user-facing result.');
  assert(activityBehavior.text.includes('Needs attention'), 'Activity should show failed runs clearly.');
  assert(activityBehavior.text.includes('Authorization: REDACTED'), 'Activity should preserve useful redacted error context.');
  assert(!activityBehavior.text.includes('renderer-secret'), 'Activity must not render credential values.');
  assert(activityBehavior.terminalHidden, 'Detailed terminal logs should remain in Advanced.');
  assert(activityBehavior.hasResume, 'Resumable Activity rows should offer Check and resume.');
  assert(activityBehavior.hasOpenLog, 'Activity rows with logs should offer Open log.');
  assert(activityBehavior.interruptedText.includes('Interrupted'), 'An unfinished dry run should display as Interrupted.');
  assert(activityBehavior.interruptedCanResume, 'An unfinished dry run should offer Check and resume.');
  assert(activityBehavior.completedDryRunText.includes('Complete'), 'A completed dry run should remain Complete.');
  assert(!activityBehavior.completedDryRunCanResume, 'A completed dry run should not offer resume.');
  assert(activityBehavior.supersededText.includes('Completed by a resumed transfer.'), 'A successfully resumed durable run should explain that its original is complete.');
  assert(!activityBehavior.supersededCanResume, 'A successfully resumed durable run must permanently suppress resume on its original Activity row.');
  assert(!activityBehavior.horizontalOverflow, `Activity should not overflow horizontally at ${width}px.`);
  assert(activityBehavior.clippedButtons.length === 0, `Activity button labels should fit at ${width}px: ${activityBehavior.clippedButtons.join(', ')}`);
  assert(activityBehavior.calls.some((call) => call.type === 'open-job-log' && call.jobId === 'upload-stale'), 'Open log should invoke the narrow job log action.');
  assert(activityBehavior.calls.some((call) => call.type === 'resume-job-record' && call.jobId === 'dry-run-interrupted'), 'Check and resume should request safe settings for the interrupted precheck by job id.');
  assert(
    activityBehavior.calls.filter((call) => call.type === 'resume-job-record' && call.jobId === 'dry-run-interrupted').length === 1,
    'Rapid Check and resume activation should prepare one queue job per durable source.',
  );
  assert(activityBehavior.resumeDisabledImmediately, 'Check and resume should disable immediately after claiming its durable source.');
  assert(!activityBehavior.completedResumeCanResume, 'A successful resumed descendant should keep the original Activity action suppressed immediately.');
  assert(activityBehavior.completedResumeText.includes('Completed by a resumed transfer.'), 'The live Activity row should explain successful resume supersession without waiting for restart.');
  assert(activityBehavior.resumeReleasedAfterSaveFailure, 'A failed durable queue save should roll back the row and release its Activity resume claim.');
  assert(activityBehavior.emptyText === 'No transfer runs yet', 'Activity needs the exact empty state.');

  await setShelfCollapsed(window, false);
  await ensureExplorerView(window);
  await window.webContents.executeJavaScript('window.scrollTo(0, 0)');
  await waitForWindowCondition(
    window,
    `document.activeElement?.id === 'explorerTitle' &&
      !document.getElementById('transferShelf')?.classList.contains('is-collapsed') &&
      window.scrollY === 0`,
    'deterministic Explorer screenshot state',
  );
  const image = await window.webContents.capturePage();
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${name}.png`), image.toPNG());
  window.close();
}

async function runNewFolderDialogScenario() {
  const window = new BrowserWindow({
    width: 1280,
    height: 768,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, 'ui-smoke-preload.js'),
    },
  });
  await window.loadFile(path.join(appDir, 'src', 'renderer', 'index.html'), {
    query: { smoke: '1' },
  });
  await waitForSmokeHook(window);
  await ensureExplorerView(window);

  const behavior = await window.webContents.executeJavaScript(`(async () => {
    const smoke = window.murdawkUplinkSmoke;
    const dialog = document.getElementById('newFolderDialog');
    if (!dialog) return { dialogPresent: false };
    const waitFor = async (predicate, label) => {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        if (predicate()) return;
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      throw new Error('New folder dialog wait timed out: ' + label);
    };
    smoke.configureQueueMock({ resetCalls: true });
    document.getElementById('driveNewFolder').click();
    await waitFor(() => dialog.open && document.activeElement?.id === 'newFolderName', 'rail open');
    const railOpened = dialog.open && document.activeElement?.id === 'newFolderName';
    document.getElementById('newFolderCancel').click();
    await waitFor(() => !dialog.open, 'rail cancel');
    const railCancelled = !dialog.open;

    document.getElementById('newRemoteFolder').click();
    await waitFor(() => dialog.open && document.activeElement?.id === 'newFolderName', 'toolbar open');
    const toolbarOpened = dialog.open && document.activeElement?.id === 'newFolderName';
    document.getElementById('newFolderName').value = 'camera originals';
    document.getElementById('newFolderForm').requestSubmit();
    await waitFor(() => smoke.queueMockSnapshot().calls.some((call) => call.type === 'remote-operation'), 'submit');
    const calls = smoke.queueMockSnapshot().calls;
    const request = calls.find((call) => call.type === 'remote-operation')?.request;
    await waitFor(() => !dialog.open, 'close after submit');
    return {
      dialogPresent: true,
      railOpened,
      railCancelled,
      toolbarOpened,
      submittedOnce: calls.filter((call) => call.type === 'remote-operation').length === 1,
      action: request?.action || '',
      targetPrefix: request?.targetPrefix || '',
    };
  })()`);
  assert(behavior.dialogPresent, 'New Folder should use an in-app dialog supported by Electron.');
  assert(behavior.railOpened && behavior.railCancelled, 'The rail New Folder button should open a focused cancellable dialog.');
  assert(behavior.toolbarOpened, 'The toolbar New Folder button should open the same focused dialog.');
  assert(
    behavior.submittedOnce && behavior.action === 'mkdir' && behavior.targetPrefix.endsWith('/camera originals/.keep'),
    `New Folder should submit one normalized placeholder request. Actual: ${JSON.stringify(behavior)}`,
  );
  window.close();
}

async function runAutomaticQueueScenario() {
  const sensitiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'murdawk-smoke-sensitive-'));
  fs.mkdirSync(path.join(sensitiveRoot, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(sensitiveRoot, 'nested', '.env.production'), 'mock-only');
  const window = new BrowserWindow({
    width: 1280,
    height: 768,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, 'ui-smoke-preload.js'),
    },
  });

  await window.loadFile(path.join(appDir, 'src', 'renderer', 'index.html'), {
    query: { smoke: '1' },
  });
  await waitForSmokeHook(window);

  const behavior = await window.webContents.executeJavaScript(`(async () => {
    const smoke = window.murdawkUplinkSmoke;
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const requiredHooks = [
      'seed',
      'intake',
      'setCurrentFolder',
      'automaticQueue',
      'pauseAll',
      'cancel',
      'running',
      'beforePauseClose',
      'uploadEvent',
      'automaticQueueSnapshot',
      'configureQueueMock',
      'queueMockSnapshot',
      'setProfile',
      'eventIntake'
    ];
    const hooksAvailable = requiredHooks.every((name) => typeof smoke[name] === 'function');
    if (!hooksAvailable) return { hooksAvailable };

    smoke.seed({ jobs: [] });
    const intake = smoke.intake(
      ['C:/Seeded Intake/clip.mov'],
      'frozen/destination'
    );
    smoke.setCurrentFolder('changed/current-folder');
    await intake;

    let successful = smoke.automaticQueueSnapshot();
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (successful.jobs[0]?.status === 'complete') break;
      await delay(10);
      successful = smoke.automaticQueueSnapshot();
    }
    const intakeTrace = successful.trace.find((entry) => entry.event === 'intake');
    const lifecycleEvents = successful.trace.map((entry) => entry.event);
    const resultConfirmation = successful.trace.find((entry) => entry.event === 'result-confirmed');
    const lifecyclePrefixes = successful.trace
      .flatMap((entry) => entry.jobs)
      .filter((job) => job.id === successful.jobs[0]?.id)
      .map((job) => job.prefix);

    smoke.configureQueueMock({
      precheckOutcomes: [{ ok: false, error: 'Mocked pre-check failure' }],
      uploadOutcomes: [],
      resetCalls: true
    });
    smoke.seed({
      jobs: [
        {
          id: 'failed-precheck',
          sources: ['C:/Seeded Intake/bad.mov'],
          settings: {
            profile: {
              remote: 'media',
              bucket: 'media',
              endpointHost: 'media.nyc3.digitaloceanspaces.com'
            },
            prefix: 'failed/precheck',
            filterMode: 'all',
            include: '',
            folderUploadMode: 'package',
            publicRead: true,
            checksum: 'size',
            notifyOn: 'success'
          },
          status: 'queued'
        },
        {
          id: 'later-work',
          sources: ['C:/Seeded Intake/later.mov'],
          settings: {
            profile: {
              remote: 'media',
              bucket: 'media',
              endpointHost: 'media.nyc3.digitaloceanspaces.com'
            },
            prefix: 'must/not/start',
            filterMode: 'all',
            include: '',
            folderUploadMode: 'package',
            publicRead: true,
            checksum: 'size',
            notifyOn: 'success'
          },
          status: 'queued'
        }
      ]
    });
    await smoke.automaticQueue();
    const stopped = smoke.automaticQueueSnapshot();
    const failureCalls = smoke.queueMockSnapshot().calls;
    const failedRow = document.querySelector('[data-shelf-job-id="failed-precheck"]');
    const advancedQueue = document.getElementById('queueDrawer');
    const advancedQueueHidden = window.getComputedStyle(advancedQueue).display === 'none';

    smoke.configureQueueMock({
      uploadOutcomes: [{ ok: false, error: 'Mocked transfer failure' }],
      resetCalls: true
    });
    smoke.seed({
      jobs: [
        { id: 'upload-failure', sources: ['C:/Seeded Intake/upload-failure.mov'], settings: { prefix: 'fail/upload' }, status: 'ready' },
        { id: 'after-upload-failure', sources: ['C:/Seeded Intake/after.mov'], settings: { prefix: 'fail/after' }, status: 'queued' }
      ]
    });
    await smoke.automaticQueue();
    const uploadFailure = smoke.automaticQueueSnapshot();
    const uploadFailureCalls = smoke.queueMockSnapshot().calls;

    smoke.configureQueueMock({
      uploadOutcomes: [{ verificationMismatch: true }],
      resetCalls: true
    });
    smoke.seed({
      jobs: [
        { id: 'verification-mismatch', sources: ['C:/Seeded Intake/mismatch.mov'], settings: { prefix: 'fail/verification' }, status: 'ready' },
        { id: 'after-verification-mismatch', sources: ['C:/Seeded Intake/after-mismatch.mov'], settings: { prefix: 'fail/after-mismatch' }, status: 'queued' }
      ]
    });
    await smoke.automaticQueue();
    const verificationMismatch = smoke.automaticQueueSnapshot();

    smoke.configureQueueMock({ resetCalls: true });
    smoke.seed({
      jobs: [
        { id: 'credential-folder', sources: [${JSON.stringify(sensitiveRoot)}], settings: { prefix: 'blocked/credential', filterMode: 'all', publicRead: true }, status: 'queued' },
        { id: 'after-credential', sources: ['C:/Seeded Intake/after-credential.mov'], settings: { prefix: 'blocked/after' }, status: 'queued' }
      ]
    });
    await smoke.automaticQueue();
    const credentialBlocked = smoke.automaticQueueSnapshot();
    const credentialCalls = smoke.queueMockSnapshot().calls;

    smoke.configureQueueMock({ resetCalls: true });
    smoke.seed({ jobs: [] });
    smoke.setProfile({ remote: 'switched-remote', bucket: 'switched-bucket', endpointHost: 'switched.example.test' });
    const eventRequest = {
      manifest: {
        remote: 'manifest-remote',
        bucket: 'manifest-bucket',
        endpointHost: 'manifest.example.test',
        uploadDefaults: { publicRead: true }
      },
      candidates: [{
        sourcePath: 'C:/Event Workspace/camera-a.mov',
        destinationPath: 'event/recordings/raw/Main/Day 1/Cameras/camera-a.mov'
      }]
    };
    const firstEventIntake = await smoke.eventIntake(eventRequest);
    const duplicateEventIntake = await smoke.eventIntake(eventRequest);
    let eventQueue = smoke.automaticQueueSnapshot();
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (eventQueue.jobs[0]?.status === 'complete') break;
      await delay(10);
      eventQueue = smoke.automaticQueueSnapshot();
    }
    const eventCalls = smoke.queueMockSnapshot().calls;

    smoke.configureQueueMock({
      saveOutcomes: [{ ok: false, error: 'Mocked durable save failure' }],
      resetCalls: true
    });
    smoke.seed({ jobs: [] });
    await smoke.intake(['C:/Seeded Intake/not-persisted.mov'], 'persistence/failure');
    await delay(20);
    const persistenceFailure = smoke.automaticQueueSnapshot();
    const persistenceCalls = smoke.queueMockSnapshot().calls;

    const pauseFixture = {
      jobs: [{
        id: 'pause-row',
        sources: ['C:/Seeded Intake/pause.mov'],
        settings: {
          profile: { remote: 'media', bucket: 'media', endpointHost: 'media.nyc3.digitaloceanspaces.com' },
          prefix: 'pause/success',
          filterMode: 'all',
          folderUploadMode: 'package',
          publicRead: true,
          checksum: 'size',
          notifyOn: 'success'
        },
        status: 'uploading'
      }],
      activeJobId: 'pause-row',
      activeTransfer: {
        isRunning: true,
        isLifecycleActive: true,
        activeJobId: 'pause-upload',
        intentId: 'pause-row',
        phase: 'uploading',
        profile: { remote: 'media', bucket: 'media', endpointHost: 'media.nyc3.digitaloceanspaces.com' }
      }
    };
    smoke.configureQueueMock({ resetCalls: true });
    smoke.seed(pauseFixture);
    await smoke.pauseAll();
    await delay(20);
    const pauseSuccess = smoke.automaticQueueSnapshot();
    const pauseSuccessCalls = smoke.queueMockSnapshot().calls;

    smoke.configureQueueMock({
      pauseOutcomes: [{ ok: false, error: 'Mocked paused record failure', delayMs: 40 }],
      saveOutcomes: [{ ok: true }, { ok: true }],
      resetCalls: true
    });
    smoke.seed(pauseFixture);
    smoke.running(true);
    const pendingPauseFailure = smoke.pauseAll();
    await delay(10);
    const cancelDisabledDuringPause = document.getElementById('cancel')?.disabled === true;
    const cancelPauseTitle = document.getElementById('cancel')?.title || '';
    await pendingPauseFailure;
    await delay(20);
    const pauseRecordFailure = smoke.automaticQueueSnapshot();
    const pauseRecordFailureCalls = smoke.queueMockSnapshot().calls;
    const cancelEnabledAfterPauseRollback = document.getElementById('cancel')?.disabled === false;

    smoke.configureQueueMock({
      saveOutcomes: [{ ok: false, error: 'Mocked pausing settings failure' }],
      resetCalls: true
    });
    smoke.seed(pauseFixture);
    await smoke.pauseAll();
    await delay(20);
    const pauseSettingsFailure = smoke.automaticQueueSnapshot();
    const pauseSettingsFailureCalls = smoke.queueMockSnapshot().calls;

    smoke.configureQueueMock({
      saveOutcomes: [
        { ok: false, error: 'Late pausing settings failure', delayMs: 40 },
        { ok: true }
      ],
      resetCalls: true
    });
    smoke.seed(pauseFixture);
    smoke.running(true);
    const prePersistencePause = smoke.pauseAll();
    await delay(10);
    smoke.uploadEvent('upload:cancelled', {
      jobId: 'pause-upload',
      intentId: 'pause-row',
      message: 'Terminal cancellation during pausing settings write'
    });
    await prePersistencePause;
    await delay(20);
    const terminalBeforeSettingsFailure = smoke.automaticQueueSnapshot();
    const terminalBeforeSettingsFailureCalls = smoke.queueMockSnapshot().calls;

    smoke.configureQueueMock({
      saveOutcomes: [{ ok: true }, { ok: true }],
      resetCalls: true
    });
    smoke.seed(pauseFixture);
    await smoke.beforePauseClose(pauseFixture.activeTransfer);
    smoke.uploadEvent('upload:pause-failed', {
      clientJobId: 'pause-row',
      intentId: 'pause-row',
      jobId: 'pause-upload',
      phase: 'uploading',
      message: 'Mocked close pause durability failure'
    });
    await delay(20);
    const closePauseFailure = smoke.automaticQueueSnapshot();
    const closePauseFailureCalls = smoke.queueMockSnapshot().calls;

    smoke.configureQueueMock({
      cancelOutcomes: [{ ok: false, emitCancelled: true, eventDelayMs: 20, resolveDelayMs: 40, error: 'Late cancel IPC failure' }],
      saveOutcomes: [{ ok: true }, { ok: true }],
      resetCalls: true
    });
    smoke.seed(pauseFixture);
    smoke.running(true);
    const cancelFirst = smoke.cancel();
    const pauseDisabledAfterCancelClaim = document.getElementById('transferShelfPauseAll')?.disabled === true;
    await smoke.beforePauseClose(pauseFixture.activeTransfer);
    const cancelFirstPauseAttempt = await smoke.pauseAll();
    await delay(25);
    const statusBeforeLatePauseFailure = smoke.automaticQueueSnapshot().jobs[0]?.status;
    smoke.uploadEvent('upload:pause-failed', {
      clientJobId: 'pause-row',
      intentId: 'pause-row',
      jobId: 'pause-upload',
      phase: 'cancelling',
      terminalAction: 'cancelled',
      message: 'Cancellation already owns terminalization'
    });
    const cancelFirstResult = await cancelFirst;
    await delay(20);
    const cancelFirstPauseSecond = smoke.automaticQueueSnapshot();
    const cancelFirstPauseSecondCalls = smoke.queueMockSnapshot().calls;

    smoke.configureQueueMock({
      pauseOutcomes: [{ ok: false, error: 'Late pause rejection', delayMs: 40 }],
      saveOutcomes: [{ ok: true }, { ok: true }],
      resetCalls: true
    });
    smoke.seed(pauseFixture);
    smoke.running(true);
    const stalePause = smoke.pauseAll();
    await delay(10);
    smoke.uploadEvent('upload:cancelled', {
      jobId: 'pause-upload',
      intentId: 'pause-row',
      message: 'Cancellation won before pause rejected'
    });
    await stalePause;
    await delay(20);
    const terminalBeforePauseRollback = smoke.automaticQueueSnapshot();
    const terminalBeforePauseRollbackCalls = smoke.queueMockSnapshot().calls;

    smoke.configureQueueMock({
      cancelOutcomes: [{ ok: false, resolveDelayMs: 30, error: 'Mocked cancel persistence failure' }],
      resetCalls: true
    });
    smoke.seed(pauseFixture);
    smoke.running(true);
    const failedCancel = smoke.cancel();
    const cancelFailurePending = {
      pauseDisabled: document.getElementById('transferShelfPauseAll')?.disabled === true,
      status: document.querySelector('[data-shelf-job-id="pause-row"] .transfer-shelf-status')?.textContent || ''
    };
    const failedCancelResult = await failedCancel;
    await delay(20);
    const cancelFailureRolledBack = {
      queue: smoke.automaticQueueSnapshot(),
      pauseEnabled: document.getElementById('transferShelfPauseAll')?.disabled === false,
      cancelEnabled: document.getElementById('cancel')?.disabled === false
    };

    smoke.configureQueueMock({
      pauseOutcomes: [{ ok: false, error: 'Mocked losing pause', delayMs: 40 }],
      saveOutcomes: [{ ok: true }, { ok: true }],
      resetCalls: true
    });
    smoke.seed(pauseFixture);
    smoke.running(true);
    const pauseFirst = smoke.pauseAll();
    await delay(10);
    const cancelSecondResult = await smoke.cancel();
    await pauseFirst;
    await delay(20);
    const pauseFirstCancelSecond = smoke.automaticQueueSnapshot();
    const pauseFirstCancelSecondCalls = smoke.queueMockSnapshot().calls;

    return {
      hooksAvailable,
      successful,
      intakeShelfOpened: intakeTrace?.shelfOpen === true,
      lifecycleEvents,
      resultCompletedByEvent: resultConfirmation?.details?.eventComplete === true,
      lifecyclePrefixes,
      stopped,
      failureCalls,
      retryVisible: failedRow?.querySelector('[data-queue-recovery="retry"]')?.textContent.trim() === 'Retry',
      failedReasonVisible: failedRow?.innerText.includes('Mocked pre-check failure') === true,
      pauseAllEnabledAfterRollback: document.getElementById('transferShelfPauseAll')?.disabled === false,
      advancedQueueHidden,
      uploadFailure,
      uploadFailureCalls,
      verificationMismatch,
      credentialBlocked,
      credentialCalls,
      firstEventAdded: firstEventIntake?.added?.length || 0,
      duplicateEventCount: duplicateEventIntake?.duplicates?.length || 0,
      eventQueue,
      eventCalls,
      persistenceFailure,
      persistenceCalls,
      pauseSuccess,
      pauseSuccessCalls,
      pauseRecordFailure,
      pauseRecordFailureCalls,
      cancelDisabledDuringPause,
      cancelPauseTitle,
      cancelEnabledAfterPauseRollback,
      pauseSettingsFailure,
      pauseSettingsFailureCalls,
      terminalBeforeSettingsFailure,
      terminalBeforeSettingsFailureCalls,
      closePauseFailure,
      closePauseFailureCalls,
      pauseDisabledAfterCancelClaim,
      statusBeforeLatePauseFailure,
      cancelFirstPauseSecond,
      cancelFirstPauseSecondCalls,
      cancelFirstResult,
      cancelFirstPauseAttempt,
      terminalBeforePauseRollback,
      terminalBeforePauseRollbackCalls,
      cancelFailurePending,
      failedCancelResult,
      cancelFailureRolledBack,
      cancelSecondResult,
      pauseFirstCancelSecond,
      pauseFirstCancelSecondCalls,
    };
  })()`);

  assert(behavior.hooksAvailable, 'Automatic queue smoke hooks should be available through the mocked-preload renderer.');
  assert(behavior.intakeShelfOpened, 'A seeded intake should open the transfer shelf before automatic work starts.');
  assert(
    behavior.lifecycleEvents.includes('prechecking'),
    'A seeded intake should enter prechecking automatically.',
  );
  assert(
    ['prechecking', 'ready', 'uploading', 'verifying', 'complete']
      .every((status) => behavior.lifecycleEvents.includes(status)),
    'The event-backed mock should advance through checking, upload, verification, and completion.',
  );
  assert(behavior.resultCompletedByEvent, 'The completion event should update the job before result fallback is considered.');
  assert(
    behavior.successful.jobs[0]?.status === 'complete',
    'The mocked successful automatic lifecycle should complete the seeded intake.',
  );
  assert(
    behavior.successful.jobs[0]?.prefix === 'frozen/destination' &&
      behavior.successful.currentPrefix === 'changed/current-folder' &&
      behavior.lifecyclePrefixes.every((prefix) => prefix === 'frozen/destination'),
    'Automatic intake should retain its frozen destination after the current folder changes.',
  );
  assert(
    behavior.stopped.jobs.find((job) => job.id === 'failed-precheck')?.status === 'failed',
    'The mocked failed pre-check should remain an attention state.',
  );
  assert(
    behavior.stopped.jobs.find((job) => job.id === 'later-work')?.status === 'queued',
    'A failed pre-check should prevent later automatic work from starting.',
  );
  assert(
    behavior.failureCalls.filter((call) => call.type === 'precheck').length === 1 &&
      behavior.failureCalls.every((call) => call.type !== 'upload'),
    'A genuine mocked pre-check failure should stop before upload and before checking later work.',
  );
  assert(behavior.retryVisible, 'Failed shelf work should retain a Retry recovery action.');
  assert(behavior.failedReasonVisible, 'Failed shelf work should explain the recorded problem beside Retry.');
  assert(behavior.pauseAllEnabledAfterRollback, 'Pause All should become available again when a failed pause rolls back and transfer continues.');
  assert(behavior.advancedQueueHidden, 'Manual transfer controls should remain hidden in normal Explorer mode.');
  assert(
    behavior.uploadFailure.jobs.find((job) => job.id === 'upload-failure')?.status === 'failed' &&
      behavior.uploadFailure.jobs.find((job) => job.id === 'after-upload-failure')?.status === 'queued',
    'A mocked upload failure should fail its ready job and stop later work.',
  );
  assert(
    behavior.uploadFailureCalls.filter((call) => call.type === 'upload').length === 1 &&
      behavior.uploadFailureCalls.every((call) => call.prefix !== 'fail/after'),
    'Upload failure should not start the later queued lifecycle.',
  );
  assert(
    ['uploading', 'failed'].every((status) => behavior.uploadFailure.trace.some((entry) => entry.event === status)),
    'Upload failure smoke should retain event-backed uploading and failed transitions.',
  );
  assert(
    behavior.verificationMismatch.jobs.find((job) => job.id === 'verification-mismatch')?.status === 'failed' &&
      behavior.verificationMismatch.jobs.find((job) => job.id === 'after-verification-mismatch')?.status === 'queued',
    'A mocked verification mismatch should fail its upload and stop later work.',
  );
  assert(
    ['uploading', 'verifying', 'failed'].every((status) => behavior.verificationMismatch.trace.some((entry) => entry.event === status)),
    'Verification mismatch smoke should retain uploading, verifying, and failed transitions.',
  );
  assert(
    behavior.credentialBlocked.jobs.find((job) => job.id === 'credential-folder')?.status === 'blocked' &&
      behavior.credentialBlocked.jobs.find((job) => job.id === 'after-credential')?.status === 'queued',
    'A credential-like file nested in an all-files/public-read folder should block the batch and later work.',
  );
  assert(
    behavior.credentialCalls.filter((call) => call.type === 'precheck').length === 1 &&
      behavior.credentialCalls.every((call) => call.type !== 'upload'),
    'Credential-like intake should stop before mocked upload.',
  );
  assert(
    behavior.firstEventAdded === 1 && behavior.duplicateEventCount === 1 && behavior.eventQueue.jobs.length === 1,
    'Repeated Event Workspace intake should append one durable job and deduplicate the repeat.',
  );
  assert(
    behavior.eventQueue.jobs[0]?.profile?.remote === 'manifest-remote' &&
      behavior.eventQueue.jobs[0]?.profile?.bucket === 'manifest-bucket' &&
      behavior.eventQueue.jobs[0]?.profile?.endpointHost === 'manifest.example.test' &&
      /^unmanaged-[a-f0-9]{32}$/.test(behavior.eventQueue.jobs[0]?.connectionId || '') &&
      behavior.eventQueue.jobs[0]?.status === 'complete',
    'Event Workspace intake should freeze the manifest profile, use an unmanaged identity when it differs from the active connection, and schedule automatically.',
  );
  assert(
    behavior.eventCalls.filter((call) => call.type === 'precheck').length === 1 &&
      behavior.eventCalls.filter((call) => call.type === 'upload').length === 1,
    'Deduplicated Event Workspace intake should run one automatic lifecycle.',
  );
  assert(
    behavior.persistenceFailure.jobs[0]?.status === 'queued' &&
      behavior.persistenceCalls.every((call) => !['precheck', 'upload'].includes(call.type)),
    'A durable persistence failure should leave intake queued and must not start automatic work.',
  );
  assert(
    behavior.pauseSuccess.jobs[0]?.status === 'paused'
      && behavior.pauseSuccessCalls[0]?.type === 'save-settings'
      && behavior.pauseSuccessCalls[0]?.queueJobs[0]?.status === 'pausing'
      && behavior.pauseSuccessCalls[1]?.type === 'pause'
      && behavior.pauseSuccessCalls.some((call) => call.type === 'save-settings' && call.queueJobs[0]?.status === 'paused'),
    'Pause All should persist pausing before IPC and settle the shelf row to paused.',
  );
  assert(
    behavior.pauseRecordFailure.jobs[0]?.status === 'uploading'
      && behavior.pauseRecordFailureCalls[0]?.queueJobs[0]?.status === 'pausing'
      && behavior.pauseRecordFailureCalls[1]?.type === 'pause'
      && behavior.pauseRecordFailureCalls.at(-1)?.queueJobs[0]?.status === 'uploading',
    'A main paused-record failure should restore and persist the active renderer row.',
  );
  assert(
    behavior.cancelDisabledDuringPause
      && /pause/i.test(behavior.cancelPauseTitle)
      && behavior.cancelEnabledAfterPauseRollback,
    'Cancel should be disabled while pause persistence is pending and restored after rollback.',
  );
  assert(
    behavior.pauseSettingsFailure.jobs[0]?.status === 'uploading'
      && behavior.pauseSettingsFailureCalls.every((call) => call.type !== 'pause')
      && behavior.pauseSettingsFailureCalls.at(-1)?.queueJobs?.[0]?.status === 'uploading',
    'A renderer pausing-state persistence failure must not invoke pause IPC or claim paused.',
  );
  assert(
    behavior.terminalBeforeSettingsFailure.jobs[0]?.status === 'cancelled'
      && behavior.terminalBeforeSettingsFailureCalls.every((call) => call.type !== 'pause')
      && behavior.terminalBeforeSettingsFailureCalls.at(-1)?.queueJobs?.[0]?.status === 'cancelled',
    'A terminal event during delayed pausing persistence must survive the later settings rejection.',
  );
  assert(
    behavior.closePauseFailure.jobs[0]?.status === 'uploading'
      && behavior.closePauseFailureCalls[0]?.queueJobs[0]?.status === 'pausing'
      && behavior.closePauseFailureCalls[1]?.type === 'queue-persist-ack'
      && behavior.closePauseFailureCalls[1]?.ok === true
      && behavior.closePauseFailureCalls.at(-1)?.queueJobs[0]?.status === 'uploading',
    'A close-path paused-record failure should restore the renderer row after its durable pausing acknowledgement.',
  );
  assert(
    behavior.pauseDisabledAfterCancelClaim
      && behavior.cancelFirstResult?.ok === false
      && behavior.cancelFirstPauseAttempt?.ok === false
      && behavior.statusBeforeLatePauseFailure === 'cancelled'
      && behavior.cancelFirstPauseSecond.jobs[0]?.status === 'cancelled'
      && behavior.cancelFirstPauseSecondCalls.every((call) => call.type !== 'pause')
      && behavior.cancelFirstPauseSecondCalls.every((call) => call.queueJobs?.[0]?.status !== 'pausing')
      && behavior.cancelFirstPauseSecondCalls.some((call) => call.type === 'queue-persist-ack' && call.ok === false)
      && behavior.cancelFirstPauseSecondCalls.at(-1)?.queueJobs?.[0]?.status !== 'uploading',
    'Cancel-first should disable Pause All and a late pause rejection must not overwrite the cancelled row.',
  );
  assert(
    behavior.terminalBeforePauseRollback.jobs[0]?.status === 'cancelled'
      && behavior.terminalBeforePauseRollbackCalls.at(-1)?.queueJobs?.[0]?.status !== 'uploading',
    'A terminal cancellation arriving before pause rejection must prevent stale pause rollback.',
  );
  assert(
    behavior.cancelFailurePending.pauseDisabled
      && behavior.cancelFailurePending.status === 'Cancelling'
      && behavior.failedCancelResult?.ok === false
      && behavior.cancelFailureRolledBack.queue.jobs[0]?.status === 'uploading'
      && behavior.cancelFailureRolledBack.pauseEnabled
      && behavior.cancelFailureRolledBack.cancelEnabled,
    'A failed optimistic cancellation should restore actions only while its own cancelling token is current.',
  );
  assert(
    behavior.cancelSecondResult?.ok === false
      && behavior.pauseFirstCancelSecond.jobs[0]?.status === 'uploading'
      && behavior.pauseFirstCancelSecondCalls.every((call) => call.type !== 'cancel'),
    'Pause-first should reject a renderer cancellation attempt and remain truthful after pause rollback.',
  );

  window.close();
}

async function inspectStartupQueueScenario(smokeScenario) {
  const window = new BrowserWindow({
    width: 1280,
    height: 768,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, 'ui-smoke-preload.js'),
    },
  });

  await window.loadFile(path.join(appDir, 'src', 'renderer', 'index.html'), {
    query: { smoke: '1', smokeScenario },
  });
  await waitForSmokeHook(window);

  let result = null;
  let explicitResumeStarted = false;
  let workCallsBeforeExplicitResume = null;
  let externalActionsStarted = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    result = await window.webContents.executeJavaScript(`(() => {
      const smoke = window.murdawkUplinkSmoke;
      const queue = smoke.automaticQueueSnapshot();
      const mock = smoke.queueMockSnapshot();
      return {
        queue,
        calls: mock.calls,
        manualControlsDisabled: ['dryRun', 'upload', 'checkUploadSelected', 'dryRunSelected', 'uploadSelected']
          .every((id) => document.getElementById(id)?.disabled === true),
        retryVisible: Boolean(document.querySelector('[data-shelf-job-id="restored-blocked"] [data-queue-recovery="retry"]')),
        checkAndResumeVisible: Boolean(document.querySelector('[data-shelf-job-id="restored-needs-resume"] [data-queue-recovery="resume"]')),
        pauseAllDisabled: document.getElementById('transferShelfPauseAll')?.disabled === true,
        pauseAllTitle: document.getElementById('transferShelfPauseAll')?.title || '',
        pauseAllLabel: document.getElementById('transferShelfPauseAll')?.getAttribute('aria-label') || '',
        logText: document.getElementById('log')?.textContent || '',
      };
    })()`);
    const statuses = result.queue.jobs.map((job) => job.status);
    const navigationFinished = result.calls.some((call) => call.type === 'list-remote');
    if (smokeScenario === 'paused-explicit-resume' && navigationFinished && !explicitResumeStarted) {
      explicitResumeStarted = true;
      await window.webContents.executeJavaScript(`document.querySelector('[data-shelf-job-id="restored-paused"] [data-queue-recovery="resume"]')?.click()`);
    }
    if (smokeScenario === 'orphaned-inflight' && navigationFinished && attempt >= 10 && !explicitResumeStarted) {
      explicitResumeStarted = true;
      workCallsBeforeExplicitResume = result.calls.filter((call) => ['precheck', 'upload'].includes(call.type));
      await window.webContents.executeJavaScript(`document.querySelector('[data-shelf-job-id="orphaned-prechecking"] [data-queue-recovery="resume"]')?.click()`);
    }
    if (smokeScenario === 'cross-profile-live' && navigationFinished && !externalActionsStarted) {
      externalActionsStarted = true;
      await window.webContents.executeJavaScript(`window.murdawkUplinkSmoke.intake(
        ['C:/External Guard/queued-while-busy.mov'],
        'restored/waiting-intake'
      )`);
      await window.webContents.executeJavaScript(`document.querySelector(
        '[data-shelf-job-id="cross-profile-row"] [data-queue-recovery="resume"]'
      )?.click()`);
    }
    const ready = smokeScenario === 'restored-automatic'
      ? statuses.join(',') === 'needs-resume-check,queued' && navigationFinished && attempt >= 10
      : smokeScenario === 'restored-ready'
        ? statuses.length === 2 && statuses.every((status) => status === 'complete')
      : smokeScenario === 'restored-precheck-failure'
        ? statuses[0] === 'failed'
        : smokeScenario === 'live-reattachment'
          ? result.queue.isRunning && navigationFinished && attempt >= 10
        : smokeScenario === 'verifying-no-child'
          ? result.queue.isRunning && statuses[0] === 'verifying' && navigationFinished && attempt >= 10
        : smokeScenario === 'cancelled-stale'
          ? statuses[0] === 'cancelled' && navigationFinished && attempt >= 10
        : smokeScenario === 'active-completes-between-reads'
          ? statuses[0] === 'complete' && !result.queue.isRunning && navigationFinished
        : smokeScenario === 'recovery-read-failure'
          ? navigationFinished && attempt >= 10
        : smokeScenario === 'cross-profile-live'
          ? statuses.length === 2 && statuses[1] === 'queued' && attempt >= 10
        : smokeScenario === 'external-releases'
          ? statuses.length === 1 && statuses[0] === 'complete'
        : smokeScenario === 'orphaned-inflight'
          ? statuses.join(',') === 'complete,needs-resume-check,needs-resume-check,paused'
        : smokeScenario === 'paused-explicit-resume'
          ? statuses.length === 1 && statuses[0] === 'complete'
        : navigationFinished && attempt >= 10;
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  result.workCallsBeforeExplicitResume = workCallsBeforeExplicitResume || [];
  window.close();
  return result;
}

async function runResumePersistenceRollbackScenario() {
  const window = new BrowserWindow({
    width: 1280,
    height: 768,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, 'ui-smoke-preload.js'),
    },
  });

  await window.loadFile(path.join(appDir, 'src', 'renderer', 'index.html'), {
    query: { smoke: '1', smokeScenario: 'resume-persistence-retry' },
  });
  await waitForSmokeHook(window);
  await waitForWindowCondition(
    window,
    `window.spacesUploader.queueMockSnapshot().calls.some((call) => call.type === 'list-remote')
      && Boolean(document.querySelector('[data-shelf-job-id="resume-persistence-row"] [data-queue-recovery="resume"]'))`,
    'held interrupted resume row',
  );

  const failed = await window.webContents.executeJavaScript(`(async () => {
    const smoke = window.murdawkUplinkSmoke;
    window.spacesUploader.configureQueueMock({
      saveOutcomes: [{ ok: false, delayMs: 80, error: 'Mocked resume persistence failure' }],
      resetCalls: false,
    });
    document.querySelector('[data-shelf-job-id="resume-persistence-row"] [data-queue-recovery="resume"]')?.click();
    await smoke.automaticQueue();
    await new Promise((resolve) => setTimeout(resolve, 130));
    await smoke.automaticQueue();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const snapshot = smoke.automaticQueueSnapshot();
    const calls = window.spacesUploader.queueMockSnapshot().calls;
    return {
      calls,
      status: snapshot.jobs[0]?.status || '',
      retryVisible: Boolean(document.querySelector('[data-shelf-job-id="resume-persistence-row"] [data-queue-recovery="resume"]')),
    };
  })()`);

  await window.webContents.executeJavaScript(`(() => {
    window.spacesUploader.configureQueueMock({ saveOutcomes: [], resetCalls: false });
    document.querySelector('[data-shelf-job-id="resume-persistence-row"] [data-queue-recovery="resume"]')?.click();
  })()`);

  let successful = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    successful = await window.webContents.executeJavaScript(`(() => ({
      queue: window.murdawkUplinkSmoke.automaticQueueSnapshot(),
      calls: window.spacesUploader.queueMockSnapshot().calls,
    }))()`);
    if (successful.queue.jobs[0]?.status === 'complete') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  window.close();
  return { failed, successful };
}

async function runStartupAutomaticQueueScenarios() {
  const resumePersistence = await runResumePersistenceRollbackScenario();
  assert(
    resumePersistence.failed.status === 'needs-resume-check'
      && resumePersistence.failed.retryVisible
      && resumePersistence.failed.calls.every((call) => !['precheck', 'upload'].includes(call.type)),
    'A failed resume settings write must restore the held row and block every scheduler trigger.',
  );
  const resumePrechecks = resumePersistence.successful.calls.filter((call) => call.type === 'precheck');
  const resumeUploads = resumePersistence.successful.calls.filter((call) => call.type === 'upload');
  const persistedResumeIndex = resumePersistence.successful.calls.findIndex((call) =>
    call.type === 'save-settings'
    && call.queueJobs[0]?.id === 'resume-persistence-row'
    && call.queueJobs[0]?.status === 'queued');
  const resumedPrecheckIndex = resumePersistence.successful.calls.findIndex((call) => call.type === 'precheck');
  assert(
    resumePersistence.successful.queue.jobs[0]?.status === 'complete'
      && resumePrechecks.length === 1
      && resumeUploads.length === 1
      && persistedResumeIndex >= 0
      && resumedPrecheckIndex > persistedResumeIndex,
    'Retrying Check and resume should persist first and run exactly one pre-check and upload.',
  );

  const restored = await inspectStartupQueueScenario('restored-automatic');
  const restoredPrechecks = restored.calls.filter((call) => call.type === 'precheck');
  const restoredUploads = restored.calls.filter((call) => call.type === 'upload');
  const firstPrecheckIndex = restored.calls.findIndex((call) => call.type === 'precheck');
  const lastNavigationIndex = restored.calls.reduce(
    (last, call, index) => call.type === 'list-remote' ? index : last,
    -1,
  );
  assert(
    restored.queue.jobs.map((job) => job.status).join(',') === 'needs-resume-check,queued',
    'Restored interrupted work should remain held with later queued work behind it.',
  );
  assert(
    restoredPrechecks.length === 0 && restoredUploads.length === 0,
    'Startup must not automatically pre-check or upload interrupted work.',
  );
  assert(
    lastNavigationIndex >= 0 && firstPrecheckIndex === -1,
    'Startup should finish initial navigation while interrupted work remains held.',
  );

  const restoredReady = await inspectStartupQueueScenario('restored-ready');
  const restoredReadyWork = restoredReady.calls.filter((call) => ['precheck', 'upload'].includes(call.type));
  assert(
    restoredReady.queue.jobs.every((job) => job.status === 'complete'),
    `Restored ready work and its later queued job should complete automatically. ${JSON.stringify({ queue: restoredReady.queue, calls: restoredReady.calls })}`,
  );
  assert(
    restoredReadyWork[0]?.type === 'upload' &&
      restoredReadyWork[0]?.prefixes?.[0] === 'restored/ready' &&
      restoredReadyWork.filter((call) => call.type === 'precheck').map((call) => call.prefix).join(',') === 'restored/after-ready',
    'A restored ready job should upload before later queued work and should not be pre-checked again.',
  );

  const live = await inspectStartupQueueScenario('live-reattachment');
  assert(
    live.queue.isRunning === true &&
      live.queue.activeQueueJobId === 'live-queue-row' &&
      live.queue.jobs.find((job) => job.id === 'live-queue-row')?.status === 'uploading',
    'A genuinely live transfer should reattach the renderer running state and active queue association.',
  );
  assert(
    live.manualControlsDisabled && live.calls.every((call) => !['precheck', 'upload'].includes(call.type)),
    'Live reattachment should keep manual controls and the automatic scheduler locked.',
  );
  assert(
    live.pauseAllDisabled === false && live.pauseAllLabel === 'Pause active transfer',
    'A renderer-owned live upload should enable the accessible Pause All control.',
  );
  assert(
    live.calls.some((call) =>
      call.type === 'save-settings'
      && call.queueJobs.find((job) => job.id === 'live-queue-row')?.jobId === 'mock-live-upload'),
    'Live reattachment should replace the stale dry-run id with the active upload id.',
  );

  const orphaned = await inspectStartupQueueScenario('orphaned-inflight');
  const orphanedRecoverySave = orphaned.calls.find((call) =>
    call.type === 'save-settings'
    && call.queueJobs.length === 4
    && call.queueJobs.slice(0, 3).every((job) => job.status === 'needs-resume-check')
    && call.queueJobs[3]?.status === 'paused');
  assert(orphanedRecoverySave, 'Orphaned active phases should require checks while pausing settles to paused.');
  assert(
    orphaned.workCallsBeforeExplicitResume.length === 0,
    'Recovered orphaned active work must remain held until Check and resume is explicit.',
  );
  assert(
    orphaned.calls.filter((call) => call.type === 'precheck').length === 1
      && orphaned.calls.filter((call) => call.type === 'upload').length === 1
      && orphaned.calls.find((call) => call.type === 'precheck')?.prefix === 'restored/prechecking'
      && orphaned.queue.jobs.map((job) => job.status).join(',') === 'complete,needs-resume-check,needs-resume-check,paused',
    'Explicit Check and resume should run one fresh lifecycle without duplicates or leapfrogging later interrupted work.',
  );

  const verifying = await inspectStartupQueueScenario('verifying-no-child');
  assert(
    verifying.queue.isRunning && verifying.queue.activeQueueJobId === 'verifying-row'
      && verifying.queue.jobs[0]?.status === 'verifying' && verifying.manualControlsDisabled,
    'A childless active verification lifecycle should reattach and lock its exact queue row.',
  );
  assert(
    verifying.calls.every((call) => !['precheck', 'upload'].includes(call.type)),
    'Childless verification must not race a second automatic lifecycle.',
  );
  assert(
    verifying.pauseAllDisabled && /verification/i.test(verifying.pauseAllTitle),
    'Pause All should be disabled with an explanation during verification.',
  );

  const cancelled = await inspectStartupQueueScenario('cancelled-stale');
  assert(
    cancelled.queue.jobs[0]?.status === 'cancelled'
      && cancelled.queue.jobs[1]?.status === 'queued'
      && cancelled.calls.every((call) => !['precheck', 'upload'].includes(call.type)),
    'A durable cancelled record should override stale uploading state and stop later work.',
  );

  const finishedDuringStartup = await inspectStartupQueueScenario('active-completes-between-reads');
  assert(
    finishedDuringStartup.queue.jobs[0]?.status === 'complete'
      && finishedDuringStartup.queue.jobs[1]?.status === 'paused'
      && finishedDuringStartup.queue.isRunning === false
      && finishedDuringStartup.manualControlsDisabled === false
      && finishedDuringStartup.calls.every((call) => !['precheck', 'upload'].includes(call.type)),
    'Startup revalidation should reconcile a finishing lifecycle and release the renderer lock.',
  );

  const recoveryFailure = await inspectStartupQueueScenario('recovery-read-failure');
  assert(
    recoveryFailure.queue.jobs[0]?.status === 'queued'
      && recoveryFailure.calls.every((call) => !['precheck', 'upload'].includes(call.type))
      && /Queue recovery is disabled: Mocked recovery snapshot read failure/.test(recoveryFailure.logText),
    'A recovery read failure should remain visible, preserve settings, and disable startup scheduling.',
  );

  const paused = await inspectStartupQueueScenario('paused-stable');
  assert(
    paused.queue.jobs.find((job) => job.id === 'restored-paused')?.status === 'paused'
      && paused.queue.jobs.find((job) => job.id === 'paused-later')?.status === 'queued',
    'Paused work should remain paused across startup and hold later automatic work.',
  );
  assert(
    paused.calls.every((call) => !['precheck', 'upload'].includes(call.type)),
    'Paused startup work must wait for an explicit Check and resume action.',
  );
  assert(
    paused.pauseAllDisabled && /No active upload/i.test(paused.pauseAllTitle),
    'A stable paused shelf should keep Pause All disabled while remaining visible.',
  );

  const explicitResume = await inspectStartupQueueScenario('paused-explicit-resume');
  const explicitPersistIndex = explicitResume.calls.findIndex((call) =>
    call.type === 'save-settings'
    && call.queueJobs[0]?.status === 'queued'
    && call.queueJobs[0]?.jobId === ''
    && call.queueJobs[0]?.resumeFromJobId === 'paused-upload');
  const explicitPrecheckIndex = explicitResume.calls.findIndex((call) => call.type === 'precheck');
  assert(
    explicitPersistIndex >= 0 && explicitPrecheckIndex > explicitPersistIndex,
    'Explicit Check and resume should persist the resume candidate before scheduling.',
  );
  assert(
    explicitResume.calls.find((call) => call.type === 'precheck')?.resumeFromJobId === 'paused-upload',
    'Explicit resume should carry durable resume provenance into the safe pre-check.',
  );

  const crossProfile = await inspectStartupQueueScenario('cross-profile-live');
  assert(
    crossProfile.queue.isRunning === false
      && crossProfile.queue.activeQueueJobId === ''
      && crossProfile.queue.jobs[0]?.status === 'queued'
      && crossProfile.queue.jobs[1]?.status === 'queued',
    'A live lifecycle from another frozen profile must not attach or claim this queue running lock.',
  );
  assert(
    crossProfile.manualControlsDisabled
      && crossProfile.calls.some((call) =>
        call.type === 'save-settings'
        && call.queueJobs.some((job) => job.id !== 'cross-profile-row' && job.status === 'queued'))
      && crossProfile.calls.every((call) => !['precheck', 'upload'].includes(call.type)),
    'External ownership should lock starts while allowing durable waiting intake without scheduling.',
  );
  assert(
    crossProfile.pauseAllDisabled && /another window/i.test(crossProfile.pauseAllTitle),
    'An external lifecycle should explain why this renderer cannot pause it.',
  );

  const externalRelease = await inspectStartupQueueScenario('external-releases');
  assert(
    externalRelease.queue.jobs[0]?.status === 'complete'
      && externalRelease.calls.filter((call) => call.type === 'precheck').length === 1
      && externalRelease.calls.filter((call) => call.type === 'upload').length === 1,
    'An idle recovery snapshot should clear the external guard and wake exactly one waiting lifecycle.',
  );

  const attention = await inspectStartupQueueScenario('restored-attention');
  assert(
    attention.queue.jobs.find((job) => job.id === 'restored-failed')?.status === 'failed' &&
      attention.queue.jobs.find((job) => job.id === 'restored-blocked')?.status === 'blocked' &&
      attention.queue.jobs.find((job) => job.id === 'restored-later')?.status === 'queued',
    'Restored failed or blocked work should stop later startup scheduling.',
  );
  assert(
    attention.calls.every((call) => !['precheck', 'upload'].includes(call.type)),
    'Startup should not invoke pre-check or upload while restored attention work exists.',
  );
  assert(attention.retryVisible, 'Restored blocked work should expose Retry in the shelf.');
  assert(attention.checkAndResumeVisible, 'Restored interrupted work should expose Check and resume in the shelf.');

  const failedPrecheck = await inspectStartupQueueScenario('restored-precheck-failure');
  const failedPrecheckCalls = failedPrecheck.calls.filter((call) => call.type === 'precheck');
  assert(
    failedPrecheck.queue.jobs.find((job) => job.id === 'precheck-failure')?.status === 'failed' &&
      failedPrecheck.queue.jobs.find((job) => job.id === 'precheck-later')?.status === 'queued',
    'A real mocked startup pre-check failure should stop the later restored job.',
  );
  assert(
    failedPrecheckCalls.length === 1 && failedPrecheckCalls[0].prefix === 'restored/precheck-failure' &&
      failedPrecheck.calls.every((call) => call.type !== 'upload'),
    'Failed startup pre-check should not upload or pre-check later work.',
  );
}

async function runTransferShelfCollapseScenario() {
  const window = new BrowserWindow({
    width: 760,
    height: 720,
    useContentSize: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, 'ui-smoke-preload.js'),
    },
  });

  await window.loadFile(path.join(appDir, 'src', 'renderer', 'index.html'), {
    query: { smoke: '1' },
  });
  await waitForSmokeHook(window);
  await window.webContents.executeJavaScript(`
    window.murdawkUplinkSmoke.seed({
      jobs: [
        {
          id: 'job-wrap',
          sources: ['C:/Austria Mix/day-2/logs'],
          settings: {
            profile: {
              remote: 'media',
              bucket: 'media',
              endpointHost: 'media.nyc3.digitaloceanspaces.com'
            },
            prefix: 'archive-event/recordings/raw/stage1/day2/mix',
            filterMode: 'all',
            include: '',
            folderUploadMode: 'package',
            publicRead: true,
            checksum: 'size',
            notifyOn: 'success'
          },
          status: 'uploading'
        }
      ],
      activeJobId: 'job-wrap',
      progress: {
        percent: 42,
        speed: '8.2 MiB/s',
        eta: '1m 12s'
      }
    });
    document.getElementById('transferShelfToggle')?.click();
  `);
  await waitForWindowCondition(
    window,
    `(() => {
      const shelf = document.getElementById('transferShelf');
      const compact = document.querySelector('.transfer-shelf-compact');
      const style = shelf && getComputedStyle(shelf);
      const rect = shelf?.getBoundingClientRect();
      return Boolean(
        shelf && !shelf.hidden && shelf.classList.contains('is-collapsed') &&
        style?.display === 'grid' && style.visibility !== 'hidden' && style.opacity !== '0' &&
        rect && rect.width > 0 && rect.height >= 47 && rect.height <= 49 &&
        rect.top >= 0 && rect.bottom <= innerHeight &&
        compact?.innerText.includes('42%') &&
        compact?.innerText.includes('1 active') &&
        compact?.innerText.includes('8.2 MiB/s') &&
        compact?.innerText.includes('ETA 1m 12s')
      );
    })()`,
    'collapsed transfer shelf fixture',
  );
  await waitForPaint(window);

  const checks = await window.webContents.executeJavaScript(`(() => {
    const shelf = document.getElementById('transferShelf');
    const shelfRect = shelf.getBoundingClientRect();
    const header = shelf.querySelector('.transfer-shelf-head');
    const headerRect = header.getBoundingClientRect();
    const toggle = document.getElementById('transferShelfToggle');
    const toggleRect = toggle.getBoundingClientRect();
    const compact = document.querySelector('.transfer-shelf-compact');
    const compactRect = compact.getBoundingClientRect();
    return {
      collapsed: shelf.classList.contains('is-collapsed'),
      shelfDisplay: getComputedStyle(shelf).display,
      shelfVisibility: getComputedStyle(shelf).visibility,
      shelfHeight: shelfRect.height,
      shelfRect: {
        x: shelfRect.x,
        y: shelfRect.y,
        width: shelfRect.width,
        height: shelfRect.height,
      },
      headerHeight: headerRect.height,
      shelfInBounds: shelfRect.left >= -1 && shelfRect.right <= document.documentElement.clientWidth + 1 && shelfRect.bottom <= document.documentElement.clientHeight + 1,
      toggleVisible: toggleRect.width > 0 && toggleRect.height > 0,
      toggleInsideShelf: toggleRect.left >= shelfRect.left && toggleRect.right <= shelfRect.right && toggleRect.bottom <= shelfRect.bottom + 1,
      toggleNamed: toggle.getAttribute('aria-label') === 'Expand transfers' && toggle.title === 'Expand transfers',
      compactVisible: compactRect.width > 0 && compactRect.height > 0,
      compactText: compact.innerText,
      bodyOverflow: document.body.scrollWidth > document.documentElement.clientWidth + 2,
    };
  })()`);

  assert(checks.collapsed, 'Transfer shelf should stay visible in its collapsed narrow state.');
  assert(checks.shelfDisplay === 'grid' && checks.shelfVisibility === 'visible', 'Collapsed transfer shelf should be visibly painted before capture.');
  assert(checks.shelfHeight >= 47 && checks.shelfHeight <= 49, 'Collapsed transfer shelf should remain approximately 48px tall.');
  assert(checks.headerHeight <= checks.shelfHeight, 'Collapsed transfer shelf should contain its header.');
  assert(checks.shelfInBounds, 'Collapsed transfer shelf should stay inside the narrow viewport.');
  assert(checks.toggleVisible && checks.toggleInsideShelf, 'Collapsed transfer shelf reopen control should remain visible and in bounds.');
  assert(checks.toggleNamed, 'Collapsed transfer shelf reopen control needs an accessible name and tooltip.');
  assert(checks.compactVisible, 'Collapsed transfer shelf should retain its live compact summary.');
  assert(checks.compactText.includes('42%'), 'Collapsed transfer shelf should retain percent.');
  assert(checks.compactText.includes('1 active'), 'Collapsed transfer shelf should retain active count.');
  assert(checks.compactText.includes('8.2 MiB/s'), 'Collapsed transfer shelf should retain speed.');
  assert(checks.compactText.includes('ETA 1m 12s'), 'Collapsed transfer shelf should retain ETA.');
  assert(!checks.bodyOverflow, 'Collapsed transfer shelf should not cause horizontal overflow.');

  const firstImage = await window.webContents.capturePage();
  await waitForPaint(window);
  const image = await window.webContents.capturePage();
  assert(imageHash(firstImage) === imageHash(image), 'Collapsed transfer shelf capture should have a deterministic image hash.');
  const shelfImage = image.crop({
    x: Math.max(0, Math.floor(checks.shelfRect.x)),
    y: Math.max(0, Math.floor(checks.shelfRect.y)),
    width: Math.max(1, Math.floor(checks.shelfRect.width)),
    height: Math.max(1, Math.floor(checks.shelfRect.height)),
  });
  assert(!shelfImage.isEmpty() && imageHasContrast(shelfImage), 'Collapsed screenshot should visibly contain the painted shelf and compact text.');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'transfer-shelf-collapsed-760.png'), image.toPNG());

  const collapsedPaused = await window.webContents.executeJavaScript(`(async () => {
    window.murdawkUplinkSmoke.seed({
      jobs: [{
        id: 'paused-collapsed',
        sources: ['C:/Paused/clip.mov'],
        settings: { prefix: 'paused/collapsed' },
        status: 'paused',
        jobId: 'paused-collapsed-upload'
      }]
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const shelf = document.getElementById('transferShelf');
    const pauseAll = document.getElementById('transferShelfPauseAll');
    return {
      hidden: shelf.hidden,
      collapsed: shelf.classList.contains('is-collapsed'),
      text: shelf.innerText,
      pauseDisabled: pauseAll.disabled,
      pauseTitle: pauseAll.title
    };
  })()`);
  assert(
    !collapsedPaused.hidden && collapsedPaused.collapsed && /paused/i.test(collapsedPaused.text),
    'A collapsed shelf should remain visible and retain paused status.',
  );
  assert(
    collapsedPaused.pauseDisabled && /No active upload/i.test(collapsedPaused.pauseTitle),
    'Collapsed paused state should expose why Pause All is unavailable.',
  );
  window.close();
}

async function runConnectionManagementScenario() {
  const window = new BrowserWindow({
    width: 760,
    height: 768,
    useContentSize: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, 'ui-smoke-preload.js'),
    },
  });
  await window.loadFile(path.join(appDir, 'src', 'renderer', 'index.html'), { query: { smoke: '1' } });
  await waitForSmokeHook(window);
  await waitForWindowCondition(window, `document.getElementById('activeConnectionName')?.textContent === 'Media Archive'`, 'initial Media Archive connection');

  const switcher = await window.webContents.executeJavaScript(`(async () => {
    const waitFor = async (predicate) => {
      for (let index = 0; index < 120; index += 1) {
        if (predicate()) return;
        await new Promise(requestAnimationFrame);
      }
      throw new Error('Connection switcher wait timed out');
    };
    const button = document.getElementById('connectionSwitcher');
    const menu = document.getElementById('connectionMenu');
    button.click();
    await waitFor(() => !menu.hidden);
    const names = [...menu.querySelectorAll('[data-connection-id]')].map((item) => item.textContent.trim());
    const actions = [...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent.trim());
    const firstFocus = document.activeElement?.dataset.connectionId || '';
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    const endFocus = document.activeElement?.id || '';
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    const homeFocus = document.activeElement?.dataset.connectionId || '';
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    const arrowFocus = document.activeElement?.dataset.connectionId || '';
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const escapeClosed = menu.hidden && document.activeElement === button;
    button.click();
    await waitFor(() => !menu.hidden);
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    const tabClosed = menu.hidden;
    button.click();
    await waitFor(() => !menu.hidden);
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    const outsideClosed = menu.hidden;

    window.murdawkUplinkSmoke.configureQueueMock({
      saveOutcomes: [{ ok: false, error: 'Mocked switch persistence failure' }],
      resetCalls: true,
    });
    button.click();
    await waitFor(() => !menu.hidden);
    menu.querySelector('[data-connection-id="archive"]').click();
    await waitFor(() => window.murdawkUplinkSmoke.queueMockSnapshot().calls.some((call) => call.type === 'save-settings'));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const failedSnapshot = window.murdawkUplinkSmoke.queueMockSnapshot();
    const failedSwitchRolledBack = document.getElementById('activeConnectionName')?.textContent === 'Media Archive'
      && !failedSnapshot.calls.some((call) => call.type === 'list-remote' && call.profile?.remote === 'archive');
    const switchStatus = document.getElementById('connectionSwitcherStatus');
    const failedSwitchStatusVisible = !switchStatus.hidden
      && switchStatus.getAttribute('role') === 'status'
      && switchStatus.getAttribute('aria-live') === 'polite'
      && switchStatus.textContent.includes('original Space');
    if (!menu.hidden) document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    window.murdawkUplinkSmoke.configureQueueMock({ resetCalls: true });
    button.click();
    await waitFor(() => !menu.hidden);
    menu.querySelector('[data-connection-id="archive"]').click();
    await waitFor(() => document.getElementById('activeConnectionName')?.textContent === 'Archive Space');
    await waitFor(() => window.murdawkUplinkSmoke.queueMockSnapshot().calls.some((call) =>
      call.type === 'list-remote' && call.profile?.remote === 'archive'));
    const snapshot = window.murdawkUplinkSmoke.queueMockSnapshot();
    const saveIndex = snapshot.calls.findIndex((call) => call.type === 'save-settings' && call.activeConnectionId === 'archive');
    const listIndex = snapshot.calls.findIndex((call) => call.type === 'list-remote' && call.profile?.remote === 'archive');
    return {
      names, actions, firstFocus, endFocus, homeFocus, arrowFocus, escapeClosed, tabClosed, outsideClosed,
      failedSwitchRolledBack, failedSwitchStatusVisible,
      activeName: document.getElementById('activeConnectionName')?.textContent || '',
      health: document.getElementById('health')?.textContent || '',
      remotePath: document.getElementById('remotePath')?.value || '',
      breadcrumb: document.getElementById('breadcrumbs')?.textContent || '',
      recents: [...document.querySelectorAll('#recentFolders [data-prefix]')].map((item) => item.dataset.prefix),
      persistedBeforeList: saveIndex >= 0 && listIndex > saveIndex,
      archiveProfileUsed: snapshot.calls.some((call) => call.type === 'list-remote' && call.profile?.remote === 'archive'),
    };
  })()`);
  assert(switcher.names.some((name) => name.includes('Media Archive')) && switcher.names.some((name) => name.includes('Archive Space')), 'Connection menu should list every connected Space.');
  assert(switcher.actions.includes('Add connection') && switcher.actions.includes('Import settings') && switcher.actions.includes('Manage connections'), 'Connection menu should expose Add, Import, and Manage actions.');
  assert(switcher.firstFocus === 'media' && switcher.homeFocus === 'media' && switcher.arrowFocus === 'archive', 'Connection menu arrow, Home, and initial focus behavior is incorrect.');
  assert(switcher.endFocus === 'manageConnections', 'End should focus the final connection menu action.');
  assert(switcher.escapeClosed && switcher.tabClosed && switcher.outsideClosed, 'Connection menu should close safely for Escape, Tab, and outside click.');
  assert(switcher.failedSwitchRolledBack, 'A failed active-connection save must leave Explorer on the original Space.');
  assert(switcher.failedSwitchStatusVisible, 'A failed connection switch should be announced visibly beside the switcher.');
  assert(switcher.activeName === 'Archive Space' && switcher.remotePath === '' && switcher.breadcrumb.includes('Archive Space'), 'Switching connections should reset Explorer to the selected Space root.');
  assert(switcher.health.includes('archive:/archive-media'), 'Connection health should update to the newly active Space.');
  assert(switcher.recents.includes('completed/exports') && !switcher.recents.includes('archive-event/recordings/raw/stage1/day2/mix'), 'Recents should be scoped to the selected connection.');
  assert(switcher.persistedBeforeList, 'The active connection must persist before its remote root is listed.');
  assert(switcher.archiveProfileUsed, 'Explorer should list the selected connection without mixing the prior profile.');

  const management = await window.webContents.executeJavaScript(`(async () => {
    const waitFor = async (predicate) => {
      for (let index = 0; index < 120; index += 1) {
        if (predicate()) return;
        await new Promise(requestAnimationFrame);
      }
      throw new Error('Connection management wait timed out');
    };
    document.getElementById('connectionSwitcher').click();
    document.getElementById('manageConnections').click();
    await waitFor(() => !document.getElementById('connectionsPanel').hidden);
    const panel = document.getElementById('connectionsPanel');
    const labels = [...panel.querySelectorAll('.connection-card')].map((card) => card.innerText);
    const connectionsAddButton = document.getElementById('connectionsAddButton');
    const connectionsImportButton = document.getElementById('connectionsImportButton');
    const connectionsImportButtonExists = Boolean(connectionsImportButton);
    const connectionsImportBesideAdd = Boolean(
      connectionsImportButton
      && connectionsAddButton?.parentElement?.contains(connectionsImportButton),
    );
    let connectionsImportCancelledFocus = false;
    if (connectionsImportButton) {
      window.murdawkUplinkSmoke.configureQueueMock({
        connectionImport: null,
        resetCalls: true,
      });
      connectionsImportButton.click();
      await waitFor(() => window.murdawkUplinkSmoke.queueMockSnapshot().calls
        .some((call) => call.type === 'import-connection'));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      connectionsImportCancelledFocus = document.activeElement === connectionsImportButton;
    }
    window.murdawkUplinkSmoke.running(true);
    const connectionsImportLockedDuringTransfer = connectionsImportButton?.disabled === true;
    window.murdawkUplinkSmoke.running(false);
    const connectionsImportUnlockedAfterTransfer = connectionsImportButton?.disabled === false;

    window.murdawkUplinkSmoke.configureQueueMock({ resetCalls: true });
    panel.querySelector('[data-connection-action="test"][data-connection-id="media"]').click();
    await waitFor(() => window.murdawkUplinkSmoke.queueMockSnapshot().calls.some((call) => call.type === 'save-settings'));
    const testCalls = window.murdawkUplinkSmoke.queueMockSnapshot().calls;
    const testedAndSaved = testCalls.some((call) => call.type === 'check-system' && call.profile?.remote === 'media')
      && testCalls.some((call) => call.type === 'save-settings' && call.connections.some((connection) => connection.id === 'media' && connection.lastTestedAt));

    window.murdawkUplinkSmoke.configureQueueMock({ resetCalls: true });
    panel.querySelector('[data-connection-action="export"][data-connection-id="media"]').click();
    await waitFor(() => document.getElementById('connectionExportDialog').open);
    const exportDefaultSafe = !document.getElementById('connectionExportIncludeKeys').checked
      && document.getElementById('connectionExportSecrets').hidden;
    document.getElementById('connectionExportSave').click();
    await waitFor(() => window.murdawkUplinkSmoke.queueMockSnapshot().calls.some((call) => call.type === 'export-connection'));
    const exportedWithoutKeys = window.murdawkUplinkSmoke.queueMockSnapshot().calls.some((call) =>
      call.type === 'export-connection'
      && call.request?.includeKeys === false
      && !/(access|secret|token|credential)/i.test(JSON.stringify(call.request?.connection)));

    const originalPrompt = window.prompt;
    window.prompt = () => 'BTC Production';
    window.murdawkUplinkSmoke.configureQueueMock({ resetCalls: true });
    panel.querySelector('[data-connection-action="rename"][data-connection-id="media"]').click();
    await waitFor(() => panel.textContent.includes('BTC Production'));
    const renamePersisted = window.murdawkUplinkSmoke.queueMockSnapshot().calls.some((call) =>
      call.type === 'save-settings' && call.connections.some((connection) => connection.id === 'media' && connection.name === 'BTC Production'));
    window.prompt = originalPrompt;

    const originalConfirm = window.confirm;
    window.confirm = () => true;
    const archiveAdvanced = panel.querySelector('[data-connection-card="archive"] .connection-advanced-tools');
    archiveAdvanced.open = true;
    window.prompt = () => 'archive';
    window.murdawkUplinkSmoke.configureQueueMock({
      connectionRemovalBlockers: [{ jobId: 'profile-paused', prefix: 'archive/paused', status: 'paused' }],
      resetCalls: true,
    });
    panel.querySelector('[data-connection-action="remove-profile"][data-connection-id="archive"]').click();
    await waitFor(() => document.getElementById('connectionNotice').textContent.includes('archive/paused'));
    const profileBlockedBeforeConfirmation = !window.murdawkUplinkSmoke.queueMockSnapshot().calls.some((call) => call.type === 'remove-profile-request');
    const profileBlockOffersUploads = Boolean(document.getElementById('returnToUploads'));

    window.murdawkUplinkSmoke.configureQueueMock({ resetCalls: true });
    window.prompt = () => 'wrong-profile';
    panel.querySelector('[data-connection-action="remove-profile"][data-connection-id="archive"]').click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const wrongProfileBlocked = !window.murdawkUplinkSmoke.queueMockSnapshot().calls.some((call) => call.type === 'remove-profile');

    window.prompt = () => 'archive';
    window.murdawkUplinkSmoke.configureQueueMock({
      profileRemovalBlockersOnDelete: [{ jobId: 'profile-race', prefix: 'archive/verifying', status: 'verifying' }],
      resetCalls: true,
    });
    panel.querySelector('[data-connection-action="remove-profile"][data-connection-id="archive"]').click();
    await waitFor(() => document.getElementById('connectionNotice').textContent.includes('archive/verifying'));
    const raceSnapshot = window.murdawkUplinkSmoke.queueMockSnapshot();
    const profileRaceBlocked = raceSnapshot.calls.some((call) => call.type === 'remove-profile-request')
      && !raceSnapshot.calls.some((call) => call.type === 'remove-profile')
      && Boolean(document.getElementById('returnToUploads'));

    window.murdawkUplinkSmoke.configureQueueMock({ resetCalls: true });
    panel.querySelector('[data-connection-action="remove-profile"][data-connection-id="archive"]').click();
    await waitFor(() => window.murdawkUplinkSmoke.queueMockSnapshot().calls.some((call) => call.type === 'remove-profile'));
    const exactProfileRemoved = window.murdawkUplinkSmoke.queueMockSnapshot().calls.some((call) =>
      call.type === 'remove-profile' && call.request?.name === 'archive' && call.request?.confirmation === 'archive');
    window.prompt = originalPrompt;
    window.confirm = originalConfirm;

    document.getElementById('connectionsAddButton').click();
    const access = document.getElementById('setupAccessKey');
    const secret = document.getElementById('setupSecretKey');
    access.value = 'VALIDATION-ACCESS';
    secret.value = 'VALIDATION-SECRET';
    document.getElementById('profileRemote').value = '';
    document.getElementById('profileBucket').value = '';
    document.getElementById('setupProfile').click();
    await waitFor(() => access.value === '' && secret.value === '');
    const validationCleared = access.value === '' && secret.value === '';
    await window.murdawkUplinkSmoke.connectionTransactionsSettled();

    window.murdawkUplinkSmoke.configureQueueMock({
      checkSystemOutcomes: [{ delayMs: 600 }],
      resetCalls: true,
    });
    document.getElementById('connectionName').value = 'Delayed Test Space';
    document.getElementById('profileRemote').value = 'delayed-test';
    document.getElementById('profileBucket').value = 'delayed-test-media';
    document.getElementById('profileEndpoint').value = 'tor1.digitaloceanspaces.com';
    access.value = 'DELAYED-ACCESS';
    secret.value = 'DELAYED-SECRET';
    document.getElementById('setupProfile').click();
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (window.murdawkUplinkSmoke.queueMockSnapshot().calls.some((call) => call.type === 'check-system')) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const delayedSecretCleared = access.value === '' && secret.value === '';
    const delayedLockState = {
      switcher: document.getElementById('connectionSwitcher').disabled,
      editorBusy: document.getElementById('connectionEditor').getAttribute('aria-busy'),
      setup: document.getElementById('setupProfile').disabled,
      pending: window.murdawkUplinkSmoke.connectionSnapshot().mutationPending,
      inFlight: !window.murdawkUplinkSmoke.queueMockSnapshot().calls.some((call) => call.type === 'check-system-complete'),
    };
    const editorLockedDuringTest = delayedLockState.switcher
      && delayedLockState.editorBusy === 'true'
      && delayedLockState.setup;
    await waitFor(() => panel.textContent.includes('Delayed Test Space'));
    await window.murdawkUplinkSmoke.connectionTransactionsSettled();

    window.murdawkUplinkSmoke.configureQueueMock({ profileSetupOutcomes: [{ ok: false, error: 'Mock setup rejected' }], resetCalls: true });
    document.getElementById('connectionName').value = 'Failure Space';
    document.getElementById('profileRemote').value = 'failure';
    document.getElementById('profileBucket').value = 'failure-space';
    document.getElementById('profileEndpoint').value = 'tor1.digitaloceanspaces.com';
    access.value = 'IPC-ACCESS';
    secret.value = 'IPC-SECRET';
    document.getElementById('setupProfile').click();
    await waitFor(() => window.murdawkUplinkSmoke.queueMockSnapshot().calls.some((call) => call.type === 'setup-profile'));
    await waitFor(() => access.value === '' && secret.value === '');
    const ipcCleared = access.value === '' && secret.value === '';
    const settingsLeak = window.murdawkUplinkSmoke.queueMockSnapshot().calls
      .filter((call) => call.type === 'save-settings')
      .some((call) => /IPC-ACCESS|IPC-SECRET|VALIDATION-ACCESS|VALIDATION-SECRET|DELAYED-ACCESS|DELAYED-SECRET/.test(JSON.stringify(call)));

    window.murdawkUplinkSmoke.configureQueueMock({
      connectionRemovalBlockers: [{ jobId: 'blocked-job', prefix: 'archive/pending', status: 'paused' }],
      resetCalls: true,
    });
    panel.querySelector('[data-connection-action="remove"][data-connection-id="archive"]').click();
    await waitFor(() => !document.getElementById('connectionNotice').hidden && document.getElementById('connectionNotice').textContent.includes('unfinished'));
    const blockedText = document.getElementById('connectionNotice').innerText;
    const blockerCalls = window.murdawkUplinkSmoke.queueMockSnapshot().calls;
    const removePersisted = blockerCalls.some((call) => call.type === 'save-settings' && !call.connections.some((connection) => connection.id === 'archive'));
    const returnToUploads = Boolean(document.getElementById('returnToUploads'));

    window.murdawkUplinkSmoke.configureQueueMock({ resetCalls: true });
    document.getElementById('showExplorerView').click();
    document.getElementById('connectionSwitcher').click();
    document.getElementById('importConnection').click();
    await waitFor(() => window.murdawkUplinkSmoke.queueMockSnapshot().calls.some((call) => call.type === 'import-connection'));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const cancelledImportFocus = document.activeElement?.id === 'connectionSwitcher'
      && document.getElementById('connectionMenu').hidden;

    window.murdawkUplinkSmoke.configureQueueMock({
      connectionImportError: 'Mocked import picker failure',
      resetCalls: true,
    });
    document.getElementById('connectionSwitcher').click();
    document.getElementById('importConnection').click();
    await waitFor(() => document.getElementById('connectionSwitcherStatus').textContent.includes('Import failed'));
    const failedImportFocus = document.activeElement?.id === 'connectionSwitcher'
      && !document.getElementById('connectionSwitcherStatus').hidden;

    window.murdawkUplinkSmoke.configureQueueMock({
      connectionImport: {
        id: 'delivery', name: 'Delivery Space', remote: 'delivery', bucket: 'delivery-media',
        endpointHost: 'ams3.digitaloceanspaces.com', publicRead: false, checksum: 'size',
        recentPrefixes: ['delivery/recent'], pinnedPrefixes: ['delivery/pinned'], lastTestedAt: '',
      },
      resetCalls: true,
    });
    document.getElementById('showExplorerView').click();
    document.getElementById('connectionSwitcher').click();
    document.getElementById('importConnection').click();
    await waitFor(() => document.getElementById('connectionImportDialog').open);
    await waitFor(() => document.getElementById('connectionImportName').textContent === 'Delivery Space');
    const explicitImportConfirmation = document.getElementById('connectionImportSave').textContent.trim() === 'Confirm import';
    document.getElementById('connectionImportSave').click();
    await waitFor(() => panel.textContent.includes('Delivery Space'));
    await waitFor(() => document.activeElement?.id === 'connectionsTitle');
    const importCalls = window.murdawkUplinkSmoke.queueMockSnapshot().calls;
    const importedAndSaved = importCalls.some((call) => call.type === 'import-connection')
      && importCalls.some((call) => call.type === 'save-settings' && call.connections.some((connection) => connection.id === 'delivery'));
    const successfulImportFocus = document.activeElement?.id === 'connectionsTitle';

    const automation = document.getElementById('automationAccess');
    automation.open = true;
    document.getElementById('automationKeyName').value = 'Smoke editing laptop';
    document.getElementById('createAutomationKey').click();
    await waitFor(() => !document.getElementById('automationOneTimeSecret').hidden);
    const automationKeyWorks = document.getElementById('automationAccessState').textContent === 'On'
      && document.getElementById('automationAccessUrl').textContent.includes('127.0.0.1:47819')
      && document.getElementById('automationOneTimeValue').value === 'smoke-api-key-value'
      && document.getElementById('automationKeyList').textContent.includes('Smoke editing laptop');
    document.getElementById('dismissAutomationValue').click();
    const automationSecretCleared = document.getElementById('automationOneTimeValue').value === ''
      && document.getElementById('automationOneTimeSecret').hidden;
    const layoutOverflow = document.body.scrollWidth > document.documentElement.clientWidth + 2;
    return {
      labels, testedAndSaved, exportDefaultSafe, exportedWithoutKeys, renamePersisted, wrongProfileBlocked, exactProfileRemoved,
      profileBlockedBeforeConfirmation, profileBlockOffersUploads, profileRaceBlocked,
      validationCleared, delayedSecretCleared, delayedLockState, editorLockedDuringTest, ipcCleared, settingsLeak, blockedText, removePersisted, returnToUploads,
      connectionsImportButtonExists, connectionsImportBesideAdd, connectionsImportCancelledFocus,
      connectionsImportLockedDuringTransfer, connectionsImportUnlockedAfterTransfer,
      cancelledImportFocus, failedImportFocus, explicitImportConfirmation, importedAndSaved, successfulImportFocus,
      automationKeyWorks, automationSecretCleared, layoutOverflow,
    };
  })()`);
  assert(management.labels.length === 2 && management.labels.every((label) => /space|Media Archive/i.test(label)), `Connections view should render both connection descriptors: ${JSON.stringify(management.labels)}`);
  assert(management.labels.every((label) => /last tested/i.test(label) && /endpoint/i.test(label)), 'Connection cards should show endpoint and last-tested details.');
  assert(management.testedAndSaved, 'Testing a connection should persist its last-tested timestamp.');
  assert(management.exportDefaultSafe, 'Connection export should keep access keys off and hidden by default.');
  assert(management.exportedWithoutKeys, 'Connection export should receive only the secret-free descriptor.');
  assert(management.renamePersisted, 'Renaming a connection should persist before updating the management view.');
  assert(management.wrongProfileBlocked && management.exactProfileRemoved, 'Underlying rclone profile removal should require an exact second confirmation.');
  assert(management.profileBlockedBeforeConfirmation && management.profileBlockOffersUploads, 'Profile removal should list paused work and return to uploads before confirmation.');
  assert(management.profileRaceBlocked, 'Main-process profile removal defense should stop a verifying job that appears after the renderer check.');
  assert(management.validationCleared && management.ipcCleared, 'Spaces keys must clear after validation and IPC failures.');
  assert(
    management.delayedSecretCleared && management.editorLockedDuringTest,
    `Spaces keys should clear before a delayed connection test while mutation controls remain locked: ${JSON.stringify({ cleared: management.delayedSecretCleared, locked: management.editorLockedDuringTest, state: management.delayedLockState })}`,
  );
  assert(!management.settingsLeak, 'Spaces keys must never enter persisted settings.');
  assert(management.blockedText.includes('archive/pending') && management.returnToUploads, 'Guarded removal should list unfinished work and offer Return to uploads.');
  assert(!management.removePersisted, 'Guarded removal must not delete the connection descriptor or queued work.');
  assert(management.connectionsImportButtonExists, 'Connections should expose a visible Import connection button.');
  assert(management.connectionsImportBesideAdd, 'Import connection should sit beside Add connection.');
  assert(management.connectionsImportCancelledFocus, 'Cancelling import from Connections should restore focus to its Import button.');
  assert(
    management.connectionsImportLockedDuringTransfer && management.connectionsImportUnlockedAfterTransfer,
    'Import connection should follow the transfer mutation lock.',
  );
  assert(
    management.cancelledImportFocus && management.failedImportFocus,
    `Cancelled and failed imports should restore focus to the Space switcher: ${JSON.stringify({ cancelled: management.cancelledImportFocus, failed: management.failedImportFocus })}`,
  );
  assert(management.explicitImportConfirmation, 'The connection preview action should say Confirm import.');
  assert(management.importedAndSaved, 'Import settings should add and persist a secret-free connection descriptor.');
  assert(management.successfulImportFocus, 'A successful import should focus the Connections view.');
  assert(management.automationKeyWorks && management.automationSecretCleared, 'Automation access should create a one-time key and clear it after acknowledgement.');
  assert(!management.layoutOverflow, 'Connection management should not cause horizontal overflow.');
  await waitForPaint(window);
  const connectionImage = await window.webContents.capturePage();
  assert(!connectionImage.isEmpty() && imageHasContrast(connectionImage), 'Connection management screenshot should be visibly rendered.');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'connections-760.png'), connectionImage.toPNG());

  const scopedAndSerialized = await window.webContents.executeJavaScript(`(async () => {
    const waitFor = async (predicate) => {
      for (let index = 0; index < 180; index += 1) {
        if (predicate()) return;
        await new Promise(requestAnimationFrame);
      }
      throw new Error('Connection transaction wait timed out');
    };
    const smoke = window.murdawkUplinkSmoke;
    await smoke.switchConnection('delivery');
    await smoke.connectionTransactionsSettled();
    const imported = smoke.connectionSnapshot();
    const importedPersisted = smoke.queueMockSnapshot().settings;
    const importedRecentsVisible = [...document.querySelectorAll('#recentFolders [data-prefix]')]
      .some((item) => item.dataset.prefix === 'delivery/recent');

    smoke.configureQueueMock({ saveOutcomes: [{ delayMs: 160 }], resetCalls: true });
    const switchPromise = smoke.switchConnection('media');
    await waitFor(() => smoke.queueMockSnapshot().calls.some((call) =>
      call.type === 'save-settings' && call.activeConnectionId === 'media'));
    const renamePromise = smoke.renameConnection('media', 'BTC Ordered');
    const controlsLocked = document.getElementById('connectionSwitcher').disabled
      && [...document.querySelectorAll('#connectionsList button')].every((button) => button.disabled)
      && [...document.querySelectorAll('#connectionEditor input, #connectionEditor select, #connectionEditor button')].every((control) => control.disabled);
    await Promise.all([switchPromise, renamePromise]);
    await smoke.connectionTransactionsSettled();
    const transactionCalls = smoke.queueMockSnapshot().calls;
    const switchSaveIndex = transactionCalls.findIndex((call) =>
      call.type === 'save-settings' && call.activeConnectionId === 'media');
    const renameSaveIndex = transactionCalls.findIndex((call) =>
      call.type === 'save-settings' && call.connections.some((connection) => connection.id === 'media' && connection.name === 'BTC Ordered'));
    const renderer = smoke.connectionSnapshot();
    const restarted = smoke.queueMockSnapshot().settings;
    return {
      importedRecentsVisible,
      importedRecentsPersisted: imported.recentPrefixesByConnection.delivery?.includes('delivery/recent')
        && importedPersisted.recentPrefixesByConnection.delivery?.includes('delivery/recent'),
      importedPinsPersisted: imported.pinnedPrefixes.includes('delivery/pinned')
        && importedPersisted.pinnedPrefixes.includes('delivery/pinned'),
      importedPrivate: imported.publicRead === false && importedPersisted.publicRead === false,
      controlsLocked,
      serializedOrder: switchSaveIndex >= 0 && renameSaveIndex > switchSaveIndex,
      rendererMatchesRestart: renderer.activeConnectionId === restarted.activeConnectionId
        && JSON.stringify(renderer.connections) === JSON.stringify(restarted.connections)
        && JSON.stringify(renderer.recentPrefixesByConnection) === JSON.stringify(restarted.recentPrefixesByConnection)
        && renderer.publicRead === restarted.publicRead
        && renderer.checksum === restarted.checksum
        && JSON.stringify(renderer.pinnedPrefixes) === JSON.stringify(restarted.pinnedPrefixes),
      finalName: renderer.connections.find((connection) => connection.id === 'media')?.name || '',
      mutationSettled: renderer.mutationPending === 0 && !document.getElementById('connectionSwitcher').disabled,
    };
  })()`);
  assert(
    scopedAndSerialized.importedRecentsVisible && scopedAndSerialized.importedRecentsPersisted
      && scopedAndSerialized.importedPinsPersisted && scopedAndSerialized.importedPrivate,
    'Imported recents, pins, and private ACL should survive activation and root refresh.',
  );
  assert(scopedAndSerialized.controlsLocked, 'Connection switcher, cards, and editor should lock during a pending transaction.');
  assert(
    scopedAndSerialized.serializedOrder && scopedAndSerialized.rendererMatchesRestart
      && scopedAndSerialized.finalName === 'BTC Ordered' && scopedAndSerialized.mutationSettled,
    `Delayed switch and rename should serialize to identical renderer and restart state: ${JSON.stringify(scopedAndSerialized)}`,
  );

  const externalGuard = await window.webContents.executeJavaScript(`(async () => {
    const smoke = window.murdawkUplinkSmoke;
    const external = { remote: 'external', bucket: 'external-media', endpointHost: 'fra1.digitaloceanspaces.com' };
    smoke.seed({
      jobs: [],
      activeTransfer: {
        activeJobId: 'external-live', intentId: 'external-live', isLifecycleActive: true,
        isRunning: true, phase: 'verifying', profile: external, prefix: 'external/pending',
      },
    });
    smoke.running(false);
    smoke.configureQueueMock({ resetCalls: true });
    let alertText = '';
    window.alert = (message) => { alertText = message; };
    window.confirm = () => true;
    await smoke.switchConnection('archive');
    await smoke.removeConnection('archive');
    await smoke.connectionTransactionsSettled();
    const calls = smoke.queueMockSnapshot().calls;
    const snapshot = smoke.connectionSnapshot();
    return {
      alertText,
      notice: document.getElementById('connectionNotice').innerText,
      activeChecks: calls.filter((call) => call.type === 'active-transfer').length,
      saved: calls.some((call) => call.type === 'save-settings'),
      archiveStillListed: snapshot.connections.some((connection) => connection.id === 'archive'),
      activeConnectionId: snapshot.activeConnectionId,
    };
  })()`);
  assert(
    externalGuard.activeChecks >= 2 && !externalGuard.saved && externalGuard.archiveStillListed
      && externalGuard.activeConnectionId === 'media'
      && externalGuard.alertText.includes('Pause or finish') && externalGuard.notice.includes('transfer is active'),
    `An external active transfer must block switching and destructive connection changes: ${JSON.stringify(externalGuard)}`,
  );

  const activeGuard = await window.webContents.executeJavaScript(`(async () => {
    const media = { remote: 'media', bucket: 'media', endpointHost: 'media.nyc3.digitaloceanspaces.com' };
    window.murdawkUplinkSmoke.seed({
      jobs: [{ id: 'media-live', sources: ['C:/BTC/live.mov'], settings: { connectionId: 'media', profile: media, prefix: 'live' }, status: 'uploading' }],
      activeJobId: 'media-live',
      activeTransfer: { activeJobId: 'media-live', isLifecycleActive: true, isRunning: true, phase: 'uploading', profile: media, intentId: 'media-live' },
    });
    window.murdawkUplinkSmoke.running(true);
    window.murdawkUplinkSmoke.configureQueueMock({ resetCalls: true });
    let alertText = '';
    window.alert = (message) => { alertText = message; };
    await window.murdawkUplinkSmoke.switchConnection('archive');
    const calls = window.murdawkUplinkSmoke.queueMockSnapshot().calls;
    return {
      alertText,
      activeName: document.getElementById('activeConnectionName').textContent,
      switchedSave: calls.some((call) => call.type === 'save-settings' && call.activeConnectionId === 'archive'),
    };
  })()`);
  assert(activeGuard.alertText.includes('Pause or finish') && activeGuard.activeName === 'BTC Ordered' && !activeGuard.switchedSave, 'An owned active lifecycle should block connection switching without changing persisted state.');
  window.close();
}

async function runFreshConnectionScenario() {
  const window = new BrowserWindow({
    width: 900,
    height: 700,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, 'ui-smoke-preload.js'),
    },
  });
  await window.loadFile(path.join(appDir, 'src', 'renderer', 'index.html'), {
    query: { smoke: '1', smokeScenario: 'fresh-connections' },
  });
  await waitForSmokeHook(window);
  await waitForWindowCondition(window, `document.getElementById('remoteTable')?.textContent.includes('No Space connected')`, 'fresh connection empty state');
  const result = await window.webContents.executeJavaScript(`(() => {
    const snapshot = window.murdawkUplinkSmoke.queueMockSnapshot();
    return {
      activeName: document.getElementById('activeConnectionName').textContent,
      profileLabel: document.getElementById('driveProfileLabel').textContent,
      uploadDisabled: document.getElementById('driveChooseFiles').disabled,
      remoteText: document.getElementById('remoteTable').innerText,
      touchedRemote: snapshot.calls.some((call) => call.type === 'list-remote' || call.type === 'check-system'),
    };
  })()`);
  assert(result.activeName === 'Choose a Space' && result.profileLabel === 'No Space connected', 'Fresh install should not invent a default server.');
  assert(result.uploadDisabled && result.remoteText.includes('Add connection'), 'Fresh install should clearly route the user to add a connection.');
  assert(!result.touchedRemote, 'Fresh install should not probe any guessed rclone profile or Space.');
  window.close();
}

async function runExplorerDownloadPreviewScenario() {
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, 'ui-smoke-preload.js'),
    },
  });
  await window.loadFile(path.join(appDir, 'src', 'renderer', 'index.html'), {
    query: { smoke: '1' },
  });
  await waitForSmokeHook(window);
  await waitForWindowCondition(window, "document.querySelectorAll('.remote-row').length > 0", 'download fixture rows');

  await window.webContents.executeJavaScript(`(() => {
    const row = [...document.querySelectorAll('.remote-row')]
      .find((candidate) => candidate.querySelector('.remote-label')?.textContent.trim() === 'speaker-card.png');
    row?.click();
  })()`);
  await waitForWindowCondition(
    window,
    `document.getElementById('inspectorPreviewImage')?.hidden === false &&
      document.getElementById('openImagePreview')?.hidden === false`,
    'authenticated Inspector image preview',
  );
  await window.webContents.executeJavaScript("document.getElementById('openImagePreview')?.click()");
  await waitForWindowCondition(window, "document.getElementById('imagePreviewDialog')?.open === true", 'larger image preview');
  const preview = await window.webContents.executeJavaScript(`(() => {
    const dialog = document.getElementById('imagePreviewDialog');
    const image = document.getElementById('imagePreviewImage');
    const rect = dialog.getBoundingClientRect();
    return {
      title: document.getElementById('imagePreviewTitle')?.textContent || '',
      imageVisible: image?.getClientRects().length > 0 && Boolean(image?.getAttribute('src')),
      insideViewport: rect.left >= -1 && rect.top >= -1 &&
        rect.right <= document.documentElement.clientWidth + 1 &&
        rect.bottom <= document.documentElement.clientHeight + 1,
    };
  })()`);
  assert(preview.title === 'speaker-card.png' && preview.imageVisible, 'Image preview should show the selected server image.');
  assert(preview.insideViewport, 'Larger image preview should remain inside the viewport.');
  await window.webContents.executeJavaScript("document.getElementById('closeImagePreview')?.click()");

  await window.webContents.executeJavaScript(`(() => {
    const rowByName = (name) => [...document.querySelectorAll('.remote-row')]
      .find((candidate) => candidate.querySelector('.remote-label')?.textContent.trim() === name);
    rowByName('logs')?.click();
    rowByName('speaker-card.png')?.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    document.getElementById('downloadRemoteItems')?.click();
  })()`);
  await waitForWindowCondition(
    window,
    `window.murdawkUplinkSmoke.queueMockSnapshot().calls.some((call) => call.type === 'download') &&
      document.getElementById('transferShelfList')?.innerText.includes('Complete')`,
    'checked mixed download completion',
    180,
  );
  const download = await window.webContents.executeJavaScript(`(() => {
    const calls = window.murdawkUplinkSmoke.queueMockSnapshot().calls;
    const check = calls.find((call) => call.type === 'download-precheck');
    const transfer = calls.find((call) => call.type === 'download');
    const savedDownload = calls.filter((call) => call.type === 'save-settings')
      .flatMap((call) => call.queueJobs || [])
      .find((job) => job.direction === 'download');
    return {
      checkedNames: (check?.remoteItems || []).map((item) => item.name).sort(),
      transferredNames: (transfer?.remoteItems?.[0] || []).map((item) => item.name).sort(),
      destination: transfer?.localDestinations?.[0] || '',
      savedDirection: savedDownload?.direction || '',
      savedDestination: savedDownload?.localDestination || '',
      shelfText: document.getElementById('transferShelf')?.innerText || '',
      downloadCue: Boolean(document.querySelector('.transfer-shelf-direction.direction-download[aria-label="Download"]')),
    };
  })()`);
  const expectedNames = ['logs', 'speaker-card.png'];
  assert(JSON.stringify(download.checkedNames) === JSON.stringify(expectedNames), 'Download pre-check should preserve a mixed file/folder selection.');
  assert(JSON.stringify(download.transferredNames) === JSON.stringify(expectedNames), 'Download should transfer the checked mixed selection.');
  assert(
    download.destination === 'C:\\Downloads\\Murdawk Smoke' &&
      download.savedDirection === 'download' &&
      download.savedDestination === 'C:\\Downloads\\Murdawk Smoke',
    'Download queue should persist its direction and chosen local folder.',
  );
  assert(download.shelfText.includes('Complete') && download.downloadCue, 'Completed downloads should remain visible in the shared transfer shelf.');
  window.close();
}

app.whenReady()
  .then(async () => {
    if (process.env.MURDAWK_UPLINK_STARTUP_SMOKE === '1') {
      await runStartupAutomaticQueueScenarios();
      return;
    }
    if (process.env.MURDAWK_UPLINK_CONNECTIONS_SMOKE === '1') {
      await runConnectionManagementScenario();
      await runFreshConnectionScenario();
      return;
    }
    await runScenario({ width: 760, height: 768, name: 'compact-760-active-upload' });
    await runScenario({ width: 1280, height: 768, name: 'breakpoint-1280-active-upload' });
    await runScenario({ width: 1281, height: 768, name: 'breakpoint-1281-active-upload' });
    await runScenario({ width: 1366, height: 768, name: 'laptop-active-upload' });
    await runScenario({ width: 1920, height: 1080, name: 'desktop-active-upload' });
    await runNewFolderDialogScenario();
    await runAutomaticQueueScenario();
    await runStartupAutomaticQueueScenarios();
    await runTransferShelfCollapseScenario();
    await runExplorerDownloadPreviewScenario();
    await runConnectionManagementScenario();
    await runFreshConnectionScenario();
  })
  .then(() => app.quit())
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
