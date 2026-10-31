// Real composer and its chip editor in Electron: skills in the draft are chips. No agent calls.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");

const fixture = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PromptComposer } from '/src/components/PromptComposer';
import { ChatMentionsContext } from '/src/components/ChatMentions';
import { PromptText } from '/src/components/PromptText';
import { MODEL_CATALOG, capabilityFor } from '/src/model';
import '/src/styles.css';
import { updateSettings } from '/src/lib/settings';
window.updateSettings = updateSettings;
const noop = () => {};
window.sent = [];
window.stops = 0;
window.milagre = { searchProjectFiles: async () => ['review.md'], listSkills: async root => ({ skills: root === '/other' ? [] : [
  { name: 'reorder', description: 'Gently put things in order', scope: 'bundled', provider: 'milagre', path: '/skills/reorder/SKILL.md' },
  { name: 'settle', description: 'Close out loose ends', scope: 'workspace', provider: 'claude', path: '/skills/settle/SKILL.md' },
  { name: 'tldr', description: 'Rewrite for a skimming reader', scope: 'bundled', provider: 'milagre', path: '/skills/tldr/SKILL.md' },
  ...['milagre','milagre-advisor','milagre-committee','milagre-help'].map(name => ({ name, description: 'Milagre orchestration and help', scope: 'bundled', provider: 'milagre', path: '/skills/' + name + '/SKILL.md' })),
  { name: 'plugin:review-code', description: 'Review code', scope: 'user', provider: 'codex', path: '/skills/review/SKILL.md' },
], warnings: [] }) };
function Fixture() {
  const [draft, setDraft] = useState('');
  const [root, setRoot] = useState('/fixture');
  const [expanded, setExpanded] = useState(false);
  const [suggestOptions, setSuggestOptions] = useState({});
  window.setSuggestOptions = setSuggestOptions;
  window.setDraft = setDraft;
  window.setProject = setRoot;
  window.setExpanded = setExpanded;
  const model = suggestOptions.provider ? MODEL_CATALOG.find(item => item.provider === suggestOptions.provider) : MODEL_CATALOG[0];
  const chats = root === '/other' ? [] : [{id: 12, title: 'Plan review', branch: 'feature', at: 12, available: true}, {id: 13, title: 'Current review', branch: 'main', at: 13, available: true}, {id: 14, title: 'Chat', branch: 'old', at: 14, available: false}];
  return <ChatMentionsContext value={{chats, project: '/fixture', currentId: 13, onOpen: key => window.opened = key}}><div style={{ width: '100%', maxWidth: 720, margin: '260px auto' }}>
    <PromptComposer projectPath={root} draft={draft} onDraftChange={setDraft}
      imageDraft={{ images: [], files: [], loading: false, error: '', onPaste: noop, remove: noop, removeFile: noop }}
      onSend={() => { window.sent.push(draft); setDraft(''); }} onStop={() => { window.stops++; }} sendBlocked={!!suggestOptions.blocked}
      suggestion={suggestOptions.text} running={!!suggestOptions.running} offlineName={suggestOptions.offline} reconnectingName={suggestOptions.reconnecting}
      models={MODEL_CATALOG} cliStatus={null} onModelPickerOpen={noop} selectedModel={model} onModelChange={noop}
      capability={capabilityFor(model, null)} onEffortChange={noop} ultracode={false} onUltracodeChange={noop}
      fastMode={false} onFastModeChange={noop} permissionMode="auto" onPermissionModeChange={noop} alwaysExpanded={expanded} />
    <div id='sent-mentions'><PromptText text='See @chat:12 @chat:14 @chat:999' skills={new Map()} files={() => false} /></div>
  </div></ChatMentionsContext>;
}
createRoot(document.getElementById('root')).render(<Fixture />);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", fs.mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-prompt-skills-")));
  await app.whenReady();
  const window = new BrowserWindow({ width: 1000, height: 700, show: false, webPreferences: { backgroundThrottling: false } });
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
  const editor = `document.querySelector('[data-prompt-editor]')`;
  // Sets the whole draft the way restored or pasted text arrives; the caret goes to the end.
  const type = async (text) => {
    await evaluate(`(() => { const input = ${editor}; input.focus(); input.value = ${JSON.stringify(text)}; })()`);
    await delay(100);
  };
  const escape = async () => {
    await evaluate(`${editor}.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
    await delay(100);
  };
  const screenshot = async (name) => {
    if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
    fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
    window.webContents.invalidate();
    await delay(250);
    // The first capture wakes a hidden window's compositor; save the next frame.
    await window.webContents.capturePage();
    await delay(100);
    fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, name + ".png"), (await window.webContents.capturePage()).toPNG());
  };
  // The skill chips in the field, as the source text each stands for.
  const highlighted = () => evaluate(`[...${editor}.querySelectorAll('[data-chip="skill"]')].map(el => el.parentElement.dataset.text)`);
  const chipPoint = (index) =>
    evaluate(
      `(() => { const rect = ${editor}.querySelectorAll('[data-chip="skill"]')[${index}].getClientRects()[0]; return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }; })()`,
    );
  try {
    await window.loadURL(process.argv[2]);
    await waitFor(`!!${editor}`);
    await type("/milagre");
    await waitFor(`document.querySelectorAll('[aria-label="Commands and skills"] button').length === 4`);
    assert.deepEqual(
      await evaluate(`[...document.querySelectorAll('[aria-label="Commands and skills"] button')].map(b => b.querySelector('span')?.textContent).sort()`),
      ["/milagre", "/milagre-advisor", "/milagre-committee", "/milagre-help"],
    );
    await screenshot("milagre-skills-menu");
    await type("run /tldr");
    await waitFor(`${editor}.querySelector('[data-chip="skill"]')?.textContent === 'Tldr'`);
    await escape();
    assert.deepEqual(await highlighted(), ["/tldr"], "The chip survives dismissal of the skill menu");
    assert.equal(await evaluate(`${editor}.querySelector('[data-chip="skill"]').getAttribute('aria-description')`), "Rewrite for a skimming reader");
    window.webContents.sendInputEvent({ type: "mouseMove", ...(await chipPoint(0)) });
    await waitFor(`document.querySelector('[role="tooltip"]')?.textContent === 'Rewrite for a skimming reader'`, "Hover gives the description");
    window.webContents.sendInputEvent({ type: "mouseMove", x: 1, y: 1 });
    await waitFor(`!document.querySelector('[role="tooltip"]')`, "Leaving the chip hides the description");
    assert.equal(await evaluate(`${editor}.value`), "run /tldr", "The draft keeps the command text");
    await screenshot("skill-chip-light");
    for (const dark of [false, true]) {
      await evaluate(`document.documentElement.classList.toggle('dark', ${dark})`);
      const colors = await evaluate(
        `(() => { const chip = ${editor}.querySelector('[data-chip="skill"]'); const input = ${editor}; return { skill: getComputedStyle(chip).color, text: getComputedStyle(input).color, caret: getComputedStyle(input).caretColor }; })()`,
      );
      assert.notEqual(colors.skill, colors.text, "Skill differs from ordinary text in each theme");
      assert.equal(colors.caret, colors.text, "Caret remains visible");
      await screenshot(dark ? "compact-dark" : "compact-light");
    }
    // A chip fits its line: the compact composer stays one line tall.
    assert.equal(await evaluate(`${editor}.getBoundingClientRect().height`), 28, "A chip doesn't grow the line");
    await type("/tl /unknown https://example.com/tldr /tldr/file");
    assert.deepEqual(await highlighted(), []);
    // Restored/pasted drafts must discover skills even when the caret menu stays dismissed.
    await evaluate(`window.setDraft('Use /tldr, then /plugin:review-code please.'); window.setExpanded(true)`);
    await waitFor(`${editor}.querySelectorAll('[data-chip="skill"]').length === 2`);
    assert.deepEqual(await highlighted(), ["/tldr", "/plugin:review-code"]);
    assert.equal(
      await evaluate(`${editor}.querySelectorAll('[data-chip="skill"]')[1].textContent`),
      "Review Code",
      "A plugin prefix is dropped from the label",
    );
    assert.equal(await evaluate(`${editor}.querySelectorAll('[data-chip="skill"]')[1].getAttribute('aria-description')`), "Review code");
    await screenshot("skill-chips-dark");
    // A press on a chip lands in the field.
    const point = await chipPoint(1);
    assert.equal(await evaluate(`!!document.elementFromPoint(${point.x}, ${point.y})?.closest('[data-prompt-editor]')`), true);
    window.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
    window.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
    await delay(100);
    assert.equal(await evaluate(`document.activeElement?.hasAttribute('data-prompt-editor')`), true);
    await screenshot("expanded-dark");
    await evaluate(`document.documentElement.classList.remove('dark')`);
    await screenshot("expanded-light");
    await type("/tl");
    await waitFor(`!!document.querySelector('[aria-label="Commands and skills"] button')`);
    // Ranking: the name that starts with the query first, then names that contain it, then description matches,
    // whatever group they sit in (reorder is listed before tldr and only matches by description).
    const ranked = () =>
      evaluate(
        `[...document.querySelectorAll('[aria-label="Commands and skills"] button')].map(b => b.querySelector('span')?.textContent).filter(name => ['/tldr', '/settle', '/reorder'].includes(name))`,
      );
    assert.deepEqual(await ranked(), ["/tldr", "/settle", "/reorder"], "/tl lists /tldr first, then the name match, then the description match");
    assert.equal(
      await evaluate(`document.querySelector('[aria-label="Commands and skills"] button span').textContent`),
      "/tldr",
      "the first row is the exact name prefix",
    );
    assert.equal(
      await evaluate(`document.querySelectorAll('[aria-label="Commands and skills"] [data-skill-group]').length`),
      0,
      "a search lists matches without group headings",
    );
    await evaluate(`document.querySelector('[aria-label="Commands and skills"] button').click()`);
    await waitFor(`${editor}.value === '/tldr '`);
    assert.deepEqual(await highlighted(), ["/tldr"], "Picker selection is a chip");
    // Real typing: Backspace after the chip takes all of it; a name the catalog doesn't know stays text.
    await evaluate(`(() => { const field = ${editor}; field.focus(); getSelection().collapse(field, 1); })()`);
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Backspace" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Backspace" });
    await waitFor(`${editor}.value === ' '`);
    await window.webContents.insertText("/unknown");
    await waitFor(`${editor}.value === '/unknown '`);
    assert.deepEqual(await highlighted(), [], "An unknown name is plain text");
    const longDraft = Array.from({ length: 20 }, (_, i) => "Line " + i + ": run /tldr and " + "wrapped text ".repeat(9)).join("\n");
    await type(longDraft);
    await escape();
    await window.setSize(530, 500);
    await delay(150);
    assert.deepEqual(await highlighted(), Array(20).fill("/tldr"));
    assert.equal(await evaluate(`${editor}.value`), longDraft, "A long draft round-trips exactly");
    const geometry = await evaluate(
      `(() => { const input = ${editor}; input.scrollTop = 120; return { height: input.clientHeight, content: input.scrollHeight, scroll: input.scrollTop }; })()`,
    );
    assert.equal(geometry.height, 100, "The field stops growing at 100px");
    assert.ok(geometry.content > 400, "and scrolls the rest");
    assert.equal(geometry.scroll, 120);
    await screenshot("wrapped-scrolled");
    await type("run /tldr");
    await escape();
    await evaluate(`${editor}.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`);
    await waitFor(`${editor}.value === ''`);
    assert.deepEqual(await evaluate("window.sent"), ["run /tldr"], "Sending preserves the exact command text");
    assert.deepEqual(await highlighted(), [], "Sending clears the chips");
    await type("run /tldr");
    await escape();
    await evaluate(`window.setProject('/other')`);
    await waitFor(`!${editor}.querySelector('[data-chip="skill"]')`);
    await evaluate(`window.setProject('/fixture')`);
    await type("@review");
    await waitFor(`document.querySelector('[aria-label="Project files and Chats"]')?.textContent.includes('Plan review')`);
    assert.ok(!(await evaluate(`document.querySelector('[aria-label="Project files and Chats"]').textContent`)).includes("Current review"));
    await evaluate(`[...document.querySelectorAll('[aria-label="Project files and Chats"] button')].find(b => b.textContent.includes('Plan review')).click()`);
    await waitFor(`${editor}.querySelector('[data-chip="chat"]')?.textContent === 'Plan review'`);
    assert.equal(await evaluate(`${editor}.value`), "@chat:12 ");
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('#sent-mentions [data-chip="chat"]')].map(el => [el.tagName, el.textContent])`), [
      ["BUTTON", "Plan review"],
      ["SPAN", "Chat"],
    ]);
    await evaluate(`document.querySelector('#sent-mentions button').click()`);
    assert.equal(await evaluate("window.opened"), "/fixture#12");
    await screenshot("chat-mentions");
    await evaluate(`window.setProject('/other')`);
    await waitFor(`!${editor}.querySelector('[data-chip="chat"]')`);
    await type("");
    await evaluate(`window.setProject('/fixture'); window.setSuggestOptions({ provider: 'claude', text: 'Add tests' });`);
    const suggestion = `document.querySelector('[data-prompt-suggestion]')`;
    await waitFor(`!!${suggestion}`);
    const key = (name, extra = "") =>
      evaluate(`${editor}.dispatchEvent(new KeyboardEvent('keydown', { key: '${name}', bubbles: true, cancelable: true ${extra} }))`);
    const sentBefore = await evaluate("window.sent.length");
    await key("Enter");
    assert.equal(await evaluate("window.sent.length"), sentBefore, "an unaccepted suggestion is never sent");
    assert.equal(await key("Tab", ", shiftKey: true"), true, "Shift+Tab keeps its focus behavior");
    await key("Tab");
    await waitFor(`${editor}.value === 'Add tests'`);
    assert.equal(await evaluate("window.sent.length"), sentBefore, "Tab only fills the draft");
    assert.equal(await evaluate("getSelection().anchorOffset"), 9, "acceptance places the caret at the end");
    await type("");
    await waitFor(`!!${suggestion}`);
    await key("ArrowRight");
    await waitFor(`${editor}.value === 'Add tests'`);
    for (const draft of [" ", "typing", "/tl"]) {
      await type(draft);
      await waitFor(`!${suggestion}`);
    }
    await key("Tab");
    await waitFor(`${editor}.value === '/tldr '`);
    for (const options of [{ running: true }, { blocked: true }, { offline: "QA Mac" }, { provider: "codex" }]) {
      await type("");
      await evaluate(`window.setSuggestOptions(${JSON.stringify({ provider: "claude", text: "Add tests", ...options })})`);
      await waitFor(`!${suggestion}`);
    }
    // Reconnecting and offline computers both leave the draft writable. Offline submits through Queue message;
    // a separate pending-send lock blocks submission without preventing edits to the next draft.
    await type("");
    await evaluate(`window.setSuggestOptions({ provider: "claude", reconnecting: "QA Mac" })`);
    await waitFor(`document.body.textContent.includes("reconnecting to QA Mac")`);
    assert.equal(await evaluate(`${editor}.isContentEditable`), true, "the draft stays writable while the computer reconnects");
    await type("still here");
    assert.equal(await evaluate(`${editor}.value`), "still here", "typing works while it reconnects");
    assert.equal(await evaluate(`document.querySelector('[aria-label="Send"]')?.disabled ?? null`), false, "Send stays open: the send waits for the computer");
    await evaluate(`window.setSuggestOptions({ provider: "claude", offline: "QA Mac", blocked: true })`);
    await waitFor(`!!document.querySelector('[aria-label="Queue message"]')`);
    assert.equal(await evaluate(`${editor}.isContentEditable`), true, "offline drafts stay editable even while a send is pending");
    assert.equal(await evaluate(`document.querySelector('[aria-label="Queue message"]').disabled`), true, "a pending send still blocks another submission");
    await type("save this while offline");
    assert.equal(await evaluate(`${editor}.value`), "save this while offline");
    await evaluate(`window.setSuggestOptions({ provider: "claude", offline: "QA Mac", running: true })`);
    await waitFor(`document.querySelector('[aria-label="Queue message"]')?.disabled === false`);
    assert.equal(
      await evaluate(`!!document.querySelector('[aria-label="Stop agent"]')`),
      false,
      "a cached running turn does not replace Queue message with Stop",
    );
    const sentBeforeQueue = await evaluate(`window.sent.length`);
    await evaluate(`document.querySelector('[aria-label="Queue message"]').click()`);
    await waitFor(`window.sent.length === ${sentBeforeQueue + 1} && ${editor}.value === ""`);
    assert.equal(await evaluate(`window.sent.at(-1)`), "save this while offline", "Queue message submits the offline draft");
    assert.equal(await evaluate(`window.stops`), 0, "queuing never tries to stop the offline agent");
    await evaluate(`window.setSuggestOptions({ provider: "claude" })`);
    await type("");
    const beforeDictation = await evaluate("window.sent.length");
    await evaluate(`window.deliverTranscript('review this', { selection: { start: 0, end: 0 } })`);
    await waitFor(`${editor}.value === 'review this'`);
    assert.equal(await evaluate("window.sent.length"), beforeDictation, "default dictation only pastes");
    await evaluate(`window.updateSettings({ dictationAction: 'send' })`);
    await delay(100);
    await evaluate(`window.deliverTranscript('please', { selection: { start: 11, end: 11 } })`);
    await waitFor(`window.sent.length === ${beforeDictation + 1}`);
    assert.equal(await evaluate("window.sent.at(-1)"), "review this please", "automatic send uses the completed draft");
    await waitFor(`${editor}.value === ''`);
    await evaluate(`window.deliverTranscript('   ', { selection: { start: 0, end: 0 } })`);
    await delay(100);
    assert.equal(await evaluate("window.sent.length"), beforeDictation + 1, "empty speech never sends");
    await evaluate(`window.setSuggestOptions({ blocked: true })`);
    await delay(100);
    await evaluate(`window.deliverTranscript('keep this draft', { selection: { start: 0, end: 0 } })`);
    await waitFor(`${editor}.value === 'keep this draft'`);
    assert.equal(await evaluate("window.sent.length"), beforeDictation + 1, "blocked send preserves the transcript");
    await evaluate(`window.setSuggestOptions({})`);
    await delay(100);
    assert.equal(await evaluate("window.sent.length"), beforeDictation + 1, "unblocking does not send an old transcript");
    assert.deepEqual(errors, []);
    console.log(
      "PASS: typed and picked skills are chips with descriptions, both themes, one-line fit, Backspace over a chip, wrapped/scrolled drafts, exact send and catalog isolation",
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.error(errors);
    console.error(
      await evaluate(
        `({ value: ${editor}?.value, html: ${editor}?.innerHTML.slice(0, 300), menu: document.querySelector('[data-picker-panel]')?.textContent, active: document.activeElement?.outerHTML.slice(0, 80), sel: getSelection().anchorNode?.nodeName + ':' + getSelection().anchorOffset })`,
      ).catch(() => null),
    );
    app.exit(1);
  }
}

async function main() {
  const { createServer } = await import("vite");
  const server = await createServer({
    configFile: path.resolve(__dirname, "../apps/desktop/vite.config.ts"),
    cacheDir: path.resolve(__dirname, "../node_modules/.vite-prompt-skills"),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "dictation-delivery-fixture",
        enforce: "pre",
        resolveId(id) {
          if (id === "./useDictation") return "\0dictation-fixture";
        },
        load(id) {
          if (id !== "\0dictation-fixture") return;
          return `import { useEffect } from 'react';
            export function useDictation(cwd, scope, deliver) {
              useEffect(() => { window.deliverTranscript = deliver; });
              return { phase: 'idle', error: null, download: null, partial: { text: '', settled: 0 }, meter: { current: null }, start() {}, stop() {}, cancel() {}, dismiss() {}, openSettings() {} };
            }`;
        },
      },
      {
        name: "prompt-skills-fixture",
        resolveId(id) {
          if (id === "/__prompt-skills.tsx") return id;
        },
        load(id) {
          if (id === "/__prompt-skills.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url !== "/__prompt-skills") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await server.transformIndexHtml(
                request.url,
                '<html><body><div id="root"></div><script type="module" src="/__prompt-skills.tsx"></script></body></html>',
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
    const child = require("node:child_process").spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__prompt-skills`], {
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
