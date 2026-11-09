const { execCommand } = require("./command.cjs");
const { execFile } = require("node:child_process");
const { resolveExecutable } = require("./environment.cjs");
const { cliName } = require("@milagre/shared/providers");
const { cliBrokenMessage, cliTooOldMessage, lastLine, missingCliMessage } = require("./events.cjs");
const { KIRO_ACP_ARGS, kiroAgentFor } = require("./kiro-acp.cjs");

// Finds each agent's CLI and checks it against the oldest version Milagre supports:
//   claude  2.1.286, the Claude Code release @anthropic-ai/claude-agent-sdk 0.3.286 is built against
//           (its package.json `claudeCodeVersion`); 2.0.77 rejects the SDK's --effort flag outright.
//   codex   0.160.0, the first release whose model/list offers GPT-6.1 Sol (0.158.0 is where Milagre's use
//           of the app-server protocol was verified; 0.160.0 adds no protocol change Milagre relies on).
//   antigravity  Antigravity, which Milagre installs itself (antigravity-install.cjs). It is never asked for
//           `--version`: the .par is a 280 MB Python archive that unpacks itself on every launch. Its version
//           is the pinned release it was installed from, and the install validated it before activating it.
//   kiro    2.34.2, the release whose v3 engine Milagre's ACP use was verified against (docs/adr/0007-kiro-over-acp.md).
//           The user installs it; Milagre runs the agent binary (`kiro-cli-chat`) that sits beside the `kiro-cli` launcher.
// `--version` prints "2.1.287 (Claude Code)", "codex-cli 0.160.0" and "kiro-cli 2.34.2".
const MIN_VERSIONS = { claude: "2.1.288", codex: "0.160.0", kiro: "2.34.2" };
const VERSION_TIMEOUT_MS = 10_000;

// [major, minor, patch] from the first x.y.z in the text, or null.
function parseVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ""));
  return match ? match.slice(1).map(Number) : null;
}

function isAtLeast(version, minimum) {
  const wanted = parseVersion(minimum);
  for (let index = 0; index < 3; index += 1) if (version[index] !== wanted[index]) return version[index] > wanted[index];
  return true;
}

// `<command> --version`: { output }, or { error } with the last line it printed when it didn't run.
function runVersion(command, { execFileImpl = execFile } = {}) {
  return new Promise((resolve) => {
    execCommand(
      command,
      ["--version"],
      { encoding: "utf8", timeout: VERSION_TIMEOUT_MS },
      (error, stdout, stderr) => {
        resolve(error ? { error: lastLine(stderr) || lastLine(error.message) } : { output: String(stdout) });
      },
      execFileImpl,
    );
  });
}

// { command, version } for a CLI Milagre can run, plus `problem`, the message a turn fails with, when it is
// missing, too old or doesn't start. A version Milagre can't read is no reason to refuse the CLI.
async function inspectCli(name, { resolve = resolveExecutable, version = runVersion, antigravity } = {}) {
  if (name === "antigravity") return inspectAntigravity(antigravity);
  const command = name === "kiro" ? kiroAgentFor(await resolve("kiro-cli")) : await resolve(name);
  if (!command) return { command: null, version: null, problem: missingCliMessage(name) };
  const result = await version(command);
  if (result.error !== undefined) return { command, version: null, problem: cliBrokenMessage(name, command, result.error) };
  const parsed = parseVersion(result.output);
  if (!parsed) return { command, version: null };
  const text = parsed.join(".");
  const found = name === "kiro" ? { command, version: text, args: KIRO_ACP_ARGS } : { command, version: text };
  return isAtLeast(parsed, MIN_VERSIONS[name]) ? found : { ...found, problem: cliTooOldMessage(name, text, MIN_VERSIONS[name]) };
}

// Antigravity: the install under the data directory (or MILAGRE_ANTIGRAVITY_PATH). `harness` and `args` are
// what the session needs to start it besides `command`.
function inspectAntigravity(antigravity) {
  const found = antigravity?.resolve();
  if (!found) {
    const problem =
      antigravity && !antigravity.supported() ? `${cliName("antigravity")} isn't available on this computer yet.` : missingCliMessage("antigravity");
    return { command: null, version: null, problem };
  }
  return { command: found.command, version: found.version, harness: found.harness, args: found.args };
}

// Each CLI is inspected once per app run, after `ready` (the login environment). One with a problem is
// inspected again on the next call, so installing, updating or fixing it needs no restart. Before that
// second look `refresh` runs (it adds install folders created since startup to PATH), because the fix may
// well be an installer that made a new folder.
function createCliCache({ ready = () => undefined, inspect = inspectCli, refresh = () => undefined, antigravity } = {}) {
  const cache = new Map();
  const hadProblem = new Set();
  const check = (name) => {
    if (!cache.has(name)) {
      const pending = Promise.resolve()
        .then(ready)
        .catch(() => {})
        .then(() => (hadProblem.has(name) ? refresh() : undefined))
        .catch(() => {})
        .then(() => inspect(name, { antigravity }))
        .then(
          (status) => {
            if (status.problem) {
              cache.delete(name);
              hadProblem.add(name);
            } else hadProblem.delete(name);
            return status;
          },
          (error) => {
            cache.delete(name);
            throw error;
          },
        );
      cache.set(name, pending);
    }
    return cache.get(name);
  };
  check.invalidate = (name) => {
    cache.delete(name);
    hadProblem.add(name);
  };
  return check;
}

module.exports = { MIN_VERSIONS, createCliCache, inspectCli, isAtLeast, parseVersion, runVersion };
