// Runs the real main process, preload, and built renderer against temporary legacy-format data.
// npm run build && npm test -- --only test-desktop [-- --packaged <.app, unpacked directory, or executable>]
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const { once } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..");

async function packagedExecutable(input) {
  const bundle = path.resolve(input);
  if (!(await fs.stat(bundle)).isDirectory()) return bundle;
  return path.join(bundle, process.platform === "darwin" ? "Contents/MacOS/Milagre" : process.platform === "win32" ? "Milagre.exe" : "milagre");
}

async function waitFor(read, description) {
  for (let i = 0; i < 400; i++) {
    const value = await read();
    if (value) return value;
    await delay(50);
  }
  throw new Error(`Timed out: ${description}`);
}

async function connect(url) {
  const socket = new WebSocket(url);
  try {
    await once(socket, "open", { signal: AbortSignal.timeout(20000) });
  } catch (error) {
    socket.close();
    throw error;
  }
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const reply = JSON.parse(data);
    if (reply.method === "Runtime.exceptionThrown" || reply.method === "Log.entryAdded") {
      console.error("Desktop renderer:", JSON.stringify(reply.params));
    }
    const request = pending.get(reply.id);
    if (!request) return;
    pending.delete(reply.id);
    clearTimeout(request.timeout);
    if (reply.error) request.reject(new Error(reply.error.message));
    else request.resolve(reply.result);
  });
  return {
    close: () => socket.close(),
    call(method, params = {}) {
      return new Promise((resolve, reject) => {
        const requestId = ++id;
        const timeout = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error(`Timed out: ${method}`));
        }, 20000);
        pending.set(requestId, { resolve, reject, timeout });
        socket.send(JSON.stringify({ id: requestId, method, params }));
      });
    },
  };
}

async function checkApp({ executable, args, profile, project, expectTheme, expectStartupError = false, recoverOwnership }) {
  console.log(`CHECK: ${expectTheme ? "installed" : "source"} desktop${expectStartupError ? " ownership recovery" : ""}`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.MILAGRE_DEV_SERVER_URL = pathToFileURL(path.join(root, "apps/desktop/dist/index.html")).href;
  // The packaged app's updater must not download/install a newer release during this check.
  const child = spawn(executable, [...args, `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--proxy-server=http://127.0.0.1:9"], {
    cwd: project,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  let output = "";
  let debuggerPort;
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (data) => {
      output = (output + data.toString()).slice(-20000);
      debuggerPort ??= output.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/)?.[1];
    });
  let connection;
  let failure;
  try {
    await waitFor(() => {
      assert.equal(child.exitCode, null, output);
      return debuggerPort;
    }, "Electron debugger");
    const page = await waitFor(async () => {
      const pages = await fetch(`http://127.0.0.1:${debuggerPort}/json/list`, { signal: AbortSignal.timeout(5000) }).then((response) => response.json());
      return pages.find((page) => page.type === "page" && page.url.startsWith("file:"));
    }, "desktop page");
    connection = await connect(page.webSocketDebuggerUrl);
    await connection.call("Runtime.enable");
    await connection.call("Log.enable");
    const evaluate = async (expression) => {
      const result = await connection.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    if (expectStartupError) {
      await waitFor(
        () => evaluate('document.body?.textContent.includes("already owned") && !!document.querySelector("[data-startup-error]")'),
        "actionable ownership error",
      );
      assert.ok(await evaluate('[...document.querySelectorAll("button")].some(button => button.textContent.includes("Open another project"))'));
      if (process.env.MILAGRE_SCREENSHOT_DIR) {
        await fs.mkdir(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
        const shot = await connection.call("Page.captureScreenshot");
        await fs.writeFile(path.join(process.env.MILAGRE_SCREENSHOT_DIR, "project-owned.png"), Buffer.from(shot.data, "base64"));
      }
      await recoverOwnership();
      await evaluate('[...document.querySelectorAll("button")].find(button => button.textContent === "Retry").click()');
      await waitFor(
        () => evaluate('document.body?.textContent.includes("Saved chat") && !document.querySelector("[data-startup-error]")'),
        "retry after releasing ownership",
      );
      console.log("PASS: a Project owned by another runtime shows an error and Retry opens its saved Chat after ownership is released");
      return;
    }
    await waitFor(() => evaluate('Boolean(window.milagre && document.body?.textContent.includes("Saved chat"))'), "saved Chat in the real UI");
    const current = await evaluate("window.milagre.getCurrentProject()");
    assert.equal(current.path, project);
    assert.equal(current.state.sessions[2].title, "Saved chat");
    assert.equal(current.state.sessions[2].native_session_id, "existing-provider-session");
    // The window takes states without messages (chat-pages-v1) and reads each Chat's as pages.
    assert.equal(current.state.messagesInChats, true);
    const saved = await evaluate(`window.milagre.readChatMessages(${JSON.stringify(project)}, 2)`);
    assert.equal(saved.messages[0].body, "Existing conversation survives the move.");
    const settings = await evaluate(`window.milagre.readWorktreeSetup(${JSON.stringify(project)})`);
    assert.equal(settings.setupCommand, "npm ci");
    assert.equal(settings.source, "setting");
    const skills = await evaluate(`window.milagre.listSkills(${JSON.stringify(project)})`);
    assert.ok(JSON.stringify(skills).includes("tldr"), "Bundled skills resolve after relocation");
    assert.equal(typeof (await evaluate("window.milagre.getAppVersion()")), "string");
    await waitFor(() => evaluate('!document.querySelector(".startup-splash-screen")'), "desktop ready for shared controls");
    // The Experimental switch owns both native windows. Disabling removes them without closing the main app.
    const pages = async () => fetch(`http://127.0.0.1:${debuggerPort}/json/list`).then((response) => response.json());
    assert.equal((await pages()).filter((page) => page.url.includes("floating-inbox=")).length, 0);
    await evaluate("window.milagre.openInboxSettings()");
    await waitFor(() => evaluate(`!!document.querySelector('[role="switch"][aria-label="Floating inbox"]')`), "Floating inbox Experimental switch");
    if (process.env.MILAGRE_SCREENSHOT_DIR) {
      const shot = await connection.call("Page.captureScreenshot");
      await fs.writeFile(path.join(process.env.MILAGRE_SCREENSHOT_DIR, "floating-inbox-settings.png"), Buffer.from(shot.data, "base64"));
    }
    await evaluate(`document.querySelector('[role="switch"][aria-label="Floating inbox"]').click()`);
    const dockPage = await waitFor(async () => (await pages()).find((page) => page.url.includes("floating-inbox=dock")), "native floating bar");
    const dock = await connect(dockPage.webSocketDebuggerUrl);
    try {
      const readDock = async (expression) => (await dock.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result.value;
      await waitFor(() => readDock('!!document.querySelector("[data-floating-bar]")'), "bar rendered through the real preload");
      assert.equal(await readDock('document.querySelector("[data-floating-bar]").getBoundingClientRect().width'), 28);
      assert.equal(await readDock("getComputedStyle(document.body).backgroundColor"), "rgba(0, 0, 0, 0)");
      await evaluate("window.milagre.toggleFloatingInbox()");
      const inboxPage = await waitFor(async () => (await pages()).find((page) => page.url.includes("floating-inbox=inbox")), "native inbox");
      const inbox = await connect(inboxPage.webSocketDebuggerUrl);
      try {
        await waitFor(
          async () =>
            (await inbox.call("Runtime.evaluate", { expression: '!!document.querySelector("[data-inbox-panel]")', returnByValue: true })).result.value,
          "native inbox rendered",
        );
        if (process.env.MILAGRE_SCREENSHOT_DIR) {
          const shot = await inbox.call("Page.captureScreenshot");
          await fs.writeFile(path.join(process.env.MILAGRE_SCREENSHOT_DIR, "native-inbox.png"), Buffer.from(shot.data, "base64"));
        }
        await evaluate("window.milagre.openInboxChat(" + JSON.stringify(project + "#2") + ")");
        await waitFor(() => evaluate(`!!document.querySelector('textarea[aria-label="Prompt"]')`), "inbox opens Chat in the main window");
        await evaluate("window.milagre.openInboxSettings()");
        await waitFor(() => evaluate(`!!document.querySelector('[role="switch"][aria-label="Floating inbox"]')`), "return to Experimental settings");
        assert.equal(await evaluate('JSON.parse(localStorage.getItem("milagre-settings")).floatingInbox'), true);
        await evaluate(`document.querySelector('[role="switch"][aria-label="Floating inbox"]').click()`);
        await waitFor(async () => !(await pages()).some((page) => page.url.includes("floating-inbox=")), "disabled experiment destroys both native windows");
        assert.equal(await evaluate('JSON.parse(localStorage.getItem("milagre-settings")).floatingInbox'), false);
      } finally {
        inbox.close();
      }
    } finally {
      dock.close();
    }
    await evaluate("window.milagre.openInboxChat(" + JSON.stringify(project + "#2") + ")");
    console.log("PASS: Experimental switch opens the 28 px native bar and inbox, routes to the main Chat, saves its state and removes both surfaces when off");
    const shared = await require("@milagre/daemon/client").connect({ dataDir: profile });
    try {
      assert.notEqual((await shared.call("daemon:status")).pid, child.pid, "Desktop uses a separate persistent host");
      await shared.call("chat:patch", [project, 2, { title: "Updated from another device" }]);
      await waitFor(
        () => evaluate('document.body?.textContent.includes("Updated from another device") && !document.body?.textContent.includes("Saved chat")'),
        "shared client update in desktop",
      );
      if (process.env.MILAGRE_SCREENSHOT_DIR) {
        await fs.mkdir(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
        const shot = await connection.call("Page.captureScreenshot");
        await fs.writeFile(path.join(process.env.MILAGRE_SCREENSHOT_DIR, "shared-desktop.png"), Buffer.from(shot.data, "base64"));
      }
      await shared.call("chat:patch", [project, 2, { title: "Saved chat" }]);
    } finally {
      shared.close();
    }
    if (expectTheme)
      assert.equal(await evaluate('document.documentElement.classList.contains("dark")'), true, "Existing UI settings survive a restart/package change");
    await evaluate(
      'localStorage.setItem("milagre-settings", JSON.stringify({theme:"dark",defaultPermissionMode:"ask",notifyWhenWaiting:false,notifyOnCompletion:false,showDockBadge:false}));',
    );
    await connection.call("Page.reload");
    await waitFor(() => evaluate('document.documentElement?.classList.contains("dark")'), "saved theme after reload");
    await waitFor(
      () => evaluate('document.body?.textContent.includes("Saved chat") && !document.querySelector(".startup-splash-screen")'),
      "saved Chat visible after reload",
    );
    if (process.env.MILAGRE_SCREENSHOT_DIR) {
      await fs.mkdir(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
      const shot = await connection.call("Page.captureScreenshot");
      await fs.writeFile(path.join(process.env.MILAGRE_SCREENSHOT_DIR, expectTheme ? "packaged-desktop.png" : "desktop.png"), Buffer.from(shot.data, "base64"));
    }
    await evaluate(`(() => {
      const input = document.querySelector('textarea[aria-label="Prompt"]');
      if (!input) throw new Error('Prompt missing');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'Keep this unsent draft');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    const hostControl = await require("@milagre/daemon/client").connect({ dataDir: profile });
    try {
      await hostControl.call("daemon:stop");
    } finally {
      hostControl.close();
    }
    await waitFor(() => evaluate('!!document.querySelector("[data-host-disconnected]")'), "disconnected host notice");
    if (process.env.MILAGRE_SCREENSHOT_DIR) {
      const shot = await connection.call("Page.captureScreenshot");
      await fs.writeFile(path.join(process.env.MILAGRE_SCREENSHOT_DIR, "host-disconnected.png"), Buffer.from(shot.data, "base64"));
    }
    await waitFor(async () => {
      try {
        await fs.stat(path.join(profile, "runtime.lock"));
        return false;
      } catch (error) {
        return error.code === "ENOENT";
      }
    }, "old host shutdown");
    const restarted = await require("@milagre/daemon/bootstrap").ensureDaemon({ dataDir: profile, version: "0.1.0", cwd: project });
    restarted.close();
    await waitFor(() => evaluate('!document.querySelector("[data-host-disconnected]")'), "desktop reconnect without reload");
    assert.equal(await evaluate("document.querySelector('textarea[aria-label=\"Prompt\"]').value"), "Keep this unsent draft");
    console.log("PASS: a shared client updates desktop and host restart restores state without losing its draft");
    // A host that dies without being asked to stop (killed outright: its lock and socket stay behind) is started again.
    const crashed = await require("@milagre/daemon/client").connect({ dataDir: profile });
    let crashedPid;
    try {
      ({ pid: crashedPid } = await crashed.call("daemon:status"));
    } finally {
      crashed.close();
    }
    process.kill(crashedPid, "SIGKILL");
    await waitFor(
      () =>
        evaluate('document.body?.textContent.includes("stopped unexpectedly, so it was started again") && !document.querySelector("[data-host-disconnected]")'),
      "host started again after a crash",
    );
    const replacement = await require("@milagre/daemon/client").connect({ dataDir: profile });
    try {
      assert.notEqual((await replacement.call("daemon:status")).pid, crashedPid);
    } finally {
      replacement.close();
    }
    assert.equal(await evaluate("document.querySelector('textarea[aria-label=\"Prompt\"]').value"), "Keep this unsent draft");
    if (process.env.MILAGRE_SCREENSHOT_DIR) {
      const shot = await connection.call("Page.captureScreenshot");
      await fs.writeFile(path.join(process.env.MILAGRE_SCREENSHOT_DIR, "host-restarted.png"), Buffer.from(shot.data, "base64"));
    }
    console.log("PASS: a host that crashed is started again, the window says so, and the draft stays");
    console.log(
      `PASS: ${expectTheme ? "packaged" : "source"} desktop opens existing Chats, provider IDs, Project settings, bundled skills and saved UI preferences`,
    );
  } catch (error) {
    failure = error;
    console.error(output);
    console.error(error);
    if (connection) {
      try {
        const state = await connection.call("Runtime.evaluate", {
          expression: "JSON.stringify({url:location.href,body:document.body?.textContent,bridge:typeof window.milagre})",
          returnByValue: true,
        });
        console.error("Desktop page at failure:", state.result.value);
        if (process.env.MILAGRE_SCREENSHOT_DIR) {
          await fs.mkdir(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
          const shot = await connection.call("Page.captureScreenshot");
          await fs.writeFile(path.join(process.env.MILAGRE_SCREENSHOT_DIR, "desktop-failure.png"), Buffer.from(shot.data, "base64"));
        }
      } catch (diagnosticError) {
        console.error("Desktop diagnostics failed:", diagnosticError);
      }
    }
    try {
      console.error(await fs.readFile(path.join(profile, "daemon.log"), "utf8"));
    } catch (logError) {
      if (logError.code !== "ENOENT") console.error(logError);
    }
    throw error;
  } finally {
    connection?.close();
    child.kill("SIGTERM");
    const timeout = setTimeout(() => child.kill("SIGKILL"), 10000);
    await exited;
    clearTimeout(timeout);
    // Desktop quit leaves the shared host available. This fixture alone owns
    // the temporary profile, so explicitly stop it before deleting test data.
    try {
      const shared = await require("@milagre/daemon/client").connect({ dataDir: profile });
      try {
        assert.ok((await shared.call("daemon:status")).capabilities.includes("desktop-v1"));
        await shared.call("daemon:stop");
      } finally {
        shared.close();
      }
      await waitFor(async () => {
        try {
          await fs.stat(path.join(profile, "runtime.lock"));
          return false;
        } catch (error) {
          if (error.code === "ENOENT") return true;
          throw error;
        }
      }, "host saves and releases the fixture profile");
    } catch (cleanupError) {
      // oxlint-disable-next-line no-unsafe-finally -- the cleanup error is rethrown only when the body did not fail, so it never masks the original error
      if (!failure) throw cleanupError;
      console.error("Fixture cleanup failed:", cleanupError);
    }
  }
}

async function main() {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-desktop-")));
  try {
    const project = path.join(temporary, "project");
    const profile = path.join(temporary, "profile");
    await fs.mkdir(path.join(project, ".milagre"), { recursive: true });
    await fs.mkdir(profile);
    execFileSync("git", ["init", "-b", "main", project], { stdio: "ignore" });
    execFileSync("git", ["-C", project, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "fixture"], {
      stdio: "ignore",
    });
    const state = {
      next_id: 5,
      projects: { 1: { id: 1, name: "project" } },
      worktrees: { 1: { id: 1, project_id: 1, path: project, name: "main" } },
      sessions: {
        2: {
          id: 2,
          worktree_id: 1,
          agent_name: "main",
          title: "Saved chat",
          status: "Stopped",
          provider: "codex",
          native_session_id: "existing-provider-session",
        },
      },
      messages: [{ id: 3, session_id: 2, role: "user", body: "Existing conversation survives the move.", context: null }],
      connections: {},
      events: [],
      approvals: [],
      tasks: {},
      artifacts: {},
      outputs: [],
      conflicts: [],
    };
    await fs.writeFile(path.join(project, ".milagre/coordination.json"), JSON.stringify(state));
    await fs.writeFile(path.join(profile, "recent-projects.json"), JSON.stringify([{ path: project, name: "project", openedAt: "2026-10-01T00:00:00.000Z" }]));
    await fs.writeFile(
      path.join(profile, "project-settings.json"),
      JSON.stringify({ projects: { [project]: { setupCommand: "npm ci", filesToCopy: [".env"] } } }),
    );
    await checkApp({ executable: require("electron"), args: [path.join(root, "apps/desktop")], profile, project, expectTheme: false });
    const packagedIndex = process.argv.indexOf("--packaged");
    if (packagedIndex !== -1) {
      assert.ok(process.argv[packagedIndex + 1], "Pass the packaged application path after --packaged");
      await checkApp({ executable: await packagedExecutable(process.argv[packagedIndex + 1]), args: [], profile, project, expectTheme: true });
    }
    const { acquireOwnership } = require("@milagre/core/ownership");
    const owner = acquireOwnership(path.join(project, ".milagre/runtime.lock"));
    try {
      await checkApp({
        executable: require("electron"),
        args: [path.join(root, "apps/desktop")],
        profile,
        project,
        expectStartupError: true,
        recoverOwnership: () => owner.release(),
      });
    } finally {
      owner.release();
    }
    // Messages are saved in chats.db (ADR-0007): read the state the way the app does.
    const saved = await require("@milagre/core/project-store").readProjectState(project);
    assert.deepEqual(saved.messages, state.messages, "Launching and quitting must preserve the transcript");
  } finally {
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
