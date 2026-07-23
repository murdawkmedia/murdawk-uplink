(function attachRcloneRemoteCore(root, factory) {
  const core = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = core;
  }
  if (root) {
    root.rcloneRemoteCore = core;
  }
})(typeof window !== 'undefined' ? window : null, function createRcloneRemoteCore() {
  const RCLONE_REMOTE_PATTERN = /^[\p{L}\p{N}_.+@ -]+$/u;

  function runtimePlatform() {
    if (typeof process === 'object' && typeof process.platform === 'string') return process.platform;
    if (typeof navigator === 'object' && /Windows/i.test(navigator.userAgent || '')) return 'win32';
    return '';
  }

  function sanitizeRcloneRemoteName(value = '', { platform = runtimePlatform(), trim = true } = {}) {
    const raw = typeof value === 'string' ? value : '';
    const name = trim ? raw.trim() : raw;
    if (!name
      || name.length > 128
      || /[\u0000-\u001f\u007f]/.test(name)
      || !RCLONE_REMOTE_PATTERN.test(name)
      || name.startsWith('-')
      || name.startsWith(' ')
      || name.endsWith(' ')) {
      throw new TypeError('Rclone remote name is invalid.');
    }
    if (platform === 'win32' && /^\p{L}$/u.test(name)) {
      throw new TypeError('A one-letter rclone remote conflicts with a Windows drive name.');
    }
    return name;
  }

  return {
    RCLONE_REMOTE_PATTERN,
    sanitizeRcloneRemoteName,
  };
});
