// Browser check: dragging chats in the sidebar pins, reorders and unpins them, a click still opens a chat, the keyboard
// does the same, and dropping a chat on another one's middle offers a Link between their Worktrees. The bridge is stubbed.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const fixture = `
import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import SidebarNav from "/src/components/SidebarNav";
import { orderChats } from "/src/lib/chat-list";
import { updateSettings } from "/src/lib/settings";
import "/src/styles.css";
updateSettings({ chatList: "grouped" });
const links = [];
window.calls = { picks: [], added: [], removed: [] };
window.milagre = {
  listRecentProjects: async () => [],
  listNamedLinks: async () => [],
  listProjects: async () => [{ id: "p1", path: "/repo", name: "repo", position: null, openedAt: "" }],
  getProjectImage: async () => null,
  getCanvas: async () => ({ projects: [], links: [...links], worktreePositions: {}, states: [] }),
  addLink: async (a, b) => { window.calls.added.push([a, b]); links.push({ id: "l" + links.length, a, b, created_at: "" }); return [...links]; },
  removeLink: async (id) => { window.calls.removed.push(id); links.splice(links.findIndex(link => link.id === id), 1); return [...links]; },
};
const start = [
  { id: "1", label: "Alpha login fix", path: "/repo/.w/alpha" },
  { id: "2", label: "Bravo diff viewer", path: "/repo/.w/bravo" },
  { id: "3", label: "Charlie flaky test", path: "/repo/.w/charlie" },
  { id: "4", label: "Delta same worktree", path: "/repo/.w/charlie" },
];
function Fixture() {
  const [sessions, setSessions] = useState(() => Object.fromEntries(start.map((chat, index) => [chat.id, { ...chat, ids: [index + 1] }])));
  const recents = orderChats(Object.values(sessions).map(session => ({ session, sessionMessages: session.ids.map(id => ({ id })) })), "created")
    .map(({ session }) => ({ id: session.id, label: session.label, pinned: !!session.pinned, pinOrder: session.pin_order, details: { path: session.path, branch: session.label.split(" ")[0].toLowerCase() } }));
  const actions = useMemo(() => ({ onPin: (id, order) => setSessions(previous => ({ ...previous, [id]: { ...previous[id], pinned: order != null, pin_order: order ?? undefined } })) }), []);
  return (
    <div style={{ display: "flex", height: "100vh", padding: "60px 12px 12px" }}>
      <SidebarNav fill workspaceName="repo" projectPath="/repo" recents={recents} activeId="1" chatActions={actions} onPick={id => window.calls.picks.push(id)} />
      <div style={{ flex: 1 }} />
    </div>
  );
}
document.documentElement.classList.add("dark");
createRoot(document.getElementById("root")).render(<Fixture />);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  await app.whenReady();
  const window = new BrowserWindow({ width: 1200, height: 560, show: false, webPreferences: { backgroundThrottling: false, partition: "chat-pins-check" } });
  window.webContents.on("did-finish-load", () => window.webContents.setZoomFactor(1));
  // A throw in the page comes back as its own message and the expression, not Electron's generic "Script failed to execute".
  const evaluate = async (source) => {
    const result = await window.webContents.executeJavaScript(
      `(async () => { try { return { value: await (${source}) }; } catch (error) { return { error: String(error?.stack ?? error) }; } })()`,
    );
    if ("error" in result) throw new Error(`${result.error}\nExpression: ${source}`);
    return result.value;
  };
  // Moves carry leftButtonDown, or Chromium reads them as the button already released.
  const mouse = (type, x, y) =>
    window.webContents.sendInputEvent({ type, x, y, button: "left", clickCount: 1, modifiers: type === "mouseMove" ? ["leftButtonDown"] : [] });
  const key = (keyCode) => {
    window.webContents.sendInputEvent({ type: "keyDown", keyCode });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode });
  };
  async function waitFor(source) {
    for (let i = 0; i < 200; i++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw new Error(`Timed out: ${source}`);
  }
  const box = (selector) =>
    evaluate(
      `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.left + 60), top: r.top, bottom: r.bottom, y: Math.round(r.top + r.height / 2) }; })()`,
    );
  const row = (id) => box(`[data-chat-id="${id}"]`);
  const order = () =>
    evaluate('[...document.querySelectorAll("[data-chat-id]")].map(n => n.dataset.chatId + (n.closest("[data-pinned-chats]") ? "*" : "")).join(" ")');
  const calls = () => evaluate("window.calls");
  // Presses on a row, moves in steps past the 4px threshold, and holds over the point before letting go.
  async function drag(from, to, { release = true } = {}) {
    mouse("mouseMove", from.x, from.y);
    mouse("mouseDown", from.x, from.y);
    for (let i = 1; i <= 6; i++) {
      mouse("mouseMove", from.x, Math.round(from.y + ((to.y - from.y) * i) / 6));
      await delay(30);
    }
    await delay(120);
    mouse("mouseMove", to.x, to.y);
    await delay(120);
    if (release) {
      mouse("mouseUp", to.x, to.y);
      await delay(250);
    }
  }
  const screenshot = async (name) => {
    const dir = process.env.MILAGRE_SCREENSHOT_DIR;
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    await delay(300);
    fs.writeFileSync(path.join(dir, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  };
  try {
    await window.loadURL(process.argv[2]);
    await waitFor('document.querySelectorAll("[data-chat-id]").length === 4');
    await delay(300);
    assert.equal(await order(), "4 3 2 1");

    // A click with no movement opens the chat.
    const three = await row(3);
    mouse("mouseMove", three.x, three.y);
    mouse("mouseDown", three.x, three.y);
    mouse("mouseUp", three.x, three.y);
    await delay(150);
    assert.deepEqual((await calls()).picks, ["3"], "a click opens the chat");

    // Dragging a chat shows an empty Pinned section; dropping there pins it, and Undo takes it back.
    mouse("mouseMove", three.x, three.y);
    mouse("mouseDown", three.x, three.y);
    mouse("mouseMove", three.x, three.y + 2);
    await delay(100);
    assert.equal(await evaluate('!!document.querySelector("[data-pin-zone]")'), false, "moving under 4px is not a drag");
    mouse("mouseMove", three.x, three.y + 8);
    await waitFor('!!document.querySelector("[data-pin-zone]")');
    const zone = await box("[data-pin-zone]");
    await drag(three, zone, { release: false });
    await screenshot("drop-to-pin");
    mouse("mouseUp", zone.x, zone.y);
    await delay(250);
    assert.equal(await order(), "3* 4 2 1", "dropped in Pinned, the chat is pinned on top");
    assert.deepEqual((await calls()).picks, ["3"], "the drag's click doesn't open the chat");
    assert.match(await evaluate('document.querySelector("[data-chat-toast]").textContent'), /Pinned\s*Undo/);
    await screenshot("pinned");
    await evaluate('document.querySelector("[data-chat-toast-undo]").click()');
    await delay(200);
    assert.equal(await order(), "4 3 2 1", "Undo unpins it");

    // Pin 3 again, then 1 on the line below it, then move 1 above 3.
    await drag(
      await row(3),
      await evaluate(
        '(() => { const r = document.querySelector("[data-chat-id=\\"3\\"]").getBoundingClientRect(); return { x: Math.round(r.left + 60), y: Math.round(r.top - 30) }; })()',
      ),
      { release: false },
    );
    await waitFor('!!document.querySelector("[data-pin-zone]")');
    const pinZone = await box("[data-pin-zone]");
    mouse("mouseMove", pinZone.x, pinZone.y);
    await delay(120);
    mouse("mouseUp", pinZone.x, pinZone.y);
    await delay(250);
    assert.equal(await order(), "3* 4 2 1");
    const pinnedThree = await row(3);
    await drag(await row(1), { x: pinnedThree.x, y: Math.round(pinnedThree.bottom - 3) });
    assert.equal(await order(), "3* 1* 4 2", "dropped on the line below a pinned chat, the chat is pinned after it");
    const pinnedThreeAgain = await row(3);
    await drag(await row(1), { x: pinnedThreeAgain.x, y: Math.round(pinnedThreeAgain.top + 3) });
    assert.equal(await order(), "1* 3* 4 2", "pinned chats reorder");

    // Dragged out onto the line above a recent chat, a pinned chat is unpinned.
    const four = await row(4);
    await drag(await row(3), { x: four.x, y: Math.round(four.top + 3) });
    assert.equal(await order(), "1* 4 3 2", "dragged out of Pinned, the chat is unpinned");

    // On the middle of a chat in the same worktree, nothing is offered and the hint says why.
    const three2 = await row(3);
    await drag(await row(4), three2, { release: false });
    await waitFor('document.querySelector("[data-drop-target]")?.dataset.dropTarget === "invalid"');
    assert.match(await evaluate('document.querySelector("[data-drop-target]").textContent'), /Same worktree/);
    await screenshot("same-worktree");
    mouse("mouseUp", three2.x, three2.y);
    await delay(250);
    assert.equal(await evaluate('!!document.querySelector("[data-link-popover]")'), false);

    // On the middle of another worktree's chat, a popover asks first; Create Link adds it, Undo removes it.
    const two = await row(2);
    await drag(await row(4), two, { release: false });
    await waitFor('document.querySelector("[data-drop-target]")?.dataset.dropTarget === "link"');
    await screenshot("link-target");
    mouse("mouseUp", two.x, two.y);
    await waitFor('!!document.querySelector("[data-link-popover]")');
    assert.equal((await calls()).added.length, 0, "nothing is created before confirming");
    await screenshot("link-popover");
    await evaluate('document.querySelector("[data-link-confirm]").click()');
    await waitFor('/Link created/.test(document.querySelector("[data-chat-toast]")?.textContent ?? "")');
    assert.deepEqual((await calls()).added, [
      [
        { project_id: "p1", worktree_path: "/repo/.w/charlie" },
        { project_id: "p1", worktree_path: "/repo/.w/bravo" },
      ],
    ]);
    // Already linked: the same drop now explains instead of offering a Link.
    await drag(await row(4), await row(2), { release: false });
    await waitFor('/Already linked/.test(document.querySelector("[data-drop-target]")?.textContent ?? "")');
    key("Escape");
    await delay(200);
    mouse("mouseUp", two.x, two.y);
    await delay(200);
    assert.equal(await evaluate('!!document.querySelector("[data-link-popover]")'), false, "Escape cancelled the drag");
    await evaluate('document.querySelector("[data-chat-toast-undo]").click()');
    await delay(200);
    assert.deepEqual((await calls()).removed, ["l0"], "Undo removes the Link");

    // Keyboard: Space picks the focused chat up, arrows move it with announcements, Space drops, Escape cancels.
    await evaluate('document.querySelector("[data-chat-id=\\"2\\"] [data-row]").focus()');
    key("Space");
    await waitFor('/Picked up Bravo/.test(document.querySelector("[aria-live=assertive]").textContent)');
    key("Down");
    await waitFor('/Pinned, position 1 of 2/.test(document.querySelector("[aria-live=assertive]").textContent)');
    key("Down");
    await waitFor('/On Alpha login fix: create Link/.test(document.querySelector("[aria-live=assertive]").textContent)');
    key("Down");
    await waitFor('/Pinned, position 2 of 2/.test(document.querySelector("[aria-live=assertive]").textContent)');
    key("Space");
    await delay(250);
    assert.equal(await order(), "1* 2* 4 3", "the keyboard pins after the last pinned chat");
    assert.equal(await evaluate('document.activeElement.closest("[data-chat-id]")?.dataset.chatId'), "2", "focus stays on the moved chat");
    assert.deepEqual((await calls()).picks, ["3"], "Space picks up instead of opening");
    key("Space");
    key("Up");
    key("Escape");
    await delay(200);
    assert.equal(await order(), "1* 2* 4 3", "Escape leaves the list as it was");

    // Collapsed, rows don't drag.
    await evaluate('document.querySelector("[aria-label=\\"Collapse sidebar\\"]").click()');
    await delay(400);
    await drag(await row(4), await row(1));
    assert.equal(await order(), "1* 2* 4 3", "a collapsed sidebar doesn't drag");

    console.log("PASS: drag and keyboard pin, reorder and unpin chats with undo; a click still opens; dropping on a chat links other Worktrees");
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
        name: "chat-pins-fixture",
        resolveId(id) {
          if (id === "/__chat_pins_fixture.tsx") return id;
        },
        load(id) {
          if (id === "/__chat_pins_fixture.tsx") return fixture;
        },
        configureServer(server) {
          server.middlewares.use(async (request, response, next) => {
            if (request.url !== "/__chat_pins__") return next();
            const html = await server.transformIndexHtml(
              request.url,
              '<html><body><div id="root"></div><script type="module" src="/__chat_pins_fixture.tsx"></script></body></html>',
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
    const child = spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__chat_pins__`], { env, stdio: "inherit" });
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
