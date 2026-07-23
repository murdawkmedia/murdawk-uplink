const assert = require('node:assert/strict');
const test = require('node:test');

const {
  sanitizeRcloneRemoteName,
} = require('../src/rclone-remote-core');

test('accepts the official rclone remote character set while preserving case', () => {
  for (const name of ['Archive+Fast', 'media@sample-event', 'Event Space', 'under_score', 'dot.name']) {
    assert.equal(sanitizeRcloneRemoteName(` ${name} `, { platform: 'win32' }), name);
  }
});

test('rejects remote delimiters unsafe edges controls and Windows drive ambiguity', () => {
  for (const name of [
    '-archive',
    ' archive',
    'archive ',
    'archive:other',
    'archive/path',
    'archive\\path',
    'archive\u0000other',
    'C',
    'z',
  ]) {
    assert.throws(
      () => sanitizeRcloneRemoteName(name, { platform: 'win32', trim: false }),
      /remote.*invalid|Windows drive/i,
      name,
    );
  }

  assert.equal(sanitizeRcloneRemoteName('C', { platform: 'linux' }), 'C');
});
