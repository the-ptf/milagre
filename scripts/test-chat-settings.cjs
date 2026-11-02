// Settings › Chat in Electron: Chat list, Reasoning and Tool calls are each two picture cards in a radio group. Expanded
// reasoning opens thinking rows until they are toggled, and Full detail shows a reply's tool calls one row each instead
// of folding them into one line. A window that had Murilo mode on opens on Full detail.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");

const fixture = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SettingsNav, SettingsPanel } from '/src/components/Settings';
import { ActivityBlock } from '/src/components/agents/ActivityBlock';
import '/src/styles.css';
let contextSettings = {buttonThreshold: 70, autoThreshold: 85, autoCompact: false};
window.milagre = {
  readContextSettings: async () => contextSettings,
  saveContextSettings: async (patch) => (contextSettings = {...contextSettings, ...patch}),
  listEditors: async () => [],
  listRecentProjects: async () => [],
  listProjects: async () => [],
  dictation: {
    status: async () => [{ id: 'large-v3-turbo', ready: true, size: 574041195, received: null }],
    download: async () => {},
    cancel: async () => {},
    remove: async () => {},
    onModel: () => () => {},
  },
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
    await waitFor(`!!${card("Tool calls", "Compact")}`);
  };
  const card = (group, label) => `document.querySelector('[role="radiogroup"][aria-label="${group}"] [role="radio"][aria-label="${label}"]')`;
  const checked = (group) =>
    `document.querySelector('[role="radiogroup"][aria-label="${group}"] [role="radio"][aria-checked="true"]')?.getAttribute("aria-label")`;
  const reply = (which, selector = "") => `document.querySelector('[data-reply=${which}] ${selector}')`;
  const shows = (which, text) => `${reply(which)}.innerText.includes(${JSON.stringify(text)})`;
  const saved = () => evaluate(`JSON.parse(localStorage.getItem("milagre-settings") ?? "{}")`);
  try {
    await window.loadURL(process.argv[2]);
    await openChat();
    assert.equal(await evaluate(`document.querySelector('h1').textContent`), "Chat");
    assert.equal(
      await evaluate(`document.querySelectorAll('[role="radiogroup"]:not([aria-label="Speech model"]) [role="radio"]').length`),
      10,
      "five settings, two choices each",
    );
    assert.equal(await evaluate(checked("How the shortcut works")), "Hold to talk");
    await evaluate(`${card("How the shortcut works", "Press to start, press to stop")}.click()`);
    await waitFor(`${checked("How the shortcut works")} === 'Press to start, press to stop'`);
    assert.equal((await saved()).dictationShortcutMode, "toggle");
    await evaluate(`${card("How the shortcut works", "Hold to talk")}.click()`);
    assert.equal(await evaluate("document.querySelector('[aria-label=\"Fix names with AI\"]').getAttribute('aria-checked')"), "true");
    await evaluate("document.querySelector('[aria-label=\"Fix names with AI\"]').click()");
    await waitFor("document.querySelector('[aria-label=\"Fix-up model\"]').disabled");
    assert.equal((await saved()).dictationFixUp, false);
    await evaluate("document.querySelector('[aria-label=\"Fix names with AI\"]').click()");
    await waitFor("!document.querySelector('[aria-label=\"Fix-up model\"]').disabled");
    // Speech model: four models named for what they're good at, the best any-language one by default.
    assert.equal(await evaluate(`document.querySelectorAll('[role="radiogroup"][aria-label="Speech model"] [role="radio"]').length`), 4);
    assert.equal(await evaluate(checked("Speech model")), "Best, any language");
    await evaluate(`${card("Speech model", "Best for English")}.click()`);
    assert.equal((await saved()).dictationModel, "medium-en", "the picked speech model is saved");
    await waitFor(`document.querySelector('[aria-label="Dictation language"]')?.disabled === true`);
    await evaluate(`${card("Speech model", "Best, any language")}.click()`);
    assert.equal((await saved()).dictationModel, "large-v3-turbo");
    await waitFor(`document.querySelector('[aria-label="Dictation language"]')?.disabled === false`);
    assert.equal(await evaluate(checked("Reasoning")), "Folded", "reasoning starts folded");
    assert.equal(await evaluate(checked("Tool calls")), "Compact", "tool calls start compact");
    assert.equal(await evaluate(`!!${reply("many", "[data-slot=activity]")}`), true, "Compact folds the activity into one line");
    assert.equal(await evaluate(shows("lone", "Only one way")), false, "a thinking row starts closed");
    assert.equal(await evaluate(checked("Chat list")), "One list", "the sidebar lists Chats in one list by default");
    assert.equal(await evaluate(checked("When dictation finishes")), "Paste text", "dictation defaults to review before sending");
    await evaluate(`${card("When dictation finishes", "Send now")}.click()`);
    assert.equal((await saved()).dictationAction, "send", "automatic send is saved");
    await window.loadURL(process.argv[2]);
    await openChat();
    assert.equal(await evaluate(checked("When dictation finishes")), "Send now", "dictation choice survives reload");
    await evaluate(`${card("When dictation finishes", "Paste text")}.click()`);
    assert.equal((await saved()).dictationAction, "paste");
    await evaluate(`${card("When dictation finishes", "Paste text")}.scrollIntoView({ block: "center" })`);
    await screenshot("chat-settings-default");
    const contextSwitch = 'document.querySelector(\'[role="checkbox"][aria-label="Show context size"]\')';
    assert.equal(await evaluate(`${contextSwitch}.getAttribute("aria-checked")`), "true");
    await evaluate(`${contextSwitch}.click()`);
    assert.equal((await saved()).showContextSize, false, "context size visibility is saved");
    const belowSwitch = 'document.querySelector(\'[role="checkbox"][aria-label="Show Compact below threshold"]\')';
    assert.equal(await evaluate(`${belowSwitch}.getAttribute("aria-checked")`), "false");
    await evaluate(`${belowSwitch}.click()`);
    assert.equal((await saved()).compactButtonDisplay, "always", "below-threshold visibility is saved");
    await waitFor(`document.querySelector('[aria-label="Auto compact quietly"]').disabled === false`);
    await evaluate(`document.querySelector('[aria-label="Auto compact quietly"]').click()`);
    await waitFor(`document.querySelector('[aria-label="Auto compact quietly"]').getAttribute("aria-checked") === "true"`);
    await evaluate(`document.querySelector('[aria-label="Increase automatic threshold"]').click()`);
    await waitFor(`document.querySelector('[aria-label="Auto compact threshold percentage"]').value === "86"`);
    await screenshot("chat-settings-context");
    await window.reload();
    await openChat();
    assert.equal(await evaluate(`${contextSwitch}.getAttribute("aria-checked")`), "false", "context visibility survives reload");
    assert.equal(await evaluate(`${belowSwitch}.getAttribute("aria-checked")`), "true");
    // The arrow keys move the choice between a group's cards, as in any radio group.
    // A card takes the choice when focus lands on it, which needs the page focused.
    window.webContents.focus();
    await evaluate(`${card("Chat list", "One list")}.focus()`);
    await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }))`);
    await waitFor(`${checked("Chat list")} === "By Project"`);
    assert.equal((await saved()).chatList, "grouped", "By Project is saved");

    await evaluate(`${card("Reasoning", "Expanded")}.click()`);
    await waitFor(shows("lone", "Only one way"));
    assert.equal((await saved()).expandReasoning, true, "Expanded reasoning is saved");
    await screenshot("chat-settings-expand-reasoning");

    await evaluate(`${card("Tool calls", "Full detail")}.click()`);
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
    assert.equal(await evaluate(checked("Reasoning")), "Expanded");

    // Murilo mode, the Experimental switch this replaces, opens on Full detail.
    await evaluate(`localStorage.setItem("milagre-settings", JSON.stringify({ muriloMode: true }))`);
    await window.loadURL(process.argv[2]);
    await openChat();
    assert.equal(await evaluate(checked("Tool calls")), "Full detail", "Murilo mode on reads as Full detail");
    assert.equal(await evaluate(`!!${reply("many", "[data-slot=activity-inline]")}`), true);
    assert.deepEqual(errors, []);
    console.log(
      "PASS: Settings › Chat shows Chat list, Reasoning and Tool calls as card radio groups on One list, Folded and Compact; arrow keys pick By Project and save it; Expanded opens thinking rows until clicked; Full detail shows each tool call, thinking and note in order with no fold; both save; Murilo mode reads as Full detail",
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
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
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
