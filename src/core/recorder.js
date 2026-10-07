// Thin, fail-safe wrapper around rrweb's record(). rrweb failures are
// swallowed (and warned once) so recording problems never break the prototype.

import { record } from 'rrweb';

const BLOCK_CLASS = 'testkit-block';

/**
 * @param {object} opts
 * @param {object} opts.config            normalized config
 * @param {(event) => void} opts.onEvent  receives every rrweb event
 */
export function createRecorder({ config, onEvent }) {
  let stopFn = null;
  let warned = false;

  function warnOnce(err) {
    if (warned) return;
    warned = true;
    console.warn('[TestKit] recorder error (suppressed; recording continues):', err);
  }

  /** Starts rrweb (emitting Meta + FullSnapshot). Returns whether it's running. */
  function start() {
    if (stopFn) return true;
    try {
      stopFn =
        record({
          emit(event) {
            try {
              onEvent(event);
            } catch (err) {
              warnOnce(err);
            }
          },
          maskAllInputs: config.mask.inputs,
          blockClass: BLOCK_CLASS,
          checkoutEveryNms: config.checkoutEveryNms,
          inlineStylesheet: true,
          inlineImages: true,
          collectFonts: true,
          recordCanvas: false,
          sampling: { input: 'last' },
          // Returning true marks the error handled so rrweb doesn't rethrow
          // it into the page's own callbacks.
          errorHandler(err) {
            warnOnce(err);
            return true;
          },
        }) || null;
    } catch (err) {
      warnOnce(err);
      stopFn = null;
    }
    return !!stopFn;
  }

  function stop() {
    const fn = stopFn;
    stopFn = null;
    try {
      fn?.();
    } catch (err) {
      warnOnce(err);
    }
  }

  /** Adds a custom event to the replay stream; a no-op while stopped. */
  function addCustomEvent(tag, payload = {}) {
    if (!stopFn) return false;
    try {
      record.addCustomEvent(tag, payload);
      return true;
    } catch (err) {
      warnOnce(err);
      return false;
    }
  }

  function takeFullSnapshot() {
    if (!stopFn) return;
    try {
      record.takeFullSnapshot(true);
    } catch (err) {
      warnOnce(err);
    }
  }

  return { start, stop, addCustomEvent, takeFullSnapshot, isRecording: () => !!stopFn };
}
