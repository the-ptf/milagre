// What a Babysit PRs Run says to the agent in the Chat: Milagre's own section, then the user's instructions.
const { BABYSIT_LEVELS } = require("@milagre/shared/babysit");
const { renderRoutinePrompt } = require("@milagre/shared/routine-prompt");
const { BABYSIT_MARKER } = require("./pull-request-watch.cjs");

// What a level lets the agent do and what it must leave alone, by the steps the level includes (babysit.mjs).
const ALLOWED = {
  report: "Say in this Chat what is wrong and what you would do. Do not change any file, commit, push or comment on GitHub.",
  fix: "Fix it in this Worktree.",
  push: "Commit the fix and push the branch. Push the fix to the PR branch only, never force-push.",
  reply: "Reply on each review thread you addressed, with the commit that fixed it.",
  rerequest: "Then re-request review from the reviewers who asked for changes.",
};
const FORBIDDEN = {
  fix: "Do not push and do not comment on GitHub: stop once it is fixed and say what you changed, so the user can look first.",
  push: "Do not reply on review threads.",
  reply: "Do not request a new review.",
};

const levelOf = (level) => BABYSIT_LEVELS.find((entry) => entry.level === level) ?? BABYSIT_LEVELS[0];

/** The level the Run goes at: the setting's, or report only when the Worktree is not on the PR's branch. */
const effectiveLevel = (settings, onBranch) => (onBranch ? settings.level : 1);

/** Whether the Run may resolve review threads: the setting, at a level that replies. */
const effectiveResolve = (settings, level) => settings.resolveThreads === true && level >= 4;

// A branch name goes in as plain text: no backticks or line breaks to break out of its quotes.
const branchName = (name) => String(name).replace(/[`\r\n]/g, "");

function levelLines(level, onBranch, settings, headBranch, prBranch) {
  const entry = levelOf(level);
  const lines = [`Level ${entry.level}, ${entry.title}: ${entry.description}`];
  if (!onBranch) {
    const where = headBranch ? `is on \`${branchName(headBranch)}\`` : "has a branch that couldn't be read";
    lines.push(
      `This Worktree is not known to be on the PR's branch, so you are limited to level 1 whatever level ${settings.level} says: report only.`,
      `Start your reply by saying this Worktree ${where}, not the PR's \`${branchName(prBranch ?? "")}\`, so this Run only reports.`,
    );
  }
  lines.push(...entry.steps.map((step) => ALLOWED[step]));
  // What the level stops short of: its last step's line (report and the top level have nothing past them).
  const forbidden = FORBIDDEN[entry.steps[entry.steps.length - 1]];
  if (forbidden) lines.push(forbidden);
  lines.push("Do not switch branches.");
  return lines;
}

/**
 * The message of a Babysit PRs Run. `settings` are the Routine's normalized settings, `event` the pull-request event
 * (`summary` is text from GitHub, so it goes in fenced as data), `onBranch` whether the Chat's Worktree is on the PR's
 * branch, `headBranch` the branch it is on (null when it couldn't be read). The settings themselves are never printed.
 */
function babysitPrompt({ settings, event, pr, onBranch, headBranch = null, routineId }) {
  const level = effectiveLevel(settings, onBranch);
  const heartbeat = routineId ? `this Heartbeat (${routineId})` : "this Heartbeat";
  const changes = renderRoutinePrompt("{{body}}", { body: event.summary }, { body: `PR #${pr.number} changes` });
  const own = settings.ownRule && String(settings.ownRuleText ?? "").trim();
  const lines = [
    `You are babysitting ${pr.url} (PR #${pr.number}). It changed:`,
    "",
    changes,
    "",
    ...levelLines(level, onBranch, settings, headBranch, event.branch),
    "",
    "Use the skill for each kind of change: a review comment, milagre-address-review; a failing check, milagre-fix-ci; merge conflicts, milagre-resolve-conflicts; a branch behind its base, milagre-update-branch. The level above limits what you do with them.",
    `End every GitHub comment you post with ${BABYSIT_MARKER}`,
    effectiveResolve(settings, level) ? "Resolve a review thread only after you replied on it and pushed the fix." : "Do not resolve review threads.",
    "Never merge the PR.",
  ];
  if (own) {
    lines.push(
      `Your own stop rule: ${own.replace(/[.!?\s]+$/, "")}. After each pass, check it; if it holds, delete ${heartbeat} with routine_delete and say why.`,
    );
  }
  const instructions = String(settings.instructions ?? "").trim();
  if (instructions) lines.push("", "## Your instructions", instructions);
  return lines.join("\n");
}

module.exports = { babysitPrompt, effectiveLevel, effectiveResolve };
