const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { z } = require("zod");
const { BUNDLED_SKILLS_DIRECTORY } = require("./bundled-skills.cjs");

// Experimental: agents see and operate desktop apps through agent-desktop (vercel-labs/agent-desktop), pinned in this
// package. Milagre runs its native CLI itself, always headless (accessibility calls, no pointer, no focus), and asks the
// user once per app per Chat before an agent touches it. macOS grants Accessibility and Screen Recording to the app that
// launches it: Milagre.app, or the daemon's launcher on a computer without the desktop app.

const COMMAND_TIMEOUT_MS = 60_000;
const OUTPUT_LIMIT = 4 * 1024 * 1024;
// Apps an agent never drives: Milagre itself, shells that run anything, the OS's own settings and password stores.
const BLOCKED_APPS = ["Milagre", "Terminal", "iTerm2", "Ghostty", "Warp", "System Settings", "System Preferences", "Passwords", "Keychain Access", "1Password"];
const REF = /^@(s[a-z0-9]+):e\d+$/i;
// Milagre's agent cursor (design cu-cursor, option A): blue arrow, white rim, blue glow; the click point is its tip.
const CURSOR_IMAGE = path.join(__dirname, "assets", "agent-cursor.png").replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2");
const CURSOR_STYLE = ["--image", CURSOR_IMAGE, "--hotspot", "10,6", "--size", "0.5", "--accent", "#2F6BFF"];
const ACTIONS = ["click", "type", "set-value", "clear", "select", "toggle", "check", "uncheck", "expand", "collapse", "focus", "scroll", "scroll-to"];

const normalizeName = (name) =>
  String(name ?? "")
    .trim()
    .toLowerCase();
const blocked = (app) => BLOCKED_APPS.some((name) => normalizeName(name) === normalizeName(app));

/** The pinned CLI and its macOS helper for this platform, inside node_modules (unpacked from the asar when packaged). */
function agentDesktopBinary({ platform = process.platform, arch = process.arch } = {}) {
  const root = path.dirname(require.resolve("agent-desktop/package.json")).replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2");
  const suffix = `${platform}-${arch}`;
  const binary = path.join(root, "bin", platform === "win32" ? `agent-desktop-${suffix}.exe` : `agent-desktop-${suffix}`);
  const helper = platform === "darwin" ? path.join(root, "bin", `agent-desktop-macos-helper-${suffix}`) : null;
  return { binary, helper, version: JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version };
}

/** The switch in Settings › Experimental, kept by the host. */
function createComputerUseSettings({ file, emit = () => {} }) {
  // `cursor`: draw Milagre's agent cursor and the step beside it on the screen while an agent acts (on by default).
  function read() {
    try {
      const stored = JSON.parse(fs.readFileSync(file, "utf8"));
      return { enabled: stored?.enabled === true, cursor: stored?.cursor !== false };
    } catch {
      return { enabled: false, cursor: true };
    }
  }
  function save(patch) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Computer use settings must be an object.");
    for (const key of ["enabled", "cursor"])
      if (patch[key] !== undefined && typeof patch[key] !== "boolean") throw new Error(`Computer use ${key} is on or off.`);
    const next = { ...read() };
    for (const key of ["enabled", "cursor"]) if (patch[key] !== undefined) next[key] = patch[key];
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    emit("computer-use:settings", next);
    return next;
  }
  return { read, save };
}

/** Runs the CLI once and parses its single JSON envelope; a crash or garbled output answers as an INTERNAL error. */
function runCli({ binary, helper, home }, args, { timeoutMs = COMMAND_TIMEOUT_MS, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, AGENT_DESKTOP_HOME: home };
    if (helper) env.AGENT_DESKTOP_MACOS_HELPER_PATH = helper;
    let child;
    try {
      child = spawnImpl(binary, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ ok: false, error: { code: "INTERNAL", message: `agent-desktop could not start: ${error.message}` } });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (envelope) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(envelope);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        ok: false,
        error: {
          code: "TIMEOUT",
          message: `agent-desktop took longer than ${Math.round(timeoutMs / 1000)} s.`,
          disposition: { delivery: "unknown", retry: "unsafe" },
        },
      });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      if (stdout.length < OUTPUT_LIMIT) stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 16_384) stderr += chunk;
    });
    child.on("error", (error) => finish({ ok: false, error: { code: "INTERNAL", message: `agent-desktop could not start: ${error.message}` } }));
    child.on("close", () => {
      try {
        finish(JSON.parse(stdout));
      } catch {
        finish({ ok: false, error: { code: "INTERNAL", message: (stderr || stdout || "agent-desktop returned no output.").trim().slice(0, 2000) } });
      }
    });
  });
}

function failure(envelope) {
  const error = envelope?.error ?? {};
  const out = { error: error.code ?? "INTERNAL", message: error.message ?? "agent-desktop failed." };
  if (error.suggestion) out.suggestion = error.suggestion;
  if (error.disposition) out.disposition = error.disposition;
  if (error.details) out.details = error.details;
  return out;
}

/**
 * The host side: status and the permission guide for Settings, and the agent tools for a Chat. `approve(chatId,
 * request)` shows Milagre's approval card and answers "allow" | "allow-for-chat" | "deny" | "cancelled".
 */
/** macOS's own launcher, for when agent-desktop's launch can't read the app list (a process record with pid -1). */
function openApp(app) {
  return new Promise((resolve) => {
    const child = spawn("/usr/bin/open", ["-a", app], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

function createComputerUse({
  dataDir,
  settings,
  approve,
  onAction = () => {},
  cli = agentDesktopBinary(),
  run = runCli,
  platform = process.platform,
  open = openApp,
}) {
  const home = path.join(dataDir, "agent-desktop");
  const exec = (args, options) => run({ ...cli, home }, args, options);
  // chatId -> { apps: Set of app names allowed for the Chat, snapshots: Map snapshot id -> app }
  const chats = new Map();
  const asking = new Map();
  const chat = (chatId) => {
    let state = chats.get(chatId);
    if (!state) chats.set(chatId, (state = { apps: new Set(), snapshots: new Map(), cursor: null, session: null }));
    return state;
  };
  // Each Chat works in an agent-desktop session of its own: its refs, and the agent cursor (which needs a session that
  // `session start` made). Sessions are opened once per Chat while the host runs, without tracing (it records the screen).
  // A failed start falls back to a plain namespace, which keeps refs apart but draws no cursor.
  const session = (chatId) => {
    const state = chat(chatId);
    state.session ??= exec(["session", "start", "--no-trace", "--name", "Milagre"], { timeoutMs: 15_000 }).then((envelope) =>
      envelope.ok && typeof envelope.data?.session_id === "string"
        ? envelope.data.session_id
        : `milagre-${crypto.createHash("sha256").update(chatId).digest("hex").slice(0, 16)}`,
    );
    return state.session;
  };

  async function status() {
    const supported = ["darwin", "win32", "linux"].includes(platform) && fs.existsSync(cli.binary);
    const base = { ...settings.read(), supported, version: cli.version, platform, blockedApps: BLOCKED_APPS };
    if (!supported) return { ...base, permissions: null };
    const envelope = await exec(["permissions"], { timeoutMs: 15_000 });
    const state = (entry) => entry?.state ?? "unknown";
    return {
      ...base,
      permissions: envelope.ok
        ? { accessibility: state(envelope.data?.accessibility), screenRecording: state(envelope.data?.screen_recording) }
        : { accessibility: "unknown", screenRecording: "unknown" },
    };
  }

  async function guide() {
    if (platform !== "darwin") return { guide: "not_needed" };
    const envelope = await exec(["permissions", "--guide"], { timeoutMs: 15_000 });
    if (!envelope.ok) throw new Error(failure(envelope).message);
    return { guide: envelope.data?.guide ?? "started" };
  }

  /** Asks the user once per app per Chat; concurrent calls for the same app share one card. */
  async function allowApp(chatId, app) {
    const name = String(app ?? "").trim();
    if (!name) throw new Error("Name the app (desktop_apps lists them).");
    if (blocked(name)) throw new Error(`POLICY_DENIED: agents never operate ${name} (Settings › Experimental › Computer use).`);
    const state = chat(chatId);
    if (state.apps.has(normalizeName(name))) return;
    const key = `${chatId}\0${normalizeName(name)}`;
    let pending = asking.get(key);
    if (!pending) {
      pending = approve(chatId, {
        requestId: `computer-use-${crypto.randomUUID()}`,
        kind: "other",
        tool: "Computer use",
        allowForChat: true,
        title: `Let the agent use ${name}?`,
        description: `It can read ${name}'s windows and click, type and select in them on this computer. It doesn't move your pointer or take focus.`,
        detail: JSON.stringify({ app: name }, null, 2),
      }).finally(() => asking.delete(key));
      asking.set(key, pending);
    }
    const decision = await pending;
    if (decision === "allow-for-chat") state.apps.add(normalizeName(name));
    if (decision === "cancelled") throw new Error("The approval card closed before the user answered.");
    if (decision !== "allow" && decision !== "allow-for-chat")
      throw new Error(`POLICY_DENIED: the user declined letting the agent use ${name}. Ask them before trying again.`);
  }

  function appOfRef(chatId, ref) {
    const match = REF.exec(String(ref ?? ""));
    if (!match) throw new Error("INVALID_ARGS: pass a qualified ref such as @s8f3k2p9:e12 from desktop_snapshot or desktop_find.");
    const app = chat(chatId).snapshots.get(match[1].toLowerCase());
    if (!app) throw new Error("SNAPSHOT_NOT_FOUND: that ref is from a snapshot this Chat didn't take. Call desktop_snapshot again.");
    return app;
  }

  /**
   * Before an action: Milagre's agent cursor on the screen, with the step beside it. Re-enabled only when the step
   * changes; a failure never stops the action, it only costs the user the cursor.
   */
  async function showStep(chatId, intent) {
    if (!settings.read().cursor) return;
    const state = chat(chatId);
    const label = typeof intent === "string" ? intent.trim().slice(0, 80) : "";
    if (state.cursor === label) return;
    const envelope = await exec(
      ["cursor-overlay", "enable", ...CURSOR_STYLE, ...(label ? ["--label", label, "--max-words", "8"] : []), "--session", await session(chatId)],
      {
        timeoutMs: 10_000,
      },
    );
    state.cursor = envelope.ok ? label : null;
  }

  async function call(chatId, app, args, options, intent) {
    if (intent !== undefined) await showStep(chatId, intent);
    const envelope = await exec([...args, "--session", await session(chatId)], options);
    if (!envelope.ok) return JSON.stringify(failure(envelope));
    const snapshotId = envelope.data?.snapshot_id;
    if (snapshotId && app) chat(chatId).snapshots.set(String(snapshotId).toLowerCase(), app);
    onAction({ chatId, app, command: args[0], data: envelope.data, intent });
    return JSON.stringify(envelope.data ?? {});
  }

  /** The Chat ended or was archived: its grants go, and so does its cursor. */
  async function forget(chatId) {
    const state = chats.get(chatId);
    chats.delete(chatId);
    // Ending the session also stops its cursor.
    if (state?.session) await exec(["session", "end", "--session", await state.session], { timeoutMs: 10_000 });
  }

  function definitions(chatId) {
    const app = z.string().min(1).max(200);
    const ref = z.string().min(3).max(100);
    const intent = z
      .string()
      .max(80)
      .optional()
      .describe("The step in a few words, such as 'Typing the new name'. Shown beside the agent cursor on screen and in the Chat.");
    return [
      {
        name: "desktop_apps",
        description: `Computer use (Settings › Experimental): list the running desktop apps on this computer, or one app's windows with their ids. Before the first use in a Chat, read ${path.join(BUNDLED_SKILLS_DIRECTORY, "desktop", "SKILL.md")}.`,
        input: { app: app.optional() },
        readOnly: true,
        run: async ({ app: name }) => call(chatId, null, name ? ["list-windows", "--app", name] : ["list-apps"]),
      },
      {
        name: "desktop_snapshot",
        description: `Computer use: read an app's window as an accessibility tree with a qualified ref (@<snapshot_id>:eN) for every element you can act on. For a dense app take skeleton first, then drill into one region with root. The first use of an app asks the user. Before the first use in a Chat, read ${path.join(BUNDLED_SKILLS_DIRECTORY, "desktop", "SKILL.md")}.`,
        input: {
          app,
          windowId: z.string().max(100).optional(),
          root: ref.optional(),
          surface: z.enum(["window", "focused", "menu", "menubar", "sheet", "popover", "alert"]).optional(),
          skeleton: z.boolean().optional(),
          interactiveOnly: z.boolean().optional(),
        },
        readOnly: true,
        run: async ({ app: name, windowId, root, surface, skeleton, interactiveOnly = true }) => {
          if (root && normalizeName(appOfRef(chatId, root)) !== normalizeName(name)) throw new Error("INVALID_ARGS: root belongs to another app's snapshot.");
          await allowApp(chatId, name);
          const args = ["snapshot", "--app", name, "--compact"];
          if (interactiveOnly) args.push("-i");
          if (skeleton) args.push("--skeleton");
          if (windowId) args.push("--window-id", windowId);
          if (root) args.push("--root", root);
          if (surface) args.push("--surface", surface);
          return call(chatId, name, args);
        },
      },
      {
        name: "desktop_find",
        description: "Find elements in an app by role, name, text or value, returning qualified refs. Use it when you know what you are looking for.",
        input: {
          app,
          role: z.string().max(60).optional(),
          name: z.string().max(500).optional(),
          text: z.string().max(500).optional(),
          value: z.string().max(500).optional(),
          exact: z.boolean().optional(),
          windowId: z.string().max(100).optional(),
        },
        readOnly: true,
        run: async ({ app: name, role, name: label, text, value, exact, windowId }) => {
          await allowApp(chatId, name);
          const args = ["find", "--app", name];
          if (role) args.push("--role", role);
          if (label) args.push("--name", label);
          if (text) args.push("--text", text);
          if (value) args.push("--value", value);
          if (exact) args.push("--exact");
          if (windowId) args.push("--window-id", windowId);
          return call(chatId, name, args);
        },
      },
      {
        name: "desktop_act",
        description:
          "Act on an element by its qualified ref: click, type (text), set-value (text), clear, select (text: the option), toggle, check, uncheck, expand, collapse, focus, scroll (direction, amount) or scroll-to. Headless: it never moves the pointer or takes focus. Retry only when the result's disposition.retry is safe; otherwise snapshot again and check.",
        input: {
          action: z.enum(ACTIONS),
          ref,
          text: z.string().max(10_000).optional(),
          direction: z.enum(["up", "down", "left", "right"]).optional(),
          amount: z.number().int().min(1).max(50).optional(),
          intent,
        },
        readOnly: false,
        run: async ({ action, ref: target, text, direction, amount, intent: step }) => {
          const name = appOfRef(chatId, target);
          await allowApp(chatId, name);
          const args = [action, target];
          if (["type", "set-value", "select"].includes(action)) {
            if (text === undefined) throw new Error(`INVALID_ARGS: ${action} needs text.`);
            args.push(text);
          }
          if (action === "scroll") {
            if (direction) args.push("--direction", direction);
            if (amount) args.push("--amount", String(amount));
          }
          return call(chatId, name, args, undefined, step ?? "");
        },
      },
      {
        name: "desktop_press",
        description:
          "Send a key combo (return, escape, tab, cmd+s, shift+tab) to an app's process without focusing it. Quit shortcuts are refused; there is no way to force them.",
        input: { app, keys: z.string().min(1).max(60), windowId: z.string().max(100).optional(), intent },
        readOnly: false,
        run: async ({ app: name, keys, windowId, intent: step }) => {
          await allowApp(chatId, name);
          const args = ["press", keys, "--app", name];
          if (windowId) args.push("--window-id", windowId);
          return call(chatId, name, args, undefined, step ?? "");
        },
      },
      {
        name: "desktop_launch",
        description: "Open an app by its name or bundle id (or attach to it when it already runs) and wait for its window.",
        input: { app, intent },
        readOnly: false,
        run: async ({ app: name, intent: step }) => {
          await allowApp(chatId, name);
          const result = await call(chatId, name, ["launch", name], { timeoutMs: 45_000 }, step ?? `Opening ${name}`);
          // agent-desktop 1.0.2 gives up when NSWorkspace lists a process with pid -1, which can last for minutes on a
          // busy Mac. LaunchServices opens the app anyway; the agent's next snapshot finds its window.
          if (platform === "darwin" && JSON.parse(result).details?.kind === "application_inventory_unstable" && (await open(name))) {
            onAction({ chatId, app: name, command: "launch", data: {} });
            return JSON.stringify({
              app: name,
              launched: true,
              via: "open -a",
              note: "Opened by macOS; call desktop_snapshot or desktop_wait for its window.",
            });
          }
          return result;
        },
      },
      {
        name: "desktop_wait",
        description: "Wait in an app until text appears, a window with a title appears, or a menu opens, instead of sleeping. Up to timeoutMs (default 10000).",
        input: {
          app,
          text: z.string().max(500).optional(),
          window: z.string().max(500).optional(),
          menu: z.boolean().optional(),
          timeoutMs: z.number().int().min(100).max(60_000).optional(),
        },
        readOnly: true,
        run: async ({ app: name, text, window, menu, timeoutMs = 10_000 }) => {
          await allowApp(chatId, name);
          const args = ["wait", "--app", name, "--timeout", String(timeoutMs)];
          if (text) args.push("--text", text);
          else if (window) args.push("--window", window);
          else if (menu) args.push("--menu");
          else throw new Error("INVALID_ARGS: wait for text, window or menu.");
          return call(chatId, name, args, { timeoutMs: timeoutMs + 15_000 });
        },
      },
      {
        name: "desktop_screenshot",
        description:
          "Take a picture of an app's window. Needs Screen Recording for Milagre. Prefer desktop_snapshot to read the UI; use this to check how it looks.",
        input: { app, windowId: z.string().max(100).optional() },
        readOnly: true,
        run: async ({ app: name, windowId }) => {
          await allowApp(chatId, name);
          const args = ["screenshot", "--app", name];
          if (windowId) args.push("--window-id", windowId);
          const envelope = await exec([...args, "--session", await session(chatId)]);
          if (!envelope.ok) return JSON.stringify(failure(envelope));
          const { data: base64, format = "png" } = envelope.data ?? {};
          if (typeof base64 !== "string") return JSON.stringify(envelope.data ?? {});
          onAction({ chatId, app: name, command: "screenshot", data: {} });
          return { text: `${name} window`, images: [{ base64, mime: `image/${format}` }] };
        },
      },
    ];
  }

  return { status, guide, definitions, forget, allowApp, session };
}

module.exports = { BLOCKED_APPS, agentDesktopBinary, createComputerUseSettings, createComputerUse, runCli };
