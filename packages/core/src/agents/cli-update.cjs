const { exec, execFile } = require("node:child_process");
const { execCommand } = require("./command.cjs");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { inspectCli, parseVersion, isAtLeast, MIN_VERSIONS } = require("./cli.cjs");
const { installDirs, mergePath, resolveExecutable } = require("./environment.cjs");

function runCommand(cmd, execImpl = exec) {
  return new Promise((resolve) => {
    const env = { ...process.env, PATH: mergePath(process.env.PATH, installDirs()) };
    execImpl(cmd, { encoding: "utf8", timeout: 120_000, env }, (error, stdout, stderr) => {
      resolve({
        code: error?.code ?? (error ? 1 : 0),
        error: error ? error.message || String(stderr || "") : null,
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
      });
    });
  });
}

/**
 * Links ~/.local/bin/claude to the newest installed version in ~/.local/share/claude/versions
 * that satisfies MIN_VERSIONS.claude.
 */
function linkNewestClaudeVersion(home = os.homedir()) {
  if (process.platform === "win32") return false;
  try {
    const versionsDir = path.join(home, ".local/share/claude/versions");
    if (!fs.existsSync(versionsDir)) return false;
    const entries = fs.readdirSync(versionsDir);
    const valid = entries
      .map((entry) => ({ entry, parsed: parseVersion(entry) }))
      .filter((item) => item.parsed !== null && isAtLeast(item.parsed, MIN_VERSIONS.claude))
      .sort((a, b) => {
        for (let i = 0; i < 3; i++) {
          if (b.parsed[i] !== a.parsed[i]) return b.parsed[i] - a.parsed[i];
        }
        return 0;
      });
    if (valid.length === 0) return false;
    const best = valid[0].entry;
    const targetBin = path.join(home, ".local/bin/claude");
    const targetVersionPath = path.join(versionsDir, best);
    if (fs.existsSync(targetBin) || fs.lstatSync(targetBin, { throwIfNoEntry: false })) {
      fs.unlinkSync(targetBin);
    }
    fs.mkdirSync(path.dirname(targetBin), { recursive: true });
    fs.symlinkSync(targetVersionPath, targetBin);
    return true;
  } catch {
    return false;
  }
}

/**
 * Updates an agent CLI. For Claude:
 * 1. Checks if a compliant version already exists in ~/.local/share/claude/versions
 * 2. Tries `claude install --force latest`
 * 3. Falls back to `curl -fsSL https://claude.ai/install.sh | bash -s latest`
 * 4. Ensures the symlink points to the newest compliant version
 */
async function runWindowsCliUpdate(name, { inspect = inspectCli, resolve = resolveExecutable, execFileImpl = execFile } = {}) {
  if (!["claude", "codex"].includes(name)) return { ok: false, error: `Unknown provider: ${name}` };
  let status = await inspect(name);
  if (name === "claude" && !status.problem) return { ok: true, version: status.version };
  const commands =
    name === "claude"
      ? [
          ["claude", ["install", "--force", "latest"]],
          ["npm", ["install", "-g", "@anthropic-ai/claude-code@latest"]],
          ["claude", ["update"]],
        ]
      : [
          ["codex", ["update"]],
          ["npm", ["install", "-g", "@openai/codex@latest"]],
        ];
  let failure;
  for (const [program, args] of commands) {
    const file = await resolve(program);
    if (file) {
      failure = await new Promise((done) =>
        execCommand(
          file,
          args,
          { encoding: "utf8", timeout: 120000, windowsHide: true },
          (error, _stdout, stderr) => done(error ? error.message || String(stderr) : null),
          execFileImpl,
        ),
      );
    } else failure = `${program} is not installed on PATH.`;
    status = await inspect(name);
    if (!status.problem) return { ok: true, version: status.version };
  }
  return { ok: false, version: status.version, error: status.problem || failure || `${name} update did not meet the required version.` };
}

/**
 * Antigravity: installs the pinned release when nothing runs yet or what runs is another version. It is
 * Milagre's own download, so there is no terminal command to run. `onProgress` gets the install's phases.
 */
async function updateAntigravity({ antigravity, onProgress, signal } = {}) {
  if (!antigravity) return { ok: false, error: "Antigravity can't be installed here." };
  const current = antigravity.resolve();
  if (current && !antigravity.updateAvailable()) return { ok: true, version: current.version };
  try {
    const { version } = await antigravity.install({ onProgress, signal });
    return { ok: true, version };
  } catch (error) {
    return { ok: false, version: current?.version ?? null, error: error?.message || "Antigravity couldn't be installed." };
  }
}

// Optional latest-release upgrades must reach the version advertised by the card, even
// when the installed version already satisfies Milagre's minimum.
async function upgradeRelease(name, deps) {
  const {
    targetVersion,
    inspect = inspectCli,
    execImpl = exec,
    execFileImpl = execFile,
    resolve = resolveExecutable,
    linkVersion = linkNewestClaudeVersion,
  } = deps;
  const satisfied = (status) => !status.problem && parseVersion(status.version) && isAtLeast(parseVersion(status.version), targetVersion);
  let status = await inspect(name);
  if (satisfied(status)) return { ok: true, version: status.version };
  const commands =
    name === "claude"
      ? [
          ["claude", ["install", "--force", "latest"]],
          ["npm", ["install", "-g", "@anthropic-ai/claude-code@latest"]],
        ]
      : [["npm", ["install", "-g", "@openai/codex@latest"]]];
  let failure;
  for (const [program, args] of commands) {
    if ((deps.platform || process.platform) === "win32") {
      const file = await resolve(program);
      failure = file
        ? await new Promise((done) =>
            execCommand(file, args, { encoding: "utf8", timeout: 120000, windowsHide: true }, (error) => done(error?.message), execFileImpl),
          )
        : `${program} is not installed on PATH.`;
    } else {
      const result = await runCommand([program, ...args].join(" "), execImpl);
      failure = result.error;
      if (name === "claude") linkVersion();
    }
    status = await inspect(name);
    if (satisfied(status)) return { ok: true, version: status.version };
  }
  return {
    ok: false,
    version: status.version,
    error: status.problem || failure || `The installed ${name} is still ${status.version ?? "unavailable"}. Version ${targetVersion} could not be activated.`,
  };
}

async function runCliUpdate(name, deps = {}) {
  if (name === "antigravity") return updateAntigravity(deps);
  if (deps.targetVersion) {
    if (!["claude", "codex"].includes(name) || !/^\d+\.\d+\.\d+$/.test(deps.targetVersion)) return { ok: false, error: "Invalid provider release." };
    return upgradeRelease(name, deps);
  }
  if ((deps.platform || process.platform) === "win32") return runWindowsCliUpdate(name, deps);
  const { inspect = inspectCli, execImpl = exec, linkVersion = linkNewestClaudeVersion } = deps;

  if (name === "claude") {
    // 1. Check if a newer version is already on disk (e.g. downloaded by a previous install)
    linkVersion();
    let status = await inspect("claude");
    if (!status.problem) {
      return { ok: true, version: status.version };
    }

    // 2. Try claude install --force latest
    await runCommand("claude install --force latest", execImpl);
    linkVersion();
    status = await inspect("claude");
    if (!status.problem) {
      return { ok: true, version: status.version };
    }

    // 3. Fallback to install.sh latest
    const fallback = await runCommand(
      process.platform === "win32" ? "npm install -g @anthropic-ai/claude-code@latest" : "curl -fsSL https://claude.ai/install.sh | bash -s latest",
      execImpl,
    );
    linkVersion();
    status = await inspect("claude");
    if (!status.problem) {
      return { ok: true, version: status.version };
    }

    // 4. Try standard claude update as last resort
    await runCommand("claude update", execImpl);
    linkVersion();
    status = await inspect("claude");
    if (!status.problem) {
      return { ok: true, version: status.version };
    }

    return {
      ok: false,
      version: status.version,
      error: status.problem || fallback.error || "Claude update did not meet the required version.",
    };
  }

  if (name === "codex") {
    const result = await runCommand("codex update", execImpl);
    const status = await inspect("codex");
    if (!status.problem) {
      return { ok: true, version: status.version };
    }
    return {
      ok: false,
      version: status.version,
      error: status.problem || result.error || "Codex update did not meet the required version.",
    };
  }

  return { ok: false, error: `Unknown provider: ${name}` };
}

module.exports = { runCliUpdate, linkNewestClaudeVersion };
