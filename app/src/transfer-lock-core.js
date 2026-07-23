function assertTransferStartAvailable(
  { activeProcess = null, activeJobId = '' } = {},
  { requestedJobId = '' } = {},
) {
  if (!activeProcess) return true;
  const error = new Error(
    `Transfer ${activeJobId || 'unknown'} is already active; ${requestedJobId || 'the requested transfer'} was not started.`,
  );
  error.code = 'TRANSFER_ALREADY_ACTIVE';
  throw error;
}

function spawnTransferProcess({
  spawnProcess,
  command = 'rclone',
  args = [],
  options = {},
  activeProcess = null,
  activeJobId = '',
  requestedJobId = '',
} = {}) {
  assertTransferStartAvailable(
    { activeProcess, activeJobId },
    { requestedJobId },
  );
  if (typeof spawnProcess !== 'function') {
    throw new TypeError('Transfer process spawner is required.');
  }
  return spawnProcess(command, args, options);
}

module.exports = {
  assertTransferStartAvailable,
  spawnTransferProcess,
};
