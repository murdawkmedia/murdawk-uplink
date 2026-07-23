const assert = require('node:assert/strict');
const test = require('node:test');
const {
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
} = require('../src/drive-shell-core');

test('CommonJS require does not attach Drive shell core to globalThis', () => {
  assert.equal(Object.hasOwn(globalThis, 'driveShellCore'), false);
});

test('normalizes Drive shell state with safe defaults', () => {
  assert.deepEqual(normalizeDriveShellState({}), {
    view: 'files',
    queueDrawerOpen: false,
    inspectorOpen: true,
    search: '',
    sortKey: 'name',
    sortDirection: 'asc',
  });
  assert.equal(normalizeDriveShellState({ view: 'bad', sortDirection: 'sideways' }).view, 'files');
});

test('filters and sorts remote entries like a cloud drive browser', () => {
  const entries = [
    { name: 'z-video.mp4', isDir: false, size: 300, modified: '2026-01-02T00:00:00Z' },
    { name: 'Assets', isDir: true, size: 0, modified: '2026-01-01T00:00:00Z' },
    { name: 'a-card.png', isDir: false, size: 100, modified: '2026-01-03T00:00:00Z' },
  ];
  assert.deepEqual(
    filterAndSortRemoteEntries(entries, { search: '', sortKey: 'name', sortDirection: 'asc' }).map((entry) => entry.name),
    ['Assets', 'a-card.png', 'z-video.mp4'],
  );
  assert.deepEqual(
    filterAndSortRemoteEntries(entries, { search: 'video', sortKey: 'size', sortDirection: 'desc' }).map((entry) => entry.name),
    ['z-video.mp4'],
  );
});

test('distinguishes remote file formats and friendly kinds', () => {
  assert.equal(remoteFileFormat({ name: 'card.avif' }), 'AVIF');
  assert.equal(remoteFriendlyKind({ name: 'card.avif' }), 'AVIF image');
  assert.equal(remoteFileFormat({ name: 'photo.jpg' }), 'JPEG');
  assert.equal(remoteFriendlyKind({ name: 'schedule.pdf' }), 'PDF document');
  assert.equal(remoteFileFormat({ name: 'README' }), 'FILE');
  assert.equal(remoteFileFormat({ name: 'assets', isDir: true }), 'FOLDER');
  assert.equal(isPreviewableImage({ name: 'card.avif', size: 10 }), true);
  assert.equal(isPreviewableImage({ name: 'clip.mp4', size: 10 }), false);
});

test('sorts each concrete file format separately', () => {
  const entries = [
    { name: 'card.png', type: 'PNG' },
    { name: 'card.avif', type: 'AVIF' },
    { name: 'card.jpg', type: 'JPEG' },
  ];
  assert.deepEqual(
    filterAndSortRemoteEntries(entries, { sortKey: 'type', sortDirection: 'asc' })
      .map((entry) => entry.name),
    ['card.avif', 'card.jpg', 'card.png'],
  );
});

test('states folder contents separately from selection', () => {
  assert.equal(remoteListSummary(24, 0), '24 items in this folder - none selected');
  assert.equal(remoteListSummary(24, 3), '3 selected of 24 items');
  assert.equal(remoteListSummary(1, 0), '1 item in this folder - none selected');
});

test('advances Drive shell sort state safely', () => {
  assert.deepEqual(
    nextSortState({ sortKey: 'name', sortDirection: 'asc' }, 'name'),
    {
      view: 'files',
      queueDrawerOpen: false,
      inspectorOpen: true,
      search: '',
      sortKey: 'name',
      sortDirection: 'desc',
    },
  );
  assert.deepEqual(
    nextSortState({ sortKey: 'name', sortDirection: 'desc' }, 'size'),
    {
      view: 'files',
      queueDrawerOpen: false,
      inspectorOpen: true,
      search: '',
      sortKey: 'size',
      sortDirection: 'asc',
    },
  );
  assert.deepEqual(
    nextSortState({ sortKey: 'bad', sortDirection: 'sideways' }, 'also-bad'),
    {
      view: 'files',
      queueDrawerOpen: false,
      inspectorOpen: true,
      search: '',
      sortKey: 'name',
      sortDirection: 'desc',
    },
  );
});

test('resolves range selection over displayed remote rows only', () => {
  const result = resolveDisplayedRemoteSelection({
    displayedIndexes: [0, 3],
    currentIndexes: [0],
    clickedIndex: 3,
    anchorIndex: 0,
    range: true,
  });
  assert.deepEqual(result, {
    selectedIndexes: [0, 3],
    selectedIndex: 3,
    anchorIndex: 0,
  });

  assert.deepEqual(
    resolveDisplayedRemoteSelection({
      displayedIndexes: [3, 0],
      currentIndexes: [0, 1, 2],
      clickedIndex: 3,
      anchorIndex: 0,
      additive: true,
      range: true,
    }).selectedIndexes,
    [3, 0],
  );
});

test('moves grid focus through displayed remote rows without leaving the visible set', () => {
  const displayedIndexes = [4, 1, 9];
  assert.equal(nextDisplayedRemoteIndex(displayedIndexes, 4, 'ArrowDown'), 1);
  assert.equal(nextDisplayedRemoteIndex(displayedIndexes, 1, 'ArrowUp'), 4);
  assert.equal(nextDisplayedRemoteIndex(displayedIndexes, 1, 'Home'), 4);
  assert.equal(nextDisplayedRemoteIndex(displayedIndexes, 1, 'End'), 9);
  assert.equal(nextDisplayedRemoteIndex(displayedIndexes, 9, 'ArrowDown'), 9);
  assert.equal(nextDisplayedRemoteIndex(displayedIndexes, -1, 'ArrowDown'), 4);
  assert.equal(nextDisplayedRemoteIndex([], 4, 'Home'), -1);
});

test('builds inspector summaries for no selection one file and many files', () => {
  assert.equal(buildInspectorSummary([]).title, 'Nothing selected');
  assert.deepEqual(buildInspectorSummary([{ name: 'clip.mp4', path: 'second-event/clip.mp4', isDir: false, displaySize: '10 GB', publicUrl: 'https://example.test/clip.mp4' }]), {
    title: 'clip.mp4',
    subtitle: 'second-event/clip.mp4',
    kind: 'MP4 video',
    detail: '10 GB',
    canCopyUrl: true,
  });
  assert.equal(buildInspectorSummary([{ name: 'private.mov', isDir: false }]).canCopyUrl, false);
  assert.equal(buildInspectorSummary([{ name: 'a' }, { name: 'b' }]).title, '2 items selected');
});

test('builds top bar and queue labels', () => {
  assert.equal(buildDriveTopBar({ remote: 'media', bucket: 'media' }, 'second-event/recordings').profileLabel, 'media:media');
  assert.equal(buildDriveTopBar({ remote: 'media', bucket: 'media' }, 'second-event/recordings').pathLabel, 'second-event/recordings');
  assert.equal(queueDrawerLabel([{ status: 'ready' }, { status: 'uploading' }, { status: 'failed' }]), '3 jobs / 1 active / 1 failed');
});
