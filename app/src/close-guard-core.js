function buildCloseGuardMessage(transfer = {}) {
  const source = transfer.currentFile || transfer.source || 'the current file';
  const pid = transfer.pid || transfer.activePid || 0;
  const processLine = pid ? `rclone process: PID ${pid}` : 'rclone process: running';
  const phase = String(transfer.phase || '').toLowerCase();
  if (!['prechecking', 'uploading'].includes(phase)) {
    return {
      type: 'warning',
      buttons: ['Keep open', 'Cancel close'],
      defaultId: 0,
      cancelId: 1,
      title: 'Upload is finishing',
      message: 'Murdawk Uplink must stay open while this upload finishes safely.',
      detail: [
        phase === 'verifying'
          ? 'Remote verification and checksum work is in progress.'
          : 'The upload is committing its final result.',
        '',
        'Please wait for this step to finish, then close the app.',
      ].join('\n'),
      noLink: true,
    };
  }
  return {
    type: 'warning',
    buttons: ['Keep uploading', 'Pause and close', 'Cancel close'],
    defaultId: 0,
    cancelId: 2,
    title: 'Upload still running',
    message: 'Murdawk Uplink is still uploading.',
    detail: [
      'Pause and close saves this upload without marking it cancelled.',
      '',
      processLine,
      `Current item: ${source}`,
      '',
      'When you resume, Murdawk Uplink checks remote files before continuing and skips matching work.',
    ].join('\n'),
    noLink: true,
  };
}

function shouldGuardClose(transfer = {}) {
  return Boolean(transfer && (transfer.isRunning || transfer.activeJobId || transfer.pid || transfer.activePid));
}

module.exports = {
  buildCloseGuardMessage,
  shouldGuardClose,
};
