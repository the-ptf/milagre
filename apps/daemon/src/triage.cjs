// `milagre triage`: start the user's own coding agent in this terminal on a triage session (packages/core/src/triage.cjs)
// covering every Milagre profile on this computer. For when the app won't start or its own entry doesn't work.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { AGENTS, findAgents, writeTriageSession } = require("@milagre/core/triage");

// Electron's userData for the packaged app, then the headless default. An explicit --data-dir replaces both.
function profileCandidates({ dataDir, env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (dataDir) return [{ label: "Selected profile", dir: dataDir }];
  const appData =
    platform === "darwin"
      ? path.join(home, "Library", "Application Support")
      : platform === "win32"
        ? env.APPDATA || path.join(home, "AppData", "Roaming")
        : env.XDG_CONFIG_HOME || path.join(home, ".config");
  return [
    { label: "Desktop app", dir: path.join(appData, "Milagre") },
    { label: "Headless (milagre serve)", dir: env.MILAGRE_DATA_DIR || path.join(home, ".milagre", "server") },
  ];
}

function readOwner(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "runtime.lock", "owner.json"), "utf8"));
  } catch {
    return null;
  }
}

async function describeHost(dir) {
  const owner = readOwner(dir);
  try {
    const client = await require("./client.cjs").connect({ dataDir: dir, timeoutMs: 3000, events: false });
    try {
      const status = await client.call("daemon:status");
      return `running (pid ${status.pid}, version ${status.version})`;
    } finally {
      client.close();
    }
  } catch (error) {
    if (!owner) return `not running (${error.code ?? error.message})`;
    let alive = false;
    try {
      process.kill(owner.pid, 0);
      alive = true;
    } catch (killError) {
      alive = killError.code === "EPERM";
    }
    return alive
      ? `not answering on its socket, but lock owner pid ${owner.pid} (started ${owner.startedAt}) is alive`
      : `not running; stale lock from pid ${owner.pid} (started ${owner.startedAt}), likely a crash`;
  }
}

const launchPrompt = (playbookPath, contextPath) =>
  `Read the files '${playbookPath}' and '${contextPath}' and follow the playbook exactly: it is your Milagre triage playbook, and it starts with asking the user what went wrong.`;

function parseTriageFlags(flags) {
  let agent;
  for (const [name, value] of flags) {
    if (name !== "agent" || !AGENTS.some((entry) => entry.id === value))
      throw new Error(`Unknown or missing triage option: --${name}. Use --agent claude or --agent codex.`);
    agent = value;
  }
  return { agent };
}

async function pickAgent(installed) {
  const readline = require("node:readline/promises").createInterface({ input: process.stdin, output: process.stdout });
  try {
    const menu = installed.map((agent, index) => `  [${index + 1}] ${agent.label}`).join("\n");
    for (;;) {
      const answer = (await readline.question(`Run triage with:\n${menu}\n> `)).trim().toLowerCase();
      const picked = installed[Number.parseInt(answer, 10) - 1] ?? installed.find((agent) => agent.id === answer);
      if (picked) return picked;
    }
  } finally {
    readline.close();
  }
}

async function triage({ dataDir, flags = [], version, output = process.stdout } = {}) {
  const { agent: requested } = parseTriageFlags(flags);
  const profiles = [];
  for (const candidate of profileCandidates({ dataDir })) {
    const exists = fs.existsSync(candidate.dir);
    profiles.push({ ...candidate, exists, host: exists ? await describeHost(candidate.dir) : undefined });
  }
  const agents = await findAgents();
  // Beside the first profile that exists, as T3 does; a computer with no profile at all still gets a session.
  const { sessionDir, playbookPath, contextPath } = await writeTriageSession({
    root: path.join(profiles.find((profile) => profile.exists)?.dir ?? os.tmpdir(), "triage"),
    entry: { kind: "cli", cliVersion: version, launchedAs: process.env.npm_command === "exec" ? "npx milagre triage" : "milagre triage" },
    profiles,
    agents,
  });

  const installed = agents.filter((agent) => agent.path);
  let selected;
  if (requested) {
    selected = installed.find((agent) => agent.id === requested);
    if (!selected) throw new Error(`\`${requested}\` is not installed or was not found on PATH.`);
  } else if (installed.length === 1) selected = installed[0];
  else if (installed.length > 1) {
    if (!process.stdin.isTTY || !process.stdout.isTTY)
      throw new Error("Both claude and codex are installed and there is no terminal to ask which to use. Re-run with --agent claude or --agent codex.");
    selected = await pickAgent(installed);
  }
  if (!selected) {
    output.write(
      `No supported agent CLI (claude, codex) was found on this computer.\n\nThe triage playbook and machine context were written to:\n  ${playbookPath}\n  ${contextPath}\n\nPaste both into any coding agent to run triage by hand.\n`,
    );
    return { sessionDir };
  }
  output.write(`Starting ${selected.label}. It will ask what went wrong.\n\n`);
  // ponytail: Windows npm shims are .cmd files, which only run through a shell; the prompt has no double quotes.
  const shell = process.platform === "win32" && /\.(cmd|bat)$/i.test(selected.path);
  const prompt = launchPrompt(playbookPath, contextPath);
  const child = shell
    ? spawn(`"${selected.path}"`, [`"${prompt}"`], { cwd: sessionDir, stdio: "inherit", shell })
    : spawn(selected.path, [prompt], { cwd: sessionDir, stdio: "inherit" });
  const code = await new Promise((resolve, reject) => {
    child.once("error", (error) => reject(new Error(`Could not start ${selected.id}: ${error.message}`)));
    child.once("exit", (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)));
  });
  if (code) process.exitCode = code;
  return { sessionDir };
}

module.exports = { triage, profileCandidates, parseTriageFlags };
