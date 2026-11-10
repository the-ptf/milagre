const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

// Antigravity is Google's agent (agy_acp_server) over ACP; see docs/adr/0006-antigravity-over-acp.md.
// This is everything AcpSession needs to know about it. Run against agy 1.3.0 on macOS arm64; the other platforms' archives are pinned by hash and layout.

const { AMBIENT_ENV, argsFor, memberNames } = require("./antigravity-install.cjs");
const { AntigravitySubagents } = require("./antigravity-subagents.cjs");
const { ANTIGRAVITY_AGENT_OPTIONS, antigravityFamilies, resolveAntigravityModel } = require("@milagre/shared/antigravity-models");

// Ambient credentials and settings that would pick another account, project or token store, or open a
// browser on the agent's own; the account's own GEMINI_HOME is set again after the scrub.
const SCRUBBED_ENV = AMBIENT_ENV;

// Milagre permission mode -> the agent's session mode.
const MODES = { ask: "default", auto: "auto_edit", full: "yolo" };

// The agent's environment: the account's (or the process's) environment without ambient Google
// credentials, with the account's profile, file token storage (profiles never share a keychain entry)
// and a temporary directory Milagre owns, because the agent unpacks large files there on every launch.
// `harness` comes from the resolved install; without one, the tool binary that ships beside the agent.
function antigravityEnv({ env = process.env, command, harness, tmpdir, platform = process.platform }) {
  const home = env.GEMINI_HOME;
  const next = { ...env };
  for (const name of SCRUBBED_ENV) delete next[name];
  if (home) next.GEMINI_HOME = home;
  next.AGY_ACP_FORCE_FILE_STORAGE = "1";
  next.PYTHONUNBUFFERED = "1";
  if (tmpdir) {
    next.TMPDIR = tmpdir;
    // Windows programs find their temporary directory through TEMP and TMP, not TMPDIR.
    if (platform === "win32") Object.assign(next, { TEMP: tmpdir, TMP: tmpdir });
  }
  if (harness || command) next.ANTIGRAVITY_HARNESS_PATH = harness ?? path.join(path.dirname(command), memberNames(platform).harness);
  return next;
}

function antigravitySpawn({ command, args, harness, env, tmpdir, platform = process.platform }) {
  return { command, args: args ?? argsFor(platform), env: antigravityEnv({ env, command, harness, tmpdir, platform }) };
}

// "I1007 21:18:18.878412 8444297088 server.py:2824] message": absl's log prefix, with its level letter.
const ABSL = /^([IWEF])\d{4} [\d:.]+\s+\d+ [\w.-]+:\d+\]\s?/;

// The line of the agent's stderr that says why it stopped: its last error log line or the last line of a
// Python traceback. Info and warning lines (telemetry, notices) say nothing a reader needs.
function crashDetail(stderr) {
  const lines = String(stderr ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    const level = ABSL.exec(line)?.[1];
    if (level === "E" || level === "F") return line.replace(ABSL, "");
    if (!level && /^[\w.]*(?:Error|Exception|Exit)\b:?/.test(line)) return line;
  }
  return "";
}

const errorText = (error) => {
  const data = error?.rpcError?.data;
  return `${error?.message ?? ""} ${typeof data === "string" ? data : data ? JSON.stringify(data) : ""}`;
};

// ACP's "authentication required" is -32000; Antigravity's own messages name sign-in or a missing API key.
function isLoginError(error) {
  if (!error?.rpcError) return false;
  if (error.rpcError.code === -32000 && !/SUBSCRIPTION_REQUIRED/.test(errorText(error))) return true;
  return /sign[ -]?in|authenticat|API key is missing|not logged in|unauthenticated|login required/i.test(errorText(error));
}

const isSubscriptionError = (error) => Boolean(error?.rpcError) && /SUBSCRIPTION_REQUIRED/.test(errorText(error));

const SIGN_IN_LINE = /Open the following link to authenticate the ACP server:\s*(\S+)/;

/** The sign-in URL in a line the agent printed, or null. */
const signInUrl = (line) => SIGN_IN_LINE.exec(String(line ?? ""))?.[1] ?? null;

/**
 * The agent model id for Milagre's model (a family id, or a raw agent id from an older chat) at `effort`, from the
 * models the session offered, else the catalog's. An id nothing knows is passed on as it is, for the agent to refuse.
 */
function resolveModel({ model, effort, offered }) {
  const options = Array.isArray(offered) && offered.length ? offered : ANTIGRAVITY_AGENT_OPTIONS;
  return (
    resolveAntigravityModel(antigravityFamilies(options), model, effort) ??
    resolveAntigravityModel(antigravityFamilies(ANTIGRAVITY_AGENT_OPTIONS), model, effort) ??
    model
  );
}

const antigravityAcp = {
  provider: "antigravity",
  name: "Antigravity",
  modes: MODES,
  spawn: antigravitySpawn,
  crashDetail,
  isLoginError,
  isSubscriptionError,
  resolveModel,
  // Its subagents are read from the transcripts in the account's profile (see antigravity-subagents.cjs).
  subagents: (options) => new AntigravitySubagents(options),
  subscriptionMessage: "Antigravity needs an eligible subscription for this Google account. Choose another account in Settings, then send your message again.",
  // The per-process temporary directories live under this root (see makeTempDir and sweepTempDirs).
  tempRoot: path.join(os.tmpdir(), "milagre-antigravity"),
};

// The agent unpacks about 1 GB into its TMPDIR on every launch and leaves it behind when it is killed. Each
// directory is named after the Milagre process that made it, `<kind>-<pid>-XXXXXX`, so a host only sweeps
// away directories whose owner has exited; other Milagre hosts on this computer share the root.
async function makeTempDir(root, kind) {
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  return fsp.mkdtemp(path.join(root, `${kind}-${process.pid}-`));
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function sweepTempDirs(root = antigravityAcp.tempRoot) {
  const entries = await fsp.readdir(root).catch(() => []);
  await Promise.all(
    entries.map((name) => {
      const pid = Number(/^[a-z-]+?-(\d+)-/.exec(name)?.[1]);
      // Directories from before this naming carry no owner; an owner that is still running keeps its own.
      if (!pid || alive(pid)) return null;
      return fsp.rm(path.join(root, name), { recursive: true, force: true }).catch(() => {});
    }),
  );
}

module.exports = {
  antigravityAcp,
  makeTempDir,
  sweepTempDirs,
  antigravityEnv,
  antigravitySpawn,
  crashDetail,
  isLoginError,
  isSubscriptionError,
  signInUrl,
  ANTIGRAVITY_MODES: MODES,
  SCRUBBED_ENV,
};
