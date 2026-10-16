// Settings › Chat in Electron: Detail level holds Always expand reasoning, which opens thinking rows until they are
// toggled, and Tool call display, whose Full detail shows a reply's tool calls one row each instead of folding them
// into one line. A window that had Murilo mode on opens on Full detail.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const fixture = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SettingsNav, SettingsPanel } from '/src/components/Settings';
import { ActivityBlock } from '/src/components/agents/ActivityBlock';
import '/src/styles.css';
window.milagre = {
  listEditors: async () => [],
  listRecentProjects: async () => [],
  listProjects: async () => [],
};
const step = (id, title, kind = 'shell', detail) => ({ id, kind, title, status: 'done', note: '1s', detail });
const entries = [
  { type: 'step', step: step('a', 'Ran \`npm test\`') },
  { type: 'text', text: 'Tests pass. Checking the build next.' },
  { type: 'step', step: step('b', 'Thought for 4s', 'thinking', 'Weighing the two fixes before touching the build.') },
  { type: 'step', step: step('c', 'Read \`package.json\`', 'read') },
];
const lone = [{ type: 'step', step: step('d', 'Thought for 2s', 'thinking', 'Only one way to read this config.') }];
function Fixture() {
  const [section, setSection] = useState('appearance');
  return (
    <div style={{ display: 'flex', gap: 12, height: '100vh', padding: 12 }}>
      <SettingsNav section={section} onSelect={setSection} onSelectProject={() => {}} onBack={() => {}} showProjectSettings={false} />
      <main style={{ flex: 1, minWidth: 0 }}><SettingsPanel section={section} models={[]} update={null} /></main>
      <aside style={{ width: 340, display: 'grid', alignContent: 'start', gap: 16 }}>
        <div data-reply="many"><ActivityBlock entries={entries} /></div>
        <div data-reply="lone"><ActivityBlock entries={lone} /></div>
      </aside>
    </div>
  );
}
createRoot(document.getElementById('root')).render(<Fixture />);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", fs.mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-chat-settings-")));
  await app.whenReady();
  const window = new BrowserWindow({ width: 1200, height: 700, show: false, webPreferences: { backgroundThrottling: false } });
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  const errors = [];
  window.webContents.on("console-message", (details) => {
    if (details.level === "error") errors.push(details.message);
  });
  const waitFor = async (source) => {
    for (let i = 0; i < 200; i++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw Error("Timed out: " + source);
  };
  const screenshot = async (name) => {
    if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
    fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
    window.webContents.invalidate();
    await delay(250);
    fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, name + ".png"), (await window.webContents.capturePage()).toPNG());
  };
  const openChat = async () => {
    await waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Chat')`);
    await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Chat').click()`);
    await waitFor(`!!${trigger}`);
  };
  const reasoning = `document.querySelector('[role="switch"][aria-label="Always expand reasoning"]')`;
  const trigger = `document.querySelector('button[aria-label="Tool call display"]')`;
  const option = (label) =>
    `[...document.querySelectorAll('[role="listbox"][aria-label="Tool call display"] [role="option"]')].find((o) => o.textContent.includes(${JSON.stringify(label)}))`;
  const reply = (which, selector = "") => `document.querySelector('[data-reply=${which}] ${selector}')`;
  const shows = (which, text) => `${reply(which)}.innerText.includes(${JSON.stringify(text)})`;
  const saved = () => evaluate(`JSON.parse(localStorage.getItem("milagre-settings") ?? "{}")`);
  try {
    await window.loadURL(process.argv[2]);
    await openChat();
    assert.equal(await evaluate(`document.querySelector('h1').textContent`), "Chat");
    assert.ok(await evaluate(`document.body.innerText.includes("Detail level")`), "one Detail level group");
    assert.equal(await evaluate(`${reasoning}.getAttribute("aria-checked")`), "false", "reasoning starts folded");
    assert.equal(await evaluate(`${trigger}.textContent.trim()`), "Compact", "tool calls start compact");
    assert.equal(await evaluate(`!!${reply("many", "[data-slot=activity]")}`), true, "Compact folds the activity into one line");
    assert.equal(await evaluate(shows("lone", "Only one way")), false, "a thinking row starts closed");
    await screenshot("chat-settings-default");

    await evaluate(`${reasoning}.click()`);
    await waitFor(shows("lone", "Only one way"));
    assert.equal((await saved()).expandReasoning, true, "Always expand reasoning is saved");
    await screenshot("chat-settings-expand-reasoning");

    await evaluate(`${trigger}.click()`);
    await waitFor(`!!${option("Full detail")}`);
    await screenshot("chat-settings-tool-call-menu");
    await evaluate(`${option("Full detail")}.click()`);
    await waitFor(`!!${reply("many", "[data-slot=activity-inline]")}`);
    assert.equal(await evaluate(`!!${reply("many", "[data-slot=activity]")}`), false, "Full detail leaves no fold");
    const text = await evaluate(`${reply("many")}.innerText`);
    for (const shown of ["npm test", "Tests pass. Checking the build next.", "Weighing the two fixes", "package.json"])
      assert.ok(text.includes(shown), `shows ${shown} in the chat`);
    assert.ok(text.indexOf("npm test") < text.indexOf("Tests pass") && text.indexOf("Tests pass") < text.indexOf("Weighing"), "in order");
    assert.equal((await saved()).toolCallDisplay, "full", "Full detail is saved");
    await screenshot("chat-settings-full-detail");

    // A click folds an expanded thinking row; the setting only sets where it starts.
    await evaluate(`${reply("lone", "[data-slot=step] button")}.click()`);
    await waitFor(`!(${shows("lone", "Only one way")})`);
    assert.equal(await evaluate(`${reasoning}.getAttribute("aria-checked")`), "true");

    // Murilo mode, the Experimental switch this replaces, opens on Full detail.
    await evaluate(`localStorage.setItem("milagre-settings", JSON.stringify({ muriloMode: true }))`);
    await window.loadURL(process.argv[2]);
    await openChat();
    assert.equal(await evaluate(`${trigger}.textContent.trim()`), "Full detail", "Murilo mode on reads as Full detail");
    assert.equal(await evaluate(`!!${reply("many", "[data-slot=activity-inline]")}`), true);
    assert.deepEqual(errors, []);
    console.log(
      "PASS: Settings › Chat lists Always expand reasoning and Tool call display under Detail level, folded and Compact by default; reasoning opens thinking rows until clicked; Full detail shows each tool call, thinking and note in order with no fold; both save; Murilo mode reads as Full detail",
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.error(errors);
    app.exit(1);
  }
}

async function main() {
  const { createServer } = await import("vite");
  const server = await createServer({
    configFile: path.resolve(__dirname, "../apps/desktop/vite.config.ts"),
    cacheDir: path.resolve(__dirname, "../node_modules/.vite-chat-settings"),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "chat-settings-fixture",
        resolveId(id) {
          if (id === "/__chat-settings.tsx") return id;
        },
        load(id) {
          if (id === "/__chat-settings.tsx") return fixture;
        },
        configureServer(server) {
          server.middlewares.use(async (request, response, next) => {
            if (request.url !== "/__chat-settings") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await server.transformIndexHtml(
                request.url,
                '<html><body><div id="root"></div><script type="module" src="/__chat-settings.tsx"></script></body></html>',
              ),
            );
          });
        },
      },
    ],
  });
  try {
    await server.listen();
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = require("node:child_process").spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__chat-settings`], {
      env,
      stdio: "inherit",
    });
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
  if (process.versions.electron) require("electron").app.exit(1);
  else process.exitCode = 1;
});
