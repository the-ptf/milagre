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
import "/src/styles.css";
const now = Date.now();
const chat = (id, worktree_id, title, extra = {}) => ({ id, worktree_id, agent_name: "Claude", status: "Stopped", title, provider: "claude", summary: { count: 2, firstId: id, lastId: id, lastAt: now - 25 * 60000 }, ...extra });
const tree = (id, path, name, diff) => ({ id, project_id: 1, path, name, diff });
const state = (worktrees, sessions) => ({ next_id: 50, projects: {}, worktrees: Object.fromEntries(worktrees.map(item => [item.id, item])), sessions: Object.fromEntries(sessions.map(item => [item.id, item])), messages: [], tasks: {} });
const frontend = state(
  [tree(1, "/a", "main", { added: 212, removed: 148 }), tree(4, "/a-finished", "finished-work"), tree(6, "/a-starter", "starter"), tree(8, "/a-filters", "sidebar-filters", { added: 410, removed: 96 })],
  [chat(2, 1, "Build UI"), chat(5, 4, "Archived", { archived: true }), chat(7, 6, "Starter", { summary: { count: 0 } }), chat(9, 8, "Sidebar filters"), chat(10, 8, "Review filters", { provider: "codex" })],
);
const backend = state([tree(1, "/b", "main", { added: 38, removed: 12 })], [chat(2, 1, "Add API", { provider: "codex" })]);
const empty = state([tree(1, "/c", "main")], [chat(2, 1, "Old work", { archived: true })]);
const projects = [
  { id: "a", path: "/a", name: "Frontend", openedAt: "2026-10-03T10:00:00Z", position: { x: 0, y: 0 } },
  { id: "b", path: "/b", name: "Backend", openedAt: "2026-10-03T09:00:00Z", position: { x: 700, y: 0 } },
  { id: "c", path: "/c", name: "Empty", openedAt: "2026-10-03T08:00:00Z", position: null },
];
const run = (approvals, questions) => ({ approvals, questions });
const runs = { "/a#2": run([{ id: "approval" }], []), "/a#10": run([], [{ id: "question" }]), "/b#2": run([], []) };
const readLinks = () => JSON.parse(localStorage.getItem("canvas-test-links") || "[]");
window.milagre = {
  getCanvas: async () => ({ projects, links: readLinks(), worktreePositions: {}, states: [{ path: "/a", state: frontend }, { path: "/b", state: backend }, { path: "/c", state: empty }] }),
  addLink: async (a, b) => { const links = [...readLinks(), { id: "link-1", a, b, created_at: new Date().toISOString() }]; localStorage.setItem("canvas-test-links", JSON.stringify(links)); return links; },
  removeLink: async id => { const links = readLinks().filter(link => link.id !== id); localStorage.setItem("canvas-test-links", JSON.stringify(links)); return links; },
  setProjectPosition: async () => [],
  setWorktreePosition: async () => null,
  getProjectImage: async () => null,
};
if (new URLSearchParams(location.search).has("dark")) document.documentElement.classList.add("dark");
createRoot(document.getElementById("root")).render(
  <DotBackground>
    <main data-workspace-main className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden pr-3 pb-3">
      <CanvasView states={{}} runs={runs} linkedWork={{ delegations: [], negotiations: [], receiveOnly: [] }} onOpenChat={(path, id) => { window.__openedChat = { path, id }; }} onNewChat={path => { window.__newChat = path; }} onBack={() => {}} />
    </main>
  </DotBackground>,
);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  await app.whenReady();
  const window = new BrowserWindow({ width: 1280, height: 760, show: false, webPreferences: { backgroundThrottling: false } });
  const evaluate = (code) => window.webContents.executeJavaScript(code);
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") console.error("page:", event.message);
  });
  const mouse = (type, x, y) =>
    window.webContents.sendInputEvent({ type, x, y, button: "left", clickCount: 1, modifiers: type === "mouseMove" ? ["leftButtonDown"] : [] });
  const waitFor = async (code) => {
    for (let i = 0; i < 200; i++) {
      if (await evaluate(code)) return;
      await delay(25);
    }
    throw new Error(`Timed out: ${code}`);
  };
  const point = (nodeName, handle) =>
    evaluate(
      `(() => { const node = [...document.querySelectorAll('.react-flow__node')].find(node => node.textContent.includes(${JSON.stringify(nodeName)}) && node.classList.contains('react-flow__node-project')); const r = node?.querySelector(${JSON.stringify(`.react-flow__handle[data-handleid="${handle}"]`)})?.getBoundingClientRect(); return r && { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`,
    );
  const screenshot = (name) => {
    if (!process.env.MILAGRE_SCREENSHOT_DIR) return Promise.resolve();
    fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
    // A hidden window paints on demand; give the latest frame a moment to land before capturing it.
    return delay(400)
      .then(() => window.webContents.capturePage())
      .then((image) => fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, `${name}.png`), image.toPNG()));
  };
  try {
    await window.loadURL(process.argv[2]);
    await evaluate('localStorage.removeItem("canvas-test-links")');
    await window.reload();
    await waitFor('document.querySelectorAll(".react-flow__node-project").length === 2');
    await waitFor('document.querySelectorAll("[data-canvas-chat]").length === 4');
    // Only what the sidebar lists: archived chats, empty starters and Projects left with neither stay off.
    for (const gone of ["Archived", "finished-work", "Starter", "Empty", "Old work"])
      assert.equal(await evaluate(`document.querySelector("[data-canvas]").textContent.includes(${JSON.stringify(gone)})`), false, gone);
    // Titles and live states lead; the branch follows.
    const card = (path) => `document.querySelector('[data-canvas-worktree="${path}"]')`;
    assert.equal(await evaluate(`${card("/a")}.dataset.attention`), "waiting");
    assert.match(await evaluate(`${card("/a")}.textContent`), /Build UI.*Waiting for you.*main/);
    assert.match(await evaluate(`${card("/a-filters")}.textContent`), /Sidebar filters.*Idle · 25m ago.*Review filters.*Asking you.*sidebar-filters/);
    assert.match(await evaluate(`${card("/b")}.textContent`), /Add API.*Running/);
    assert.equal(await evaluate(`${card("/b")}.querySelectorAll("svg").length > 1`), true, "the card shows its provider logo");
    // React Flow's own controls and attribution are gone; the canvas has its own zoom.
    assert.equal(await evaluate('Boolean(document.querySelector(".react-flow__attribution, .react-flow__controls"))'), false);
    assert.equal(await evaluate('Boolean(document.querySelector("[data-canvas-zoom]"))'), true);
    await screenshot("canvas");
    await evaluate("document.querySelector('[data-canvas-chat=\"2\"]').click()");
    assert.deepEqual(await evaluate("window.__openedChat"), { path: "/a", id: 2 });
    await evaluate('[...document.querySelectorAll("[data-canvas-chat]")].find(button => button.textContent.includes("Add API")).click()');
    assert.deepEqual(await evaluate("window.__openedChat"), { path: "/b", id: 2 });
    await evaluate("document.querySelector('[data-canvas-new-chat=\"/a\"]').click()");
    assert.equal(await evaluate("window.__newChat"), "/a");
    // The filter dims cards with nothing to show, and counts what each keeps.
    assert.match(await evaluate("document.querySelector('[data-canvas-filter=\"needs-you\"]').textContent"), /Needs you\s*2/);
    await evaluate("document.querySelector('[data-canvas-filter=\"needs-you\"]').click()");
    await waitFor(`${card("/b")}.classList.contains("opacity-35")`);
    assert.equal(await evaluate(`${card("/a")}.classList.contains("opacity-35")`), false);
    await screenshot("needs-you");
    await evaluate("document.querySelector('[data-canvas-filter=\"all\"]').click()");
    await waitFor(`!${card("/b")}.classList.contains("opacity-35")`);
    const from = await point("Frontend", "right");
    const to = await point("Backend", "left");
    assert.ok(from && to, "project handles are rendered");
    mouse("mouseMove", from.x, from.y);
    mouse("mouseDown", from.x, from.y);
    for (let i = 1; i <= 20; i++) {
      mouse("mouseMove", Math.round(from.x + ((to.x - from.x) * i) / 20), Math.round(from.y + ((to.y - from.y) * i) / 20));
      await delay(15);
    }
    mouse("mouseUp", to.x, to.y);
    await waitFor('JSON.parse(localStorage.getItem("canvas-test-links") || "[]").length === 1');
    await waitFor('document.querySelectorAll(".react-flow__edge").length === 1');
    await waitFor('Boolean(document.querySelector("[data-project-link]"))');
    await screenshot("linked");
    await evaluate('document.querySelector(".react-flow__edge").dispatchEvent(new MouseEvent("click", { bubbles: true }))');
    await waitFor('[...document.querySelectorAll("[data-canvas] button")].some(button => button.textContent === "Remove Link")');
    await evaluate('[...document.querySelectorAll("[data-canvas] button")].find(button => button.textContent === "Remove Link").click()');
    await waitFor('JSON.parse(localStorage.getItem("canvas-test-links") || "[]").length === 0');
    // The same gesture creates it again; a reload reads the saved Link through the stubbed bridge.
    await window.reload();
    await waitFor('document.querySelectorAll(".react-flow__node-project").length === 2');
    const fromAgain = await point("Frontend", "right");
    const toAgain = await point("Backend", "left");
    mouse("mouseMove", fromAgain.x, fromAgain.y);
    mouse("mouseDown", fromAgain.x, fromAgain.y);
    for (let i = 1; i <= 20; i++) {
      mouse("mouseMove", Math.round(fromAgain.x + ((toAgain.x - fromAgain.x) * i) / 20), Math.round(fromAgain.y + ((toAgain.y - fromAgain.y) * i) / 20));
      await delay(15);
    }
    mouse("mouseUp", toAgain.x, toAgain.y);
    await waitFor('JSON.parse(localStorage.getItem("canvas-test-links") || "[]").length === 1');
    await window.reload();
    await waitFor('document.querySelectorAll(".react-flow__edge").length === 1');
    await window.loadURL(`${process.argv[2]}?dark`);
    await waitFor('document.querySelectorAll(".react-flow__edge").length === 1');
    await delay(300);
    await screenshot("dark");
    console.log("PASS: canvas shows only listed chats, live states, filter, new chat, own zoom, Link drag, removal, persistence after reload");
    app.exit(0);
  } catch (error) {
    console.error(error);
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
        name: "canvas-links-fixture",
        resolveId(id) {
          if (id === "/__canvas_links_fixture.tsx") return id;
        },
        load(id) {
          if (id === "/__canvas_links_fixture.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url.split("?")[0] !== "/__canvas_links__") return next();
            const html = await server.transformIndexHtml(
              request.url,
              '<html><body><div id="root"></div><script type="module" src="/__canvas_links_fixture.tsx"></script></body></html>',
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
    const child = spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__canvas_links__`], { env, stdio: "inherit" });
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
