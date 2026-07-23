const assert = require('node:assert/strict');
const test = require('node:test');
const {
  AUTOMATION_CAPABILITIES,
  assertAutomationCapability,
  publicAutomationCapabilities,
} = require('../src/automation-capabilities-core');

test('publishes safe read and queue capabilities without credentials', () => {
  const capabilities = publicAutomationCapabilities();
  assert.equal(capabilities.some((item) => item.id === 'remote.list'), true);
  assert.equal(capabilities.some((item) => item.id === 'event.reconcile'), true);
  assert.equal(capabilities.some((item) => /secret|token|password|credential/i.test(JSON.stringify(item))), false);
});

test('capability ids are stable and explicit for MCP/API clients', () => {
  assert.deepEqual(publicAutomationCapabilities().map((item) => item.id), [
    'capabilities.read',
    'connections.read',
    'queue.read',
    'remote.list',
    'remote.metadata',
    'remote.publicUrl',
    'queue.create',
    'queue.dryRun',
    'job.status',
    'event.manifest',
    'event.reconcile',
    'event.queuePreview',
  ]);
});

test('allows safe capabilities and blocks destructive actions', () => {
  assert.equal(assertAutomationCapability('remote.list').id, 'remote.list');
  assert.throws(() => assertAutomationCapability('remote.delete'), /not exposed/);
  assert.equal(AUTOMATION_CAPABILITIES.every((item) => item.destructive !== true), true);
});

test('mutation of returned capability objects does not affect later reads', () => {
  const originalLabel = assertAutomationCapability('remote.list').label;

  publicAutomationCapabilities().find((item) => item.id === 'remote.list').label = 'Mutated public label';
  assertAutomationCapability('remote.list').label = 'Mutated assertion label';
  AUTOMATION_CAPABILITIES.find((item) => item.id === 'remote.list').label = 'Mutated exported label';

  assert.equal(assertAutomationCapability('remote.list').label, originalLabel);
  assert.equal(
    publicAutomationCapabilities().find((item) => item.id === 'remote.list').label,
    originalLabel,
  );
});
