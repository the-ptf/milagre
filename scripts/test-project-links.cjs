// Real main/preload/renderer and daemon against temporary Git repositories.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const { once } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");
const { pathToFileURL } = require("node:url");
const { startDaemon } = require("@milagre/daemon/server");
const { connect: connectHost } = require("@milagre/daemon/client");
const root = path.resolve(__dirname, "..");
async function waitFor(read, description) {
  for (let i = 0; i < 400; i++) {
    const value = await read();
    if (value) return value;
    await delay(50);
  }
  throw new Error(`Timed out: ${description}`);
}
async function cdp(url) {
  const socket = new WebSocket(url);
  await once(socket, "open");
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const response = JSON.parse(data),
      request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    clearTimeout(request.timer);
    // oxlint-disable-next-line no-unused-expressions -- directive or optional call used for its side effect; nothing to assign
    response.error ? request.reject(new Error(response.error.message)) : request.resolve(response.result);
  });
  return {
    close: () => socket.close(),
    call(method, params = {}) {
      return new Promise((resolve, reject) => {
        const requestId = ++id;
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error(`Timed out: ${method}`));
        }, 20000);
        pending.set(requestId, { resolve, reject, timer });
        socket.send(JSON.stringify({ id: requestId, method, params }));
      });
    },
  };
}
async function main() {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-project-links-")));
  const profile = path.join(dir, "profile"),
    worktreeRoot = path.join(dir, "worktrees");
  const projects = [];
  for (const name of ["food-api", "food-web"]) {
    const folder = path.join(dir, name);
    projects.push(folder);
    await fs.mkdir(folder);
    execFileSync("git", ["init", "-qb", "main", folder]);
    await fs.writeFile(path.join(folder, "status.txt"), "Original\n");
    for (let index = 0; index < 12; index++) await fs.writeFile(path.join(folder, `a-${String(index).padStart(2, "0")}.bin`), Buffer.from([0, 0]));
    execFileSync("git", ["-C", folder, "add", "."]);
    execFileSync("git", ["-C", folder, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "Fixture"]);
  }
  let providerCalls = 0;
  const options = {
    cwd: projects[0],
    registryRoots: [],
    worktreeRoot,
    environmentReady: Promise.resolve(),
    titleModels: {},
    agentCli: async () => ({ command: "/fake" }),
    createSession: (provider, context) => ({
      turnActive: false,
      async startTurn() {
        providerCalls++;
        assert.equal(context.workspaceRoots.length, 2);
        for (const member of context.workspaceRoots) await fs.writeFile(path.join(member, "status.txt"), "Shared edit\n");
        context.emit({ type: "session-started", nativeId: "shared-session" });
        context.emit({ type: "turn-started", turnId: "turn" });
        context.emit({ type: "text-delta", messageId: `reply-${providerCalls}`, text: "Updated status.txt in both owned Worktrees." });
        context.emit({ type: "turn-completed" });
        return { turnId: "turn" };
      },
      close() {},
      interrupt() {},
    }),
  };
  let daemon, client, child, connection, evaluate;
  let output = "";
  const shot = async (name) => {
    if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
    await fs.mkdir(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
    await delay(200);
    const image = await connection.call("Page.captureScreenshot");
    await fs.writeFile(path.join(process.env.MILAGRE_SCREENSHOT_DIR, name + ".png"), Buffer.from(image.data, "base64"));
  };
  try {
    daemon = await startDaemon({ dataDir: profile, version: "0.1.0", runtimeOptions: options });
    client = await connectHost({ dataDir: profile });
    for (const project of projects) await client.call("project:open", [project]);
    await client.call("project:open", [projects[0]]);
    const rendererUrl = process.env.MILAGRE_TEST_DEV_SERVER_URL || pathToFileURL(path.join(root, "apps/desktop/dist/index.html")).href;
    const env = { ...process.env, MILAGRE_DEV_SERVER_URL: rendererUrl, MILAGRE_WORKTREE_ROOT: worktreeRoot };
    delete env.ELECTRON_RUN_AS_NODE;
    // Other windows on a busy machine cover this one; macOS then pauses its animation frames and the canvas and panels never finish.
    const unthrottled = ["--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--disable-features=CalculateNativeWinOcclusion"];
    child = spawn(require("electron"), [path.join(root, "apps/desktop"), `--user-data-dir=${profile}`, "--remote-debugging-port=0", ...unthrottled], {
      cwd: projects[0],
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (data) => {
        output = (output + data).slice(-20000);
      });
    const port = await waitFor(() => {
      assert.equal(child.exitCode, null, output);
      return output.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/)?.[1];
    }, "Electron debugger");
    const page = await waitFor(
      async () => (await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())).find((page) => page.type === "page" && page.url === rendererUrl),
      "real desktop page",
    );
    connection = await cdp(page.webSocketDebuggerUrl);
    evaluate = async (expression) => {
      const result = await connection.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const click = (text) => evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(text)}).click()`);
    const input = (selector, value) =>
      evaluate(
        `(() => {const input = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', {bubbles:true})); })()`,
      );
    const linkProjects = () => evaluate(`document.querySelector('[data-link-projects]').click()`);
    const scopeOf = (name) => `[data-sidebar-scope][aria-label=${JSON.stringify(name)}]`;
    const linkScope = `[data-sidebar-scope^="milagre-link:"]`;
    const isCurrent = (selector) => evaluate(`!!document.querySelector(${JSON.stringify(selector + "[data-current]")})`);
    // "New chat in <name>" on a group switches the sidebar to that Project or Link, restoring its unsent draft.
    const openScope = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector + " [data-scope-action]")}).click()`);
    const scopeMenu = async (selector) => {
      await evaluate(`document.querySelector(${JSON.stringify(selector + " [data-scope-menu]")}).click()`);
      await waitFor(() => evaluate(`!!document.querySelector('[data-scope-menu-panel]')`), "scope menu");
    };
    const closeScopeMenu = async () => {
      await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      await waitFor(() => evaluate(`!document.querySelector('[data-scope-menu-panel]')`), "scope menu closed");
    };
    await waitFor(() => evaluate(`!!document.querySelector('[data-link-projects]') && !document.querySelector('.startup-splash-screen')`), "desktop ready");
    await waitFor(() => evaluate(`!!document.querySelector('[data-sidebar-scope][data-current] [data-scope-menu]')`), "Project group");
    await scopeMenu("[data-sidebar-scope][data-current]");
    assert.ok(await evaluate(`!!document.querySelector('[data-scope-menu-item="copy-path"]')`));
    assert.equal(await evaluate(`document.body.textContent.includes('Import project')`), false);
    await closeScopeMenu();
    await shot("project-selector");
    await linkProjects();
    await waitFor(
      () => evaluate(`!!document.querySelector('#link-name') && document.querySelectorAll('dialog input[type=checkbox]').length === 2`),
      "Link creation dialog",
    );
    const openingMotion = () =>
      evaluate(
        `document.querySelector('dialog').getAnimations().map(animation => ({ frames: animation.effect.getKeyframes(), duration: animation.effect.getTiming().duration }))`,
      );
    const normalMotion = await openingMotion();
    assert.ok(
      normalMotion.some(
        (animation) =>
          animation.frames.some((frame) => frame.transform && frame.transform !== "none") &&
          Number(animation.frames[0].opacity) < Number(animation.frames.at(-1).opacity),
      ),
      "Opening Link projects fades and scales the dialog into view",
    );
    await click("Cancel");
    await waitFor(() => evaluate(`!document.querySelector('#link-name')`), "Link dialog closed");
    await connection.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await linkProjects();
    await waitFor(
      () => evaluate(`!!document.querySelector('#link-name') && document.querySelectorAll('dialog input[type=checkbox]').length === 2`),
      "reduced-motion Link dialog",
    );
    const reducedMotion = await openingMotion();
    assert.ok(
      reducedMotion.some((animation) => Number(animation.frames[0].opacity) < Number(animation.frames.at(-1).opacity)),
      "Reduced motion keeps the opening fade",
    );
    assert.ok(
      reducedMotion.every((animation) => animation.frames.every((frame) => !frame.transform || frame.transform === "none")),
      "Reduced motion removes scale movement",
    );
    await click("Cancel");
    await waitFor(() => evaluate(`!document.querySelector('#link-name')`), "reduced-motion Link dialog closed");
    await connection.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
    await linkProjects();
    await waitFor(
      () => evaluate(`!!document.querySelector('#link-name') && document.querySelectorAll('dialog input[type=checkbox]').length === 2`),
      "Link dialog reopened",
    );
    assert.equal(
      await evaluate(`document.querySelectorAll('dialog input[type=checkbox]:checked').length`),
      0,
      "Opening Link projects leaves membership choices to the user",
    );
    assert.equal(await evaluate(`document.querySelector('dialog button[type=submit]').disabled`), true);
    await shot("create-link-empty");
    await input("#link-name", "RDFood");
    assert.equal(await evaluate(`document.querySelector('dialog button[type=submit]').disabled`), true);
    await evaluate(`document.querySelector('dialog input[type=checkbox]').click()`);
    assert.equal(await evaluate(`document.querySelectorAll('dialog input[type=checkbox]:checked').length`), 1);
    assert.equal(await evaluate(`document.querySelector('dialog button[type=submit]').disabled`), true, "One explicitly selected Project is insufficient");
    await input('input[aria-label="Search projects"]', "food-web");
    assert.equal(await evaluate(`document.querySelectorAll('dialog input[type=checkbox]').length`), 1);
    await evaluate(`document.querySelector('dialog input[type=checkbox]').click()`);
    await input('input[aria-label="Search projects"]', "");
    await shot("create-link");
    await click("Create Link");
    await waitFor(() => evaluate(`!!document.querySelector('${linkScope}[data-current]') && !document.querySelector('#link-name')`), "selected Link");
    assert.equal(providerCalls, 0);
    const links = await client.call("link:list");
    const link = links[0];
    assert.equal(links.length, 1);
    assert.equal(Object.keys((await client.call("link:snapshot", [link.id])).state.sessions).length, 0, "Draft allocates no Worktrees");
    await waitFor(() => evaluate(`document.body.textContent.includes('Links')`), "Links sidebar section");
    await scopeMenu(linkScope);
    assert.equal(await evaluate(`['reveal', 'copy-path', 'settings'].some((key) => !!document.querySelector('[data-scope-menu-item="' + key + '"]'))`), false);
    await shot("link-selector");
    await closeScopeMenu();
    await input('textarea[aria-label="Prompt"]', "Update status.txt across both Projects.");
    await evaluate(`document.querySelector('button[aria-label="Send"]').click()`);
    await waitFor(() => evaluate(`!!document.querySelector('dialog[open] #ai-consent-title')`), "AI sharing decision before Link send");
    assert.equal(providerCalls, 0, "No provider call before consent");
    assert.equal(Object.keys((await client.call("link:snapshot", [link.id])).state.sessions).length, 0, "Consent precedes Worktree allocation");
    await click("Allow sharing");
    await waitFor(() => evaluate(`document.body.textContent.includes('Updated status.txt in both owned Worktrees.')`), "one shared transcript");
    const state = (await client.call("link:snapshot", [link.id])).state,
      session = Object.values(state.sessions)[0];
    assert.equal(session.worktrees.length, 2);
    assert.equal(providerCalls, 1);
    assert.equal(state.messages.filter((message) => message.role === "assistant").length, 1);
    for (const project of projects) assert.equal(await fs.readFile(path.join(project, "status.txt"), "utf8"), "Original\n");
    for (const member of session.worktrees) assert.equal(await fs.readFile(path.join(member.worktreePath, "status.txt"), "utf8"), "Shared edit\n");
    assert.equal(await evaluate(`document.querySelector('[data-chat-pane]').textContent.includes('RDFood / Link')`), false);
    assert.ok(await evaluate(`document.body.textContent.includes('2 Worktrees')`));
    await shot("shared-chat");
    await input('textarea[aria-label="Prompt"]', "Keep my draft while viewing the linked Projects");
    await click("Canvas");
    await waitFor(() => evaluate(`!!document.querySelector('[data-canvas]')`), "Link canvas");
    assert.ok(await isCurrent(linkScope), "Canvas keeps the selected Link");
    await waitFor(
      () => evaluate(`document.querySelectorAll('[data-canvas-project]').length === 2 && !!document.querySelector('[data-named-link]')`),
      "both Link members and membership connection",
    );
    for (const project of projects)
      assert.ok(
        await evaluate(`!!document.querySelector('[data-canvas-project=' + CSS.escape(${JSON.stringify(project)}) + ']')`),
        "Each member Project is visible",
      );
    assert.equal(await evaluate(`document.querySelector('[data-named-link]').textContent`), "RDFood");
    assert.equal(
      await evaluate(`[...document.querySelectorAll('[data-canvas] button')].some(button => button.textContent === 'Remove Link')`),
      false,
      "Membership lines do not become removable Delegation edges",
    );
    await shot("link-canvas");
    await click("Back");
    assert.equal(await evaluate(`document.querySelector('textarea[aria-label="Prompt"]').value`), "Keep my draft while viewing the linked Projects");
    await click("Canvas");
    await waitFor(
      () => evaluate(`!![...document.querySelectorAll('[data-canvas-chat]')].find(button => button.textContent.includes('Shared Link Chat'))`),
      "canonical shared Chat in Canvas",
    );
    await evaluate(`[...document.querySelectorAll('[data-canvas-chat]')].find(button => button.textContent.includes('Shared Link Chat')).click()`);
    assert.equal(
      await evaluate(`document.querySelector('textarea[aria-label="Prompt"]').value`),
      "Keep my draft while viewing the linked Projects",
      "Opening the current shared Chat from a member keeps its draft",
    );
    await input('textarea[aria-label="Prompt"]', "");
    assert.ok(await evaluate(`!!document.querySelector('[data-changes-toggle]')`), "Shared Chats use the same right Changes toggle as Project Chats");
    await evaluate(`document.querySelector('[data-changes-toggle]').click()`);
    await waitFor(
      () => evaluate(`document.querySelectorAll('[data-link-changes-project] [data-diff-tree-file="status.txt"]').length === 2`),
      "changes in both owned Worktrees",
    );
    assert.equal(await evaluate(`Math.round(document.querySelector('[data-changes-panel]').getBoundingClientRect().width)`), 320);
    assert.equal(
      await evaluate(`document.querySelector('[data-changes-panel] [data-diff-counts="total"]').textContent`),
      "+2−2",
      "Totals include both Projects",
    );
    await shot("link-changes");
    const apiId = session.worktrees.find((member) => member.projectPath === projects[0]).projectId;
    const webId = session.worktrees.find((member) => member.projectPath === projects[1]).projectId;
    const group = (id) => `[data-link-changes-project=${JSON.stringify(id)}]`;
    await evaluate(`document.querySelector(${JSON.stringify(group(apiId) + " [data-project-collapse]")}).click()`);
    assert.equal(
      await evaluate(`document.querySelectorAll('[data-link-changes-project] [data-diff-tree-file]').length`),
      1,
      "Collapsing one Project preserves the other tree",
    );
    await evaluate(`document.querySelector(${JSON.stringify(group(apiId) + " [data-project-collapse]")}).click()`);
    const apiRoot = session.worktrees.find((member) => member.projectId === apiId).worktreePath;
    const webRoot = session.worktrees.find((member) => member.projectId === webId).worktreePath;
    for (const folder of [apiRoot, webRoot])
      for (let index = 0; index < 12; index++) await fs.writeFile(path.join(folder, `a-${String(index).padStart(2, "0")}.bin`), Buffer.from([0, 1]));
    await fs.writeFile(path.join(apiRoot, "status.txt"), "Only API changes\n");
    await fs.writeFile(path.join(webRoot, "status.txt"), "Only web changes\n");
    await evaluate(`document.querySelector('[data-diff-refresh]').click()`);
    await waitFor(
      () => evaluate(`document.querySelectorAll('[data-link-changes-project] [data-diff-tree-file]').length === 26`),
      "changed binary files precede the selected file in both members",
    );
    await evaluate(`document.querySelector(${JSON.stringify(group(apiId) + ' [data-diff-tree-file="status.txt"]')}).click()`);
    try {
      await waitFor(() => evaluate(`document.querySelector('[data-diff-view]')?.textContent.includes('Only API changes')`), "API diff uses API Worktree");
    } catch (error) {
      console.error(
        "Diff diagnostic:",
        await evaluate(
          `(() => { const view = document.querySelector('[data-diff-view]'); return { text: view?.textContent, scrollTop: view?.scrollTop, height: view?.clientHeight, scrollHeight: view?.scrollHeight, files: [...document.querySelectorAll('[data-diff-file]')].map(file => ({ path: file.dataset.diffFile, top: file.getBoundingClientRect().top })) }; })()`,
        ),
      );
      throw error;
    }
    assert.equal(await evaluate(`document.querySelector('[data-diff-view]').textContent.includes('Only web changes')`), false);
    assert.ok(
      await evaluate(
        `(() => { const view = document.querySelector('[data-diff-view]'); const file = view.querySelector('[data-diff-file="status.txt"]'); return view.scrollTop > 0 && file.getBoundingClientRect().top < view.getBoundingClientRect().bottom; })()`,
      ),
      "First selection scrolls to a file that arrives with the member list",
    );
    await evaluate(`document.querySelector(${JSON.stringify(group(webId) + ' [data-diff-tree-file="status.txt"]')}).click()`);
    await waitFor(
      () => evaluate(`document.querySelector('[data-diff-view]')?.textContent.includes('Only web changes')`),
      "same file name in web uses web Worktree",
    );
    assert.equal(await evaluate(`document.querySelector('[data-diff-view]').textContent.includes('Only API changes')`), false);
    assert.ok(
      await evaluate(
        `(() => { const view = document.querySelector('[data-diff-view]'); const file = view.querySelector('[data-diff-file="status.txt"]'); return view.scrollTop > 0 && file.getBoundingClientRect().top < view.getBoundingClientRect().bottom; })()`,
      ),
      "Changing members also scrolls to the selected file",
    );
    await evaluate(`document.querySelector('[data-diff-view]').scrollTop = 0`);
    await fs.writeFile(path.join(webRoot, "reading-position.txt"), "Refresh keeps the reading position\n");
    await evaluate(`document.querySelector('[data-diff-refresh-all]').click()`);
    await waitFor(
      () => evaluate(`!!document.querySelector('[data-diff-view] [data-diff-file="reading-position.txt"]')`),
      "diff list refreshed while reading another file",
    );
    await delay(150);
    assert.ok(
      await evaluate(`document.querySelector('[data-diff-view]').scrollTop < 5`),
      "Refresh preserves manual scrolling instead of repeating the last selection",
    );
    await fs.unlink(path.join(webRoot, "reading-position.txt"));
    for (const folder of [apiRoot, webRoot])
      for (let index = 0; index < 12; index++) await fs.writeFile(path.join(folder, `a-${String(index).padStart(2, "0")}.bin`), Buffer.from([0, 0]));
    await fs.writeFile(path.join(webRoot, "web-only.txt"), "Web-only file\n");
    await evaluate(`document.querySelector('[data-diff-refresh-all]').click()`);
    await waitFor(
      () =>
        evaluate(
          `!!document.querySelector(${JSON.stringify(group(webId) + ' [data-diff-tree-file="web-only.txt"]')}) && document.querySelectorAll('[data-link-changes-project] [data-diff-tree-file]').length === 3`,
        ),
      "diff toolbar refresh also updates grouped trees",
    );
    await shot("link-project-diff");
    await evaluate(`document.querySelector('[data-diff-back]').click()`);
    await evaluate(`document.querySelector('button[aria-label="Changes mode"]').click()`);
    await click("Committed");
    await waitFor(
      () =>
        evaluate(
          `document.querySelectorAll('[data-link-changes-project] [data-diff-tree-file]').length === 0 && document.querySelectorAll('[data-link-changes-project] [data-diff-base]').length === 2`,
        ),
      "each Project compares its own recorded base",
    );
    execFileSync("git", ["-C", apiRoot, "add", "status.txt"]);
    execFileSync("git", ["-C", apiRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "API-only fixture change"]);
    await evaluate(`document.querySelector('[data-diff-refresh]').click()`);
    await waitFor(
      () =>
        evaluate(
          `document.querySelectorAll('[data-link-changes-project] [data-diff-tree-file]').length === 1 && !!document.querySelector(${JSON.stringify(group(apiId) + ' [data-diff-tree-file="status.txt"]')})`,
        ),
      "refresh shows committed changes in the API only",
    );
    assert.equal(await evaluate(`document.querySelector('[data-changes-panel] [data-diff-counts="total"]').textContent`), "+1−1");
    await evaluate(`document.querySelector('button[aria-label="Changes mode"]').click()`);
    await click("Uncommitted");
    await waitFor(
      () =>
        evaluate(
          `!!document.querySelector(${JSON.stringify(group(webId) + ' [data-diff-tree-file="status.txt"]')}) && !document.querySelector(${JSON.stringify(group(apiId) + ' [data-diff-tree-file="status.txt"]')})`,
        ),
      "uncommitted mode excludes the committed member file",
    );
    await fs.rename(webRoot, webRoot + "-moved");
    try {
      await evaluate(`document.querySelector('[data-diff-refresh]').click()`);
      await waitFor(
        () => evaluate(`document.querySelector(${JSON.stringify(group(webId))}).textContent.includes("isn't one of the open project's chats")`),
        "an unavailable Worktree has its own notice",
      );
      assert.ok(
        await evaluate(`document.querySelector(${JSON.stringify(group(apiId))}).textContent.includes('No uncommitted changes')`),
        "One member error leaves the other Project readable",
      );
    } finally {
      await fs.rename(webRoot + "-moved", webRoot);
    }
    await fs.writeFile(path.join(webRoot, "web-only.txt"), "Web-only file\n");
    await evaluate(`document.querySelector('[data-diff-refresh]').click()`);
    await waitFor(
      () => evaluate(`!!document.querySelector(${JSON.stringify(group(webId) + ' [data-diff-tree-file="web-only.txt"]')})`),
      "refresh restores a recovered member and finds an untracked file",
    );
    const projectHeader = await evaluate(
      `(() => { const rect = document.querySelector(${JSON.stringify(group(webId) + " [data-project-header]")}).getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; })()`,
    );
    await connection.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...projectHeader });
    await shot("link-project-row-hover");
    await evaluate(`document.querySelector(${JSON.stringify(group(webId) + " [data-project-actions]")}).click()`);
    await shot("link-project-actions");
    await click("Commit and open PR…");
    await waitFor(() => evaluate(`!!document.querySelector('[data-git-dialog]')`), "Project menu opens scoped Git dialog");
    assert.ok(await evaluate(`document.querySelector('[data-git-dialog] header').textContent.includes('food-web')`));
    await waitFor(
      () => evaluate(`document.querySelector('[data-git-dialog]').textContent.includes('web-only.txt')`),
      "Git dialog reads the explicit web member Worktree",
    );
    assert.equal(
      await evaluate(`!!document.querySelector('dialog[aria-label="Choose Project for Git"]')`),
      false,
      "Project row already identifies the Git target",
    );
    await evaluate(`document.querySelector('[data-git-dialog] button[aria-label="Close"]').click()`);
    await evaluate(`document.querySelector('[data-changes-toggle]').click()`);
    await waitFor(() => evaluate(`!document.querySelector('[data-changes-panel]')`), "right bar hidden");
    assert.equal(await evaluate(`!!document.querySelector('[data-diff-view]')`), false);
    await evaluate(
      `[...document.querySelectorAll('button[data-row]')].find(button => button.textContent.includes('Update status.txt')).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 140, clientY: 200 }))`,
    );
    await waitFor(
      () => evaluate(`!![...document.querySelectorAll('[data-menu-row]')].find(button => button.textContent === 'Commit and open PR…' && !button.disabled)`),
      "shared Chat Git action is available",
    );
    await click("Commit and open PR…");
    await waitFor(() => evaluate(`!!document.querySelector('dialog[aria-label="Choose Project for Git"]')`), "Git member chooser");
    assert.equal(await evaluate(`[...document.querySelectorAll('dialog button')].find(button=>button.textContent==='Continue').disabled`), true);
    await shot("choose-git-project");
    await click("Cancel");
    await input('textarea[aria-label="Prompt"]', "Keep this Link draft");
    await openScope(scopeOf("food-api"));
    await waitFor(() => isCurrent(scopeOf("food-api")), "ordinary Project restored");
    await input('textarea[aria-label="Prompt"]', "Keep this Project draft");
    await openScope(linkScope);
    await waitFor(() => evaluate(`document.querySelector('textarea[aria-label="Prompt"]')?.value === 'Keep this Link draft'`), "independent Link draft");
    await input('textarea[aria-label="Prompt"]', "Follow up in both Worktrees");
    await evaluate(`document.querySelector('button[aria-label="Send"]').click()`);
    await waitFor(() => providerCalls === 2, "second turn");
    assert.deepEqual((await client.call("link:snapshot", [link.id])).state.sessions[session.id].worktrees, session.worktrees);
    await evaluate(`document.querySelector('button[aria-label="New chat"]').click()`);
    await input('textarea[aria-label="Prompt"]', "An independent new Chat draft");
    await openScope(scopeOf("food-api"));
    await waitFor(() => isCurrent(scopeOf("food-api")), "Project switch");
    assert.equal(await evaluate(`document.querySelector('textarea[aria-label="Prompt"]').value`), "Keep this Project draft");
    await openScope(linkScope);
    await waitFor(
      () => evaluate(`document.querySelector('textarea[aria-label="Prompt"]')?.value === 'An independent new Chat draft'`),
      "new Chat draft restored",
    );
    assert.equal(
      await evaluate(`document.querySelector('[data-chat-pane]').textContent.includes('Updated status.txt in both owned Worktrees.')`),
      false,
      "Explicit new Chat selection must survive a scope switch",
    );
    const setupGate = path.join(dir, "setup-ready");
    await client.call("worktree-setup:save", [projects[0], `while test ! -f '${setupGate}'; do sleep 0.1; done`]);
    await evaluate(`document.querySelector('button[aria-label="New chat"]').click()`);
    await input('textarea[aria-label="Prompt"]', "Slow new shared Chat");
    await evaluate(`document.querySelector('button[aria-label="Send"]').click()`);
    await waitFor(
      async () => Object.values((await client.call("link:snapshot", [link.id])).state.preparations).some((prep) => prep.status === "setup"),
      "slow preparation started",
    );
    await evaluate(`document.querySelector('button[aria-label="New chat"]').click()`);
    await input('textarea[aria-label="Prompt"]', "Slow new shared Chat");
    await fs.writeFile(setupGate, "ready");
    await waitFor(() => providerCalls === 3, "earlier send finishes");
    await delay(500);
    assert.equal(
      await evaluate(`document.querySelector('textarea[aria-label="Prompt"]').value`),
      "Slow new shared Chat",
      "A late send must not select its Chat or clear the new draft",
    );
    await evaluate(`[...document.querySelectorAll('button[data-row]')].find(button => button.textContent.includes('Update status.txt')).click()`);
    await fs.unlink(setupGate);
    await evaluate(`document.querySelector('button[aria-label="New chat"]').click()`);
    await input('textarea[aria-label="Prompt"]', "Send then switch scope");
    await evaluate(`document.querySelector('button[aria-label="Send"]').click()`);
    await waitFor(
      async () => Object.values((await client.call("link:snapshot", [link.id])).state.preparations).some((prep) => prep.status === "setup"),
      "scope-switch preparation",
    );
    await openScope(scopeOf("food-api"));
    await waitFor(() => isCurrent(scopeOf("food-api")), "switched away during setup");
    await fs.writeFile(setupGate, "ready");
    await waitFor(() => providerCalls === 4, "background send acknowledgement");
    await delay(500);
    await openScope(linkScope);
    await waitFor(() => isCurrent(linkScope), "returned Link");
    assert.equal(
      await evaluate(`document.querySelector('textarea[aria-label="Prompt"]').value`),
      "",
      "Acknowledged first send must not return as an unsent new Chat draft",
    );
    assert.ok(await evaluate(`document.querySelector('[data-chat-pane]').textContent.includes('Send then switch scope')`));
    await evaluate(`[...document.querySelectorAll('button[data-row]')].find(button => button.textContent.includes('Update status.txt')).click()`);
    // Missing members preserve history and the unsent draft, with a named error.
    await fs.rename(projects[0], projects[0] + "-moved");
    try {
      await input('textarea[aria-label="Prompt"]', "Draft survives missing Project");
      await evaluate(`document.querySelector('button[aria-label="Send"]').click()`);
      await waitFor(() => evaluate(`document.body.textContent.includes('unavailable')`), "named unavailable member error");
      assert.equal(await evaluate(`document.querySelector('textarea[aria-label="Prompt"]').value`), "Draft survives missing Project");
      assert.equal(providerCalls, 4);
      await shot("missing-member");
    } finally {
      await fs.rename(projects[0] + "-moved", projects[0]);
    }
    client.close();
    client = null;
    await daemon.close();
    daemon = null;
    await waitFor(() => evaluate(`!!document.querySelector('[data-host-disconnected]')`), "Link reconnect notice");
    await shot("link-disconnected");
    daemon = await startDaemon({ dataDir: profile, version: "0.1.0", runtimeOptions: options });
    client = await connectHost({ dataDir: profile });
    await waitFor(() => evaluate(`!document.querySelector('[data-host-disconnected]')`), "Link reconnect");
    assert.equal(await evaluate(`document.querySelector('textarea[aria-label="Prompt"]').value`), "Draft survives missing Project");
    assert.deepEqual((await client.call("link:snapshot", [link.id])).state.sessions[session.id].worktrees, session.worktrees);
    console.log(
      "PASS: real desktop creates a named Link, owns two Worktrees in one Chat, chooses Git scope, preserves scoped drafts and reconnects without new Worktrees.",
    );
  } catch (error) {
    console.error(output);
    throw error;
  } finally {
    await fs.writeFile(path.join(dir, "setup-ready"), "ready").catch(() => {});
    connection?.close();
    if (child && child.exitCode === null) {
      const exit = once(child, "exit");
      child.kill();
      await exit;
    }
    client?.close();
    await daemon?.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
