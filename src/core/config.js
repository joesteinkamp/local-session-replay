// Normalizes the user's TestKit.init() config. See docs/CONTRACTS.md.

const DEFAULTS = {
  study: 'untitled-study',
  activate: 'query',
  audio: { enabled: true, bitrate: 32000 },
  mask: { inputs: true },
  checkoutEveryNms: 60000,
  inlineImages: true,
  commitSha: null,
  tasks: [],
};

function metaCommit() {
  if (typeof document === 'undefined') return null;
  const el = document.querySelector('meta[name="testkit:commit"]');
  return el?.content?.trim() || null;
}

export function normalizeConfig(user = {}) {
  const audio = typeof user.audio === 'boolean' ? { enabled: user.audio } : user.audio || {};
  const tasks = Array.isArray(user.tasks) ? user.tasks : [];
  return {
    study: String(user.study || DEFAULTS.study),
    activate: user.activate ?? DEFAULTS.activate,
    audio: {
      enabled: audio.enabled ?? DEFAULTS.audio.enabled,
      bitrate: Number(audio.bitrate) || DEFAULTS.audio.bitrate,
    },
    mask: { inputs: user.mask?.inputs ?? DEFAULTS.mask.inputs },
    checkoutEveryNms: Number(user.checkoutEveryNms) || DEFAULTS.checkoutEveryNms,
    inlineImages: typeof user.inlineImages === 'boolean' ? user.inlineImages : DEFAULTS.inlineImages,
    commitSha: user.commitSha || metaCommit(),
    tasks: tasks.map((t, i) => ({
      id: String(t.id ?? `task-${i + 1}`),
      prompt: String(t.prompt ?? ''),
      successHint: t.successHint ? String(t.successHint) : null,
      timeLimit: Number(t.timeLimit) > 0 ? Number(t.timeLimit) : null,
      followUp: t.followUp ? String(t.followUp) : null,
    })),
  };
}
