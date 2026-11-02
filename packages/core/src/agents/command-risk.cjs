const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { babysitDenial, commandsOf } = require("../babysit-guard.cjs");

// Auto mode's risk filter for an agent that asks before every command it doesn't consider read-only (Kiro; see
// docs/adr/0007-kiro-over-acp.md). A command is risky when it reaches outside the Chat's worktree or can't be undone
// from it: it writes or deletes outside the worktree, discards uncommitted work, writes to GitHub or another remote
// service, runs as an administrator, installs software on the computer, runs a script from the internet, sends data
// over the network or changes the computer itself. A risky command gets a card that says why; anything else runs.
// The check reads the command's words, as babysit-guard.cjs does: it can't see what a script it runs will do, so a
// command that runs one from outside the worktree counts as risky.

const base = (word) => path.basename(word).replace(/\.exe$/i, "");

// Words that only change how a command runs, ahead of the command itself.
const PREFIXES = new Set(["command", "builtin", "exec", "nohup", "time", "nice", "env", "xargs", "timeout", "caffeinate"]);

const ADMIN = new Set(["sudo", "su", "doas", "pkexec"]);
const SYSTEM = new Set([
  "shutdown",
  "reboot",
  "halt",
  "launchctl",
  "systemctl",
  "crontab",
  "osascript",
  "diskutil",
  "mkfs",
  "fdisk",
  "dd",
  "csrutil",
  "spctl",
  "networksetup",
  "scutil",
  "pmset",
  "security",
  "kill",
  "pkill",
  "killall",
]);
const REMOTE_SHELLS = new Set(["ssh", "scp", "sftp", "rsync", "nc", "ncat", "netcat", "telnet", "ftp"]);
// Package managers that install for the whole computer, by the subcommands that do.
const SYSTEM_PACKAGES = new Map([
  ["brew", /^(?:install|reinstall|uninstall|remove|rm|upgrade|tap|untap|link|unlink|services|cleanup)$/],
  ["apt", /^(?:install|remove|purge|upgrade|dist-upgrade|autoremove)$/],
  ["apt-get", /^(?:install|remove|purge|upgrade|dist-upgrade|autoremove)$/],
  ["dnf", /^(?:install|remove|upgrade)$/],
  ["yum", /^(?:install|remove|upgrade)$/],
  ["port", /^(?:install|uninstall|upgrade)$/],
  ["gem", /^(?:install|uninstall|update)$/],
  ["cargo", /^(?:install|uninstall|publish)$/],
  ["pipx", /^(?:install|uninstall|upgrade|reinstall)$/],
  ["softwareupdate", /./],
  ["mas", /^(?:install|uninstall|upgrade)$/],
]);
const JS_PACKAGES = new Set(["npm", "pnpm", "yarn", "bun"]);
// Cloud and deploy CLIs: anything but reading is a change to a remote service.
const CLOUD = new Set([
  "aws",
  "gcloud",
  "az",
  "kubectl",
  "helm",
  "terraform",
  "tofu",
  "pulumi",
  "heroku",
  "fly",
  "flyctl",
  "vercel",
  "netlify",
  "doctl",
  "wrangler",
  "firebase",
  "supabase",
  "eas",
]);
const CLOUD_READS = /^(?:describe|list|get|show|status|version|help|whoami|logs?|plan|diff|validate|ls|info|--version|-v|--help|-h|config|auth)(?:-|$)/;
const DOCKER_CHANGES = /^(?:rm|rmi|kill|stop|prune|push|login|system|volume|network|swarm|compose)$/;
// Commands that write or delete the paths they are given (besides options).
const WRITERS = new Set([
  "rm",
  "rmdir",
  "unlink",
  "shred",
  "trash",
  "mv",
  "cp",
  "ln",
  "touch",
  "mkdir",
  "chmod",
  "chown",
  "chgrp",
  "tee",
  "install",
  "truncate",
  "rsync",
]);
const DELETERS = new Set(["rm", "rmdir", "unlink", "shred", "trash"]);
// Files that hold credentials, read or written.
const SECRETS = /(?:^|\/)(?:\.ssh|\.aws|\.gnupg|\.kube|\.docker\/config\.json|\.netrc|\.npmrc|\.pypirc|\.config\/gh|\.git-credentials|Keychains)(?:\/|$)/;

// The real path, through symlinks, of a file that may not exist yet: its nearest existing folder resolved, the rest
// kept. Agents name files by their real path (/private/var/… on macOS) where the Chat knows /var/….
function real(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    const parent = path.dirname(file);
    return parent === file ? file : path.join(real(parent), path.basename(file));
  }
}

// A path a command names, made absolute against the command's folder; null for an option or a word that isn't one.
function pathOf(word, cwd) {
  if (!word || word.startsWith("-") || /^[a-z][\w+.-]*:\/\//i.test(word)) return null;
  const expanded = word === "~" || word.startsWith("~/") ? path.join(os.homedir(), word.slice(1)) : word.replace(/^\$HOME(?=\/|$)/, os.homedir());
  return real(path.resolve(cwd, expanded));
}

const inside = (roots, file) =>
  roots.some((root) => {
    const relative = path.relative(root, file);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  });

// The words after the command and its prefixes (`sudo` is a risk of its own, so it isn't skipped here).
function strip(words) {
  let index = 0;
  while (index < words.length && (PREFIXES.has(base(words[index])) || /^\w+=/.test(words[index]))) index += 1;
  return words.slice(index);
}

// The redirection targets of a simple command: `> file`, `>>file`, `2> file`, `&> file`.
function redirections(words) {
  const targets = [];
  words.forEach((word, index) => {
    const match = /^(?:\d|&)?>>?(.*)$/.exec(word);
    if (!match || match[1].startsWith("&")) return;
    const target = match[1] || words[index + 1];
    if (target && target !== "/dev/null" && !target.startsWith("/dev/std")) targets.push(target);
  });
  return targets;
}

function gitRisk(args) {
  const verb = args.find((word, index) => !word.startsWith("-") && !["-C", "-c", "--git-dir", "--work-tree"].includes(args[index - 1]));
  const rest = args.slice(args.indexOf(verb) + 1);
  if (verb === "push") return "pushes to a remote";
  if (verb === "reset" && rest.includes("--hard")) return "discards uncommitted changes (git reset --hard)";
  if (verb === "clean" && rest.some((word) => /^-[a-z]*f/.test(word) || word === "--force")) return "deletes untracked files (git clean)";
  if ((verb === "checkout" || verb === "restore") && (rest.includes("--") || rest.includes(".")) && !rest.includes("--staged"))
    return "discards uncommitted changes";
  if (verb === "stash" && ["drop", "clear"].includes(rest[0])) return "deletes stashed changes";
  if (verb === "branch" && rest.some((word) => word === "-D" || word === "--delete")) return "deletes a branch";
  if (verb === "filter-branch" || verb === "filter-repo") return "rewrites the repository's history";
  if (verb === "remote" && ["add", "remove", "rm", "set-url", "rename"].includes(rest[0])) return "changes the repository's remotes";
  if (verb === "config" && rest.includes("--global")) return "changes git settings for every repository";
  return null;
}

function packageRisk(name, args) {
  const verb = args.find((word) => !word.startsWith("-"));
  if (JS_PACKAGES.has(name)) {
    if (["publish", "unpublish", "deprecate", "owner", "access", "token", "adduser", "login"].includes(verb)) return `changes the ${name} registry`;
    if (args.some((word) => word === "-g" || word === "--global") || (name === "yarn" && verb === "global")) return "installs software for the whole computer";
    return null;
  }
  if (name === "pip" || name === "pip3")
    return args.includes("install") && !process.env.VIRTUAL_ENV && args.some((word) => word === "--user" || word === "--break-system-packages")
      ? "installs Python packages for the whole computer"
      : null;
  const changes = SYSTEM_PACKAGES.get(name);
  return changes && changes.test(verb ?? "") ? "installs or removes software on this computer" : null;
}

function curlRisk(name, args) {
  if (name === "curl" && args.some((word) => /^-(?:d|F|T)$|^--(?:data|data-\w+|form|upload-file|json)(?:=|$)/.test(word))) return "sends data over the network";
  if (name === "curl" && args.some((word, index) => /^-X|^--request/.test(word) && /POST|PUT|PATCH|DELETE/i.test(word + (args[index + 1] ?? ""))))
    return "sends data over the network";
  if (name === "wget" && args.some((word) => /^--(?:post-data|post-file|method)/.test(word))) return "sends data over the network";
  return null;
}

/** Why one simple command is risky, or null. */
function simpleRisk(words, { cwd, roots }) {
  const all = strip(words);
  if (!all.length) return null;
  const name = base(all[0]);
  const args = all.slice(1);
  if (ADMIN.has(name)) return "runs as an administrator";
  if (SYSTEM.has(name)) return name === "kill" || name === "pkill" || name === "killall" ? "stops processes" : "changes this computer's settings or system";
  if (REMOTE_SHELLS.has(name)) return name === "rsync" && !args.some((word) => /^[\w.-]+@?[\w.-]*:/.test(word)) ? null : "connects to another machine";
  if (name === "git") return gitRisk(args);
  if (name === "gh") {
    // `gh api` writes are found for the whole line (babysitDenial); these are the subcommands that change GitHub.
    const [group, verb] = args.filter((word) => !word.startsWith("-"));
    const reads = /^(?:view|list|status|diff|checks|checkout|download|browse|search|watch|ls)$/;
    return group && group !== "api" && group !== "auth" && group !== "search" && verb && !reads.test(verb) ? "writes to GitHub" : null;
  }
  if (CLOUD.has(name)) {
    const verbs = args.filter((word) => !word.startsWith("-"));
    return verbs.some((word) => CLOUD_READS.test(word)) &&
      !verbs.some((word) => /^(?:apply|delete|destroy|deploy|create|update|put|remove|rm|set|scale|rollout|up|push|publish|release|submit)/.test(word))
      ? null
      : `changes a remote service (${name})`;
  }
  if (name === "docker" || name === "podman")
    return DOCKER_CHANGES.test(args.find((word) => !word.startsWith("-")) ?? "") ? "changes containers or images on this computer" : null;
  const packages = packageRisk(name, args);
  if (packages) return packages;
  const network = curlRisk(name, args);
  if (network) return network;
  if (name === "find" && args.some((word) => word === "-delete" || word === "-exec" || word === "-execdir")) {
    const start = pathOf(args.find((word) => !word.startsWith("-")) ?? ".", cwd);
    if (!inside(roots, start) && !roots.includes(start)) return "deletes or runs commands on files outside the worktree";
  }
  const secret = args.find((word) => SECRETS.test(pathOf(word, cwd) ?? ""));
  if (secret) return "touches saved credentials";
  if (WRITERS.has(name)) {
    const targets = args.map((word) => pathOf(word, cwd)).filter(Boolean);
    if (DELETERS.has(name) && targets.some((file) => roots.includes(file) || file === real(os.homedir()) || file === "/"))
      return "deletes the whole worktree or more";
    // cp and rsync only write their last path; the others write every path they name.
    const written = name === "cp" || name === "rsync" || name === "install" ? targets.slice(-1) : targets;
    if (written.some((file) => !inside(roots, file))) return DELETERS.has(name) ? "deletes files outside the worktree" : "writes outside the worktree";
  }
  const outside = redirections(all)
    .map((word) => pathOf(word, cwd))
    .find((file) => file && !inside(roots, file));
  if (outside) return "writes outside the worktree";
  return null;
}

/**
 * Why a shell command is risky in Auto mode, or null when it can run without asking. `cwd` is the folder it runs in
 * and `roots` the folders the Chat owns (its own folder, and a Link's other worktrees).
 */
function commandRisk(command, { cwd, roots = [] } = {}) {
  const text = String(command ?? "");
  const owned = [...new Set(roots.filter(Boolean).map((root) => real(path.resolve(root))))];
  if (!owned.length) return "runs outside a worktree";
  const folder = real(path.resolve(cwd ?? owned[0]));
  if (!owned.includes(folder) && !inside(owned, folder)) return "runs outside the worktree";
  if (babysitDenial(text, { level: 1, resolveThreads: false })) return "writes to GitHub";
  const commands = commandsOf(text);
  const names = commands.map((words) => base(strip(words)[0] ?? ""));
  // `curl … | sh`, `bash <(curl …)`, `sh -c "$(wget …)"`.
  if (
    names.some((name) => name === "curl" || name === "wget") &&
    names.some((name) => ["sh", "bash", "zsh", "dash", "fish", "eval", "source", "."].includes(name))
  )
    return "runs a script from the internet";
  for (const words of commands) {
    const risk = simpleRisk(words, { cwd: folder, roots: owned });
    if (risk) return risk;
  }
  return null;
}

module.exports = { commandRisk };
