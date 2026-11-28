const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");

const fixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import { CanvasView } from "/src/components/CanvasView";
import { DotBackground } from "/src/components/DotBackground";
import { AgentRunsContext, createAgentRunsStore } from "/src/lib/agent-runs-store";
import "/src/styles.css";
const unsubscribe = () => () => {};
const now = Date.now();
const message = (id, session_id, role, body) => ({ id, session_id, role, body, context: null });
const chat = (id, worktree_id, title, extra = {}) => ({ id, worktree_id, agent_name: "Claude", status: "Stopped", title, provider: "claude", summary: { count: 2, firstId: id * 10 + 1, lastId: id * 10 + 2, lastAt: now - 25 * 60000 }, ...extra });
const titles = { 2: "Resolver comentarios do PR", 3: "Falha de autenticacao Teams", 5: "Entender o projeto", 6: "Abrir PR do fix", 7: "Recuperar rotinas", 8: "Site novo" };
const stateOf = (worktrees, ids) => ({
  next_id: 100,
  projects: {},
  worktrees,
  sessions: Object.fromEntries(ids.map(([id, worktree]) => [id, chat(id, worktree, titles[id])])),
  messages: ids.flatMap(([id]) => [
    message(id * 10 + 1, id, "user", "Please look at " + titles[id].toLowerCase() + "."),
    message(id * 10 + 2, id, "assistant", "Done with the first pass on " + titles[id].toLowerCase() + ". The change touches two files and the tests pass."),
  ]),
  tasks: {},
});
const state = stateOf({ 1: { id: 1, project_id: 1, path: "/a", name: "main" }, 4: { id: 4, project_id: 1, path: "/a-fix", name: "fix/file-link" } }, [[2, 1], [3, 1], [5, 4], [6, 4], [7, 4]]);
const other = stateOf({ 1: { id: 1, project_id: 1, path: "/b", name: "main" } }, [[8, 1]]);
const run = (extra) => ({ text: "Working on it.", model: "claude-opus-5-5", steps: [], approvals: [], questions: [], answered: {}, startedAt: now - 240000, ...extra });
window.runs = {
  "/a#2": run({ steps: [{ id: "s1", kind: "edit", title: "Edited \`file-link.mjs\`", status: "done", file: "/a/file-link.mjs" }, { id: "s2", kind: "shell", title: "Ran \`npm test\`", status: "running", description: "Running the unit tests" }] }),
  "/a#3": run({ approvals: [{ requestId: "p1", kind: "command", tool: "Bash", title: "Run a command", command: "mongosh ms-cliente --eval 'db.idEmpotentes.createIndex(...)'", allowForChat: true }] }),
  "/a#6": run({ questions: [{ requestId: "q1", questions: [{ id: "account", header: "Account", question: "Which GitHub account opens the PR?", options: [{ label: "gsilvrd" }, { label: "Other" }] }] }] }),
};
const projects = [
  { id: "a", path: "/a", name: "milagre", openedAt: "2026-11-12T10:00:00Z", position: { x: 0, y: 0 } },
  { id: "b", path: "/b", name: "site", openedAt: "2026-11-12T10:00:00Z", position: { x: 700, y: 0 } },
];
window.calls = [];
const record = (name) => async (...args) => { window.calls.push([name, ...args]); return true; };
window.milagre = {
  listEditors: async () => [],
  on: unsubscribe,
  onAgentEvent: unsubscribe,
  onComputerEvent: unsubscribe,
  onRuntimeConnection: unsubscribe,
  onLinksChanged: unsubscribe,
  getCanvas: async () => ({ projects, links: [], worktreePositions: {}, states: [{ path: "/a", state }, { path: "/b", state: other }] }),
  setProjectPosition: async () => [],
  setWorktreePosition: async () => null,
  getProjectImage: async () => null,
  readContextSettings: async () => ({ followUps: "now" }),
};
const actions = {
  models: [],
  send: record("send"),
  respond: record("respond"),
  answerQuestion: record("answer"),
  interrupt: record("interrupt"),
};
if (new URLSearchParams(location.search).has("dark")) document.documentElement.classList.add("dark");
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !event.defaultPrevented) window.leftCanvas = (window.leftCanvas ?? 0) + 1;
});
function Root() {
  const [shown, setShown] = React.useState(true);
  window.leaveCanvas = () => {
    setShown(false);
    setTimeout(() => setShown(true), 50);
  };
  return shown ? (
    <CanvasView states={{ "/a": state, "/b": other }} runs={window.runs} linkedWork={{ delegations: [], negotiations: [], receiveOnly: [] }}
      onOpenChat={(path, id) => { window.openedFull = { path, id }; }} onBack={() => {}}
      chatActions={new URLSearchParams(location.search).has("off") ? undefined : actions} />
  ) : null;
}
const runStore = createAgentRunsStore();
runStore.set(window.runs);
createRoot(document.getElementById("root")).render(
  <AgentRunsContext.Provider value={runStore}>
  <DotBackground>
    <main data-workspace-main className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden pr-3 pb-3">
      <Root />
    </main>
  </DotBackground>
  </AgentRunsContext.Provider>,
);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  await app.whenReady();
  const offscreen = Boolean(process.env.MILAGRE_SCREENSHOT_DIR);
  const window = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { backgroundThrottling: false, offscreen } });
  const evaluate = (code) => window.webContents.executeJavaScript(code);
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") console.error("page:", event.message);
  });
  const waitFor = async (code, what = code) => {
    for (let i = 0; i < 200; i++) {
      if (await evaluate(code)) return;
      await delay(25);
    }
    throw new Error(`Timed out: ${what}`);
  };
  const screenshot = (name) => {
    if (!process.env.MILAGRE_SCREENSHOT_DIR) return Promise.resolve();
    fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
    window.webContents.invalidate();
    return delay(600)
      .then(() => window.webContents.capturePage())
      .then((image) => fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, `${name}.png`), image.toPNG()));
  };
  const row = (id) => `[...document.querySelectorAll('[data-canvas-chat="${id}"]')].at(-1)`;
  const win = (id) => `document.querySelector('[data-canvas-window="/a#${id}"]')`;
  const windows = () => evaluate('[...document.querySelectorAll("[data-canvas-window]")].map((item) => item.dataset.canvasWindow)');
  const nodeBox = (id) =>
    evaluate(`(() => {
      const node = document.querySelector('.react-flow__node[data-id="chatwindow:%2Fa%23${id}"]');
      const at = /translate\\((-?[\\d.]+)px, ?(-?[\\d.]+)px\\)/.exec(node.style.transform);
      return { x: Number(at[1]), y: Number(at[2]), width: parseFloat(node.style.width), height: parseFloat(node.style.height) };
    })()`);
  const type = (id, text) =>
    evaluate(`{
      const field = ${win(id)}.querySelector("[data-canvas-composer]");
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(field, ${JSON.stringify(text)});
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }`);
  const escapeIn = (selector) => evaluate(`${selector}.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))`);
  try {
    await window.loadURL(process.argv[2]);
    await evaluate('localStorage.setItem("milagre.canvasChatWindows", JSON.stringify({ "/a#7": { x: -900, y: 60, width: 500, height: 400 } }))');
    await window.loadURL(process.argv[2]);
    await waitFor('document.querySelectorAll("[data-canvas-chat]").length === 6', "six Chats on the canvas");
    await screenshot("canvas-closed");

    await waitFor('document.querySelector("[data-canvas-step]")?.textContent === "Running the unit tests"', "the step line on the closed card");
    assert.equal(
      await evaluate('[...document.querySelectorAll("[data-canvas-worktree]")].every((card) => card.scrollHeight <= card.clientHeight + 1)'),
      true,
      "closed cards fit their live blocks",
    );
    await evaluate('document.querySelector("[data-canvas-approval=p1] [data-canvas-allow]").click()');
    await waitFor(
      'window.calls.some((call) => call[0] === "respond" && call[1] === "/a#3" && call[2] === "p1" && call[3] === "allow")',
      "Allow on the closed card",
    );
    await evaluate('document.querySelector("[data-canvas-question=q1] [data-canvas-option=gsilvrd]").click()');
    await waitFor(
      'window.calls.some((call) => call[0] === "answer" && call[1] === "/a#6" && call[2] === "q1" && call[3]?.account?.[0] === "gsilvrd")',
      "an option answers the question on the closed card",
    );
    assert.deepEqual(await windows(), [], "answering does not open a window");
    assert.equal(await evaluate("window.openedFull"), undefined);
    await evaluate("window.calls = []");

    await evaluate(`${row(2)}.click()`);
    await waitFor(`Boolean(${win(2)})`, "Chat 2 opens as a window");
    assert.equal(await evaluate("window.openedFull"), undefined, "a single click does not leave the canvas");
    await waitFor(`${win(2)}.textContent.includes("Running the unit tests")`, "the live step");
    assert.match(await evaluate(`${win(2)}.textContent`), /Done with the first pass/);
    await screenshot("canvas-window-running");

    const viewport = 'document.querySelector(".react-flow__viewport").style.transform';
    const before = await evaluate(viewport);
    await evaluate(`${win(2)}.querySelector(".nowheel").dispatchEvent(new WheelEvent("wheel", { deltaY: 300, bubbles: true, cancelable: true }))`);
    await evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    assert.equal(await evaluate(viewport), before, "the canvas does not move");

    await evaluate(`${win(2)}.querySelector("[data-canvas-stop]").click()`);
    await waitFor('window.calls.some((call) => call[0] === "interrupt" && call[1] === "/a#2")', "Stop calls interrupt");
    await type(2, "depois abre o PR");
    await waitFor(`${win(2)}.querySelector("[data-canvas-composer]").value === "depois abre o PR"`, "the draft is typed");
    await evaluate(`${win(2)}.querySelector("[data-canvas-composer]").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))`);
    await waitFor('window.calls.some((call) => call[0] === "send")', "Enter sends");
    const send = await evaluate('window.calls.find((call) => call[0] === "send")[1]');
    assert.deepEqual([send.key, send.body, send.worktreeId], ["/a#2", "depois abre o PR", 1]);
    await waitFor(`${win(2)}.querySelector("[data-canvas-composer]").value === ""`, "the field clears after a send");

    for (const id of [3, 5, 6, 7]) {
      await evaluate(`${row(id)}.click()`);
      await waitFor(`Boolean(${win(id)})`, `Chat ${id} opens as a window`);
    }
    assert.equal((await windows()).length, 5, "five windows: nothing closed another");
    assert.equal(await evaluate('document.querySelectorAll("[data-canvas-windowed]").length'), 5, "the cards mark the Chats open as windows");
    await waitFor('document.querySelectorAll(".react-flow__edge-chatwindow").length === 5', "a line from each window to its card");
    await waitFor(`[...${win(3)}.querySelectorAll("button")].some((button) => /^Allow/.test(button.textContent))`, "the approval in its window");
    await evaluate(`[...${win(3)}.querySelectorAll("button")].find((button) => /^Allow/.test(button.textContent)).click()`);
    await waitFor('window.calls.some((call) => call[0] === "respond" && call[1] === "/a#3" && call[2] === "p1")', "Allow in the window calls respond");
    assert.match(await evaluate(`${win(6)}.textContent`), /Which GitHub account opens the PR\?/);
    assert.deepEqual(await nodeBox(7), { x: -900, y: 60, width: 500, height: 400 });
    const sectionB = await evaluate(`(() => {
      const node = document.querySelector('.react-flow__node[data-id="project:b"]');
      const at = /translate\\((-?[\\d.]+)px, ?(-?[\\d.]+)px\\)/.exec(node.style.transform);
      return { x: Number(at[1]), width: parseFloat(node.style.width) };
    })()`);
    for (const id of [2, 3, 5, 6]) assert.ok((await nodeBox(id)).x >= sectionB.x + sectionB.width, `window ${id} is past Project b`);
    assert.ok((await nodeBox(6)).x > (await nodeBox(5)).x && (await nodeBox(5)).x > (await nodeBox(3)).x);
    await screenshot("canvas-windows");

    const sides = (id) => evaluate(`document.querySelector('[data-canvas-line="/a#${id}"]').dataset.sides`);
    assert.equal(await sides(2), "right-left");
    assert.equal(await sides(7), "left-right");
    await evaluate(`{
      const dot = document.querySelector('[data-canvas-line="/a#2"]');
      const r = dot.getBoundingClientRect();
      const at = (dy) => ({ bubbles: true, cancelable: true, pointerId: 1, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 + dy });
      dot.dispatchEvent(new PointerEvent("pointerdown", at(0)));
      dot.dispatchEvent(new PointerEvent("pointermove", at(60)));
      dot.dispatchEvent(new PointerEvent("pointerup", at(120)));
    }`);
    await waitFor(`document.querySelector('[data-canvas-line="/a#2"]').hasAttribute("data-bent")`, "the line is bent");
    assert.ok(JSON.parse(await evaluate('localStorage.getItem("milagre.canvasChatWindows")'))["/a#2"].bend.y > 0, "the bend is kept for that Chat");
    await evaluate(`document.querySelector('[data-canvas-line="/a#2"]').dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))`);
    await waitFor(`!document.querySelector('[data-canvas-line="/a#2"]').hasAttribute("data-bent")`, "a double click straightens it");
    assert.equal(JSON.parse(await evaluate('localStorage.getItem("milagre.canvasChatWindows")'))["/a#2"]?.bend, undefined);

    await type(5, "primeiro rascunho");
    await type(6, "segundo rascunho");
    await waitFor(
      `${win(5)}.querySelector("[data-canvas-composer]").value === "primeiro rascunho" && ${win(6)}.querySelector("[data-canvas-composer]").value === "segundo rascunho"`,
      "both drafts kept",
    );
    assert.equal((await windows()).length, 5);

    await escapeIn(`${win(6)}.querySelector("[data-canvas-composer]")`);
    await waitFor(`!${win(6)}`, "Esc closes the window it is in");
    assert.equal(await evaluate("window.leftCanvas"), undefined, "Esc that closes a window does not also leave the canvas");
    assert.equal(await evaluate(`${win(5)}.querySelector("[data-canvas-composer]").value`), "primeiro rascunho");
    await evaluate(`{
      const dialog = document.createElement("dialog");
      dialog.dataset.t = "settings";
      document.body.append(dialog);
      dialog.showModal();
      dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    }`);
    assert.equal((await windows()).length, 4, "Esc in a dialog leaves the windows alone");
    await evaluate('document.querySelector("dialog[data-t]").close(); document.querySelector("dialog[data-t]").remove()');
    await escapeIn("document.body");
    await waitFor(`!${win(7)}`, "Esc closes the last opened");

    const kept = await windows();
    await evaluate("window.leaveCanvas()");
    await waitFor('document.querySelectorAll("[data-canvas-chat]").length === 0', "the canvas unmounts");
    await waitFor(
      `JSON.stringify([...document.querySelectorAll("[data-canvas-window]")].map((item) => item.dataset.canvasWindow)) === ${JSON.stringify(JSON.stringify(kept))}`,
      "back, the same windows",
    );

    assert.equal(await evaluate('document.querySelector("[data-canvas-close-all]").textContent'), "Close all 3");
    await evaluate('document.querySelector("[data-canvas-close-all]").click()');
    await waitFor('document.querySelectorAll("[data-canvas-window]").length === 0', "Close all closes every window");

    await evaluate(`${row(5)}.click()`);
    await evaluate(`${row(5)}.click()`);
    await waitFor('window.openedFull?.path === "/a" && window.openedFull?.id === 5', "a second click opens the full Chat");
    await evaluate("window.openedFull = undefined");
    await evaluate(`${row(3)}.click()`);
    await waitFor(`Boolean(${win(3)})`);
    await evaluate(`${win(3)}.querySelector("header").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))`);
    await waitFor('window.openedFull?.path === "/a" && window.openedFull?.id === 3', "a double click on the header opens the full Chat");
    await evaluate(`${win(3)}.querySelector("[data-canvas-close]").click()`);
    await waitFor(`!${win(3)}`, "the close button closes it");

    await window.loadURL(`${process.argv[2]}?dark`);
    await waitFor('document.querySelectorAll("[data-canvas-chat]").length === 6');
    await evaluate(`${row(3)}.click()`);
    await waitFor(`Boolean(${win(3)})`);
    await screenshot("canvas-window-dark");

    await window.loadURL(`${process.argv[2]}?off`);
    await waitFor('document.querySelectorAll("[data-canvas-chat]").length === 6');
    assert.equal(await evaluate('document.querySelectorAll("[data-canvas-step], [data-canvas-approval], [data-canvas-question]").length'), 0);
    await evaluate(`${row(2)}.click()`);
    await waitFor('window.openedFull?.path === "/a" && window.openedFull?.id === 2', "off: a click opens the full Chat");
    assert.deepEqual(await windows(), []);
    console.log(
      "PASS: closed cards show the step and answer approvals and questions; Chats open as windows (any number, past another Project, saved place and size), act there (Stop, send, approval, question), lines join facing sides and bend, drafts kept, Esc closes the focused one, Close all, double click to the full Chat; off, a click opens the full Chat",
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    await screenshot("failure");
    app.exit(1);
  }
}

async function main() {
  const { createServer } = await import("vite");
  const { spawn } = require("node:child_process");
  const server = await createServer({
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "canvas-chats-fixture",
        resolveId(id) {
          if (id === "/__canvas_chats_fixture.tsx") return id;
        },
        load(id) {
          if (id === "/__canvas_chats_fixture.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url.split("?")[0] !== "/__canvas_chats__") return next();
            const html = await server.transformIndexHtml(
              request.url,
              '<html><body><div id="root"></div><script type="module" src="/__canvas_chats_fixture.tsx"></script></body></html>',
            );
            response.setHeader("Content-Type", "text/html");
            response.end(html);
          });
        },
      },
    ],
  });
  try {
    await server.listen();
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__canvas_chats__`], { env, stdio: "inherit" });
    process.exitCode = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    await server.close();
  }
}
(process.versions.electron ? browserChecks() : main()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
