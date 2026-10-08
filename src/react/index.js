'use client';
// Package entry: `import { TestKit } from 'local-session-replay/react'`. The
// directive must stay first in this file: esbuild keeps it only at the top of an
// entry, and Next App Router needs it to import the component from server files.
export { TestKit } from './TestKit.js';

export const version = __TESTKIT_VERSION__;
