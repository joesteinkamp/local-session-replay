// <TestKit /> boots TestKit once, from an effect, and renders nothing (the
// overlay is a Shadow DOM host outside React's tree). Plain JS, no JSX.
//
// Mount-once: only the first committed mount on the page counts (claimInit in
// src/activation.js), so StrictMode's double effect and HMR remounts are
// no-ops and later prop changes are ignored. Unmounting does not stop the
// session: recording continues until the tester stops it.
import { useEffect } from 'react';
import { boot } from '../boot.js';

/** Internal (not re-exported by the entry): tests inject a fake boot. */
export function createTestKit(bootFn) {
  return function TestKit(props) {
    useEffect(() => {
      // A failed chunk import (e.g. after a redeploy) must not surface as an
      // unhandled rejection. The claim stays taken: fix the cause and reload.
      bootFn(props).catch((err) => console.error('[TestKit] failed to start', err));
    }, []); // eslint-disable-line react-hooks/exhaustive-deps -- mount-once by design
    return null;
  };
}

export const TestKit = createTestKit(boot);
