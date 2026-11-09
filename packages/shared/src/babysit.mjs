// The Babysit PRs settings every surface shares: the daemon reads them, the desktop and the phone edit them. Also the
// line a Chat shows when babysitting its PR stopped. Types: babysit.d.mts.

/** What can wake the agent, in the order the settings list them. */
const WAKE_ORDER = Object.freeze(["comments", "checks", "conflicts", "behind"]);

export const INTERVAL_OPTIONS = Object.freeze([1, 2, 5, 10, 15, 30]);
export const DAYS_OPTIONS = Object.freeze([1, 3, 7, 14, 30]);
export const FAILURE_OPTIONS = Object.freeze([2, 3, 5]);

const INSTRUCTIONS_MAX = 4000;
const OWN_RULE_MAX = 300;

/** The five levels, each including everything above it. */
export const BABYSIT_LEVELS = Object.freeze(
  [
    { level: 1, title: "Report only", description: "Posts what's wrong in the Chat and changes nothing.", steps: ["report"] },
    {
      level: 2,
      title: "Fix, don't push",
      description: "Fixes it in the Worktree and stops for you to look before anything reaches GitHub.",
      steps: ["fix"],
    },
    { level: 3, title: "Fix and push", description: "Commits the fix and pushes the branch.", steps: ["fix", "push"] },
    {
      level: 4,
      title: "Fix, push and reply",
      description: "Also replies on each review thread it addressed, with the commit that fixed it.",
      steps: ["fix", "push", "reply"],
    },
    {
      level: 5,
      title: "Fix, push, reply and re-request review",
      description: "Then asks the reviewers who left changes to look again.",
      steps: ["fix", "push", "reply", "rerequest"],
    },
  ].map((entry) => Object.freeze({ ...entry, steps: Object.freeze(entry.steps) })),
);

export const BABYSIT_DEFAULTS = Object.freeze({
  enabled: false,
  intervalMinutes: 1,
  wake: Object.freeze(["comments", "checks", "conflicts"]),
  level: 3,
  resolveThreads: true,
  stopWhenGreen: true,
  stopAfterDays: Object.freeze({ on: true, days: 7 }),
  stopAfterFailures: Object.freeze({ on: false, times: 3 }),
  ownRule: false,
  ownRuleText: "",
  instructions: "",
});

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const bool = (value, fallback) => (typeof value === "boolean" ? value : fallback);
const oneOf = (value, options, fallback) => (options.includes(value) ? value : fallback);
const text = (value, max, fallback) => (typeof value === "string" ? value.slice(0, max) : fallback);

/** A rule with a switch and a number: the number survives the switch being off, so turning it on restores it. */
function numberRule(value, options, key, fallback) {
  const source = isRecord(value) ? value : {};
  return { on: bool(source.on, fallback.on), [key]: oneOf(source[key], options, fallback[key]) };
}

/** Any stored or received value as complete, valid settings: unknown keys dropped, each bad value reset to its default. */
export function normalizeBabysitSettings(value) {
  const source = isRecord(value) ? value : {};
  const defaults = BABYSIT_DEFAULTS;
  const wake = Array.isArray(source.wake) ? WAKE_ORDER.filter((kind) => source.wake.includes(kind)) : [...defaults.wake];
  return {
    enabled: bool(source.enabled, defaults.enabled),
    intervalMinutes: oneOf(source.intervalMinutes, INTERVAL_OPTIONS, defaults.intervalMinutes),
    wake,
    level: oneOf(source.level, [1, 2, 3, 4, 5], defaults.level),
    resolveThreads: bool(source.resolveThreads, defaults.resolveThreads),
    stopWhenGreen: bool(source.stopWhenGreen, defaults.stopWhenGreen),
    stopAfterDays: numberRule(source.stopAfterDays, DAYS_OPTIONS, "days", defaults.stopAfterDays),
    stopAfterFailures: numberRule(source.stopAfterFailures, FAILURE_OPTIONS, "times", defaults.stopAfterFailures),
    ownRule: bool(source.ownRule, defaults.ownRule),
    ownRuleText: text(source.ownRuleText, OWN_RULE_MAX, defaults.ownRuleText),
    instructions: text(source.instructions, INSTRUCTIONS_MAX, defaults.instructions),
  };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// Why babysitting a PR stopped, as the Chat's line says it after "Stopped babysitting PR #<n>: ".
const STOPPED_WHY = {
  merged: () => "merged",
  closed: () => "closed",
  green: () => "checks pass and it's approved",
  failures: (context) => `the same problem failed ${plural(context.times ?? 3, "time")}`,
  expired: (context) => `watched for ${plural(context.days ?? 7, "day")}`,
  "own-rule": () => "your own stop rule held",
  deleted: () => "its Heartbeat was deleted",
};

/**
 * The line a Chat shows when its PR's babysit Heartbeat ended (context kind "babysit-stopped"): "Stopped babysitting PR #1:
 * merged.". A reason this build doesn't know reads as a plain stop.
 */
export function babysitStoppedText(context) {
  const why = Object.hasOwn(STOPPED_WHY, context.reason) ? STOPPED_WHY[context.reason](context) : null;
  return why ? `Stopped babysitting PR #${context.pr}: ${why}.` : `Stopped babysitting PR #${context.pr}.`;
}

export function isBabysitStopped(message) {
  return message?.context?.kind === "babysit-stopped";
}
