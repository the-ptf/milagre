const fs = require("node:fs");
const path = require("node:path");
const { resolveKiroModel } = require("@milagre/shared/kiro-models");

// Kiro is AWS's agent (kiro-cli) over ACP; see docs/adr/0007-kiro-over-acp.md. This is everything AcpSession needs
// to know about it. Run against kiro-cli 2.34.2 on macOS arm64, engine v3, signed in through IAM Identity Center.

// The v3 engine: its `model` option reports each model's credit multiplier and efforts, and an `effortLevel` option
// follows the model. v2 asks for every command, `git status` included, and reports neither.
const ACP_ARGS = ["acp", "--agent-engine", "v3"];

// Kiro's `autopilot` option stays on in every mode. On, Kiro asks before each edit and each command it doesn't
// consider read-only; off (supervised), it also asks for every command and asks again to review each edit after it
// is made, a second card for what Ask already approved. Its `mode` option is something else (its agents: Default,
// Spec, Plan…), so Milagre never sets it. Milagre's own modes decide the cards (see AcpSession.askPermission).
const MODES = { ask: "on", auto: "on", full: "on", bot: "on" };

// The app the Homebrew cask (and Kiro's installer) puts in /Applications holds the agent beside the `kiro-cli` launcher.
const APP_AGENT = "/Applications/Kiro CLI.app/Contents/MacOS/kiro-cli-chat";
const AGENT_NAME = process.platform === "win32" ? "kiro-cli-chat.exe" : "kiro-cli-chat";

function isExecutableFile(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * The agent binary for a `kiro-cli` launcher found on PATH (or null). `kiro-cli acp` only works once the CLI's own
 * setup has linked `~/.local/bin/kiro-cli-chat`, so Milagre runs the agent beside the launcher's real path instead.
 */
function kiroAgentFor(launcher, { exists = isExecutableFile, realpath = fs.realpathSync } = {}) {
  const candidates = [process.env.MILAGRE_KIRO_PATH];
  if (launcher) {
    try {
      candidates.push(path.join(path.dirname(realpath(launcher)), AGENT_NAME));
    } catch {}
    candidates.push(path.join(path.dirname(launcher), AGENT_NAME));
  }
  if (process.platform === "darwin") candidates.push(APP_AGENT);
  return candidates.find((candidate) => candidate && exists(candidate)) ?? null;
}

function kiroSpawn({ command, args, env }) {
  return { command, args: args ?? ACP_ARGS, env: { ...env } };
}

// "2026-10-30T14:49:46.060Z ERROR kiro::…: message": the agent's tracing prefix says nothing a reader needs.
const LOG = /^\S+\s+(?:ERROR|WARN|INFO|DEBUG|TRACE)\s+[\w:.-]+:\s*/;

/** The line of the agent's stderr that says why it stopped: its last error line, else its last line. */
function crashDetail(stderr) {
  const lines = String(stderr ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const error = lines.findLast((line) => /\bERROR\b|^error:/i.test(line));
  return (error ?? lines.at(-1) ?? "").replace(LOG, "").replace(/^error:\s*/i, "");
}

const errorText = (error) => {
  const data = error?.rpcError?.data;
  return `${error?.message ?? ""} ${typeof data === "string" ? data : data ? JSON.stringify(data) : ""}`;
};

// ACP's "authentication required" is -32000; kiro-cli says "Not logged in" or names its login.
function isLoginError(error) {
  if (!error?.rpcError) return false;
  if (error.rpcError.code === -32000) return true;
  return /not logged in|kiro-cli login|authenticat|sign[ -]?in|token (?:has )?expired|unauthori[sz]ed/i.test(errorText(error));
}

/** Kiro's model id for Milagre's `kiro:` id. */
const resolveModel = ({ model }) => resolveKiroModel(model);

/**
 * The effort to set for the session's model, or null. Kiro offers `effortLevel` after each model switch, at that
 * model's default; one it doesn't list for the model (or a model without efforts, like Auto) is left alone.
 */
function resolveEffort({ model, effort, offered }) {
  if (!effort) return null;
  const option = (offered ?? []).find((item) => item?.value === model);
  const { _meta: meta } = option ?? {};
  const levels = meta?.kiro?.effortLevels;
  return Array.isArray(levels) && levels.includes(effort) ? effort : null;
}

const kiroAcp = {
  provider: "kiro",
  name: "Kiro",
  modes: MODES,
  // The session option the permission mode sets; Kiro has no session/set_mode for it.
  modeOption: "autopilot",
  effortOption: "effortLevel",
  spawn: kiroSpawn,
  crashDetail,
  isLoginError,
  resolveModel,
  resolveEffort,
  // Kiro keeps every session in its history; a throwaway one (a chat title, a commit message) is deleted after use.
  deleteThrowawaySessions: true,
  // Kiro asks before most commands; in Auto, Milagre lets the ones that stay inside the worktree run (command-risk.cjs).
  riskFilter: true,
};

module.exports = { kiroAcp, kiroAgentFor, kiroSpawn, crashDetail, isLoginError, resolveEffort, KIRO_ACP_ARGS: ACP_ARGS, KIRO_MODES: MODES };
