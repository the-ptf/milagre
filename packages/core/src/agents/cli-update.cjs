const { exec, execFile } = require("node:child_process");
const { execCommand } = require("./command.cjs");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { inspectCli, parseVersion, isAtLeast, MIN_VERSIONS } = require("./cli.cjs");
const { lastLine } = require("./events.cjs");
const { cliName } = require("@milagre/shared/providers");
const { installDirs, mergePath, refreshInstallPath, resolveExecutable } = require("./environment.cjs");
const { installChannel, isHomebrew, brewArgs, channelRelease, downloadSize, watchBrewDownload } = require("./cli-channel.cjs");

// The official installers download a whole release, which takes longer than an npm or self update.
const UPDATE_TIMEOUT_MS = 120_000;
const INSTALLER_TIMEOUT_MS = 300_000;
// The official installers, for a computer that has no CLI yet. Neither needs Node. Codex's asks questions unless
const UNIX_INSTALLERS = {
  claude: "curl -fsSL https://claude.ai/install.sh | bash -s latest",
  codex: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
};
const WINDOWS_INSTALLERS = {
  claude: "irm https://claude.ai/install.ps1 | iex",
  codex: "irm https://chatgpt.com/codex/install.ps1 | iex",
};
const INSTALLER_ENV = { CODEX_NON_INTERACTIVE: "1" };
const BREW_ENV = { HOMEBREW_NO_ENV_HINTS: "1", NONINTERACTIVE: "1" };
const LOG_LINES = 8;

const outputTail = (result) =>
  `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-LOG_LINES)
    .join("\n")
    .slice(-2000);
const brewFailure = (result) =>
  result.stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .findLast((line) => line.startsWith("Error: ")) ||
  lastLine(result.stderr) ||
  result.error;

// Windows PowerShell from System32, never one found on PATH: a Project must not supply the program that installs.
function windowsPowerShell(env = process.env) {
  return path.win32.join(env.SystemRoot || env.windir || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

// `firstDirs` go ahead of PATH, so the update runs with the node and npm that sit beside the CLI being updated.
function runCommand(cmd, execImpl = exec, firstDirs = [], { timeout = UPDATE_TIMEOUT_MS, extraEnv = {} } = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, ...extraEnv, PATH: mergePath(firstDirs, process.env.PATH, installDirs()) };
    execImpl(cmd, { encoding: "utf8", timeout, env }, (error, stdout, stderr) => {
      resolve({
        code: error?.code ?? (error ? 1 : 0),
        error: error ? error.message || String(stderr || "") : null,
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
      });
    });
  });
}

const shellQuote = (value) => (/^[\w./@:-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`);

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

// Windows: each step runs a program by its absolute path, with its arguments kept out of any shell. A CLI that is
// there updates itself first; one that isn't comes from the official PowerShell installer, then npm when Node is
async function runWindowsCliUpdate(
  name,
  { inspect = inspectCli, resolve = resolveExecutable, execFileImpl = execFile, refresh = refreshInstallPath, env = process.env } = {},
) {
  if (!["claude", "codex"].includes(name)) return { ok: false, error: `Unknown provider: ${name}` };
  let status = await inspect(name);
  if (name === "claude" && !status.problem) return { ok: true, version: status.version };
  const installed = Boolean(await resolve(name));
  const installer = [windowsPowerShell(env), ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_INSTALLERS[name]], INSTALLER_TIMEOUT_MS];
  const npm = ["npm", ["install", "-g", name === "claude" ? "@anthropic-ai/claude-code@latest" : "@openai/codex@latest"]];
  const commands =
    name === "claude"
      ? installed
        ? [["claude", ["install", "--force", "latest"]], installer, npm, ["claude", ["update"]]]
        : [installer, npm]
      : installed
        ? [["codex", ["update"]], npm, installer]
        : [installer, npm];
  let failure;
  for (const [program, args, timeout = UPDATE_TIMEOUT_MS] of commands) {
    const file = path.win32.isAbsolute(program) ? program : await resolve(program);
    if (file) {
      failure = await new Promise((done) =>
        execCommand(
          file,
          args,
          { encoding: "utf8", timeout, windowsHide: true, env: { ...env, ...INSTALLER_ENV } },
          (error, _stdout, stderr) => done(error ? lastLine(stderr) || error.message : null),
          execFileImpl,
        ),
      );
    } else failure = `${program} is not installed on PATH.`;
    refresh();
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
  const windows = (deps.platform || process.platform) === "win32";
  const channel = windows ? { kind: "other" } : (deps.channelOf ?? installChannel)(name, status.command);
  if (isHomebrew(channel)) return upgradeWithHomebrew(name, channel, deps, satisfied);
  deps.onProgress?.({ phase: "install" });
  // Codex may come from npm, bun, pnpm or Homebrew. A plain `npm install -g` can land in another prefix than the
  const codex = !windows && name === "codex" && status.command ? status.command : null;
  const commands =
    name === "claude"
      ? [
          ["claude", ["install", "--force", "latest"]],
          ["npm", ["install", "-g", "@anthropic-ai/claude-code@latest"]],
        ]
      : [...(codex ? [[codex, ["update"]]] : []), ["npm", ["install", "-g", "@openai/codex@latest"]]];
  const firstDirs = codex ? [path.dirname(codex)] : [];
  let failure;
  let log;
  for (const [program, args] of commands) {
    if (windows) {
      const file = await resolve(program);
      failure = file
        ? await new Promise((done) =>
            execCommand(file, args, { encoding: "utf8", timeout: 120000, windowsHide: true }, (error) => done(error?.message), execFileImpl),
          )
        : `${program} is not installed on PATH.`;
    } else {
      const result = await runCommand([shellQuote(program), ...args].join(" "), execImpl, firstDirs);
      failure = result.error ? lastLine(result.stderr) || result.error : failure;
      log = result.error ? outputTail(result) : log;
      if (name === "claude") linkVersion();
    }
    status = await inspect(name);
    if (satisfied(status)) return { ok: true, version: status.version };
  }
  return {
    ok: false,
    version: status.version,
    error:
      status.problem ||
      failure ||
      `The installed ${name}${status.command ? ` at ${status.command}` : ""} is still ${status.version ?? "unavailable"}. Version ${targetVersion} could not be activated.`,
    ...(log ? { log } : {}),
  };
}

// Homebrew owns the binary on PATH, so only Homebrew may replace it: an npm install there fails with EEXIST.
async function upgradeWithHomebrew(name, channel, deps, satisfied) {
  const { targetVersion, inspect = inspectCli, execImpl = exec, onProgress, release = channelRelease, sizeOf = downloadSize, watch = watchBrewDownload } = deps;
  const url =
    channel.kind === "homebrew-cask"
      ? await release(name, channel).then(
          (found) => found.url,
          () => null,
        )
      : null;
  const total = url ? await sizeOf(url) : null;
  let stop = () => {};
  if (url && total) {
    onProgress?.({ phase: "download", received: 0, total });
    stop = watch({ url, total, onProgress: (progress) => onProgress?.(progress) });
  } else onProgress?.({ phase: "install" });
  const command = [channel.brew, ...brewArgs(channel)].map(shellQuote).join(" ");
  const result = await runCommand(command, execImpl, [path.dirname(channel.brew)], { timeout: INSTALLER_TIMEOUT_MS, extraEnv: BREW_ENV });
  stop();
  const status = await inspect(name);
  if (satisfied(status)) return { ok: true, version: status.version };
  const log = outputTail(result);
  return {
    ok: false,
    version: status.version,
    error: result.error
      ? brewFailure(result)
      : `Homebrew didn't install ${cliName(name)} ${targetVersion}. ${cliName(name)} is still ${status.version ?? "unavailable"}.`,
    ...(log ? { log } : {}),
  };
}

async function runCliUpdate(name, deps = {}) {
  if (name === "antigravity") return updateAntigravity(deps);
  if (name === "kiro")
    return { ok: false, error: "Kiro CLI is installed and updated outside Milagre: `brew install --cask kiro-cli` installs it, `kiro-cli update` updates it." };
  if (deps.targetVersion) {
    if (!["claude", "codex"].includes(name) || !/^\d+\.\d+\.\d+$/.test(deps.targetVersion)) return { ok: false, error: "Invalid provider release." };
    return upgradeRelease(name, deps);
  }
  if ((deps.platform || process.platform) === "win32") return runWindowsCliUpdate(name, deps);
  const { inspect = inspectCli, execImpl = exec, linkVersion = linkNewestClaudeVersion, refresh = refreshInstallPath } = deps;
  if (!["claude", "codex"].includes(name)) return { ok: false, error: `Unknown provider: ${name}` };
  if (name === "claude") linkVersion();
  let status = await inspect(name);
  if (name === "claude" && !status.problem) return { ok: true, version: status.version };
  // A CLI that is there updates itself; one that isn't comes from the official installer, then npm.
  const installed = Boolean(status.command);
  const installer = [UNIX_INSTALLERS[name], { timeout: INSTALLER_TIMEOUT_MS, extraEnv: INSTALLER_ENV }];
  const channel = installed ? (deps.channelOf ?? installChannel)(name, status.command) : { kind: "other" };
  const commands = isHomebrew(channel)
    ? [[[channel.brew, ...brewArgs(channel)].map(shellQuote).join(" "), { timeout: INSTALLER_TIMEOUT_MS, extraEnv: BREW_ENV }]]
    : name === "claude"
      ? installed
        ? [["claude install --force latest"], installer, ["claude update"]]
        : [installer]
      : installed
        ? [["codex update"], ["npm install -g @openai/codex@latest"]]
        : [installer, ["npm install -g @openai/codex@latest"]];
  let failure;
  for (const [command, options] of commands) {
    const result = await runCommand(command, execImpl, [], options);
    failure = result.error ? lastLine(result.stderr) || result.error : failure;
    if (name === "claude") linkVersion();
    refresh();
    status = await inspect(name);
    if (!status.problem) return { ok: true, version: status.version };
  }
  return {
    ok: false,
    version: status.version,
    error: (status.command ? status.problem || failure : failure || status.problem) || `${cliName(name)} could not be installed.`,
  };
}

module.exports = { runCliUpdate, linkNewestClaudeVersion };
