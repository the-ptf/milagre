const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

// Antigravity is Google's agent (agy_acp_server) over ACP; see docs/providers.md.
// This is everything AcpSession needs to know about it. Run against agy 1.3.0 on macOS arm64; the other platforms' archives are pinned by hash and layout.

const { AMBIENT_ENV, argsFor, memberNames } = require("./antigravity-install.cjs");
const { AntigravitySubagents } = require("./antigravity-subagents.cjs");
const { ANTIGRAVITY_AGENT_OPTIONS, antigravityFamilies, resolveAntigravityModel } = require("@milagre/shared/antigravity-models");

const SCRUBBED_ENV = AMBIENT_ENV;

const MODES = { ask: "default", auto: "auto_edit", full: "yolo" };

// credentials, with the account's profile, file token storage (profiles never share a keychain entry)
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

const ABSL = /^([IWEF])\d{4} [\d:.]+\s+\d+ [\w.-]+:\d+\]\s?/;

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

const signInUrl = (line) => SIGN_IN_LINE.exec(String(line ?? ""))?.[1] ?? null;

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
  subagents: (options) => new AntigravitySubagents(options),
  subscriptionMessage: "Antigravity needs an eligible subscription for this Google account. Choose another account in Settings, then send your message again.",
  tempRoot: path.join(os.tmpdir(), "milagre-antigravity"),
};

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
