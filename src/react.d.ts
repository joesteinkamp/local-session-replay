// Types for `local-session-replay/react`. Props are the same config as init();
// option semantics: README.md "Config reference".
import type { TestKitConfig } from './index.js';

export type { TestKitConfig, TestKitTask } from './index.js';

/**
 * Boots TestKit once, on mount, when activated; renders nothing. Only the first
 * committed mount on the page counts: later prop changes are ignored, and
 * unmounting does not stop a session.
 */
export function TestKit(props: TestKitConfig): null;

export const version: string;
