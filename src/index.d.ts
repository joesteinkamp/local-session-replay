// Types for the package entry. Option semantics: README.md "Config reference".

export interface TestKitTask {
  id: string;
  prompt: string;
  /** Shown in the summary as "Expected". */
  successHint?: string;
  /** Seconds. A countdown on the task card; never auto-advances. */
  timeLimit?: number;
  /** Accepted but not asked: the overlay keeps to the happy path. */
  followUp?: string;
}

export interface TestKitConfig {
  study?: string;
  /** `'query'` (default) activates with `?test=1`. `?test=0` always disables. */
  activate?: 'query' | boolean | (() => boolean);
  audio?: boolean | { enabled?: boolean; bitrate?: number };
  mask?: { inputs?: boolean };
  checkoutEveryNms?: number;
  inlineImages?: boolean;
  commitSha?: string | null;
  tasks?: TestKitTask[];
}

/** Starts TestKit when activated; resolves once the overlay is booting, or immediately if inactive or server-side. Only the first call on the page counts. */
export function init(config?: TestKitConfig): Promise<void>;

export const version: string;
