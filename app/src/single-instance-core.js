function focusExistingWindow(window) {
  if (!window || window.isDestroyed?.()) return false;
  if (window.isMinimized?.()) window.restore();
  window.show?.();
  window.focus?.();
  return true;
}

function coordinateSingleInstance({ app, getWindow, startPrimary = () => {} }) {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }
  app.on('second-instance', () => {
    focusExistingWindow(getWindow());
  });
  startPrimary();
  return true;
}

module.exports = { coordinateSingleInstance, focusExistingWindow };
