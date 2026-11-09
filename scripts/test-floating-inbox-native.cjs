// Real main process and renderer: native panel activation, hover IPC and saved placement.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn, execFileSync } = require("node:child_process");
const { once } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");
const { pathToFileURL } = require("node:url");
const root = path.resolve(__dirname, "..");
async function waitFor(read, label) {
  for (let i = 0; i < 400; i++) {
    if (await read()) return;
    await delay(50);
  }
  throw new Error("Timed out: " + label);
}
/** Resolves once two reads 100 ms apart agree: a native window has stopped moving. */
async function settled(read, label) {
  let last = await read();
  for (let i = 0; i < 100; i++) {
    await delay(100);
    const next = await read();
    if (next === last) return;
    last = next;
  }
  throw new Error("Never settled: " + label);
}
async function nativeChecks() {
  const { app, BrowserWindow, screen } = require("electron");
  const profile = process.argv[2],
    project = process.argv[3];
  app.setPath("userData", profile);
  process.env.MILAGRE_DEV_SERVER_URL = pathToFileURL(path.join(root, "apps/desktop/dist/index.html")).href;
  // oxlint-disable-next-line import/no-unassigned-import -- launches the real app's main process
  require("../apps/desktop/electron/main.cjs");
  const view = (name) => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes("floating-inbox=" + name));
  let main;
  await waitFor(async () => {
    main = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL() === process.env.MILAGRE_DEV_SERVER_URL);
    return main && (await main.webContents.executeJavaScript('document.body?.textContent.includes("Saved chat")'));
  }, "main app loaded");
  // A background macOS app cannot focus its panel until the app itself is active.
  if (process.platform === "darwin") app.focus({ steal: true });
  main.focus();
  await waitFor(() => main.isFocused(), "main app focused");
  main.hide();
  await main.webContents.executeJavaScript("window.milagre.setFloatingInbox(true)");
  await waitFor(
    async () => view("dock") && (await view("dock").webContents.executeJavaScript('!!document.querySelector("[data-floating-drag]")')),
    "dock loaded",
  );
  await waitFor(
    async () => view("inbox") && (await view("inbox").webContents.executeJavaScript('!!document.querySelector("[data-inbox-panel]")')),
    "inbox loaded",
  );
  const dock = view("dock"),
    inbox = view("inbox");
  assert.equal(dock.hasShadow(), false);
  assert.equal(inbox.hasShadow(), false);
  await dock.webContents.executeJavaScript("window.milagre.toggleFloatingInbox()");
  await waitFor(() => inbox.isVisible(), "inbox visible");
  assert.equal(main.isVisible(), false, "opening the panel leaves the main window hidden");
  inbox.focus();
  await waitFor(() => inbox.isFocused(), "inbox focused");
  assert.equal(main.isVisible(), false, "focusing the panel leaves the main window hidden");
  if (process.platform === "darwin") {
    app.emit("activate");
    assert.equal(main.isVisible(), false, "activation from the focused panel does not show main");
  }
  inbox.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  inbox.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  await waitFor(() => !inbox.isVisible(), "Escape closes the focused native inbox");
  assert.equal(main.isVisible(), false);
  await dock.webContents.executeJavaScript("window.milagre.closeFloatingInbox()");
  await main.webContents.executeJavaScript(`window.milagre.patchChat(${JSON.stringify(project)},2,{unread:true})`);
  await waitFor(async () => await dock.webContents.executeJavaScript('!!document.querySelector("[data-inbox-agent]")'), "live Chat indicator");
  await dock.webContents.executeJavaScript('document.querySelector("[data-inbox-agent]").dispatchEvent(new MouseEvent("mouseover",{bubbles:true}))');
  await waitFor(
    async () =>
      view("preview") &&
      (await view("preview").webContents.executeJavaScript('document.querySelector("[data-inbox-preview]")?.textContent.includes("Saved chat")')),
    "hover card from real IPC",
  );
  const preview = view("preview");
  assert.equal(preview.isVisible(), true);
  assert.equal(main.isVisible(), false);
  assert.equal(preview.hasShadow(), false);
  assert.equal(await preview.webContents.executeJavaScript('getComputedStyle(document.querySelector("[data-inbox-preview]")).borderTopWidth'), "0px");
  if (process.env.MILAGRE_SCREENSHOT_DIR) {
    await delay(200); // Let the first native frame paint before capture.
    await fs.mkdir(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
    await fs.writeFile(path.join(process.env.MILAGRE_SCREENSHOT_DIR, "native-hover.png"), (await preview.webContents.capturePage()).toPNG());
  }
  await dock.webContents.executeJavaScript('document.querySelector("[data-inbox-agent]").dispatchEvent(new MouseEvent("mouseout",{bubbles:true}))');
  assert.equal(preview.isVisible(), false);
  await dock.webContents.executeJavaScript('document.querySelector("[data-floating-bar]").dispatchEvent(new MouseEvent("mouseout",{bubbles:true}))');
  await delay(450);
  assert.equal(await dock.webContents.executeJavaScript('document.querySelector("[data-floating-bar]").dataset.expanded'), "false");
  const collapsedHeight = dock.getBounds().height;
  await dock.webContents.executeJavaScript('document.querySelector("[data-inbox-agent]").click()');
  await waitFor(() => inbox.isVisible(), "dot opens the inbox page");
  await waitFor(
    async () => (await inbox.webContents.executeJavaScript('document.querySelector("[data-inbox-item]")?.dataset.inboxItem')) === project + "#2",
    "dot selects the matching Chat",
  );
  assert.equal(main.isVisible(), false, "dot opens the page without opening desktop");
  await dock.webContents.executeJavaScript('document.querySelector("[data-floating-bar]").dispatchEvent(new MouseEvent("mouseout",{bubbles:true}))');
  await delay(450);
  assert.equal(
    await dock.webContents.executeJavaScript('document.querySelector("[data-floating-bar]").dataset.expanded'),
    "true",
    "open inbox keeps the dock expanded",
  );
  assert.equal(dock.getBounds().height, collapsedHeight + 90);
  if (process.env.MILAGRE_SCREENSHOT_DIR) {
    await fs.writeFile(path.join(process.env.MILAGRE_SCREENSHOT_DIR, "native-inbox-populated.png"), (await inbox.webContents.capturePage()).toPNG());
  }
  inbox.webContents.sendInputEvent({ type: "keyDown", keyCode: "D", modifiers: [process.platform === "darwin" ? "meta" : "control"] });
  inbox.webContents.sendInputEvent({ type: "keyUp", keyCode: "D", modifiers: [process.platform === "darwin" ? "meta" : "control"] });
  await waitFor(() => !inbox.isVisible(), "Cmd/Ctrl+D closes the focused native inbox");
  await delay(250);
  assert.equal(await dock.webContents.executeJavaScript('document.querySelector("[data-floating-bar]").dataset.expanded'), "false");
  await dock.webContents.executeJavaScript("window.milagre.closeFloatingInbox()");
  const area = screen.getPrimaryDisplay().workArea;
  let cursor = screen.getCursorScreenPoint();
  screen.getCursorScreenPoint = () => cursor;
  const startDrag = async () => {
    await dock.webContents.executeJavaScript('document.querySelector("[data-floating-bar]").dispatchEvent(new MouseEvent("mouseover",{bubbles:true}))');
    await waitFor(
      async () => (await dock.webContents.executeJavaScript('document.querySelector("[data-floating-bar]").dataset.expanded')) === "true",
      "hover expands grip",
    );
    await delay(100);
    const grip = await dock.webContents.executeJavaScript(
      '(()=>{const b=document.querySelector("[data-floating-drag]").getBoundingClientRect();return {x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}})()',
    );
    cursor = { x: dock.getBounds().x + grip.x, y: dock.getBounds().y + grip.y };
    dock.webContents.sendInputEvent({ type: "mouseMove", ...grip });
    dock.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...grip });
    await waitFor(
      async () =>
        view("drag") &&
        view("drag").isVisible() &&
        (await view("drag").webContents.executeJavaScript('document.querySelectorAll("[data-snap-target]").length === 3')),
      "pointer down shows native blur and three targets",
    );
  };
  const drop = async (point) => {
    cursor = point;
    dock.webContents.sendInputEvent({ type: "mouseMove", x: 20, y: 30 });
    await delay(50);
    dock.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, x: 20, y: 30 });
    await waitFor(() => !view("drag").isVisible(), "release hides drag overlay");
    await delay(1200);
  };
  const original = dock.getBounds();
  await startDrag();
  assert.ok(collapsedHeight < 180, "idle native bar follows just its dots");
  assert.equal(dock.getBounds().height, 70, "dragging uses a compact native window");
  assert.equal(await dock.webContents.executeJavaScript('document.querySelectorAll("[data-inbox-agent]").length'), 0);
  const overlay = view("drag");
  assert.equal(main.isVisible(), false);
  const savedSettings = await dock.webContents.executeJavaScript('window.milagrePreferences.get("milagre-settings").value ?? null');
  try {
    for (const theme of ["light", "dark"]) {
      await dock.webContents.executeJavaScript(
        `(() => {
          const preferences = window.milagrePreferences;
          const result = preferences.set('milagre-settings', JSON.stringify({...JSON.parse(preferences.get('milagre-settings').value || '{}'),theme:${JSON.stringify(theme)}}));
          if (result.error) throw new Error(result.error);
          window.dispatchEvent(new StorageEvent('storage',{key:'milagre-settings'}));
        })()`,
      );
      await waitFor(
        async () => (await main.webContents.executeJavaScript('document.documentElement.classList.contains("dark")')) === (theme === "dark"),
        "native preference change reaches the main window",
      );
      const persisted = JSON.parse(await fs.readFile(path.join(profile, "preferences.json"), "utf8"));
      assert.equal(JSON.parse(persisted["milagre-settings"]).theme, theme, "the floating window saves its theme in native preferences");
      for (const window of [dock, inbox, preview, overlay]) {
        if (window !== overlay)
          await waitFor(
            async () => (await window.webContents.executeJavaScript('document.documentElement.classList.contains("dark")')) === (theme === "dark"),
            "floating theme updated",
          );
        assert.deepEqual(
          await window.webContents.executeJavaScript(
            '[document.documentElement,document.body,document.getElementById("root")].map(element=>[getComputedStyle(element).backgroundColor,getComputedStyle(element).backgroundImage])',
          ),
          Array.from({ length: 3 }, () => ["rgba(0, 0, 0, 0)", "none"]),
          `${window.webContents.getURL()} stays transparent in ${theme} mode`,
        );
      }
    }
  } finally {
    await dock.webContents.executeJavaScript(
      `(() => {
        const result = window.milagrePreferences.set("milagre-settings",${JSON.stringify(savedSettings)});
        if (result.error) throw new Error(result.error);
        window.dispatchEvent(new StorageEvent('storage',{key:'milagre-settings'}));
      })()`,
    );
  }
  if (process.env.MILAGRE_SCREENSHOT_DIR) {
    await delay(200);
    await fs.writeFile(path.join(process.env.MILAGRE_SCREENSHOT_DIR, "native-drag-targets.png"), (await overlay.webContents.capturePage()).toPNG());
  }
  await drop({ x: area.x + area.width / 2, y: area.y + area.height / 3 });
  assert.equal(dock.getBounds().x, original.x, "missing all targets springs back to the previous edge");
  assert.ok(Math.abs(dock.getBounds().y + dock.getBounds().height / 2 - original.y - original.height / 2) <= 1, "the previous snap center is restored");
  await startDrag();
  await drop({ x: area.x + 25, y: area.y + area.height / 2 });
  await waitFor(async () => {
    try {
      return JSON.parse(await fs.readFile(path.join(profile, "floating-inbox-position.json"), "utf8")).edge === "left";
    } catch {
      return false;
    }
  }, "drag position saved");
  assert.equal(dock.getBounds().x, area.x, "left bar touches the screen edge");
  await dock.webContents.executeJavaScript("window.milagre.toggleFloatingInbox()");
  assert.ok(inbox.getBounds().x > dock.getBounds().x, "left-hand bar opens inbox to its right");
  assert.equal(main.isVisible(), false);
  await dock.webContents.executeJavaScript("window.milagre.closeFloatingInbox()");
  await startDrag();
  await drop({ x: area.x + area.width / 2, y: area.y + area.height - 54 });
  await waitFor(
    async () =>
      dock.getBounds().width > dock.getBounds().height &&
      (await dock.webContents.executeJavaScript('document.querySelector("[data-floating-bar]")?.dataset.placement === "bottom"')),
    "bottom snap rotates the native bar and renderer",
  );
  const bottom = dock.getBounds();
  assert.equal(bottom.y + bottom.height, area.y + area.height, "bottom bar touches its edge");
  assert.ok(Math.abs(bottom.x + bottom.width / 2 - (area.x + area.width / 2)) <= 1);
  await dock.webContents.executeJavaScript("window.milagre.toggleFloatingInbox()");
  assert.ok(inbox.getBounds().y + inbox.getBounds().height < bottom.y, "bottom inbox opens above the bar");
  assert.equal(main.isVisible(), false);
  if (process.env.MILAGRE_SCREENSHOT_DIR) {
    await delay(200);
    await fs.writeFile(path.join(process.env.MILAGRE_SCREENSHOT_DIR, "native-bottom.png"), (await dock.webContents.capturePage()).toPNG());
  }
  await dock.webContents.executeJavaScript("window.milagre.closeFloatingInbox()");
  // Closing collapses the bar over 180 ms. On a slow runner the hover used to land mid-collapse and the preview never
  // showed (CI timed out here), so wait for the dock to come to rest, then hover again until the preview is up.
  await settled(() => JSON.stringify(dock.getBounds()), "dock after closing the inbox");
  const agentMouse = (type) =>
    dock.webContents.executeJavaScript(`document.querySelector("[data-inbox-agent]").dispatchEvent(new MouseEvent(${JSON.stringify(type)},{bubbles:true}))`);
  for (let attempt = 0; !preview.isVisible(); attempt++) {
    if (attempt === 10) throw new Error("Timed out: bottom hover preview");
    if (attempt) await agentMouse("mouseout");
    await agentMouse("mouseover");
    for (let i = 0; i < 40 && !preview.isVisible(); i++) await delay(50);
  }
  assert.ok(preview.getBounds().y + preview.getBounds().height < bottom.y, "bottom tooltip opens above the bar");
  await dock.webContents.executeJavaScript('document.querySelector("[data-inbox-agent]").dispatchEvent(new MouseEvent("mouseout",{bubbles:true}))');
  await dock.webContents.executeJavaScript("window.milagre.toggleFloatingInbox()");
  main.close();
  assert.equal(main.isDestroyed(), false, "closing desktop keeps its renderer available while the floating inbox is enabled");
  assert.equal(main.isVisible(), false);
  await inbox.webContents.executeJavaScript(`window.milagre.openInboxChat(${JSON.stringify(project + "#2")})`);
  await waitFor(() => main.isVisible(), "Open Chat brings main forward");
  console.log("PASS: native shadow disabled, inbox stays independent of main, real hover preview, saved position and Open Chat routing");
  app.exit(0);
}
async function stopHost(profile) {
  try {
    const client = await require("@milagre/daemon/client").connect({ dataDir: profile });
    await client.call("daemon:stop");
    client.close();
  } catch (error) {
    if (!["ENOENT", "ECONNREFUSED", "ECONNRESET"].includes(error.code)) throw error;
  }
}
async function main() {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-inbox-native-")));
  const profile = path.join(temporary, "profile"),
    project = path.join(temporary, "project");
  await fs.mkdir(path.join(project, ".milagre"), { recursive: true });
  await fs.mkdir(profile);
  execFileSync("git", ["init", "-b", "main", project], { stdio: "ignore" });
  execFileSync("git", ["-C", project, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "fixture"], {
    stdio: "ignore",
  });
  await fs.writeFile(
    path.join(project, ".milagre/coordination.json"),
    JSON.stringify({
      next_id: 4,
      projects: { 1: { id: 1, name: "project" } },
      worktrees: { 1: { id: 1, project_id: 1, path: project, name: "main" } },
      sessions: { 2: { id: 2, worktree_id: 1, agent_name: "main", title: "Saved chat", status: "Stopped", provider: "codex" } },
      messages: [{ id: 3, session_id: 2, role: "assistant", body: "The floating inbox is ready to review.", outcome: "completed", context: null }],
      connections: {},
      events: [],
      approvals: [],
      tasks: {},
      artifacts: {},
      outputs: [],
      conflicts: [],
    }),
  );
  await fs.writeFile(path.join(profile, "recent-projects.json"), JSON.stringify([{ path: project, name: "project", openedAt: new Date().toISOString() }]));
  const env = { ...process.env, MILAGRE_CHATS_HOME: path.join(temporary, "chats-home") };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const child = spawn(require("electron"), [__filename, profile, project], { cwd: project, env, stdio: "inherit" });
    const [code] = await once(child, "exit");
    assert.equal(code, 0);
  } finally {
    await stopHost(profile);
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}
(process.versions.electron ? nativeChecks() : main()).catch((error) => {
  console.error(error);
  if (process.versions.electron) require("electron").app.exit(1);
  else process.exitCode = 1;
});
