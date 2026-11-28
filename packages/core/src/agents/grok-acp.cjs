const { resolveGrokModel } = require("@milagre/shared/grok-models");

// Grok is xAI's coding agent (the Grok Build CLI, `grok`) over ACP; see docs/providers.md. This is everything
// AcpSession needs to know about it.

const ACP_ARGS = ["agent", "stdio"];

// Grok's own permission mode stays `ask` (its default): it runs read-only tools and read-only shell commands and
// asks before the rest. Milagre's mode decides what reaches a card, so Milagre never switches Grok's.
const MODES = {};

const EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh"]);

function grokSpawn({ command, args, env }) {
  return { command, args: args ?? ACP_ARGS, env: { ...env } };
}

function crashDetail(stderr) {
  const lines = String(stderr ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const error = lines.findLast((line) => /\bERROR\b|^error:/i.test(line));
  return (error ?? lines.at(-1) ?? "").replace(/^error:\s*/i, "");
}

const errorText = (error) => {
  const data = error?.rpcError?.data;
  return `${error?.message ?? ""} ${typeof data === "string" ? data : data ? JSON.stringify(data) : ""}`;
};

// ACP's "authentication required" is -32000; Grok points to `grok login` when its session token is missing or can't refresh.
function isLoginError(error) {
  if (!error?.rpcError) return false;
  if (error.rpcError.code === -32000) return true;
  return /not logged in|not signed in|grok login|authenticat|sign[ -]?in|token (?:has )?expired|unauthori[sz]ed/i.test(errorText(error));
}

/** Grok's model id for Milagre's `grok:` id. */
const resolveModel = ({ model }) => resolveGrokModel(model);

/**
 * The `reasoning_effort` to set, or null. Grok applies it to the current model and drops it, with a warning, when the
 * model doesn't advertise reasoning effort, so any level it names is safe to send.
 */
function resolveEffort({ effort }) {
  return typeof effort === "string" && EFFORTS.has(effort) ? effort : null;
}

const grokAcp = {
  provider: "grok",
  name: "Grok",
  modes: MODES,
  effortOption: "reasoning_effort",
  spawn: grokSpawn,
  crashDetail,
  isLoginError,
  resolveModel,
  resolveEffort,
  // Grok asks before most commands; in Auto, Milagre lets the ones that stay inside the worktree run (command-risk.cjs).
  riskFilter: true,
};

module.exports = { grokAcp, grokSpawn, crashDetail, isLoginError, resolveEffort, GROK_ACP_ARGS: ACP_ARGS, GROK_MODES: MODES };
