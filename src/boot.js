// Shared by both package entries: src/index.js exports it as `init`, and the
// React component (src/react/TestKit.js) calls it from an effect. The recorder
// is a dynamic import, so host bundlers split it into its own chunk and casual
// viewers download only this file and activation.js.
import { claimInit, isActivated } from './activation.js';

/** Starts TestKit when activated; resolves once the overlay is booting (or immediately if inactive or server-side). */
export async function boot(config = {}) {
  if (typeof window === 'undefined') return; // server render: nothing to record
  if (!claimInit()) return;
  window.TestKit = window.TestKit || { init: boot, version: __TESTKIT_VERSION__ };
  if (!isActivated(config)) return;
  const { start } = await import('./core/index.js');
  await start(config);
}
