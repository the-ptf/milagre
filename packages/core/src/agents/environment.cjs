const { execFile, spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Opened from Finder or the Dock, Milagre gets launchd's environment: PATH is /usr/bin:/bin:/usr/sbin:/sbin
// and nothing the user's shell sets is there, so neither CLI is found and agent commands miss node, gh,

const SHELL_TIMEOUT_MS = 10_000;
const NPM_TIMEOUT_MS = 5_000;
const SHELLS = new Set(["zsh", "bash", "fish", "sh", "dash", "ksh"]);
// Not imported: set by the throwaway shell itself (PWD, OLDPWD, SHLVL, _), or meaning something to Electron or the
// host that the user's shell can't know about this app (a shell started from a terminal that runs Electron as Node).
const { HOST_ONLY: SHELL_ONLY } = require("../host-env.cjs");
// What launchd gives an app opened from Finder or the Dock. Any other PATH came from a terminal.
const LAUNCHD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

function shellCommand(mark) {
  return `/usr/bin/printf '%s' '${mark}'; /usr/bin/env -0; /usr/bin/printf '%s' '${mark}'`;
}

function parseShellEnv(stdout, mark) {
  const start = stdout.indexOf(mark);
  const end = start < 0 ? -1 : stdout.indexOf(mark, start + mark.length);
  if (end < 0) return null;
  const env = {};
  for (const entry of stdout.slice(start + mark.length, end).split("\0")) {
    const at = entry.indexOf("=");
    if (at > 0) env[entry.slice(0, at)] = entry.slice(at + 1);
  }
  return env.PATH ? env : null;
}

function readLoginShellEnv({
  shell,
  env = process.env,
  timeoutMs = SHELL_TIMEOUT_MS,
  spawnImpl = spawn,
  killGroup = (pid) => process.kill(-pid, "SIGKILL"),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  if (!shell || !SHELLS.has(path.basename(shell))) return Promise.resolve(null);
  const mark = `__MILAGRE_ENV_${randomBytes(8).toString("hex")}__`;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(shell, ["-i", "-l", "-c", shellCommand(mark)], { env, stdio: ["ignore", "pipe", "ignore"], detached: true });
    } catch {
      resolve(null);
      return;
    }
    let stdout = "";
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const timer = setTimeoutImpl(() => {
      try {
        killGroup(child.pid);
      } catch {}
      settle(null);
    }, timeoutMs);
    timer.unref?.();
    const ended = () => clearTimeoutImpl(timer);
    child.stdout.setEncoding?.("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const parsed = parseShellEnv(stdout, mark);
      if (parsed) settle(parsed);
    });
    child.on("error", () => {
      ended();
      settle(null);
    });
    child.on("close", () => {
      ended();
      settle(parseShellEnv(stdout, mark));
    });
  });
}

// nvm's default node, where npm puts global CLIs such as Codex: ~/.nvm/alias/default names a version
function nvmBin(home, { exists, readdir, readFile }) {
  const root = path.join(home, ".nvm/versions/node");
  if (!exists(root)) return null;
  let wanted = "";
  try {
    wanted = String(readFile(path.join(home, ".nvm/alias/default"), "utf8"))
      .trim()
      .replace(/^v/, "");
  } catch {}
  const numbers = (name) => name.slice(1).split(".").map(Number);
  const versions = readdir(root)
    .filter((name) => /^v\d+\.\d+\.\d+$/.test(name))
    .sort((a, b) => {
      const [x, y] = [numbers(a), numbers(b)];
      return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
    });
  const match = (/^\d/.test(wanted) && versions.find((name) => name.slice(1) === wanted || name.slice(1).startsWith(`${wanted}.`))) || versions[0];
  return match ? path.join(root, match, "bin") : null;
}

function installDirs(
  home = os.homedir(),
  { exists = fs.existsSync, readdir = fs.readdirSync, readFile = fs.readFileSync, platform = process.platform, env = process.env } = {},
) {
  if (platform === "win32")
    return [
      path.join(home, ".local/bin"), // Claude Code's native installer
      path.join(home, ".grok/bin"), // Grok Build's installer
      path.join(env.LOCALAPPDATA || path.join(home, "AppData/Local"), "Programs/OpenAI/Codex/bin"), // Codex's installer
      path.join(env.APPDATA || path.join(home, "AppData/Roaming"), "npm"),
      path.join(env.LOCALAPPDATA || path.join(home, "AppData/Local"), "Microsoft/WinGet/Links"),
      env.VOLTA_HOME && path.join(env.VOLTA_HOME, "bin"),
      env.NVM_SYMLINK,
      env.PNPM_HOME,
      path.join(home, ".bun/bin"),
    ].filter((dir) => dir && exists(dir));
  return [
    path.join(home, ".local/bin"), // Claude Code's native installer
    path.join(home, ".grok/bin"), // Grok Build's installer
    path.join(home, ".claude/local"), // Claude Code's older local npm install
    "/opt/homebrew/bin",
    "/usr/local/bin",
    nvmBin(home, { exists, readdir, readFile }),
    path.join(home, ".volta/bin"),
    path.join(home, ".asdf/shims"),
    path.join(home, ".local/share/mise/shims"),
    path.join(home, ".npm-global/bin"), // npm's documented prefix for global installs without sudo
    path.join(home, "Library/pnpm"), // pnpm's default PNPM_HOME on macOS
    path.join(home, ".bun/bin"),
  ].filter((dir) => dir && exists(dir));
}

// npm's global bin folder (`<npm prefix -g>/bin`), where `npm install -g @openai/codex` puts Codex. Usually it
// is on PATH already, but npm can be set up to install where no shell looks: an npmrc `prefix`, or Homebrew's
// say. Null when npm isn't found or doesn't answer.
function npmGlobalBin({ env = process.env, home = os.homedir(), execFileImpl = execFile } = {}) {
  return new Promise((resolve) => {
    try {
      execFileImpl("npm", ["prefix", "-g"], { encoding: "utf8", timeout: NPM_TIMEOUT_MS, env, cwd: home }, (error, stdout) => {
        const prefix = error ? "" : String(stdout).trim().split(/\r?\n/).at(-1);
        resolve(prefix && path.isAbsolute(prefix) ? path.join(prefix, "bin") : null);
      });
    } catch {
      resolve(null);
    }
  });
}

function mergePathFor(platform, ...lists) {
  const delimiter = platform === "win32" ? ";" : ":";
  const seen = new Set();
  for (const list of lists) {
    for (const dir of Array.isArray(list) ? list : String(list ?? "").split(delimiter)) if (dir) seen.add(dir);
  }
  return [...seen].join(delimiter);
}
function mergePath(...lists) {
  return mergePathFor(process.platform, ...lists);
}

function userShell() {
  try {
    return os.userInfo().shell;
  } catch {
    return null;
  }
}

function refreshInstallPath({ target = process.env, platform = process.platform, home = os.homedir(), dirs = installDirs } = {}) {
  const name = platform === "win32" ? Object.keys(target).find((key) => key.toLowerCase() === "path") || "Path" : "PATH";
  target[name] = mergePathFor(platform, target[name], dirs(home, { platform, env: target }));
}

// their value (HOME, TMPDIR, SSH_AUTH_SOCK from launchd), except PATH. Opened from Finder or the Dock,
// (npm run dev), the app's own PATH comes first, so an `nvm use`, direnv or virtualenv there still wins,
// then the shell's, then the install folders. npm's global bin folder goes last, asked for with that PATH.
async function loadLoginEnvironment({
  target = process.env,
  platform = process.platform,
  home = os.homedir(),
  userShell: shellInfo = userShell,
  shell = target.SHELL || shellInfo() || (platform === "darwin" ? "/bin/zsh" : "/bin/sh"),
  readShellEnv = readLoginShellEnv,
  dirs = installDirs,
  npmBin = npmGlobalBin,
} = {}) {
  if (platform === "win32") {
    refreshInstallPath({ target, platform, home, dirs });
    return { source: "fallback" };
  }
  const imported = await readShellEnv({ shell, env: { ...target } });
  for (const [key, value] of Object.entries(imported ?? {})) {
    if (key !== "PATH" && !SHELL_ONLY.has(key) && target[key] === undefined) target[key] = value;
  }
  target.PATH =
    target.PATH === LAUNCHD_PATH || !target.PATH ? mergePath(imported?.PATH, target.PATH, dirs(home)) : mergePath(target.PATH, imported?.PATH, dirs(home));
  target.PATH = mergePath(target.PATH, await npmBin({ env: { ...target }, home }));
  return { source: imported ? "shell" : "fallback" };
}

function resolveExecutable(name, { platform = process.platform, env = process.env, execFileImpl = execFile, fsImpl = fs } = {}) {
  if (platform === "win32") {
    if (!/^[a-z0-9_.-]+$/i.test(name)) return Promise.resolve(null);
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
    const extensions = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter((ext) => /^\.(exe|com|cmd|bat)$/i.test(ext));
    const hasExtension = /\.(exe|com|cmd|bat)$/i.test(name);
    for (const directory of String(env[pathKey] || "").split(";")) {
      if (!path.isAbsolute(directory) || directory === "." || directory.includes("\0")) continue;
      for (const extension of hasExtension ? [""] : extensions) {
        const candidate = path.join(directory, name + extension.toLowerCase());
        try {
          if (fsImpl.statSync(candidate).isFile()) return Promise.resolve(candidate);
        } catch {}
      }
    }
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    execFileImpl("/usr/bin/which", [name], { encoding: "utf8", timeout: 5000 }, (error, stdout) => {
      resolve(error ? null : String(stdout).trim().split(/\r?\n/)[0] || null);
    });
  });
}

module.exports = {
  SHELL_TIMEOUT_MS,
  installDirs,
  loadLoginEnvironment,
  mergePath,
  npmGlobalBin,
  parseShellEnv,
  readLoginShellEnv,
  refreshInstallPath,
  resolveExecutable,
};
