// The desktop composer's chip editor in the real App: skills and @files are atomic chips while the draft stays plain
// text. Typing, picking, Backspace over a chip, undo, paste, IME composition, history recall, a restored draft and send.
// Fake bridge, no agent calls.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const fixture = `
// This fixture exercises a device that has already accepted AI sharing.
import { AI_CONSENT_VERSION } from "@milagre/shared/ai-consent";
localStorage.setItem("milagre.ai-sharing-consent", AI_CONSENT_VERSION);
import React from 'react';
import { createRoot } from 'react-dom/client';
import '/src/styles.css';
const state = { next_id: 1, projects: { 1: { id: 1, name: 'Milagre' } }, worktrees: {}, sessions: {}, connections: {}, events: [], messages: [], approvals: [], tasks: {}, artifacts: {}, outputs: [], conflicts: [] };
state.worktrees = { 1: { id: 1, name: 'main', path: '/fixture', project_id: 1 } };
state.sessions = { 3: { id: 3, worktree_id: 1, agent_name: 'Claude', provider: 'claude', status: 'Idle' } };
state.messages = [{ id: 4, session_id: 3, role: 'user', body: 'Chips chat', context: null }];
state.next_id = 5;
window.calls = []; window.searches = []; window.listeners = [];
window.milagre = new Proxy({
  getRuntimeConnection: async () => ({ connected: true }),
  getAgentPorts: async () => ({}),
  getLinkedWork: async () => ({ delegations: [], negotiations: [], receiveOnly: [] }),
  getCurrentProject: async () => ({ path: '/fixture', name: 'Milagre', state }),
  listRecentProjects: async () => [], listBranches: async () => ['main'], listEditors: async () => [],
  getCachedUsage: async () => ({ providers: [] }), readUsage: async () => ({ providers: [] }), getUpdateState: async () => ({ status: 'idle' }),
  listSkills: async () => ({ skills: [{ name: 'tldr', description: 'Rewrite for a skimming reader', path: '/skills/tldr/SKILL.md', scope: 'bundled', provider: 'milagre' }], warnings: [] }),
  searchProjectFiles: async (root, query) => { window.searches.push({ root, query }); return ['src/my app.ts', 'src/model.ts'].filter(p => p.includes(query)); },
  sendMessage: async request => {
    window.calls.push(request);
    const message = { id: state.next_id, session_id: request.sessionId, body: request.body, images: request.images, ...(request.files.length ? { files: request.files } : {}), context: null, role: 'user', model: request.model };
    Object.assign(state, { next_id: state.next_id + 1, messages: [...state.messages, message] });
    window.listeners.forEach(fn => fn({ chatId: '/fixture#' + request.sessionId, event: { type: 'message-sent', model: request.model }, state: { ...state } }));
    window.listeners.forEach(fn => fn({ chatId: '/fixture#' + request.sessionId, event: { type: 'turn-completed' }, state: { ...state } }));
    return { sessionId: request.sessionId };
  },
  onAgentEvent: fn => { window.listeners.push(fn); return () => { window.listeners = window.listeners.filter(x => x !== fn); }; },
}, { get(target, key) { return target[key] ?? (String(key).startsWith('on') ? () => () => {} : async () => null); } });
localStorage.setItem('milagre-settings', JSON.stringify({ theme: 'light' }));
const { default: App } = await import('/src/App');
createRoot(document.getElementById('root')).render(<App />);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", fs.mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-composer-chips-")));
  await app.whenReady();
  const window = new BrowserWindow({
    width: 1000,
    height: 760,
    show: false,
    webPreferences: { partition: "composer-chips-test", backgroundThrottling: false },
  });
  const errors = [];
  window.webContents.on("console-message", (details) => {
    if (details.level === "error") errors.push(details.message);
  });
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  const waitFor = async (source, what = source) => {
    for (let n = 0; n < 200; n++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw Error("Timed out: " + what);
  };
  const editor = `document.querySelector('[data-prompt-editor]')`;
  const draft = () => evaluate(`${editor}.value`);
  const draftIs = (text) => waitFor(`${editor}?.value === ${JSON.stringify(text)}`, `draft is ${JSON.stringify(text)}`);
  const chips = (kind) => evaluate(`[...${editor}.querySelectorAll('[data-chip="${kind}"]')].map(chip => chip.querySelector(".truncate").textContent)`);
  // Real key presses, as the keyboard sends them: they reach the field as keydown and then beforeinput.
  const press = async (keyCode, modifiers = []) => {
    window.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    // Enter and printable keys edit on the char event that follows keydown.
    if ((keyCode.length === 1 || keyCode === "Return") && !modifiers.includes("meta"))
      window.webContents.sendInputEvent({ type: "char", keyCode: keyCode === "Return" ? "\r" : keyCode, modifiers });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
    await delay(60);
  };
  const typeText = async (text) => {
    for (const char of text) {
      await window.webContents.insertText(char);
      await delay(15);
    }
    await delay(80);
  };
  const keydown = (key, extra = {}) =>
    evaluate(
      `${editor}.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true, ...${JSON.stringify(extra)} }))`,
    );
  // The caret as an offset into the draft: chips count as their source text, line breaks as one character.
  const caret = () =>
    evaluate(`(() => {
      const s = getSelection(); const r = document.createRange(); r.selectNodeContents(${editor}); r.setEnd(s.focusNode, s.focusOffset);
      const copy = r.cloneContents();
      copy.querySelectorAll('[data-text]').forEach(chip => chip.replaceWith(chip.dataset.text));
      copy.querySelectorAll('br').forEach(br => br.replaceWith('\\n'));
      return copy.textContent.replace(/\u200B/g, '').length;
    })()`);
  // A click's worth of caret placement: before everything, or before the closing line break.
  const caretTo = (where) =>
    evaluate(`(() => { const field = ${editor}; getSelection().collapse(field, ${where === "start" ? 0 : "field.childNodes.length - 1"}); })()`).then(() =>
      delay(60),
    );
  // A skill chip and a file chip on one line share their box (top and height within 0.5px) and sit centred on the line of
  // text around them (within 1px of the centre of the first text node's line).
  const assertAligned = async (scope, label) => {
    const boxes = await evaluate(`(() => {
      const scope = ${scope};
      const box = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, height: r.height, centre: r.top + r.height / 2 }; };
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, { acceptNode: (n) => n.parentElement.closest('[data-chip]') || !n.nodeValue.trim() ? NodeFilter.FILTER_SKIP : NodeFilter.FILTER_ACCEPT });
      const text = walker.nextNode(); const range = document.createRange(); range.selectNodeContents(text);
      return { skill: box(scope.querySelector('[data-chip="skill"]')), file: box(scope.querySelector('[data-chip="file"]')), text: box(range) };
    })()`);
    assert.ok(Math.abs(boxes.skill.top - boxes.file.top) <= 0.5, `${label}: chips share a top ${JSON.stringify(boxes)}`);
    assert.ok(Math.abs(boxes.skill.height - boxes.file.height) <= 0.5, `${label}: chips share a height ${JSON.stringify(boxes)}`);
    for (const kind of ["skill", "file"])
      assert.ok(Math.abs(boxes[kind].centre - boxes.text.centre) <= 1, `${label}: the ${kind} chip is centred on the text line ${JSON.stringify(boxes)}`);
  };
  const screenshot = async (name) => {
    const dir = process.env.MILAGRE_SCREENSHOT_DIR;
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    window.webContents.invalidate();
    await delay(250);
    await window.webContents.capturePage();
    await delay(100);
    fs.writeFileSync(path.join(dir, name + ".png"), (await window.webContents.capturePage()).toPNG());
  };
  try {
    await window.loadURL(process.argv[2]);
    window.webContents.focus();
    const row = `[...document.querySelectorAll('aside [data-row]')].find(row => row.textContent.includes('Chips chat'))`;
    await waitFor(`!!(${row})`, "the Chat row");
    await evaluate(`(${row}).click()`);
    await waitFor(`!!${editor}`, "the prompt editor");
    assert.equal(await evaluate(`${editor}.getAttribute('aria-label')`), "Prompt");
    assert.equal(await evaluate(`${editor}.getAttribute('contenteditable')`), "true");
    await evaluate(`${editor}.focus()`);

    // Typing and a / pick: one skill chip, the draft as plain text.
    await typeText("use /tl");
    await draftIs("use /tl");
    await waitFor(`document.querySelector('[aria-label="Commands and skills"]')?.textContent.includes('/tldr')`, "the skill menu");
    await keydown("Enter");
    await draftIs("use /tldr ");
    assert.deepEqual(await chips("skill"), ["Tldr"]);
    assert.equal(await evaluate(`${editor}.querySelector('[data-chip="skill"]').title`), "Rewrite for a skimming reader", "hover shows the description");
    assert.equal(await evaluate(`${editor}.querySelector('[data-chip][data-text]').getAttribute('contenteditable')`), "false", "a chip is atomic");
    assert.equal(await caret(), "use /tldr ".length, "the caret lands after the pick");
    console.log("PASS: typing and a / pick make one skill chip");

    // An @ pick: a file chip, the quoted mention in the draft, one attachment.
    await typeText("@my");
    await waitFor(`document.querySelector('[aria-label="Project files"]')?.textContent.includes('my app.ts')`, "the file menu");
    await keydown("Enter");
    await draftIs('use /tldr @"src/my app.ts" ');
    assert.deepEqual(await chips("file"), ["my app.ts"]);
    assert.equal(await evaluate(`${editor}.querySelector('[data-chip="file"]').title`), "src/my app.ts");
    await waitFor(`document.querySelectorAll('[data-promptbar] [aria-label="Remove my app.ts"]').length === 1`, "one attachment");
    await assertAligned(editor, "composer");
    assert.equal(await evaluate(`${editor}.querySelector('[data-chip="skill"] svg')`), null, "a skill chip has no icon");
    await screenshot("composer-chips");
    console.log("PASS: an @ pick makes a file chip, writes the mention and attaches the file once");

    // Backspace after the chip takes the whole chip and its attachment; ⌘Z brings both back.
    await press("Backspace");
    await draftIs('use /tldr @"src/my app.ts"');
    await press("Backspace");
    await draftIs("use /tldr ");
    assert.deepEqual(await chips("file"), []);
    await waitFor(`!document.querySelector('[data-promptbar] [aria-label="Remove my app.ts"]')`, "the attachment goes with the chip");
    await press("z", ["meta"]);
    await draftIs('use /tldr @"src/my app.ts"');
    assert.deepEqual(await chips("file"), ["my app.ts"]);
    await waitFor(`document.querySelectorAll('[data-promptbar] [aria-label="Remove my app.ts"]').length === 1`, "undo attaches the file again");
    await press("z", ["meta", "shift"]);
    await draftIs("use /tldr ");
    await press("z", ["meta"]);
    await draftIs('use /tldr @"src/my app.ts"');
    // Arrow keys step over a chip as one character.
    await press("Left");
    assert.equal(await caret(), "use /tldr ".length, "Left steps over the whole chip");
    await press("Right");
    assert.equal(await caret(), 'use /tldr @"src/my app.ts"'.length);
    console.log("PASS: Backspace removes a chip and its attachment, ⌘Z and ⌘⇧Z undo and redo it, arrows step over it");

    // Paste is plain text: HTML is stripped.
    await evaluate(
      `(() => { const data = new DataTransfer(); data.setData('text/html', '<b>hi</b>'); ${editor}.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })); })()`,
    );
    await draftIs('use /tldr @"src/my app.ts"hi');
    await evaluate(
      `(() => { const data = new DataTransfer(); data.setData('text/plain', ' and\\r\\nmore'); data.setData('text/html', '<i>ignored</i>'); ${editor}.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })); })()`,
    );
    await draftIs('use /tldr @"src/my app.ts"hi and\nmore');
    await press("z", ["meta"]);
    await draftIs('use /tldr @"src/my app.ts"hi');
    console.log("PASS: paste inserts plain text, one undo step each");

    // Copying a selection with chips copies the plain text.
    const copied = await evaluate(`(() => {
      const range = document.createRange(); range.selectNodeContents(${editor});
      getSelection().removeAllRanges(); getSelection().addRange(range);
      const data = new DataTransfer();
      ${editor}.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data }));
      return data.getData('text/plain');
    })()`);
    assert.equal(copied, 'use /tldr @"src/my app.ts"hi');
    await caretTo("end");

    // IME: a real composition through DevTools, then synthetic events. Enter while composing doesn't send.
    window.webContents.debugger.attach("1.3");
    await window.webContents.debugger.sendCommand("Input.imeSetComposition", { text: "にほん", selectionStart: 3, selectionEnd: 3 });
    await delay(100);
    await evaluate(`${editor}.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true }))`);
    await window.webContents.debugger.sendCommand("Input.insertText", { text: "日本" });
    await draftIs('use /tldr @"src/my app.ts"hi日本');
    window.webContents.debugger.detach();
    await evaluate(`(() => {
      const field = ${editor};
      field.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
      field.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: 'にほん' }));
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true }));
      field.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '日本' }));
    })()`);
    await draftIs('use /tldr @"src/my app.ts"hi日本日本');
    await delay(150);
    assert.equal(await draft(), 'use /tldr @"src/my app.ts"hi日本日本', "each composition lands once");
    assert.equal(await evaluate("window.calls.length"), 0, "Enter during a composition doesn't send");
    assert.deepEqual(await chips("skill"), ["Tldr"]);
    assert.deepEqual(await chips("file"), ["my app.ts"]);
    console.log("PASS: IME compositions commit once, and Enter while composing doesn't send");

    // Shift+Enter is a line break; Up on a later line moves the caret, not through history.
    await press("Return", ["shift"]);
    await typeText("x");
    await draftIs('use /tldr @"src/my app.ts"hi日本日本\nx');
    assert.equal(await evaluate("window.calls.length"), 0);
    await keydown("ArrowUp");
    assert.equal(await draft(), 'use /tldr @"src/my app.ts"hi日本日本\nx', "Up on the second line stays in the draft");

    // Enter sends the plain text and attaches the chip's file; the sent message shows the chips.
    await keydown("Enter");
    await waitFor("window.calls.length === 1", "the send");
    const sent = await evaluate("window.calls[0]");
    assert.equal(sent.body, 'use /tldr @"src/my app.ts"hi日本日本\nx');
    assert.deepEqual(sent.files, ["/fixture/src/my app.ts"]);
    await draftIs("");
    await waitFor(`!!document.querySelector('article [data-chip="file"]')`, "the sent file chip");
    assert.equal(await evaluate(`document.querySelector('article [data-chip="file"] .truncate').textContent`), "my app.ts");
    assert.equal(await evaluate(`!!document.querySelector('article [data-chip="skill"]')`), true);
    await assertAligned(`[...document.querySelectorAll('article')].find(a => a.querySelector('[data-chip="file"]'))`, "sent message");
    console.log("PASS: Enter sends the exact text with the file attached, and the sent message shows the chips");

    // Up on the first line recalls the sent prompt, chips and all.
    await evaluate(`${editor}.focus()`);
    await keydown("ArrowUp");
    await draftIs('use /tldr @"src/my app.ts"hi日本日本\nx');
    await waitFor(`${editor}.querySelectorAll('[data-chip="file"]').length === 1`, "recalled chips");
    await keydown("ArrowDown");
    await keydown("ArrowDown");
    await draftIs("");
    console.log("PASS: Up on the first line recalls history, Down restores the draft");

    // A draft the composer didn't type (restored, from the phone): its mention becomes a chip once the search finds the file.
    await evaluate(`${editor}.value = 'fix @src/model.ts'`);
    await draftIs("fix @src/model.ts");
    await waitFor(`${editor}.querySelector('[data-chip="file"] .truncate')?.textContent === 'model.ts'`, "the restored mention's chip");
    assert.ok(await evaluate(`window.searches.some(s => s.query === 'src/model.ts' && s.root === '/fixture')`), "looked up in the Project");
    await waitFor(`!!document.querySelector('[data-promptbar] [aria-label="Remove model.ts"]')`, "the restored mention is attached");
    // A mention of a file that isn't there stays text.
    await evaluate(`${editor}.value = 'fix @src/missing.ts now'`);
    await delay(400);
    assert.deepEqual(await chips("file"), []);
    await waitFor(`!document.querySelector('[data-promptbar] [aria-label="Remove model.ts"]')`, "the attachment left with its chip");
    console.log("PASS: a restored draft's mention becomes a chip after the search; an unknown path stays text");

    // Typing in the middle keeps every character, around chips too.
    await evaluate(`${editor}.value = ''`);
    await typeText("/tldr a");
    await draftIs("/tldr a");
    await waitFor(`${editor}.querySelectorAll('[data-chip="skill"]').length === 1`, "a typed skill is a chip");
    await caretTo("start");
    await typeText("go ");
    await draftIs("go /tldr a");
    await caretTo("end");
    await press("Backspace");
    await press("Backspace");
    await draftIs("go /tldr");
    await press("Backspace");
    await draftIs("go ");
    console.log("PASS: typing before a chip and Backspace into one keep the text exact");

    assert.deepEqual(errors, []);
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.error(errors);
    console.error(await evaluate(`({ value: ${editor}?.value, html: ${editor}?.innerHTML })`).catch(() => null));
    app.exit(1);
  }
}

async function main() {
  const { createServer } = await import("vite");
  const server = await createServer({
    configFile: path.resolve(__dirname, "../apps/desktop/vite.config.ts"),
    cacheDir: path.resolve(__dirname, "../node_modules/.vite-composer-chips"),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "composer-chips-fixture",
        resolveId(id) {
          if (id === "/__composer-chips.tsx") return id;
        },
        load(id) {
          if (id === "/__composer-chips.tsx") return fixture;
        },
        configureServer(server) {
          server.middlewares.use(async (request, response, next) => {
            if (request.url !== "/__composer-chips") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await server.transformIndexHtml(
                request.url,
                '<html><body><div id="root"></div><script type="module" src="/__composer-chips.tsx"></script></body></html>',
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
    const child = require("node:child_process").spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__composer-chips`], {
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
