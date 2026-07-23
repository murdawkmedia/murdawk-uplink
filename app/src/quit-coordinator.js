const { shouldGuardClose } = require('./close-guard-core');

function createQuitCoordinator({
  app,
  persistence,
  getActiveTransfer,
  confirmActiveQuit,
  pauseActiveTransfer,
  onError = () => {},
}) {
  let promptPromise = null;
  let shutdownPromise = null;
  let allowQuit = false;

  function finishShutdown(beforeClose) {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      try {
        if (beforeClose) await beforeClose();
        await persistence.flush();
        await persistence.close();
        allowQuit = true;
        app.quit();
        return true;
      } catch (error) {
        onError(error);
        return false;
      } finally {
        if (!allowQuit) shutdownPromise = null;
      }
    })();
    return shutdownPromise;
  }

  function requestActiveQuit() {
    if (shutdownPromise) return shutdownPromise;
    if (promptPromise) return promptPromise;
    promptPromise = (async () => {
      try {
        const decision = await confirmActiveQuit(getActiveTransfer());
        if (decision !== 'pause') return false;
        return await finishShutdown(pauseActiveTransfer);
      } catch (error) {
        onError(error);
        return false;
      } finally {
        promptPromise = null;
      }
    })();
    return promptPromise;
  }

  function handleBeforeQuit(event) {
    if (allowQuit) return Promise.resolve(true);
    event.preventDefault();
    return shouldGuardClose(getActiveTransfer())
      ? requestActiveQuit()
      : finishShutdown();
  }

  function handleWindowClose(event) {
    if (allowQuit || !shouldGuardClose(getActiveTransfer())) return Promise.resolve(false);
    event.preventDefault();
    return requestActiveQuit();
  }

  return { handleBeforeQuit, handleWindowClose };
}

module.exports = { createQuitCoordinator };
