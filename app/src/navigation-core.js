(function attachNavigationCore(root, factory) {
  const connectionCore = root?.connectionCore
    || (typeof require === 'function' ? require('./connection-core') : null);
  const core = factory(connectionCore);
  if (typeof module === 'object' && module.exports) {
    module.exports = core;
  }
  if (root) {
    root.navigationCore = core;
  }
})(typeof window !== 'undefined' ? window : null, function createNavigationCore(connectionCore) {
  function normalizePrefix(value = '') {
    return String(value)
      .trim()
      .replace(/\\/g, '/')
      .replace(/^\/+|\/+$/g, '')
      .replace(/\/{2,}/g, '/');
  }

  function connectionDescriptorForProfile(profile = {}) {
    const normalized = connectionCore.normalizeConnectionProfile(profile);
    const { remote, bucket, endpointHost } = normalized;
    const identityParts = connectionCore.canonicalConnectionTuple(normalized)
      .split('\u0000')
      .map((part) => encodeURIComponent(part));

    return {
      id: `legacy-profile:${identityParts.join(':')}`,
      name: bucket || remote || 'Space',
      profile: normalized,
    };
  }

  function recordRecentPrefix(value = {}, connectionId = '', prefix = '', limit = 8) {
    const id = String(connectionId || '').trim();
    const next = normalizePrefix(prefix);
    if (!id || !next) return { ...value };

    const current = Array.isArray(value[id]) ? value[id] : [];
    return {
      ...value,
      [id]: [next, ...current.map(normalizePrefix)]
        .filter(Boolean)
        .filter((item, index, list) => list.indexOf(item) === index)
        .slice(0, limit),
    };
  }

  function recentPrefixesForConnection(value = {}, connectionId = '') {
    return Array.isArray(value[connectionId]) ? [...value[connectionId]] : [];
  }

  function rootFolderShortcuts(entries = [], limit = 100) {
    const boundedLimit = Number.isFinite(limit)
      ? Math.max(0, Math.min(Math.floor(limit), 100))
      : 100;
    const seen = new Set();
    return (Array.isArray(entries) ? entries : [])
      .filter((entry) => entry && entry.isDir)
      .map((entry) => {
        const path = normalizePrefix(entry.path || entry.name);
        const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : path;
        return { name, path };
      })
      .filter((entry) => entry.path && !entry.path.includes('/'))
      .filter((entry) => {
        if (seen.has(entry.path)) return false;
        seen.add(entry.path);
        return true;
      })
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))
      .slice(0, boundedLimit);
  }

  function navigationMoveTargetPrefixes({
    currentPrefix = '',
    rootEntries = [],
    pinnedPrefixes = [],
    recentPrefixes = [],
  } = {}) {
    return [
      currentPrefix,
      ...(Array.isArray(rootEntries) ? rootEntries.map((entry) => entry && (entry.path || entry.name)) : []),
      ...(Array.isArray(pinnedPrefixes) ? pinnedPrefixes : []),
      ...(Array.isArray(recentPrefixes) ? recentPrefixes : []),
    ]
      .map(normalizePrefix)
      .filter(Boolean)
      .filter((prefix, index, list) => list.indexOf(prefix) === index)
      .slice(0, 100);
  }

  function navigationListingPlan(prefix = '', hasRootCache = false) {
    const targetPrefix = normalizePrefix(prefix);
    return {
      targetPrefix,
      shouldPrimeRoot: Boolean(targetPrefix) && !hasRootCache,
    };
  }

  return {
    connectionDescriptorForProfile,
    navigationListingPlan,
    navigationMoveTargetPrefixes,
    normalizePrefix,
    recordRecentPrefix,
    recentPrefixesForConnection,
    rootFolderShortcuts,
  };
});
