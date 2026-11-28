#!/usr/bin/env node
// Starts, drives and stops a disposable Milagre desktop dev copy for verification. It never touches a Milagre,
// Electron, Vite or daemon process it did not start: every PID it stops is one it recorded in its own run state.
// Usage: node .agents/skills/verify-milagre/scripts/verify-milagre.cjs help
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn, execFileSync } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");

const repo = path.resolve(__dirname, "../../../..");
const base = path.join(fs.realpathSync(os.tmpdir()), "milagre-verify");
const runsDir = path.join(base, "runs");
const evidenceRoot = path.join(base, "evidence");
const latestFile = path.join(base, "latest");

const HELP = `verify-milagre: drive a disposable Milagre desktop dev copy over CDP.

  launch [--onboarding] [--show] [--claude-config-dir d] [--codex-home d]
                                        Start Vite + Electron + host in a scratch dir. Prints the run id.
                                        --onboarding skips seeding the Project (first-launch flow).
                                        --show puts the window on screen (default: MILAGRE_BACKGROUND=1).
                                        --claude-config-dir / --codex-home pick the provider account the
                                        copy's agents use (default: ~/.claude and ~/.codex).
  doctor                                Read-only health check of the run. Exit 1 when unfit to drive.
  eval <js>                             Evaluate an expression in the main window; prints JSON.
  wait <js> [--timeout ms]              Poll until the expression is truthy (default 20000 ms).
  click <css> | --name <label> | --text <substring> [--role r] [--nth n]
                                        Real mouse click at the element's centre (fails if covered).
                                        --name matches the exact accessible name (aria-label or text);
                                        --text matches a substring of it. With several matches, --nth picks.
  rightclick <css> | --name <label>     Context-menu click.
  hover <css> | --name <label>          Move the pointer over an element.
  type <text>                           Insert text into the focused field.
  press <key> [--meta] [--shift]        Key press: Enter, Escape, Tab, ArrowDown, Backspace, or one character.
  shot <name>                           Screenshot to the evidence dir as <name>.png.
  snapshot <name>                       Text tree of visible controls (role, name, state) to <name>.txt.
  host <method> [json-args-array] [--map 'v => ...']
                                        Call this run's own daemon (the second, read-only view of state).
                                        "$PROJECT" in the args is replaced by the run's Project path.
  phone-host [--port p]                 Start a phone bridge on this run's daemon (mobile-host --desktop-data-dir).
  metro [--port p]                      Start this checkout's Metro for the phone app (CI=1: restart after edits).
  phone-sim --udid u                    Boot (simslim only) and verify slim; stop shuts it down if this run booted it.
  phone-install --from u                Copy the Milagre dev build from simulator u, pin it to this run's Metro,
                                        install it on the phone-sim simulator.
  phone-pair                            Open the host's pairing link on the simulator (token never printed).
  phone-shot <name>                     Simulator screenshot to the evidence dir as <name>.png.
  note <text>                           Append a line to the evidence log.
  stop [--keep-scratch]                 Stop exactly this run's PIDs and its daemon; evidence stays.
  runs                                  List runs and whether their processes are alive.

  Every command takes --run <id>; without it, the last launched run is used.
  Scratch: ${runsDir}/<id>   Evidence (kept after stop): ${evidenceRoot}/<id>`;

function parse(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else positional.push(arg);
  }
  return { flags, positional };
}

function fail(message) {
  console.error(`verify-milagre: ${message}`);
  process.exit(1);
}

const alive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

function freePort(preferred) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(freePort(0)));
    server.listen(preferred, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function stateFile(id) {
  return path.join(runsDir, id, "state.json");
}

function loadState(flags) {
  const id = typeof flags.run === "string" ? flags.run : fs.existsSync(latestFile) ? fs.readFileSync(latestFile, "utf8").trim() : null;
  if (!id) fail("no run. Start one with `launch`.");
  if (!fs.existsSync(stateFile(id))) fail(`run ${id} has no state at ${stateFile(id)}.`);
  return JSON.parse(fs.readFileSync(stateFile(id), "utf8"));
}

function saveState(state) {
  fs.writeFileSync(stateFile(state.id), JSON.stringify(state, null, 2));
}

function log(state, entry) {
  fs.mkdirSync(state.evidence, { recursive: true });
  fs.appendFileSync(path.join(state.evidence, "actions.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}

// --- CDP ---------------------------------------------------------------------------------------------------------

async function pages(state) {
  const response = await fetch(`http://127.0.0.1:${state.cdpPort}/json/list`, { signal: AbortSignal.timeout(5000) });
  return response.json();
}

async function mainPage(state) {
  const list = await pages(state);
  const page = list.find((p) => p.type === "page" && p.url.startsWith(state.viteUrl) && !p.url.includes("floating-inbox="));
  if (!page) throw new Error(`no main window at ${state.viteUrl} (pages: ${list.map((p) => p.url).join(", ") || "none"})`);
  return page;
}

async function cdp(state) {
  const page = await mainPage(state);
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP socket failed")), { once: true });
  });
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const reply = JSON.parse(String(data));
    const request = pending.get(reply.id);
    if (!request) return;
    pending.delete(reply.id);
    if (reply.error) request.reject(new Error(reply.error.message));
    else request.resolve(reply.result);
  });
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`CDP timed out: ${method}`));
      }, 30000);
      pending.set(requestId, {
        resolve: (value) => (clearTimeout(timer), resolve(value)),
        reject: (error) => (clearTimeout(timer), reject(error)),
      });
      socket.send(JSON.stringify({ id: requestId, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  return { call, evaluate, close: () => socket.close() };
}

// Finds an element by CSS selector or by accessible name, scrolls it into view and returns its centre, refusing a
// point another element covers (an overlay, a closed sheet): the click must land where a user's would.
function locateScript({ selector, name, text, role, nth = 0 }) {
  return `(() => {
    const selector = ${JSON.stringify(selector ?? null)};
    const name = ${JSON.stringify(name ?? null)};
    const text = ${JSON.stringify(text ?? null)};
    const role = ${JSON.stringify(role ?? null)};
    const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
    const label = (el) => (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "").replace(/\\s+/g, " ").trim();
    const roleOf = (el) => el.getAttribute("role") || ({ BUTTON: "button", A: "link", INPUT: el.type === "checkbox" ? "checkbox" : "textbox", TEXTAREA: "textbox", SELECT: "combobox" })[el.tagName] || "";
    let found;
    if (selector) found = [...document.querySelectorAll(selector)].filter(visible);
    else if (text) found = [...document.querySelectorAll('button,a[href],[role],[data-chat-id]')].filter(visible).filter((el) => label(el).includes(text) && (!role || roleOf(el) === role));
    else {
      const all = [...document.querySelectorAll('button,a[href],[role],input,textarea,select,[contenteditable="true"],[data-chat-id]')].filter(visible);
      const exact = all.filter((el) => label(el) === name && (!role || roleOf(el) === role));
      found = exact.length ? exact : all.filter((el) => el.getAttribute("aria-label") === name && (!role || roleOf(el) === role));
    }
    const el = found[${Number(nth)}];
    if (!el) return { error: "no visible element for " + (selector || (role ? role + " " : "") + JSON.stringify(name || text)) + " (" + found.length + " matches)" };
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    if (!hit || !(el === hit || el.contains(hit) || hit.contains(el))) return { error: "element is covered at its centre by " + (hit ? hit.tagName + "." + hit.className : "nothing"), x, y };
    return { x, y, tag: el.tagName, label: label(el).slice(0, 80) };
  })()`;
}

function target(positional, flags) {
  const selector = positional[0];
  if (!selector && typeof flags.name !== "string" && typeof flags.text !== "string") fail("pass a CSS selector, --name <exact label> or --text <substring>.");
  return { selector, name: flags.name, text: flags.text, role: flags.role, nth: flags.nth ?? 0 };
}

const KEYS = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
};

// --- Host (daemon) -----------------------------------------------------------------------------------------------

async function hostCall(state, method, args = []) {
  const { connect } = require(path.join(repo, "apps/daemon/src/client.cjs"));
  const client = await connect({ dataDir: state.profile, timeoutMs: 10000, events: false });
  try {
    return await client.call(method, args);
  } finally {
    client.close();
  }
}

// --- Commands ----------------------------------------------------------------------------------------------------

function spawnLogged(command, args, { cwd, env, logFile }) {
  const out = fs.openSync(logFile, "a");
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", out, out] });
  child.unref();
  fs.closeSync(out);
  return child.pid;
}

// The agent's own shell carries variables (ELECTRON_RUN_AS_NODE, CLAUDE_CODE_* messaging sockets, CLAUDECODE) that
// would turn Electron into Node or tie the copy's agents to the calling session. Start from a clean environment.
function cleanEnv(extra) {
  const keep = ["HOME", "USER", "LOGNAME", "SHELL", "PATH", "LANG", "LC_ALL", "TMPDIR", "TERM", "DEVELOPER_DIR", "T3CODE_HOME", "PASEO_HOME"];
  const env = {};
  for (const key of keep) if (process.env[key] !== undefined) env[key] = process.env[key];
  return { ...env, DO_NOT_TRACK: "1", ...extra };
}

async function waitFor(read, description, timeout = 60000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    try {
      last = await read();
      if (last) return last;
    } catch (error) {
      last = error.message;
    }
    await delay(250);
  }
  throw new Error(`timed out waiting for ${description}${last ? ` (last: ${String(last).slice(0, 300)})` : ""}`);
}

const STALE_RUN_MS = 4 * 60 * 60 * 1000;

function ownedPid(state, pid) {
  if (!alive(pid)) return false;
  try {
    const command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
    return command.includes(state.repo) || command.includes(state.scratch);
  } catch {
    return false;
  }
}

async function reapStaleRuns() {
  if (!fs.existsSync(runsDir)) return;
  for (const id of fs.readdirSync(runsDir)) {
    if (!fs.existsSync(stateFile(id))) continue;
    try {
      const state = JSON.parse(fs.readFileSync(stateFile(id), "utf8"));
      const started = Date.parse(state.startedAt) || fs.statSync(stateFile(id)).mtimeMs;
      if (Date.now() - started < STALE_RUN_MS && fs.existsSync(state.repo)) continue;
      state.pids = Object.fromEntries(Object.entries(state.pids).filter(([, pid]) => ownedPid(state, pid)));
      console.log(`Stopping run ${id} (started ${state.startedAt}): runs older than 4 h or whose checkout is gone are left over.`);
      await stop(state, { reaping: true });
    } catch (error) {
      console.log(`Could not stop run ${id}: ${error.message.split("\n")[0]}`);
    }
  }
}

async function launch(flags) {
  await reapStaleRuns();
  if (!fs.existsSync(path.join(repo, "node_modules/electron"))) fail("node_modules is missing: run `bun install --frozen-lockfile` (or `npm ci`) first.");
  const id = typeof flags["run-id"] === "string" ? flags["run-id"] : `${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}-${process.pid}`;
  const scratch = path.join(runsDir, id);
  const evidence = path.join(evidenceRoot, id);
  fs.mkdirSync(scratch, { recursive: true });
  fs.mkdirSync(evidence, { recursive: true });
  const project = path.join(scratch, "verify-project");
  const profile = path.join(scratch, "profile");
  for (const dir of [project, profile, path.join(scratch, "chats-home"), path.join(scratch, "worktrees")]) fs.mkdirSync(dir, { recursive: true });

  // A throwaway Git repository as the Project: never the development checkout, whose ownership lock the user's app holds.
  fs.writeFileSync(path.join(project, "README.md"), "# Verify project\n\nA disposable Project for Milagre verification runs.\n");
  fs.writeFileSync(path.join(project, "notes.txt"), "alpha\nbeta\n");
  const git = (...args) =>
    execFileSync("git", ["-c", "user.name=Milagre Verify", "-c", "user.email=verify@example.invalid", ...args], { cwd: project, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-q", "-m", "Initial commit");
  // A fresh profile would scan the user's real folders (~/Developer, ~/.milagre/worktrees) for Projects; mark it scanned.
  fs.writeFileSync(path.join(profile, "project-registry.json"), JSON.stringify({ scanned: true, projects: [] }));
  // The host opens the Git repository it starts in, so first launch (onboarding) starts in an empty plain folder, with
  // empty agent homes: onboarding suggests folders from Claude Code and Codex history, which must not be the user's.
  const onboardingFolder = path.join(scratch, "empty-folder");
  if (flags.onboarding)
    for (const dir of [onboardingFolder, path.join(scratch, "claude-home"), path.join(scratch, "codex-home")]) fs.mkdirSync(dir, { recursive: true });
  else
    fs.writeFileSync(
      path.join(profile, "recent-projects.json"),
      JSON.stringify([{ path: project, name: "verify-project", openedAt: new Date().toISOString() }]),
    );

  const vitePort = await freePort(Number(flags["vite-port"]) || 5290);
  const cdpPort = await freePort(Number(flags["cdp-port"]) || 9390);
  if (vitePort === 5180) fail("refusing port 5180: the user's own dev session lives there.");
  const viteUrl = `http://127.0.0.1:${vitePort}`;
  const state = { id, repo, scratch, evidence, project, profile, vitePort, viteUrl, cdpPort, pids: {}, startedAt: new Date().toISOString() };
  state.head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  fs.mkdirSync(base, { recursive: true });
  saveState(state);
  fs.writeFileSync(latestFile, id);

  state.pids.vite = spawnLogged(
    process.execPath,
    [path.join(repo, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"],
    {
      cwd: path.join(repo, "apps/desktop"),
      env: cleanEnv({}),
      logFile: path.join(scratch, "vite.log"),
    },
  );
  saveState(state);
  await waitFor(async () => (await fetch(viteUrl, { signal: AbortSignal.timeout(2000) })).ok, `Vite on ${viteUrl}`);

  const electron = require(path.join(repo, "node_modules/electron"));
  const args = [
    path.join(repo, "apps/desktop"),
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${cdpPort}`,
    "--use-mock-keychain",
    // An occluded or hidden window throttles rAF and timers, so animations never finish and DOM probes lie.
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
  ];
  state.pids.electron = spawnLogged(electron, args, {
    cwd: flags.onboarding ? onboardingFolder : project,
    env: cleanEnv({
      ...(flags.onboarding
        ? { CLAUDE_CONFIG_DIR: path.join(scratch, "claude-home"), CODEX_HOME: path.join(scratch, "codex-home"), MILAGRE_ONBOARDING_TEMP_FOLDERS: "1" }
        : {}),
      // Opt-in: run the copy's agents on a provider account of the caller's choosing (the default ~/.claude or
      // ~/.codex account may be at its usage limit). Only the folder path is passed; credentials stay where they are.
      ...(typeof flags["claude-config-dir"] === "string" ? { CLAUDE_CONFIG_DIR: path.resolve(flags["claude-config-dir"]) } : {}),
      ...(typeof flags["codex-home"] === "string" ? { CODEX_HOME: path.resolve(flags["codex-home"]) } : {}),
      MILAGRE_DEV_SERVER_URL: viteUrl,
      MILAGRE_BACKGROUND: flags.show ? "0" : "1",
      MILAGRE_CHATS_HOME: path.join(scratch, "chats-home"),
      MILAGRE_WORKTREE_ROOT: path.join(scratch, "worktrees"),
    }),
    logFile: path.join(scratch, "electron.log"),
  });
  saveState(state);
  await waitFor(async () => {
    if (!alive(state.pids.electron)) throw new Error(`Electron exited; see ${path.join(scratch, "electron.log")}`);
    return mainPage(state);
  }, "the main window over CDP");
  const session = await cdp(state);
  try {
    const ready = flags.onboarding
      ? '!!document.querySelector("[data-onboarding]") && !document.querySelector(".startup-splash-screen")'
      : '!!window.milagre && !document.querySelector(".startup-splash-screen") && !!document.querySelector("[data-prompt-editor]")';
    await waitFor(() => session.evaluate(ready), flags.onboarding ? "onboarding" : "the Project's composer", 90000);
  } finally {
    session.close();
  }
  const status = await waitFor(() => hostCall(state, "daemon:status"), "this run's daemon");
  state.pids.daemon = status.pid;
  saveState(state);
  log(state, { command: "launch", vitePort, cdpPort, project, head: state.head, daemonPid: status.pid });
  console.log(JSON.stringify({ run: id, viteUrl, cdpPort, project, profile, evidence, pids: state.pids, head: state.head }, null, 2));
}

async function doctor(state) {
  const checks = [];
  const check = (name, ok, detail = "") => checks.push({ name, ok: !!ok, detail });
  for (const [name, pid] of Object.entries(state.pids)) if (name !== "phoneHost" || pid) check(`${name} pid ${pid} alive`, alive(pid));
  const owner = (port) => {
    try {
      return Number(
        execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
          .trim()
          .split("\n")[0],
      );
    } catch {
      return null;
    }
  };
  check(`port ${state.vitePort} owned by our Vite`, owner(state.vitePort) === state.pids.vite, `owner ${owner(state.vitePort)}`);
  try {
    const session = await cdp(state);
    try {
      const info = await session.evaluate(`(async () => ({
        url: location.href,
        bridge: !!window.milagre,
        splash: !!document.querySelector(".startup-splash-screen"),
        startupError: document.querySelector("[data-startup-error]")?.textContent?.slice(0, 200) || null,
        project: window.milagre ? (await window.milagre.getCurrentProject())?.path ?? null : null,
        version: window.milagre ? await window.milagre.getAppVersion() : null,
        visibility: document.visibilityState,
      }))()`);
      check("main window on our Vite URL", info.url.startsWith(state.viteUrl), info.url);
      check("preload bridge present", info.bridge);
      check("no startup error", !info.startupError, info.startupError || "");
      check("splash gone", !info.splash);
      check("current Project is the scratch repo (or none during onboarding)", info.project === null || info.project === state.project, String(info.project));
      check("document visible to rAF", info.visibility === "visible", info.visibility);
      check("app version", !!info.version, info.version);
    } finally {
      session.close();
    }
  } catch (error) {
    check("CDP reachable", false, error.message);
  }
  try {
    const status = await hostCall(state, "daemon:status");
    check("daemon answers on this run's profile", status.pid === state.pids.daemon, `pid ${status.pid}`);
  } catch (error) {
    check("daemon answers on this run's profile", false, error.message);
  }
  const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  check("checkout HEAD unchanged since launch", head === state.head, `${state.head} -> ${head}`);
  for (const c of checks) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name}${c.detail ? `  (${c.detail})` : ""}`);
  log(state, { command: "doctor", ok: checks.every((c) => c.ok), failed: checks.filter((c) => !c.ok).map((c) => c.name) });
  if (!checks.every((c) => c.ok)) process.exit(1);
}

async function withPage(state, fn) {
  const session = await cdp(state);
  try {
    return await fn(session);
  } finally {
    session.close();
  }
}

async function mouse(session, point, kind) {
  await session.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  if (kind === "hover") return;
  const button = kind === "right" ? "right" : "left";
  await session.call("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button, clickCount: 1 });
  await session.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button, clickCount: 1 });
}

async function pointer(state, positional, flags, kind) {
  const where = target(positional, flags);
  const result = await withPage(state, async (session) => {
    const point = await session.evaluate(locateScript(where));
    if (point.error) throw new Error(point.error);
    await mouse(session, point, kind);
    return point;
  });
  log(state, { command: kind, target: where, landed: result });
  console.log(JSON.stringify(result));
}

// --- Phone --------------------------------------------------------------------------------------------------------

const BUNDLE_ID = "com.victorlucas.milagre";
const xcrunEnv = () => ({ ...process.env, DEVELOPER_DIR: process.env.DEVELOPER_DIR || "/Applications/Xcode.app/Contents/Developer" });
const xcrun = (...args) => execFileSync("xcrun", args, { encoding: "utf8", env: xcrunEnv() }).trim();
// Milagre keeps these simslim categories on; the rest is off (~/.claude/rules/simulators.md).
const SLIM_KEEP = "widgets,icloud,web";

function simulatorState(udid) {
  const line = execFileSync("simslim", ["list"], { encoding: "utf8" })
    .split("\n")
    .find((row) => row.startsWith(udid));
  if (!line) fail(`simslim does not list ${udid}.`);
  return /\bbooted\b/.test(line) ? "booted" : "shutdown";
}

function simslimVerify(udid) {
  try {
    execFileSync("simslim", ["verify", udid, "--except", SLIM_KEEP], { stdio: "inherit" });
    return true;
  } catch {
    return false;
  }
}

// Boots (only through simslim) and verifies slim. A simulator this run boots is shut down again by `stop`.
async function phoneSim(state, flags) {
  const udid = typeof flags.udid === "string" ? flags.udid : fail("pass --udid <simulator udid> (see `simslim list`).");
  let bootedByRun = false;
  if (simulatorState(udid) !== "booted") {
    execFileSync("simslim", ["boot", udid], { stdio: "inherit" });
    bootedByRun = true;
  }
  if (!simslimVerify(udid)) {
    if (!bootedByRun) fail(`${udid} is booted but not slim, and this run did not boot it: pick another simulator rather than rebooting someone else's.`);
    execFileSync("simslim", ["on", udid, "--except", SLIM_KEEP], { stdio: "inherit" });
    if (!simslimVerify(udid)) fail(`${udid} still fails simslim verify after simslim on.`);
  }
  state.phoneSim = { udid, bootedByRun };
  saveState(state);
  log(state, { command: "phone-sim", udid, bootedByRun });
  console.log(JSON.stringify(state.phoneSim));
}

// Installs a copy of an existing Milagre development build whose bundle URL points at this run's Metro. The source
// simulator is only read from; its own app and pinned Metro port stay as they are.
async function phoneInstall(state, flags) {
  const udid = state.phoneSim?.udid || fail("run `phone-sim --udid <udid>` first.");
  if (!state.metroPort) fail("run `metro` first: the copy is pinned to its port.");
  const from = typeof flags.from === "string" ? flags.from : fail("pass --from <udid of a simulator that has a Milagre development build>.");
  if (!state.phoneSim.bootedByRun) {
    let existing = null;
    try {
      existing = xcrun("simctl", "get_app_container", udid, BUNDLE_ID);
    } catch {
      /* not installed */
    }
    if (existing)
      fail(`${udid} already has Milagre and this run did not boot it; installing would replace someone else's build. Use a simulator this run boots.`);
  }
  const source = xcrun("simctl", "get_app_container", from, BUNDLE_ID);
  const app = path.join(state.scratch, "Milagre.app");
  fs.rmSync(app, { recursive: true, force: true });
  execFileSync("cp", ["-R", source, app]);
  const plist = path.join(app, "Info.plist");
  if (fs.existsSync(path.join(app, "main.jsbundle")))
    fail(`${source} is a release build (it embeds main.jsbundle); it cannot load this checkout's JavaScript.`);
  execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :RCTMetroPort ${state.metroPort}`, plist]);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "ignore" });
  xcrun("simctl", "install", udid, app);
  state.phoneSim.installed = true;
  saveState(state);
  log(state, { command: "phone-install", udid, from, metroPort: state.metroPort });
  console.log(`installed ${BUNDLE_ID} on ${udid}, pinned to Metro ${state.metroPort}`);
}

async function metro(state, flags) {
  if (alive(state.pids.metro)) fail(`Metro already running (pid ${state.pids.metro}).`);
  const port = await freePort(Number(flags.port) || 8960);
  const cwd = path.join(repo, "apps/mobile");
  const expo = path.dirname(require.resolve("expo/package.json", { paths: [cwd] }));
  // CI=1: no prompts and no file watching, so restart Metro after an edit. The worktree's own Expo CLI, never the
  // main checkout's (a different Metro fails with vlqMapFromBabelDecodedMap).
  state.pids.metro = spawnLogged(
    process.execPath,
    ["--dns-result-order=ipv4first", path.join(expo, "bin/cli"), "start", "--localhost", "--port", String(port), "--dev-client"],
    {
      cwd,
      env: cleanEnv({ CI: "1" }),
      logFile: path.join(state.scratch, "metro.log"),
    },
  );
  state.metroPort = port;
  saveState(state);
  await waitFor(
    async () => (await (await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(2000) })).text()).includes("running"),
    `Metro on ${port}`,
    120000,
  );
  log(state, { command: "metro", port });
  console.log(JSON.stringify({ metro: `http://127.0.0.1:${port}`, log: path.join(state.scratch, "metro.log") }));
}

// Opens the host's pairing link on the simulator, as scanning its QR code does. The link carries the token, so it is
// built here from the private connection file and never printed. iOS then asks "Open in Milagre?": tap Open.
async function phonePair(state) {
  const udid = state.phoneSim?.udid || fail("run `phone-sim` first.");
  const file = path.join(state.scratch, "phone-host", "mobile-connection.json");
  if (!fs.existsSync(file)) fail("run `phone-host` first.");
  const { url, token } = JSON.parse(fs.readFileSync(file, "utf8"));
  const { pairingLink } = require(path.join(repo, "apps/daemon/src/mobile-pairing.cjs"));
  xcrun("simctl", "openurl", udid, pairingLink({ address: url, token, name: "Verify host" }));
  log(state, { command: "phone-pair", udid, address: url });
  console.log(`opened the pairing link on ${udid}; confirm iOS's "Open in Milagre?" prompt`);
}

// Every process below the ones this run started (renderers, the host, its agents and their tools), read before
// anything is stopped: once a parent exits its children are re-parented and can no longer be told apart.
function descendants(roots) {
  const children = new Map();
  for (const line of execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" }).trim().split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const found = new Set();
  const queue = roots.filter(Boolean);
  while (queue.length) {
    for (const child of children.get(queue.shift()) ?? []) {
      if (found.has(child)) continue;
      found.add(child);
      queue.push(child);
    }
  }
  return [...found];
}

async function stop(state, flags) {
  const report = [];
  const tree = descendants(Object.values(state.pids));
  // 1. The window first, so the app saves and its agents wind down.
  if (alive(state.pids.phoneHost)) {
    process.kill(state.pids.phoneHost, "SIGTERM");
    report.push(`phone host ${state.pids.phoneHost} SIGTERM`);
  }
  if (alive(state.pids.electron)) {
    process.kill(state.pids.electron, "SIGTERM");
    report.push(`electron ${state.pids.electron} SIGTERM`);
  }
  // 2. The host outlives the app by design; stop it through its own socket so it suspends turns and releases its locks.
  try {
    await hostCall(state, "daemon:stop");
    report.push(`daemon ${state.pids.daemon} daemon:stop`);
  } catch (error) {
    report.push(`daemon:stop: ${error.message}`);
  }
  for (const name of ["metro", "vite"]) {
    if (!alive(state.pids[name])) continue;
    process.kill(state.pids[name], "SIGTERM");
    report.push(`${name} ${state.pids[name]} SIGTERM`);
  }
  // 3. A simulator this run booted goes back to shutdown, through simslim; one it found booted is left as it was.
  if (state.phoneSim?.bootedByRun) {
    try {
      execFileSync("simslim", ["shutdown", state.phoneSim.udid], { stdio: "ignore" });
      report.push(`simulator ${state.phoneSim.udid} simslim shutdown`);
    } catch (error) {
      report.push(`simslim shutdown ${state.phoneSim.udid}: ${error.message}`);
    }
  }
  for (const [name, pid] of Object.entries(state.pids)) {
    if (!pid) continue;
    const started = Date.now();
    while (alive(pid) && Date.now() - started < 15000) await delay(200);
    if (alive(pid)) {
      process.kill(pid, "SIGKILL");
      report.push(`${name} ${pid} SIGKILL after 15 s`);
    }
  }
  for (const pid of tree) {
    const started = Date.now();
    while (alive(pid) && Date.now() - started < 5000) await delay(100);
    if (alive(pid)) {
      process.kill(pid, "SIGKILL");
      report.push(`child ${pid} SIGKILL (outlived its run)`);
    }
  }
  report.push(`${tree.length} child processes of this run checked`);
  const left = [...Object.entries(state.pids), ...tree.map((pid) => ["child", pid])].filter(([, pid]) => alive(pid));
  const ports = [state.vitePort, state.cdpPort, state.phonePort, state.metroPort].filter(Boolean).filter((port) => {
    try {
      execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
      return true;
    } catch {
      return false;
    }
  });
  log(state, { command: "stop", report, left, portsStillListening: ports });
  // Logs are evidence too: copy them out before the scratch dir goes.
  for (const file of ["vite.log", "electron.log", "phone-host.log", "metro.log"]) {
    const from = path.join(state.scratch, file);
    // The phone host prints its pairing link, which carries the token.
    if (fs.existsSync(from))
      fs.writeFileSync(path.join(state.evidence, file), fs.readFileSync(from, "utf8").replace(/token=[a-f0-9]{64}/gi, "token=<redacted>"));
  }
  if (!flags["keep-scratch"] && !left.length) fs.rmSync(state.scratch, { recursive: true, force: true });
  console.log(report.join("\n"));
  console.log(left.length ? `STILL ALIVE: ${JSON.stringify(left)}` : "all run processes stopped");
  if (ports.length) console.log(`ports still listening: ${ports.join(", ")}`);
  console.log(`evidence kept at ${state.evidence}`);
  if (left.length && !flags.reaping) process.exitCode = 1;
}

async function snapshot(state, name) {
  const text = await withPage(state, (session) =>
    session.evaluate(`(() => {
      const lines = [];
      const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; };
      const name = (el) => (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || el.value || "").replace(/\\s+/g, " ").trim().slice(0, 100);
      for (const el of document.querySelectorAll('h1,h2,h3,button,a[href],[role],input,textarea,select,[contenteditable="true"],[data-chat-id]')) {
        if (!visible(el)) continue;
        const role = el.getAttribute("role") || el.tagName.toLowerCase();
        const flags = ["aria-pressed","aria-checked","aria-selected","aria-expanded","aria-current","disabled"].filter((a) => el.hasAttribute(a) && el.getAttribute(a) !== "false").map((a) => a.replace("aria-", "") + (el.getAttribute(a) && el.getAttribute(a) !== "true" ? "=" + el.getAttribute(a) : ""));
        const data = [...el.attributes].filter((a) => a.name.startsWith("data-") && a.name !== "data-state").slice(0, 3).map((a) => a.name + (a.value ? "=" + a.value.slice(0, 40) : ""));
        lines.push(role + ' "' + name(el) + '"' + (flags.length ? " [" + flags.join(" ") + "]" : "") + (data.length ? " {" + data.join(" ") + "}" : ""));
      }
      return "url: " + location.href + "\\ntitle: " + document.title + "\\n" + lines.join("\\n");
    })()`),
  );
  const file = path.join(state.evidence, `${name}.txt`);
  fs.writeFileSync(file, text);
  log(state, { command: "snapshot", file });
  console.log(file);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { flags, positional } = parse(rest);
  if (!command || command === "help" || flags.help) return console.log(HELP);
  if (command === "launch") return launch(flags);
  if (command === "runs") {
    if (!fs.existsSync(runsDir)) return console.log("no runs");
    for (const id of fs.readdirSync(runsDir)) {
      if (!fs.existsSync(stateFile(id))) continue;
      const state = JSON.parse(fs.readFileSync(stateFile(id), "utf8"));
      console.log(
        `${id}  ${Object.entries(state.pids)
          .map(([n, p]) => `${n}:${p}${alive(p) ? "" : "(dead)"}`)
          .join(" ")}  ${state.viteUrl}`,
      );
    }
    return;
  }
  const state = loadState(flags);
  switch (command) {
    case "doctor":
      return doctor(state);
    case "eval": {
      const value = await withPage(state, (session) => session.evaluate(positional.join(" ")));
      log(state, { command: "eval", expression: positional.join(" ").slice(0, 500), value: JSON.stringify(value)?.slice(0, 500) });
      return console.log(JSON.stringify(value, null, 2));
    }
    case "wait": {
      const expression = positional.join(" ");
      const value = await withPage(state, (session) => waitFor(() => session.evaluate(expression), expression.slice(0, 120), Number(flags.timeout) || 20000));
      log(state, { command: "wait", expression: expression.slice(0, 500), value: JSON.stringify(value)?.slice(0, 200) });
      return console.log(JSON.stringify(value));
    }
    case "click":
      return pointer(state, positional, flags, "left");
    case "rightclick":
      return pointer(state, positional, flags, "right");
    case "hover":
      return pointer(state, positional, flags, "hover");
    case "type": {
      const text = positional.join(" ");
      await withPage(state, (session) => session.call("Input.insertText", { text }));
      log(state, { command: "type", text });
      return console.log(`typed ${text.length} characters`);
    }
    case "press": {
      const name = positional[0];
      const key = KEYS[name] ?? { key: name, code: `Key${name.toUpperCase()}`, text: name, windowsVirtualKeyCode: name.toUpperCase().charCodeAt(0) };
      const modifiers = (flags.alt ? 1 : 0) | (flags.ctrl ? 2 : 0) | (flags.meta ? 4 : 0) | (flags.shift ? 8 : 0);
      await withPage(state, async (session) => {
        await session.call("Input.dispatchKeyEvent", { type: "keyDown", modifiers, ...key, text: modifiers & 6 ? undefined : key.text });
        await session.call("Input.dispatchKeyEvent", { type: "keyUp", modifiers, ...key, text: undefined });
      });
      log(state, { command: "press", key: name, modifiers });
      return console.log(`pressed ${name}`);
    }
    case "shot": {
      const name = positional[0] || `shot-${Date.now()}`;
      const file = path.join(state.evidence, `${name}.png`);
      const image = await withPage(state, (session) => session.call("Page.captureScreenshot", { format: "png" }));
      fs.writeFileSync(file, Buffer.from(image.data, "base64"));
      log(state, { command: "shot", file });
      return console.log(file);
    }
    case "snapshot":
      return snapshot(state, positional[0] || `snapshot-${Date.now()}`);
    case "host": {
      const [method, json] = positional;
      const args = json ? JSON.parse(json.replaceAll("$PROJECT", state.project)) : [];
      const raw = await hostCall(state, method, args);
      // --map 'v => …' trims a large answer (a whole Project state) to the part the proof needs.
      const value = typeof flags.map === "string" ? new Function(`return (${flags.map})`)()(raw) : raw;
      log(state, { command: "host", method, args: json, map: flags.map, value: JSON.stringify(value)?.slice(0, 500) });
      return console.log(JSON.stringify(value, null, 2));
    }
    case "phone-host": {
      if (alive(state.pids.phoneHost)) fail(`phone host already running (pid ${state.pids.phoneHost}).`);
      const port = await freePort(Number(flags.port) || 8940);
      const hostDir = path.join(state.scratch, "phone-host");
      const logFile = path.join(state.scratch, "phone-host.log");
      state.pids.phoneHost = spawnLogged(
        process.execPath,
        [path.join(repo, "scripts/mobile-host.cjs"), "--data-dir", hostDir, "--desktop-data-dir", state.profile, "--port", String(port), "--no-qr"],
        { cwd: state.scratch, env: cleanEnv({ MILAGRE_DEV_PLAIN_SECRETS: "1" }), logFile },
      );
      state.phonePort = port;
      saveState(state);
      const connection = path.join(hostDir, "mobile-connection.json");
      await waitFor(() => fs.existsSync(connection), "the phone host's connection file");
      log(state, { command: "phone-host", port, connectionFile: connection });
      // The connection file holds the pairing token: hand over its path, never its contents.
      return console.log(JSON.stringify({ bridge: `http://127.0.0.1:${port}`, connectionFile: connection, log: logFile }, null, 2));
    }
    case "metro":
      return metro(state, flags);
    case "phone-sim":
      return phoneSim(state, flags);
    case "phone-install":
      return phoneInstall(state, flags);
    case "phone-pair":
      return phonePair(state);
    case "phone-shot": {
      const udid = state.phoneSim?.udid || fail("run `phone-sim` first.");
      const file = path.join(state.evidence, `${positional[0] || `phone-${Date.now()}`}.png`);
      xcrun("simctl", "io", udid, "screenshot", file);
      log(state, { command: "phone-shot", udid, file });
      return console.log(file);
    }
    case "note":
      log(state, { command: "note", text: positional.join(" ") });
      return console.log("noted");
    case "stop":
      return stop(state, flags);
    default:
      fail(`unknown command ${command}. Run with help.`);
  }
}

main().catch((error) => fail(error.message));
