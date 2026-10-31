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

// The agent's design PNG: resvg's WebAssembly (unpacked from the asar) drawn on a worker thread loaded from core. The
// daemon runs in the main process; Node mode loads the same asar paths with the same Electron runtime.
async function checkDesignRaster({ executable, raster, label }) {
  const script = `require(process.argv[1]).renderDesignPng({ schemaVersion: 1, width: 390, height: 844, nodes: [
    { id: "title", type: "text", x: 16, y: 60, width: 300, height: 40, text: "Packaged", fontSize: 24, fontWeight: 600 }] })
    .then((png) => { console.log(JSON.stringify({ mime: png.mime, width: png.width, height: png.height, bytes: png.base64.length })); process.exit(0); },
      (error) => { console.error(error.stack); process.exit(1); });`;
  const child = spawn(executable, ["-e", script, raster], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => (output += data.toString()));
  const [code] = await once(child, "exit");
  assert.equal(code, 0, output);
  const png = JSON.parse(output.trim().split("\n").at(-1));
  assert.deepEqual([png.mime, png.width, png.height], ["image/png", 390, 844], output);
  assert.ok(png.bytes > 1000, output);
  console.log(`PASS: ${label} core draws a design PNG on its worker thread`);
}

function packagedRaster(executable) {
  const resources = process.platform === "darwin" ? path.join(path.dirname(executable), "../Resources") : path.join(path.dirname(executable), "resources");
  return path.join(resources, "app.asar/node_modules/@milagre/core/src/design-raster.cjs");
}

async function checkApp({ executable, args, profile, project, expectTheme, expectStartupError = false, onboarding, recoverOwnership }) {
  console.log(`CHECK: ${expectTheme ? "installed" : "source"} desktop${expectStartupError ? " ownership recovery" : onboarding ? " onboarding" : ""}`);
  const env = { ...process.env };
  env.MILAGRE_CHATS_HOME = path.join(profile, "chats-home");
  delete env.ELECTRON_RUN_AS_NODE;
  // Onboarding reads agent history from these: a fake Claude Code history names one folder without Git.
  if (onboarding) Object.assign(env, { CLAUDE_CONFIG_DIR: onboarding.claudeHome, CODEX_HOME: onboarding.codexHome, MILAGRE_ONBOARDING_TEMP_FOLDERS: "1" });
  env.MILAGRE_DEV_SERVER_URL = pathToFileURL(path.join(root, "apps/desktop/dist/index.html")).href;
  // The packaged app's updater must not download/install a newer release during this check. On macOS the app seals
  // its computer vault key with safeStorage at launch; the source and packaged apps share this profile but not a code
  // signature, so the real keychain would ask for access and block the main process. A mock keychain never asks.
  const keychain = process.platform === "darwin" ? ["--use-mock-keychain"] : [];
  const child = spawn(executable, [...args, `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--proxy-server=http://127.0.0.1:9", ...keychain], {
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
    if (onboarding) {
      const shot = async (name) => {
        if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
        await fs.mkdir(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
        const image = await connection.call("Page.captureScreenshot");
        await fs.writeFile(path.join(process.env.MILAGRE_SCREENSHOT_DIR, name), Buffer.from(image.data, "base64"));
      };
      const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
      await waitFor(
        () => evaluate('document.querySelector("[data-onboarding]")?.dataset.step === "1" && !document.querySelector(".startup-splash-screen")'),
        "first-launch onboarding",
      );
      assert.equal(await evaluate("window.milagre.getCurrentProject()"), null);
      assert.equal(await evaluate('!!document.querySelector("[data-startup-error]")'), false);
      assert.ok(await evaluate('document.body.textContent.includes("Choose your agent")'));
      await waitFor(() => evaluate('document.querySelectorAll("[data-onboarding-agents] [data-agent]:not([data-state=checking])").length === 4'), "agent rows");
      await shot("onboarding-agent.png");
      await evaluate('[...document.querySelectorAll("[data-onboarding] footer button")].at(-1).click()');
      await waitFor(() => evaluate('document.querySelector("[data-onboarding]")?.dataset.step === "2"'), "project step");
      await waitFor(
        () => evaluate(`!!document.querySelector('[data-folder=${JSON.stringify(path.basename(onboarding.plainFolder))}]')`),
        "agent history folder",
      );
      assert.equal(await evaluate("document.querySelectorAll('[data-onboarding-tile]').length"), 3);
      assert.ok(await evaluate("!!document.querySelector('[data-onboarding-skip]')"), "the project step can be skipped");
      await shot("onboarding-project.png");
      await click(`[data-folder=${JSON.stringify(path.basename(onboarding.plainFolder))}] button`);
      await waitFor(() => evaluate("!!document.querySelector('[data-no-git]')"), "No Git explanation");
      await shot("onboarding-no-git.png");
      await evaluate('[...document.querySelectorAll("[data-no-git] button")].find((button) => button.textContent === "Open folder").click()');
      await waitFor(() => evaluate("!document.querySelector('[data-onboarding]') && !!document.querySelector('[data-first-chat-starters]')"), "first Chat");
      assert.ok(await evaluate("!!document.querySelector('[data-no-git-note]')"), "a Project without Git says its Chat works in the folder");
      assert.equal(
        await evaluate("window.milagre.getCurrentProject().then((project) => [project.path, project.git])").then(JSON.stringify),
        JSON.stringify([onboarding.plainFolder, false]),
      );
      // The app fades in over the onboarding screen; the picture waits for it.
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await shot("onboarding-first-chat.png");
      console.log("PASS: fresh install walks onboarding and opens a folder without Git");
      return;
    }
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
    await waitFor(() => evaluate(`!!document.querySelector('[role="checkbox"][aria-label="Floating inbox"]')`), "Floating inbox Experimental switch");
    if (process.env.MILAGRE_SCREENSHOT_DIR) {
      const shot = await connection.call("Page.captureScreenshot");
      await fs.writeFile(path.join(process.env.MILAGRE_SCREENSHOT_DIR, "floating-inbox-settings.png"), Buffer.from(shot.data, "base64"));
    }
    await evaluate(`document.querySelector('[role="checkbox"][aria-label="Floating inbox"]').click()`);
    const dockPage = await waitFor(async () => (await pages()).find((page) => page.url.includes("floating-inbox=dock")), "native floating bar");
    const dock = await connect(dockPage.webSocketDebuggerUrl);
    try {
      const readDock = async (expression) => (await dock.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result.value;
      await waitFor(() => readDock('!!document.querySelector("[data-floating-bar]")'), "bar rendered through the real preload");
      assert.equal(await readDock('document.querySelector("[data-floating-bar]").getBoundingClientRect().width'), 28);
      try {
        assert.equal(await readDock("getComputedStyle(document.body).backgroundColor"), "rgba(0, 0, 0, 0)");
      } catch (error) {
        console.error(
          "Floating dock at failure:",
          await readDock(`JSON.stringify({ url: location.href, readyState: document.readyState, userAgent: navigator.userAgent,
            root: document.documentElement.outerHTML.slice(0, document.documentElement.outerHTML.indexOf('>') + 1),
            body: document.body.getAttribute('style'), background: getComputedStyle(document.body).background,
            rootBackground: getComputedStyle(document.documentElement).background,
            appBackground: getComputedStyle(document.getElementById('root')).background,
            sheets: [...document.styleSheets].map(sheet => ({href: sheet.href, disabled: sheet.disabled})) })`),
        );
        await dock.call("DOM.enable");
        await dock.call("CSS.enable");
        const { root } = await dock.call("DOM.getDocument");
        const { nodeId } = await dock.call("DOM.querySelector", { nodeId: root.nodeId, selector: "body" });
        const styles = await dock.call("CSS.getMatchedStylesForNode", { nodeId });
        const computed = await dock.call("CSS.getComputedStyleForNode", { nodeId });
        console.error(
          "Floating dock CSS computed background:",
          JSON.stringify(computed.computedStyle.filter((property) => property.name.startsWith("background"))),
        );
        console.error(
          "Floating dock matched rules:",
          JSON.stringify({ rules: styles.matchedCSSRules, inline: styles.inlineStyle, attributes: styles.attributesStyle }),
        );
        console.error(
          "Floating dock color state:",
          await readDock(`JSON.stringify({
          background: getComputedStyle(document.body).backgroundColor,
          bodyClass: document.body.className, parent: document.body.parentElement.tagName,
          forcedColors: matchMedia('(forced-colors: active)').matches,
          colorScheme: getComputedStyle(document.body).colorScheme,
          forcedColorAdjust: getComputedStyle(document.body).forcedColorAdjust,
          stripe: getComputedStyle(document.body).getPropertyValue('--stripe-bg'),
          animations: document.getAnimations().filter(a => a.effect?.target === document.body).map(a => ({state:a.playState,frames:a.effect?.getKeyframes()})),
          animationStyles: ${JSON.stringify(styles.cssAnimationStyles ?? [])}
        })`),
        );
        await readDock("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
        console.error("Floating dock background after two frames:", await readDock("getComputedStyle(document.body).backgroundColor"));
        const directory = path.join(process.env.RUNNER_TEMP || os.tmpdir(), "milagre-dock-diagnostics");
        await fs.mkdir(directory, { recursive: true });
        const shot = await dock.call("Page.captureScreenshot");
        await fs.writeFile(path.join(directory, "opaque-dock.png"), Buffer.from(shot.data, "base64"));
        throw error;
      }
      await dock.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
      await readDock(`document.documentElement.removeAttribute('data-floating-inbox');
        getComputedStyle(document.body).backgroundColor`);
      await readDock("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      const restoredCanvas = await readDock(`(() => {
        document.documentElement.setAttribute('data-floating-inbox', '');
        return { background: getComputedStyle(document.body).backgroundColor,
          animations: document.body.getAnimations().length };
      })()`);
      assert.deepEqual(
        restoredCanvas,
        { background: "rgba(0, 0, 0, 0)", animations: 0 },
        "reduced motion must not animate the floating canvas from opaque to transparent",
      );
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
        await waitFor(() => evaluate(`!!document.querySelector('[data-prompt-editor]')`), "inbox opens Chat in the main window");
        await evaluate("window.milagre.openInboxSettings()");
        await waitFor(() => evaluate(`!!document.querySelector('[role="checkbox"][aria-label="Floating inbox"]')`), "return to Experimental settings");
        assert.equal(await evaluate('JSON.parse(localStorage.getItem("milagre-settings")).floatingInbox'), true);
        await evaluate(`document.querySelector('[role="checkbox"][aria-label="Floating inbox"]').click()`);
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
      await waitFor(
        async () => (await shared.call("daemon:status", [{ commands: true }])).desktopCommands?.some((command) => command.name === "desktop:app:version"),
        "desktop command capability registration",
      );
      const desktopVersion = await shared.call("desktop:invoke", [{ method: "app:version", args: [] }]);
      assert.equal(typeof desktopVersion, "string");
      const computers = await shared.call("computers:list");
      assert.ok(Array.isArray(computers.computers), "CLI can read the same saved computers as the native UI");
      assert.deepEqual(await evaluate("window.milagre.computers.list()"), computers, "Desktop and CLI share the daemon-owned computer list");
      console.log("PASS: native commands execute through the owning desktop handlers");
      // A window at most 1024 px wide (the CI runners' screens) collapses the sidebar. Its rail shows a Chat's initials
      // with one scope but Project avatars with several (the Chats home the source pass makes, a Link), and then no
      // Chat title is on the page. Expanded (once its button shows), the Chat's row shows its title.
      await shared.call("chat:patch", [project, 2, { title: "Updated from another device" }]);
      await waitFor(
        () =>
          evaluate(
            `(document.querySelector('[aria-label="Expand sidebar"]')?.click(), document.body?.textContent.includes("Updated from another device") && !document.body?.textContent.includes("Saved chat"))`,
          ),
        "shared client update in desktop",
      );
      if (process.env.MILAGRE_SCREENSHOT_DIR) {
        await fs.mkdir(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
        const shot = await connection.call("Page.captureScreenshot");
        await fs.writeFile(path.join(process.env.MILAGRE_SCREENSHOT_DIR, "shared-desktop.png"), Buffer.from(shot.data, "base64"));
      }
      await shared.call("chat:patch", [project, 2, { title: "Saved chat" }]);
      // Packaged apps intentionally ignore the fixture Chats home override.
      if (!expectTheme) {
        // Starting a draft in another Project must not disable an existing Chat's actions.
        const home = await shared.call("chats:ensure");
        const homeChat = Object.values(home.state.sessions)[0];
        await shared.call("chat:patch", [home.path, homeChat.id, { title: "Personal menu regression" }]);
        await shared.call("chat:git-note", [home.path + "#" + homeChat.id, "A saved conversation for scoped menu checks."]);
        await evaluate("window.milagre.openInboxChat(" + JSON.stringify(home.path + "#" + homeChat.id) + ")");
        await waitFor(() => evaluate('document.body.textContent.includes("A saved conversation for scoped menu checks.")'), "personal Chat opens");
        await evaluate(`document.querySelector('[aria-label="New chat"]').click()`);
        await waitFor(() => evaluate('!!document.querySelector("[data-new-chat-heading]")'), "new Chat draft opens in the real Project");
        // A window at most 1024 px wide (the CI macOS runner's screen) collapses the sidebar, whose rail shows only the
        // open Project's Chats. Expanded, the personal Chat has its own row.
        await evaluate(`document.querySelector('[aria-label="Expand sidebar"]')?.click()`);
        // The open Project has Chats with the same numbers, so the row is the one with this id and this title.
        const personalRow =
          "[...document.querySelectorAll('[data-chat-id=\"" + homeChat.id + '"]\')].find((row) => row.textContent.includes("Personal menu regression"))';
        await waitFor(() => evaluate("!!(" + personalRow + ")"), "personal Chat stays in the sidebar");
        await evaluate("(" + personalRow + ').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 180, clientY: 260 }))');
        await waitFor(() => evaluate('!!document.querySelector("[data-chat-menu]")'), "personal Chat menu from the new draft");
        const menu = await evaluate(
          '[...document.querySelectorAll("[data-chat-menu] [role=menuitem]")].map(row => ({ label: row.textContent, disabled: row.disabled }))',
        );
        for (const label of ["Rename chat", "Reload chat", "Mark as unread", "Pin", "Delete"])
          assert.equal(menu.find((row) => row.label === label)?.disabled, false, label + " remains available outside the open Project");
        assert.ok(!menu.some((row) => /Archive/.test(row.label)), "the menu offers Delete");
        await evaluate('[...document.querySelectorAll("[data-chat-menu] [role=menuitem]")].find(row => row.textContent === "Mark as unread").click()');
        await waitFor(
          async () => (await shared.call("project:read", [home.path])).state.sessions[homeChat.id]?.unread === true,
          "unread targets the personal Chat",
        );
        assert.notEqual((await shared.call("project:read", [project])).state.sessions[2]?.unread, true, "the draft Project's Chat stays read");
        await evaluate("(" + personalRow + ').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 180, clientY: 260 }))');
        await waitFor(() => evaluate('!!document.querySelector("[data-chat-menu]")'), "reopen personal Chat actions");
        await evaluate('[...document.querySelectorAll("[data-chat-menu] [role=menuitem]")].find(row => row.textContent === "Delete").click()');
        await waitFor(
          async () => (await shared.call("project:read", [home.path])).state.sessions[homeChat.id] === undefined,
          "Delete removes the personal conversation",
        );
        await evaluate("window.milagre.openInboxChat(" + JSON.stringify(project + "#2") + ")");
        console.log("PASS: new Chat drafts keep other Chats and their actions available; Delete removes the saved conversation");
      }
    } finally {
      shared.close();
    }
    if (expectTheme)
      assert.equal(await evaluate('document.documentElement.classList.contains("dark")'), true, "Existing UI settings survive a restart/package change");
    await evaluate(
      'window.milagrePreferences.set("milagre-settings", JSON.stringify({theme:"dark",defaultPermissionMode:"ask",notifyWhenWaiting:false,notifyOnCompletion:false,showDockBadge:false}));',
    );
    await connection.call("Page.reload");
    await waitFor(() => evaluate('document.documentElement?.classList.contains("dark")'), "saved theme after reload");
    await evaluate(
      'window.milagrePreferences.set("milagre.composer-preferences", JSON.stringify({"fixture-chat":{effort:"high",fastMode:true}})); localStorage.clear();',
    );
    await connection.call("Page.reload");
    await waitFor(() => evaluate('document.documentElement?.classList.contains("dark")'), "native theme restored without origin storage");
    const durable = JSON.parse(await fs.readFile(path.join(profile, "preferences.json"), "utf8"));
    assert.equal(JSON.parse(durable["milagre-settings"]).theme, "dark");
    assert.equal(JSON.parse(durable["milagre.composer-preferences"])["fixture-chat"].fastMode, true);
    console.log("PASS: theme and composer preferences survive loss of Chromium origin storage");
    // The reloads mount a fresh sidebar, collapsed again on a narrow screen (see "shared client update in desktop"); it
    // is expanded once its button shows.
    await waitFor(
      () =>
        evaluate(
          `(document.querySelector('[aria-label="Expand sidebar"]')?.click(), document.body?.textContent.includes("Saved chat") && !document.querySelector(".startup-splash-screen"))`,
        ),
      "saved Chat visible after reload",
    );
    if (process.env.MILAGRE_SCREENSHOT_DIR) {
      await fs.mkdir(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
      const shot = await connection.call("Page.captureScreenshot");
      await fs.writeFile(path.join(process.env.MILAGRE_SCREENSHOT_DIR, expectTheme ? "packaged-desktop.png" : "desktop.png"), Buffer.from(shot.data, "base64"));
    }
    // The tall composer's canvas estimate can call a draft short enough for one line when the compact prompt just
    // wrapped it. Acting on it flipped the layout on every commit until React stopped (error #185) and unmounted the
    // window, which the slow macOS runner hit. Skew the estimate and check the composer settles tall.
    await evaluate(`(() => {
      const measure = (window.__measureText = CanvasRenderingContext2D.prototype.measureText);
      CanvasRenderingContext2D.prototype.measureText = function (text) { return { width: measure.call(this, text).width / 2 }; };
      const input = document.querySelector('[data-prompt-editor]');
      if (!input) throw new Error('Prompt missing');
      input.value = 'A draft long enough that the compact prompt has to wrap it onto a second line, while the estimate says it fits';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await waitFor(() => evaluate(`document.querySelector('[data-prompt-editor]')?.className.includes('min-h-[68px]')`), "tall composer for a wrapped draft");
    await delay(200);
    assert.equal(await evaluate(`document.querySelector('[data-prompt-editor]').className.includes('min-h-[68px]')`), true, "the composer stays tall");
    await evaluate("(CanvasRenderingContext2D.prototype.measureText = window.__measureText, true)");
    await evaluate(`(() => {
      const input = document.querySelector('[data-prompt-editor]');
      if (!input) throw new Error('Prompt missing');
      input.value = 'Keep this unsent draft';
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
    assert.equal(await evaluate("document.querySelector('[data-prompt-editor]').value"), "Keep this unsent draft");
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
    assert.equal(await evaluate("document.querySelector('[data-prompt-editor]').value"), "Keep this unsent draft");
    if (process.env.MILAGRE_SCREENSHOT_DIR) {
      const shot = await connection.call("Page.captureScreenshot");
      await fs.writeFile(path.join(process.env.MILAGRE_SCREENSHOT_DIR, "host-restarted.png"), Buffer.from(shot.data, "base64"));
    }
    console.log("PASS: a host that crashed is started again, the window says so, and the draft stays");
    if (!expectTheme) {
      await evaluate(`(() => {
        window.milagrePreferences.set("milagre-settings", JSON.stringify({ ...JSON.parse(window.milagrePreferences.get("milagre-settings").value || "{}"), chatList: "grouped" }));
        window.dispatchEvent(new StorageEvent("storage", { key: "milagre-settings" }));
      })()`);
      const second = await fs.mkdtemp(path.join(path.dirname(project), "removal-member-"));
      const linkId = await evaluate(`(async () => {
        await window.milagre.openProjectAt(${JSON.stringify(second)});
        const registered = await window.milagre.listProjects();
        const ids = [${JSON.stringify(project)}, ${JSON.stringify(second)}].map((path) => registered.find((entry) => entry.path === path).id);
        const link = await window.milagre.createNamedLink({ name: "Removal regression Link", projectIds: ids });
        await window.milagre.forgetProject(${JSON.stringify(second)});
        window.dispatchEvent(new Event("milagre:recent-projects-changed"));
        return link.id;
      })()`);
      // A window at most 1024 px wide (the CI macOS runner's screen) starts with the sidebar collapsed, and a collapsed
      // sidebar lists no scopes. The chooser below mounts a fresh sidebar, so it is expanded again there.
      const expandSidebar = () => evaluate(`document.querySelector('[aria-label="Expand sidebar"]')?.click()`);
      await expandSidebar();
      await waitFor(() => evaluate(`!!document.querySelector('[data-sidebar-scope="milagre-link:${linkId}"]')`), "remaining Link in sidebar");
      // CSS.escape: a Windows path's backslashes would otherwise escape the selector.
      await evaluate(`document.querySelector('[data-sidebar-scope=' + CSS.escape(${JSON.stringify(project)}) + '] [data-scope-menu]').click()`);
      await waitFor(() => evaluate(`!!document.querySelector('[data-scope-menu-item="remove"]')`), "Project removal menu");
      await evaluate(`document.querySelector('[data-scope-menu-item="remove"]').click()`);
      await waitFor(() => evaluate(`!!document.querySelector('[data-project-remove-confirm]')`), "Project removal confirmation");
      await evaluate(`(() => {
        window.milagrePreferences.set("milagre-settings", JSON.stringify({ ...JSON.parse(window.milagrePreferences.get("milagre-settings").value || "{}"), chatList: "list" }));
        window.dispatchEvent(new StorageEvent("storage", { key: "milagre-settings" }));
      })()`);
      await evaluate(`document.querySelector('[data-project-remove-confirm]').click()`);
      await waitFor(() => evaluate(`!!document.querySelector('[data-project-chooser]')`), "Project chooser after last local Project removal");
      assert.equal(await evaluate(`!!document.querySelector('[data-onboarding]')`), false);
      await expandSidebar();
      await waitFor(
        () => evaluate(`!!document.querySelector('[data-sidebar-scope="milagre-link:${linkId}"] [data-scope-action]')`),
        "remaining Link is accessible",
      );
      await evaluate(`document.querySelector('[data-sidebar-scope="milagre-link:${linkId}"] [data-scope-action]').click()`);
      await waitFor(
        () => evaluate(`!document.querySelector('[data-project-chooser]') && !!document.querySelector('[data-chat-pane] [data-prompt-editor]')`),
        "remaining Link opens",
      );
      console.log("PASS: removing the last local Project keeps its Named Link accessible and opens it");
      // The packaged and ownership passes below share this profile and expect it as it was: the Project back, open and
      // current, and no Link (a collapsed sidebar lists Chats only while this Mac has a single scope).
      await evaluate(`(async () => {
        await window.milagre.openProjectAt(${JSON.stringify(project)});
        const link = (await window.milagre.listNamedLinks()).find((entry) => entry.id === ${JSON.stringify(linkId)});
        await window.milagre.updateNamedLink({ id: link.id, name: link.name, projectIds: link.projectIds, hidden: true });
      })()`);
      await waitFor(
        () =>
          evaluate(
            `window.milagre.getCurrentProject().then((current) => current?.path === ${JSON.stringify(project)} && !!document.querySelector('[data-chat-pane] [data-prompt-editor]'))`,
          ),
        "Project opened again after its removal",
      );
    }
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
          expression:
            "(async () => JSON.stringify({url:location.href,body:document.body?.textContent,bridge:typeof window.milagre,connection:await window.milagre?.getRuntimeConnection()}))()",
          awaitPromise: true,
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
    // Quit the way a user does. On Windows child.kill() is TerminateProcess: Chromium never flushes localStorage,
    // so the packaged run read the source run's stale settings (light theme, Floating inbox still on).
    if (child.exitCode === null) await connection?.call("Runtime.evaluate", { expression: "void window.milagre?.retryQuit()" }).catch(() => {});
    connection?.close();
    const terminate = setTimeout(() => {
      console.error("Desktop did not quit within 10 s; terminating it");
      child.kill("SIGTERM");
    }, 10000);
    const timeout = setTimeout(() => child.kill("SIGKILL"), 20000);
    await exited;
    clearTimeout(terminate);
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
  if (process.env.MILAGRE_SCREENSHOT_DIR) await fs.mkdir(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
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
    const freshFolder = path.join(temporary, "empty-folder");
    const plainFolder = path.join(temporary, "notes");
    await fs.mkdir(freshFolder);
    await fs.mkdir(plainFolder);
    await fs.writeFile(path.join(plainFolder, "todo.md"), "- milk\n");
    const claudeHome = path.join(temporary, "claude-home");
    await fs.mkdir(path.join(claudeHome, "projects", "-notes"), { recursive: true });
    await fs.writeFile(path.join(claudeHome, "projects", "-notes", "session.jsonl"), `${JSON.stringify({ type: "user", cwd: plainFolder })}\n`);
    await checkApp({
      executable: require("electron"),
      args: [path.join(root, "apps/desktop")],
      profile: path.join(temporary, "fresh-profile"),
      project: freshFolder,
      onboarding: { claudeHome, codexHome: path.join(temporary, "codex-home"), plainFolder },
    });
    await checkApp({ executable: require("electron"), args: [path.join(root, "apps/desktop")], profile, project, expectTheme: false });
    await checkDesignRaster({ executable: require("electron"), raster: path.join(root, "packages/core/src/design-raster.cjs"), label: "source" });
    const packagedIndex = process.argv.indexOf("--packaged");
    if (packagedIndex !== -1) {
      assert.ok(process.argv[packagedIndex + 1], "Pass the packaged application path after --packaged");
      const executable = await packagedExecutable(process.argv[packagedIndex + 1]);
      await checkApp({ executable, args: [], profile, project, expectTheme: true });
      await checkDesignRaster({ executable, raster: packagedRaster(executable), label: "packaged" });
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
