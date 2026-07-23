const assert = require('node:assert/strict');
const test = require('node:test');

const {
  shelfShouldPersist,
  summarizeTransferShelf,
  transferShelfStatusLabel,
} = require('../src/transfer-shelf-core');

test('summarizes an empty transfer shelf', () => {
  assert.deepEqual(summarizeTransferShelf([]), {
    active: 0,
    waiting: 0,
    complete: 0,
    needsAttention: 0,
    label: 'No transfers',
  });
  assert.equal(shelfShouldPersist([]), false);
});

test('summarizes mixed transfer lifecycle states in plain language', () => {
  const jobs = [
    { status: 'prechecking' },
    { status: 'uploading' },
    { status: 'verifying' },
    { status: 'pausing' },
    { status: 'queued' },
    { status: 'ready' },
    { status: 'paused' },
    { status: 'needs-resume-check' },
    { status: 'complete' },
    { status: 'failed' },
    { status: 'blocked' },
  ];

  assert.deepEqual(summarizeTransferShelf(jobs), {
    active: 4,
    waiting: 4,
    complete: 1,
    needsAttention: 2,
    label: '4 active, 2 paused, 2 waiting, 1 complete, 2 need attention',
  });
  assert.equal(shelfShouldPersist(jobs), true);
});

test('keeps a collapsed shelf persistent for interrupted or failed work', () => {
  assert.equal(shelfShouldPersist([{ status: 'paused' }]), true);
  assert.equal(shelfShouldPersist([{ status: 'needs-resume-check' }]), true);
  assert.equal(shelfShouldPersist([{ status: 'interrupted' }]), true);
  assert.equal(shelfShouldPersist([{ status: 'failed' }]), true);
  assert.equal(shelfShouldPersist([{ status: 'blocked' }]), true);
});

test('keeps a cancelled upload visible as paused waiting work', () => {
  assert.deepEqual(summarizeTransferShelf([{ status: 'cancelled' }]), {
    active: 0,
    waiting: 1,
    complete: 0,
    needsAttention: 0,
    label: '1 paused',
  });
  assert.equal(shelfShouldPersist([{ status: 'cancelled' }]), true);
  assert.equal(transferShelfStatusLabel('cancelled'), 'Paused');
});

test('counts cancelled uploads in mixed transfer shelf summaries', () => {
  assert.deepEqual(summarizeTransferShelf([
    { status: 'uploading' },
    { status: 'cancelled' },
    { status: 'complete' },
    { status: 'failed' },
  ]), {
    active: 1,
    waiting: 1,
    complete: 1,
    needsAttention: 1,
    label: '1 active, 1 paused, 1 complete, 1 needs attention',
  });
});

test('keeps completed work visible until the user clears it', () => {
  assert.equal(shelfShouldPersist([{ status: 'complete' }, { status: 'complete' }]), true);
  assert.equal(summarizeTransferShelf([{ status: 'complete' }, { status: 'complete' }]).label, '2 complete');
});

test('ignores unknown and malformed statuses without hiding known relevant work', () => {
  const unknownOnly = [{ status: 'future-state' }, {}, null];
  assert.deepEqual(summarizeTransferShelf(unknownOnly), {
    active: 0,
    waiting: 0,
    complete: 0,
    needsAttention: 0,
    label: 'No transfers',
  });
  assert.equal(shelfShouldPersist(unknownOnly), false);
  assert.equal(shelfShouldPersist([...unknownOnly, { status: 'uploading' }]), true);
});

test('provides approved user-facing lifecycle labels', () => {
  assert.deepEqual(
    {
      prechecking: transferShelfStatusLabel('prechecking'),
      queued: transferShelfStatusLabel('queued'),
      ready: transferShelfStatusLabel('ready'),
      uploading: transferShelfStatusLabel('uploading'),
      pausing: transferShelfStatusLabel('pausing'),
      paused: transferShelfStatusLabel('paused'),
      needsResumeCheck: transferShelfStatusLabel('needs-resume-check'),
      interrupted: transferShelfStatusLabel('interrupted'),
      cancelled: transferShelfStatusLabel('cancelled'),
      verifying: transferShelfStatusLabel('verifying'),
      complete: transferShelfStatusLabel('complete'),
      failed: transferShelfStatusLabel('failed'),
      blocked: transferShelfStatusLabel('blocked'),
      unknown: transferShelfStatusLabel('future-state'),
    },
    {
      prechecking: 'Checking',
      queued: 'Waiting',
      ready: 'Waiting',
      uploading: 'Uploading',
      pausing: 'Pausing',
      paused: 'Paused',
      needsResumeCheck: 'Paused',
      interrupted: 'Paused',
      cancelled: 'Paused',
      verifying: 'Verifying',
      complete: 'Complete',
      failed: 'Needs attention',
      blocked: 'Needs attention',
      unknown: 'Waiting',
    },
  );
});

test('uses download language for downward transfers', () => {
  assert.equal(transferShelfStatusLabel({ status: 'uploading', direction: 'download' }), 'Downloading');
  assert.equal(transferShelfStatusLabel({ status: 'prechecking', direction: 'download' }), 'Checking download');
  assert.equal(transferShelfStatusLabel({ status: 'uploading', direction: 'upload' }), 'Uploading');
});
