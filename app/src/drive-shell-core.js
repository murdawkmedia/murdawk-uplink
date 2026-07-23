(function attachDriveShellCore(root, factory) {
  const core = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = core;
  }
  if (root && !root.driveShellCore) {
    root.driveShellCore = core;
  }
})(typeof window !== 'undefined' ? window : undefined, function createDriveShellCore() {
  const VALID_VIEWS = new Set(['files', 'event-workspace', 'connections', 'activity']);
  const VALID_SORT_KEYS = new Set(['name', 'size', 'modified', 'type']);
  const ACTIVE_QUEUE_STATUSES = new Set(['uploading', 'dry-run', 'verifying']);
  const FAILED_QUEUE_STATUSES = new Set(['failed', 'blocked']);

function normalizeDriveShellState(state = {}) {
  const view = VALID_VIEWS.has(state.view) ? state.view : 'files';
  const sortKey = VALID_SORT_KEYS.has(state.sortKey) ? state.sortKey : 'name';
  const sortDirection = state.sortDirection === 'desc' ? 'desc' : 'asc';

  return {
    view,
    queueDrawerOpen: Boolean(state.queueDrawerOpen),
    inspectorOpen: state.inspectorOpen === undefined ? true : Boolean(state.inspectorOpen),
    search: String(state.search || '').trim(),
    sortKey,
    sortDirection,
  };
}

function filterAndSortRemoteEntries(entries = [], state = {}) {
  const normalizedState = normalizeDriveShellState(state);
  const search = normalizedState.search.toLowerCase();
  const direction = normalizedState.sortDirection === 'desc' ? -1 : 1;

  return entries
    .filter((entry) => {
      if (!search) {
        return true;
      }
      return String(entry.name || '').toLowerCase().includes(search);
    })
    .slice()
    .sort((left, right) => {
      if (normalizedState.sortKey === 'name' && Boolean(left.isDir) !== Boolean(right.isDir)) {
        return left.isDir ? -1 : 1;
      }

      const compared = compareEntryValue(left, right, normalizedState.sortKey);
      if (compared !== 0) {
        return compared * direction;
      }

      return String(left.name || '').localeCompare(String(right.name || ''), undefined, { sensitivity: 'base' });
    });
}

function nextSortState(state = {}, key = '') {
  const normalizedState = normalizeDriveShellState(state);
  const nextKey = VALID_SORT_KEYS.has(key) ? key : 'name';
  return normalizeDriveShellState({
    ...normalizedState,
    sortKey: nextKey,
    sortDirection: normalizedState.sortKey === nextKey && normalizedState.sortDirection === 'asc'
      ? 'desc'
      : 'asc',
  });
}

function resolveDisplayedRemoteSelection({
  displayedIndexes = [],
  currentIndexes = [],
  clickedIndex = -1,
  anchorIndex = -1,
  additive = false,
  range = false,
} = {}) {
  const displayed = displayedIndexes
    .map((index) => Number(index))
    .filter((index) => Number.isInteger(index) && index >= 0);
  const clicked = Number(clickedIndex);
  const clickedPosition = displayed.indexOf(clicked);

  if (clickedPosition < 0) {
    return { selectedIndexes: [], selectedIndex: -1, anchorIndex: -1 };
  }

  const visible = new Set(displayed);
  const current = new Set(
    currentIndexes
      .map((index) => Number(index))
      .filter((index) => visible.has(index)),
  );

  if (range) {
    const anchor = visible.has(Number(anchorIndex)) ? Number(anchorIndex) : clicked;
    const anchorPosition = displayed.indexOf(anchor);
    const start = Math.min(anchorPosition, clickedPosition);
    const end = Math.max(anchorPosition, clickedPosition);
    const next = additive ? current : new Set();
    for (let position = start; position <= end; position += 1) {
      next.add(displayed[position]);
    }
    const selectedIndexes = displayed.filter((index) => next.has(index));
    return {
      selectedIndexes,
      selectedIndex: clicked,
      anchorIndex: anchor,
    };
  }

  if (additive) {
    if (current.has(clicked)) {
      current.delete(clicked);
    } else {
      current.add(clicked);
    }
    const selectedIndexes = displayed.filter((index) => current.has(index));
    return {
      selectedIndexes,
      selectedIndex: current.has(clicked) ? clicked : selectedIndexes.at(-1) ?? -1,
      anchorIndex: clicked,
    };
  }

  return {
    selectedIndexes: [clicked],
    selectedIndex: clicked,
    anchorIndex: clicked,
  };
}

function nextDisplayedRemoteIndex(displayedIndexes = [], currentIndex = -1, key = '') {
  const displayed = displayedIndexes
    .map((index) => Number(index))
    .filter((index) => Number.isInteger(index) && index >= 0);
  if (!displayed.length) {
    return -1;
  }

  if (key === 'Home') {
    return displayed[0];
  }
  if (key === 'End') {
    return displayed.at(-1);
  }

  const currentPosition = displayed.indexOf(Number(currentIndex));
  if (currentPosition < 0) {
    return key === 'ArrowUp' ? displayed.at(-1) : displayed[0];
  }
  if (key === 'ArrowUp') {
    return displayed[Math.max(0, currentPosition - 1)];
  }
  if (key === 'ArrowDown') {
    return displayed[Math.min(displayed.length - 1, currentPosition + 1)];
  }
  return displayed[currentPosition];
}

function compareEntryValue(left, right, sortKey) {
  if (sortKey === 'size') {
    return Number(left.size || 0) - Number(right.size || 0);
  }

  if (sortKey === 'modified') {
    return parseModifiedTime(left.modified) - parseModifiedTime(right.modified);
  }

  if (sortKey === 'type') {
    return entryType(left).localeCompare(entryType(right), undefined, { sensitivity: 'base' });
  }

  return String(left.name || '').localeCompare(String(right.name || ''), undefined, { sensitivity: 'base' });
}

const FRIENDLY_KIND_BY_FORMAT = Object.freeze({
  AVIF: 'AVIF image',
  GIF: 'GIF image',
  JPEG: 'JPEG image',
  PNG: 'PNG image',
  WEBP: 'WebP image',
  MP4: 'MP4 video',
  MOV: 'MOV video',
  M4V: 'M4V video',
  WAV: 'WAV audio',
  MP3: 'MP3 audio',
  PDF: 'PDF document',
});
const PREVIEWABLE_IMAGE_FORMATS = new Set(['AVIF', 'GIF', 'JPEG', 'PNG', 'WEBP']);

function remoteFileFormat(entry = {}) {
  if (entry.isDir) return 'FOLDER';
  const name = String(entry.name || entry.path || '');
  const dotIndex = name.lastIndexOf('.');
  if (dotIndex < 0 || dotIndex === name.length - 1) return 'FILE';
  const extension = name.slice(dotIndex + 1).toUpperCase();
  return extension === 'JPG' || extension === 'JPE' ? 'JPEG' : extension;
}

function remoteFriendlyKind(entry = {}) {
  const format = remoteFileFormat(entry);
  if (format === 'FOLDER') return 'Folder';
  return FRIENDLY_KIND_BY_FORMAT[format] || (format === 'FILE' ? 'File' : `${format} file`);
}

function remoteListSummary(total = 0, selected = 0) {
  const itemCount = Math.max(0, Number(total) || 0);
  const selectedCount = Math.min(itemCount, Math.max(0, Number(selected) || 0));
  if (selectedCount) return `${selectedCount} selected of ${itemCount} item${itemCount === 1 ? '' : 's'}`;
  return `${itemCount} item${itemCount === 1 ? '' : 's'} in this folder - none selected`;
}

function isPreviewableImage(entry = {}) {
  return !entry.isDir && PREVIEWABLE_IMAGE_FORMATS.has(remoteFileFormat(entry));
}

function parseModifiedTime(modified) {
  const time = Date.parse(modified || '');
  return Number.isFinite(time) ? time : 0;
}

function entryType(entry = {}) {
  return remoteFileFormat(entry);
}

function buildInspectorSummary(selection = []) {
  if (!selection.length) {
    return {
      title: 'Nothing selected',
      subtitle: 'Select a file or folder to inspect it.',
      kind: 'Selection',
      detail: '0 items',
      canCopyUrl: false,
    };
  }

  if (selection.length === 1) {
    const item = selection[0] || {};
    const isFolder = Boolean(item.isDir);
    return {
      title: item.name || 'Untitled',
      subtitle: item.path || item.name || '',
      kind: remoteFriendlyKind(item),
      detail: item.displaySize || (isFolder ? 'Folder' : 'File'),
      canCopyUrl: !isFolder && Boolean(item.publicUrl),
    };
  }

  const folderCount = selection.filter((item) => item && item.isDir).length;
  const fileCount = selection.length - folderCount;

  return {
    title: `${selection.length} items selected`,
    subtitle: `${folderCount} folders / ${fileCount} files`,
    kind: 'Multiple',
    detail: 'Batch actions available',
    canCopyUrl: selection.some((item) => item && !item.isDir && item.publicUrl),
  };
}

function buildDriveTopBar(profile = {}, remotePrefix = '') {
  const remote = profile.remote || 'remote';
  const bucket = profile.bucket || 'space';
  const normalizedPrefix = String(remotePrefix || '').trim();

  return {
    profileLabel: `${remote}:${bucket}`,
    pathLabel: normalizedPrefix || 'Space root',
  };
}

function queueDrawerLabel(queue = []) {
  const active = queue.filter((job) => ACTIVE_QUEUE_STATUSES.has(job && job.status)).length;
  const failed = queue.filter((job) => FAILED_QUEUE_STATUSES.has(job && job.status)).length;

  return `${queue.length} jobs / ${active} active / ${failed} failed`;
}

  return {
    buildDriveTopBar,
    buildInspectorSummary,
    filterAndSortRemoteEntries,
    nextSortState,
    nextDisplayedRemoteIndex,
    normalizeDriveShellState,
    isPreviewableImage,
    queueDrawerLabel,
    remoteFileFormat,
    remoteFriendlyKind,
    remoteListSummary,
    resolveDisplayedRemoteSelection,
  };
});
