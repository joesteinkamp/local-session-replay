// Package entry: `import { init } from 'local-session-replay'`. The non-React
// path (Vue, Svelte, vanilla bundled apps); React apps use
// `local-session-replay/react`. Must never import React.
export { boot as init } from './boot.js';

export const version = __TESTKIT_VERSION__;
