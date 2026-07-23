const {
  resolveConnectionBinding,
  sanitizeConnectionProfile,
} = require('./connection-core');

function bindMainTransferIdentity(request = {}, connections = []) {
  const requestedProfile = sanitizeConnectionProfile(request.profileSnapshot || request.profile);
  const binding = resolveConnectionBinding({
    connections,
    connectionId: request.connectionId,
    profile: requestedProfile,
  });
  const profile = Object.freeze({ ...binding.profile });
  const profileSnapshot = Object.freeze({ ...binding.profile });
  return Object.freeze({
    connectionId: binding.connectionId,
    profile,
    profileSnapshot,
  });
}

const bindMainUploadIdentity = bindMainTransferIdentity;

module.exports = {
  bindMainTransferIdentity,
  bindMainUploadIdentity,
};
