// Real App and browser file APIs, isolated agent IPC. No paid agent calls.
const assert = require("node:assert/strict");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");
const { openRenderer } = require("./renderer-ready.cjs");
const imageBytes = require("node:fs").readFileSync(path.join(__dirname, "fixtures/photo.png")).toString("base64");
const fixture = `
window.imageBytes = ${JSON.stringify(imageBytes)};
import React from 'react';
import { createRoot } from 'react-dom/client';
import '/src/styles.css';
// A project's state as the main process reads it.
const state = { next_id: 1, projects: { 1: { id: 1, name: 'Milagre' } }, worktrees: {}, sessions: {}, connections: {}, events: [], messages: [], approvals: [], tasks: {}, artifacts: {}, outputs: [], conflicts: [] };
state.worktrees = { 1: { id: 1, name: 'main', path: '/fixture', project_id: 1 } };
state.sessions = { 3: { id: 3, worktree_id: 1, agent_name: 'Claude', provider: 'claude', status: 'Idle' }, 5: { id: 5, worktree_id: 1, agent_name: 'Other', provider: 'codex', status: 'Idle' } };
state.messages = [{ id: 4, session_id: 3, role: 'user', body: 'Attachment test', context: null, images: [{id:'old',name:'legacy.png',dataUrl:'data:image/png;base64,'+window.imageBytes},{id:'new',name:'stored.png',path:'/fixture/.milagre/images/photo.png'}] }, { id: 6, session_id: 5, role: 'user', body: 'Other chat', context: null }, { id: 7, session_id: 3, role: 'assistant', body: 'The [written design](/fixture/docs/spec.md) is committed. See [the helper](src/greeting.ts#L3) and [the site](https://example.com).', context: null }];
state.messages.push({ id: 8, session_id: 3, role: 'user', body: 'Fix @src/greeting.ts using /frontend-design', context: null, files: ['/fixture/src/greeting.ts', '/fixture/extra.txt'] });
state.next_id = 9;
state.messages.find(message => message.role === 'assistant').body += ' [archive](/fixture/archive.zip)';
window.calls = []; window.searches = []; window.notices = []; window.synced = []; window.listeners = [];
window.stateListeners = [];
// Stands in for the main process: it saves every project's state, and tells the window.
const broadcast = () => { window.saved = { ...state }; window.stateListeners.forEach(fn => fn({ path: '/fixture', state: window.saved })); };
// A turn that ends in a chat not on screen leaves it unread, and the state comes with the event (see ChatHost.receive).
window.emitAgent = event => {
  const ended = ['turn-completed', 'turn-failed', 'turn-cancelled'].includes(event.type);
  if (ended && window.openChat !== '/fixture#3') state.sessions = { ...state.sessions, 3: { ...state.sessions[3], unread: true } };
  window.listeners.forEach(fn => fn({ chatId: '/fixture#3', event, ...(ended ? { state: { ...state } } : {}) }));
};
window.milagre = new Proxy({
  simulators: { list: async () => ({ devices: [], supported: true }) },
  getLinkedWork: async () => ({ delegations: [], negotiations: [] }),
  getRuntimeConnection: async () => ({ connected: true }),
 // The main process always answers with a map of chat id to ports; null would crash the ports hook.
 getAgentPorts: async () => ({}),
 // So is the linked-work snapshot (linked:snapshot); null would crash useLinkedWork.
 getLinkedWork: async () => ({ delegations: [], negotiations: [], receiveOnly: [] }),
 onQuitFailed: fn => {window.quitFailed=fn;return ()=>{};},
 retryQuit: async () => {window.retriedQuit=true;},
 listSkills: async () => ({ skills: [{ name: 'frontend-design', description: 'Build polished interfaces', path: '/skills/frontend-design/SKILL.md', scope: 'bundled', provider: 'claude' }], warnings: [] }),
 readAttachment: async file => { (window.fileReads ??= []).push(file); if (file.endsWith('.zip')) return {text:'',binary:true,truncated:false}; if (file.endsWith('missing.txt')) throw new Error('File no longer exists.'); if (file.endsWith('.md')) return { text: '# Live activities\\n\\nThe **plan** has [goals](goals.md).\\n\\n- One\\n- Two', truncated: false, binary: false }; return { text: file.endsWith('empty.txt') ? '' : 'export const greeting = "hello";', truncated: false, binary: false }; },
 readAttachmentChunk: async (file, offset) => { if (window.failDownload) {window.failDownload = false; throw new Error('Connection lost. Try again.');} (window.downloadReads ??= []).push(file); return {base64:'UEsDBAD/AAE=',size:8,version:'zip-v1'}; },
 showImageMenu: async (file, name) => { (window.imageMenus ??= []).push([file, name]); },
 onOpenChat: fn => { window.openNotification = fn; return () => {}; },
 switchProject: async root => ({ path: root, name: 'Other project', state: { ...state, sessions: { 10: { id: 10, worktree_id: 1, agent_name: 'Notified', status: 'Idle' } }, messages: [{ id: 11, session_id: 10, body: 'Notification destination', role: 'user', context: null }], next_id: 12 } }),
 getCurrentProject: async () => ({ path: '/fixture', name: 'Milagre', state }),
 listRecentProjects: async () => [], listBranches: async () => ['main'], listEditors: async () => [],
 getCachedUsage: async () => ({ providers: [] }), readUsage: async () => ({ providers: [] }), getUpdateState: async () => ({ status: 'idle' }),
 uploadAttachment: async request => ({ file: { path: "/fixture/uploads/" + request.name } }),
 getPathForFile: file => '/fixture/files/' + file.name,
 searchProjectFiles: async (root, query) => { window.searches.push({root,query}); return ['src/my app.ts', 'src/model.ts', 'media/photo.png', 'media/clip.mp4'].filter(p => p.includes(query)); },
 // The main process saves the message, then starts the turn (see ChatHost.send).
 sendMessage: async request => {
   window.calls.push(request);
   const message = { id: state.next_id, session_id: request.sessionId, body: request.body, images: request.images, ...(request.files.length ? { files: request.files } : {}), context: null, role: 'user', model: request.model };
   Object.assign(state, { next_id: state.next_id + 1, messages: [...state.messages, message] });
   window.saved = { ...state };
   window.listeners.forEach(fn => fn({ chatId: '/fixture#' + request.sessionId, event: { type: 'message-sent', model: request.model }, state: window.saved }));
   window.emitAgent({ type: 'turn-started', turnId: 'test' });
   return { sessionId: request.sessionId };
 },
 onAgentEvent: fn => { window.listeners.push(fn); return () => { window.listeners = window.listeners.filter(x => x !== fn); }; },
 onProjectState: fn => { window.stateListeners.push(fn); return () => { window.stateListeners = window.stateListeners.filter(x => x !== fn); }; },
 // Opening a chat reads it.
 setOpenChat: async chatId => {
   window.openChat = chatId;
   const id = chatId ? Number(chatId.split('#').pop()) : null;
   if (id !== null && state.sessions[id]?.unread) { state.sessions = { ...state.sessions, [id]: { ...state.sessions[id], unread: false } }; broadcast(); }
 },
 notifyCompletion: async notice => { window.notices.push(notice); },
 syncNotifications: async value => { window.synced.push(value); },
 interruptAgent: async chatId => { window.interrupted = chatId; },
}, { get(target, key) { return target[key] ?? (String(key).startsWith('on') ? () => () => {} : async () => null); } });
localStorage.setItem('milagre-settings', JSON.stringify({ theme: 'dark' }));
window.updateSettings = (await import('/src/lib/settings')).updateSettings;
const { default: App } = await import('/src/App');
createRoot(document.getElementById('root')).render(<App />);
`;
async function browserChecks() {
  const { app, BrowserWindow, protocol, net, session } = require("electron");
  protocol.registerSchemesAsPrivileged([{ scheme: "milagre-media", privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }]);
  await app.whenReady();
  const handleMedia = require("../apps/desktop/electron/media.cjs").createMediaHandler((url, options) => net.fetch(url, options));
  session.fromPartition("issues-test").protocol.handle("milagre-media", (request) => {
    const url = new URL(request.url);
    url.searchParams.set("path", path.join(__dirname, "fixtures", path.basename(url.searchParams.get("path"))));
    return handleMedia(new Request(url, { headers: request.headers }));
  });
  const rangeUrl = `milagre-media://file/?path=${encodeURIComponent(path.join(__dirname, "fixtures/clip.mp4"))}`;
  const range = await handleMedia(new Request(rangeUrl, { headers: { Range: "bytes=0-9" } }));
  assert.equal(range.status, 206, "Actual Electron fetch honors video byte ranges");
  assert.equal((await range.arrayBuffer()).byteLength, 10);
  const window = new BrowserWindow({ width: 1000, height: 760, show: false, webPreferences: { partition: "issues-test", backgroundThrottling: false } });
  const evaluate = async (source) => {
    try {
      return await window.webContents.executeJavaScript(source);
    } catch (error) {
      console.error(source);
      throw error;
    }
  };
  const errors = [];
  const downloadFolder = await require("node:fs/promises").mkdtemp(path.join(require("node:os").tmpdir(), "milagre-file-download-ui-"));
  const downloadFile = path.join(downloadFolder, "archive.zip");
  const downloaded = new Promise((resolve, reject) => {
    session.fromPartition("issues-test").once("will-download", (_event, item) => {
      assert.equal(item.getFilename(), "archive.zip");
      item.setSavePath(downloadFile);
      item.once("done", (_event, state) => (state === "completed" ? resolve() : reject(new Error(state))));
    });
  });
  window.webContents.on("console-message", (details) => {
    if (details.level === "error" || details.level === 3) errors.push(details.message);
  });
  const waitFor = async (source) => {
    for (let n = 0; n < 200; n++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw Error("Timed out: " + source);
  };
  const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const key = (key, extra = {}) =>
    evaluate(
      `document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true, ...${JSON.stringify(extra)} }))`,
    );
  const type = async (text) => {
    await evaluate(
      `(() => { const el=document.querySelector('[data-prompt-editor]'); el.focus(); el.value = ${JSON.stringify(text)}; el.dispatchEvent(new Event('input',{bubbles:true})); })()`,
    );
    await delay(120);
  };
  const screenshot = async (name) => {
    if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
    const fs = require("node:fs");
    fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
    window.webContents.invalidate();
    await delay(250);
    fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  };
  const chooseFiles = async (names) => {
    await evaluate(
      `(() => { const dt=new DataTransfer(); for(const [name,type] of ${JSON.stringify(names)}) dt.items.add(new File([type.startsWith('image/') ? Uint8Array.from(atob(window.imageBytes), c => c.charCodeAt(0)) : name.endsWith('.tsx') ? 'export const Card = () => <section title="hello">Welcome</section>;' : type === 'text/plain' ? 'export const greeting = "hello";' : name],name,{type})); const input=document.querySelector('input[type=file]'); input.files=dt.files; input.dispatchEvent(new Event('change',{bubbles:true})); })()`,
    );
    await delay(100);
  };
  try {
    await openRenderer(window, process.argv[2], String.raw`!!document.querySelector("[data-prompt-editor]")`);
    await key("2", { metaKey: true });
    await waitFor(String.raw`document.querySelector("[aria-current=page]")?.textContent.includes("Attachment test")`);
    await waitFor(
      String.raw`document.querySelector('article [aria-label="Preview legacy.png"] img')?.naturalWidth > 0 && document.querySelector('article [aria-label="Preview stored.png"] img')?.naturalWidth > 0`,
    );
    assert.ok(await evaluate(`document.querySelector('article [aria-label="Preview legacy.png"] img').src.startsWith('data:image/png')`));
    assert.ok(await evaluate(`document.querySelector('article [aria-label="Preview stored.png"] img').src.startsWith('milagre-media:')`));
    await screenshot("legacy-and-stored-images");

    // A selected passage quotes into this Chat without sending or discarding its existing draft.
    await type("My question");
    const passage = await evaluate(`(() => {
      const content = document.querySelector('[data-slot="message-content"]');
      const range = document.createRange(); range.selectNodeContents(content);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      return selection.toString();
    })()`);
    await waitFor(`!!document.querySelector('[aria-label="Ask about selected text"]')`);
    const askPoint = await evaluate(
      `(() => { const rect=document.querySelector('[aria-label="Ask about selected text"]').getBoundingClientRect(); return {x: Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)}; })()`,
    );
    window.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...askPoint });
    window.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...askPoint });
    const quoted = `My question\n\n${passage
      .split("\n")
      .map((line) => (line.trim() ? `> ${line}` : ">"))
      .join("\n")}\n\n`;
    await waitFor(`document.querySelector('[data-prompt-editor]').value === ${JSON.stringify(quoted)}`);
    await waitFor(`document.activeElement.matches('[data-prompt-editor]')`);
    assert.equal(await evaluate("window.calls.length"), 0, "Ask fills the draft without sending it");
    // Typing starts after the quote, even when the draft had a previous caret.
    await evaluate(`document.activeElement.dispatchEvent(new InputEvent('beforeinput', {inputType:'insertText', data:'?', bubbles:true, cancelable:true}))`);
    await waitFor(`document.querySelector('[data-prompt-editor]').value === ${JSON.stringify(quoted + "?")}`);
    await screenshot("ask-selected-passage");
    await type("");

    // A sent message shows its @file mention and /skill as chips; the mentioned file gets no second tile, an unmentioned one keeps its tile.
    await waitFor(`!!document.querySelector('article [data-chip="skill"]')`);
    assert.equal(await evaluate(`document.querySelectorAll('article [data-chip="file"]').length`), 1);
    assert.equal(await evaluate(`document.querySelector('article [data-chip="file"] .truncate').textContent`), "greeting.ts");
    assert.equal(await evaluate(`document.querySelector('article [data-chip="file"] [data-file-badge]').textContent`), "TS");
    assert.equal(await evaluate(`document.querySelector('article [data-chip="file"]').title`), "src/greeting.ts");
    assert.equal(await evaluate(`document.querySelector('article [data-chip="skill"]').textContent`), "Frontend Design");
    assert.equal(await evaluate(`document.querySelector('article [data-chip="skill"]').getAttribute('aria-description')`), "Build polished interfaces");
    assert.equal(await evaluate(`!!document.querySelector('article [aria-label="Preview greeting.ts"]')`), false, "A mentioned file is not shown twice");
    assert.equal(await evaluate(`!!document.querySelector('article [aria-label="Preview extra.txt"]')`), true, "An unmentioned file keeps its tile");
    await screenshot("sent-message-chips");
    await click('article [data-chip="file"]');
    await waitFor(`document.querySelector('dialog[open]')?.textContent.includes('export const greeting')`);
    assert.equal(await evaluate("window.fileReads.at(-1)"), "/fixture/src/greeting.ts");
    await key("Escape");
    await waitFor(`!document.querySelector('dialog')`);
    await evaluate("window.fileReads = []");
    const replyLink = (text) => `[...document.querySelectorAll('article a')].find(a => a.textContent === ${JSON.stringify(text)})`;
    await evaluate(`${replyLink("archive")}.click(); window.failDownload = true;`);
    await waitFor(`!!document.querySelector('dialog[open]')`);
    const downloadButton = `[...document.querySelectorAll('dialog[open] button')].find(button => button.textContent === 'Download')`;
    await evaluate(`${downloadButton}.click()`);
    await waitFor(`document.querySelector('dialog[open] [role=alert]')?.textContent.includes('Connection lost')`);
    await evaluate(`${downloadButton}.click()`);
    await Promise.race([
      downloaded,
      delay(5000).then(() => {
        throw new Error("File download did not finish");
      }),
    ]);
    assert.equal(await evaluate(`document.querySelector('[data-toast]:popover-open')?.textContent`), "Download started.");
    assert.deepEqual(await require("node:fs/promises").readFile(downloadFile), Buffer.from([80, 75, 3, 4, 0, 255, 0, 1]));
    await require("node:fs/promises").rm(downloadFolder, { recursive: true, force: true });
    await key("Escape");
    await waitFor(`!document.querySelector('dialog')`);

    // A reply's link to a file on this computer opens the file viewer; markdown opens formatted, with the source a click away.
    assert.equal(await evaluate(`${replyLink("the site")}.target`), "_blank", "Web links still leave the app");
    await evaluate(`${replyLink("written design")}.click()`);
    await waitFor(`!!document.querySelector('dialog[open] h1')`);
    assert.equal(await evaluate(`document.querySelector('dialog[open] h1').textContent`), "Live activities");
    assert.equal(await evaluate(`document.querySelector('dialog[open] strong').textContent`), "plan");
    assert.equal(await evaluate("window.fileReads.at(-1)"), "/fixture/docs/spec.md");
    assert.equal(await evaluate(`document.querySelector('dialog[open] [aria-pressed=true]').getAttribute('aria-label')`), "Formatted");
    await screenshot("markdown-link-formatted");
    // A relative link inside the document resolves against the document's folder.
    await evaluate(`[...document.querySelectorAll('dialog[open] a')].find(a => a.textContent === 'goals').click()`);
    await waitFor(`window.fileReads.at(-1) === '/fixture/docs/goals.md'`);
    await waitFor(`document.querySelectorAll('dialog[open]').length === 2`);
    await key("Escape");
    await waitFor(`document.querySelectorAll('dialog[open]').length === 1`);
    await evaluate(`document.querySelector('dialog[open] [aria-label=Source]').click()`);
    await waitFor(`!!document.querySelector('dialog[open] [data-file-code]')`);
    assert.ok(await evaluate(`document.querySelector('dialog[open] [data-file-code]').textContent.startsWith('# Live activities')`));
    await screenshot("markdown-link-source");
    await key("Escape");
    await waitFor(`!document.querySelector('dialog')`);
    // A relative link in a reply resolves against the chat's worktree; other files open as code.
    await evaluate(`${replyLink("the helper")}.click()`);
    await waitFor(`!!document.querySelector('dialog[open] [data-file-code]')`);
    assert.equal(await evaluate("window.fileReads.at(-1)"), "/fixture/src/greeting.ts");
    assert.equal(await evaluate(`document.querySelector('dialog[open] [aria-pressed]')`), null, "Only markdown offers the formatted view");
    await key("Escape");
    await waitFor(`!document.querySelector('dialog')`);
    await evaluate("window.fileReads = []");

    await evaluate(`document.querySelector('input[type=file]').addEventListener('click', e => { window.pickerOpened=true; e.preventDefault(); });`);
    await click('[aria-label="Add attachments and sources"]');
    await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Add files')).click()`);
    assert.equal(await evaluate("window.pickerOpened"), true, "Add files invokes native file input");
    await chooseFiles([
      ["note.txt", "text/plain"],
      ["clip.mp4", "video/mp4"],
      ["photo.png", "image/png"],
    ]);
    await waitFor(String.raw`!!document.querySelector("[aria-label=\"Preview clip.mp4\"]")`);
    assert.equal(await evaluate('document.querySelector("[data-prompt-editor]").value'), "[Image #1] ", "Attached image inserts [Image #1] token");
    assert.equal(await evaluate('document.querySelectorAll("[data-prompt-editor] [data-chip=image]").length'), 1, "Attached image renders as an inline chip");
    assert.equal(await evaluate('document.querySelector("[data-promptbar] [data-image-badge]")?.textContent'), "#1", "Composer image thumbnail shows #1 badge");
    assert.deepEqual(
      await evaluate(
        `[...document.querySelectorAll('[data-promptbar] [aria-label=Attachments] [aria-label^="Preview "]')].map((b) => b.getAttribute('aria-label'))`,
      ),
      ["Preview note.txt", "Preview clip.mp4", "Preview photo.png"],
      "Attachments keep the order they were added in, images included",
    );
    await click("[data-prompt-editor] [data-chip=image]");
    await waitFor(`!!document.querySelector('dialog[open] img')`);
    await key("Escape");
    await waitFor(`!document.querySelector('dialog')`);
    assert.equal(await evaluate('document.querySelector("[aria-label=Send]").disabled'), false, "File-only messages can send");
    await chooseFiles([["Card.tsx", "text/typescript"]]);
    await click('[aria-label="Preview Card.tsx"]');
    await waitFor(`!!document.querySelector('dialog[open]')`);
    await waitFor(`!!document.querySelector('dialog [data-file-code] [data-syntax="keyword"]')`);
    assert.ok(await evaluate(`document.querySelector('dialog [data-syntax="tag"]')?.textContent.includes('section')`));
    assert.equal(
      await evaluate(`document.querySelector('dialog [data-file-code]').textContent`),
      'export const Card = () => <section title="hello">Welcome</section>;',
    );
    const syntaxColor = () => evaluate(`getComputedStyle(document.querySelector('dialog [data-syntax="keyword"]')).color`);
    const darkSyntaxColor = await syntaxColor();
    await screenshot("tsx-preview-dark");
    await evaluate(`window.updateSettings({ theme: 'light' })`);
    await waitFor(`!document.documentElement.classList.contains('dark')`);
    assert.notEqual(await syntaxColor(), darkSyntaxColor, "Syntax colors follow the theme");
    await screenshot("tsx-preview-light");
    await evaluate(`window.updateSettings({ theme: 'dark' })`);
    await waitFor(`document.documentElement.classList.contains('dark')`);
    await key("Escape");
    await waitFor(`!document.querySelector('dialog')`);
    await click('[aria-label="Remove Card.tsx"]');
    await screenshot("attachments-draft");
    assert.ok(await evaluate(`!!document.querySelector('[aria-label="Preview note.txt"]')`), "Text attachment is a clickable preview button");
    await click('[aria-label="Preview note.txt"]');
    await waitFor(`document.querySelector('dialog[open]')?.textContent.includes('export const greeting')`);
    assert.deepEqual(await evaluate("window.fileReads ?? []"), [], "Unsent picked files preview locally");
    await screenshot("text-file-preview");
    await key("Escape");
    await waitFor(`!document.querySelector('dialog')`);
    assert.equal(await evaluate('document.activeElement?.getAttribute("aria-label")'), "Preview note.txt");
    // The lightbox steps through every image and video in the attachments, and zooms images.
    const counter = String.raw`document.querySelector("dialog [aria-live]")?.textContent`;
    await click('[aria-label="Preview photo.png"]');
    await waitFor(String.raw`document.querySelector("dialog[open] img")?.naturalWidth > 0`);
    assert.equal(await evaluate(counter), "2 / 2", "The photo was added after the video, so it pages after it");
    assert.equal(
      await evaluate(`document.querySelector('[data-promptbar] [aria-label="Preview photo.png"] img').classList.contains('opacity-0')`),
      true,
      "The open thumbnail hides behind the viewer",
    );
    await delay(500);
    await screenshot("lightbox-image");
    // Real mouse input, so pointer capture decides where each click lands, as it does for a user.
    const mouseClick = async (x, y) => {
      for (const type of ["mouseDown", "mouseUp"]) {
        window.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1 });
        await delay(30);
      }
    };
    const clickImage = async () => {
      const r = await evaluate(
        `(() => { const r = document.querySelector('dialog img').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
      );
      await mouseClick(r.x, r.y);
    };
    await clickImage();
    await waitFor(String.raw`document.querySelector("dialog img")?.dataset.zoom === "2.50"`);
    await key("ArrowRight");
    await delay(100);
    assert.equal(await evaluate(counter), "2 / 2", "Arrow keys pan a zoomed image instead of changing item");
    await delay(400);
    await screenshot("lightbox-zoomed");
    await clickImage();
    await waitFor(String.raw`document.querySelector("dialog img")?.dataset.zoom === "1.00"`);
    assert.equal(await evaluate('document.querySelector("dialog [aria-label=Next]").disabled'), true, "Navigation stops at the last item");
    await key("ArrowLeft");
    await waitFor(`${counter} === '1 / 2' && !!document.querySelector('dialog video[controls]')`);
    await key("ArrowRight");
    await waitFor(`${counter} === '2 / 2'`);
    // A click on the empty area around the image closes the viewer.
    // Let the slide that ArrowRight started settle first: a click right after it left the viewer open about half the runs.
    await delay(600);
    // A point found by hit-testing, so it is certain to be empty stage and not a control or the image.
    const empty = await evaluate(
      `(() => { for (const fy of [0.5, 0.3, 0.7, 0.2, 0.8]) for (const fx of [0.1, 0.9, 0.25, 0.75, 0.5]) {
        const x = Math.round(innerWidth * fx), y = Math.round(innerHeight * fy), el = document.elementFromPoint(x, y);
        if (el?.closest('dialog') && !el.closest('button, img, video, [aria-live], [role=slider]')) return { x, y };
      } return null; })()`,
    );
    assert.ok(empty, "The viewer has an empty area to click");
    await mouseClick(empty.x, empty.y);
    await waitFor(String.raw`!document.querySelector("dialog")`);
    assert.equal(await evaluate('document.activeElement?.getAttribute("aria-label")'), "Preview photo.png", "Focus returns to the thumbnail");
    assert.equal(await evaluate(`document.querySelector('[data-promptbar] [aria-label="Preview photo.png"] img').classList.contains('opacity-0')`), false);
    assert.equal(await evaluate("window.interrupted"), undefined);
    // Right-clicking an image, as a thumbnail or full size, offers Copy Image and Save Image.
    const rightClick = (selector) =>
      evaluate(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))`);
    await rightClick('[data-promptbar] [aria-label="Preview photo.png"]');
    await click('[aria-label="Preview photo.png"]');
    await waitFor(String.raw`document.querySelector("dialog[open] img")?.naturalWidth > 0`);
    await rightClick("dialog img");
    const menus = await evaluate("window.imageMenus");
    assert.equal(menus.length, 2, "One menu per right-click");
    for (const [file, name] of menus) {
      assert.match(file, /photo\.png$|^data:image\/png;base64,/);
      assert.equal(name, "photo.png");
    }
    await key("Escape");
    await waitFor(String.raw`!document.querySelector("dialog")`);
    await click('[aria-label="Preview clip.mp4"]');
    await waitFor(String.raw`document.querySelector("dialog video[controls]")?.videoWidth > 0`);
    await waitFor(String.raw`document.querySelector("dialog video")?.currentTime > 0`);
    await screenshot("video-preview");
    await key("Escape");
    await waitFor(String.raw`!document.querySelector("dialog")`);
    await click('[aria-label="Send"]');
    await waitFor(String.raw`window.calls.length === 1`);
    await waitFor(String.raw`!!document.querySelector('[aria-label="Stop agent"]')`);
    assert.equal(await evaluate(`document.querySelector('[aria-label="Stop agent"]').disabled`), false, "An empty draft can stop a running agent");
    await screenshot("agent-stop-button");
    assert.deepEqual(await evaluate("window.calls[0].images.map(i=>i.name)"), ["photo.png"]);
    assert.ok(await evaluate('window.calls[0].prompt.includes("/fixture/files/note.txt") && window.calls[0].prompt.includes("/fixture/files/clip.mp4")'));
    assert.deepEqual(await evaluate("window.saved.messages.at(-1).files"), ["/fixture/files/note.txt", "/fixture/files/clip.mp4", "/fixture/files/photo.png"]);
    assert.equal(await evaluate("window.saved.messages.at(-1).body"), "[Image #1]");
    // A send that is only its image mentions shows the photo tile alone, with no text bubble carrying an [Image #1] chip.
    await waitFor(String.raw`!!document.querySelector("article [aria-label=\"Preview photo.png\"]")`);
    // The image also sits in the message's files (by its original path) but shows once: the sent copy keeps that path as its source.
    assert.equal(
      await evaluate(`document.querySelector('article:has([aria-label="Preview note.txt"])').querySelectorAll('[aria-label="Preview photo.png"]').length`),
      1,
      "A chosen image shows once in the sent message",
    );
    assert.equal(await evaluate(`!!document.querySelector('article [data-chip="image"]')`), false, "An images-only message has no [Image #1] chip");
    await click('article [aria-label="Preview note.txt"]');
    await waitFor(`document.querySelector('dialog[open]')?.textContent.includes('export const greeting')`);
    await key("Escape");
    await waitFor(`!document.querySelector('dialog')`);
    assert.deepEqual(await evaluate("window.fileReads"), ["/fixture/files/note.txt"]);
    assert.equal(await evaluate("window.interrupted"), undefined, "File preview Escape never stops active agent");
    await click('article [aria-label="Preview photo.png"]');
    await waitFor(`document.querySelector('dialog[open] img')?.naturalWidth > 0`);
    await key("Escape");
    await waitFor(String.raw`!document.querySelector("dialog")`);
    assert.equal(await evaluate("window.interrupted"), undefined, "Preview Escape never stops active agent");
    await type("@src/");
    await waitFor(String.raw`document.querySelector("[aria-label=\"Project files and Chats\"]")?.textContent.includes("my app.ts")`);
    await screenshot("file-mentions");
    await key("Enter");
    // A picked file is a chip in the draft (its mention, quoted for the space) and an attachment.
    const mentions = '@"src/my app.ts" @media/photo.png @media/clip.mp4 ';
    assert.equal(await evaluate('document.querySelector("[data-prompt-editor]").value'), '@"src/my app.ts" ');
    await waitFor(`document.querySelectorAll("[data-prompt-editor] [data-chip=file]").length === 1`);
    assert.equal(
      await evaluate(`!!document.querySelector('[data-promptbar] [aria-label="Remove my app.ts"]')`),
      false,
      "A chip is the file's only representation",
    );
    assert.equal(await evaluate("window.calls.length"), 1, "Choosing a file does not send the message");
    assert.equal(await evaluate("window.searches.at(-1).root"), "/fixture");
    await type('@"src/my app.ts" @photo');
    await waitFor(String.raw`document.querySelector('[aria-label="Project files and Chats"]')?.textContent.includes('photo.png')`);
    await key("Enter");
    await waitFor(`document.querySelectorAll("[data-prompt-editor] [data-chip=file]").length === 2`);
    await type('@"src/my app.ts" @media/photo.png @clip');
    await waitFor(String.raw`document.querySelector('[aria-label="Project files and Chats"]')?.textContent.includes('clip.mp4')`);
    await key("Enter");
    await waitFor(`document.querySelectorAll("[data-prompt-editor] [data-chip=file]").length === 3`);
    assert.equal(await evaluate('document.querySelector("[data-prompt-editor]").value'), mentions, "Picked media are mentioned like any file");
    assert.equal(await evaluate('document.querySelectorAll("[data-prompt-editor] [data-chip=file]").length'), 3);
    assert.equal(await evaluate(`!!document.querySelector("[data-promptbar] [aria-label=Attachments]")`), false, "Mentioned files show as chips, not tiles");
    await screenshot("file-attachments-selected");
    await type(mentions + "Review these");
    await click('[aria-label="Stop agent"]');
    assert.equal(await evaluate("window.interrupted"), "/fixture#3", "Stop targets the open chat");
    assert.equal(await evaluate('document.querySelector("[data-prompt-editor]").value'), mentions + "Review these", "Stopping preserves the draft");
    assert.equal(await evaluate("window.calls.length"), 1, "Stop does not send the draft");
    await evaluate('document.querySelector("[data-prompt-editor]").focus()');
    await key("Enter");
    await waitFor("window.calls.length === 2");
    assert.ok(await evaluate('window.calls[1].prompt.includes("/fixture/media/photo.png") && window.calls[1].prompt.includes("/fixture/media/clip.mp4")'));
    assert.equal(await evaluate("window.saved.messages.at(-1).body"), mentions + "Review these");
    await type("");
    await evaluate(
      `(() => { const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(6 * 1024 * 1024)], 'photo.png', {type:'image/png'})); document.querySelector('[data-prompt-editor]').dispatchEvent(new DragEvent('drop', { bubbles:true, cancelable:true, dataTransfer:dt })); })()`,
    );
    await waitFor(String.raw`document.querySelector('[data-promptbar] img')?.src.startsWith('data:image/png')`);
    assert.equal(await evaluate('document.querySelector("[data-prompt-editor]").value'), "[Image #1] ", "Images above the old limit remain image attachments");
    // With text beside it, the image mention stays a chip in the sent message and opens the viewer.
    await type("look [Image #1]");
    await evaluate('document.querySelector("[data-prompt-editor]").focus()');
    await key("Enter");
    await waitFor("window.calls.length === 3");
    assert.equal(await evaluate("window.saved.messages.at(-1).body"), "look [Image #1]");
    await waitFor(String.raw`!!document.querySelector('article [data-chip="image"]')`);
    await click('article [data-chip="image"]');
    await waitFor(`document.querySelector('dialog[open] img')?.naturalWidth > 0`);
    await key("Escape");
    await waitFor(String.raw`!document.querySelector("dialog")`);
    await type("");
    await evaluate(
      `(() => { const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(6 * 1024 * 1024)], 'photo.png', {type:'image/png'})); document.querySelector('[data-prompt-editor]').dispatchEvent(new DragEvent('drop', { bubbles:true, cancelable:true, dataTransfer:dt })); })()`,
    );
    await waitFor(String.raw`document.querySelector('[data-promptbar] img')?.src.startsWith('data:image/png')`);
    assert.equal(await evaluate('document.querySelector("[data-prompt-editor]").value'), "[Image #1] ", "A dropped image after a send is [Image #1] again");
    await click('[data-promptbar] [aria-label="Remove photo.png"]');
    await evaluate(
      `(() => { const dt = new DataTransfer(); dt.items.add(new File([Uint8Array.from(atob(window.imageBytes), c=>c.charCodeAt(0))], 'pasted.png', {type:'image/png'})); document.querySelector('[data-prompt-editor]').dispatchEvent(new ClipboardEvent('paste', { bubbles:true, cancelable:true, clipboardData:dt })); })()`,
    );
    await waitFor(String.raw`document.querySelector('[data-promptbar] img')?.src.startsWith('data:image/png')`);
    assert.equal(await evaluate('document.querySelector("[data-prompt-editor]").value'), "[Image #1] ", "Pasting an image inserts [Image #1]");
    await evaluate(
      `Object.defineProperty(navigator.clipboard, 'read', { configurable: true, value: async () => [{ types: ['image/png'], getType: async () => new Blob([Uint8Array.from(atob(window.imageBytes), c => c.charCodeAt(0))], { type: 'image/png' }) }] })`,
    );
    await click('[aria-label="Add attachments and sources"]');
    await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Paste image')).click()`);
    await waitFor(`!!document.querySelector('[data-promptbar] [aria-label="Preview Pasted image.png"]')`);
    assert.equal(await evaluate('document.querySelector("[data-prompt-editor]").value'), "[Image #1] [Image #2] ", "Pasting a second image inserts [Image #2]");
    await click('[data-promptbar] [aria-label="Remove pasted.png"]');
    await waitFor(`document.querySelector("[data-prompt-editor]").value.trim() === "[Image #1]"`);
    assert.equal(
      await evaluate('document.querySelector("[data-prompt-editor]").value.trim()'),
      "[Image #1]",
      "Removing Image #1 shifts [Image #2] to [Image #1]",
    );
    await type("");
    await waitFor(`!document.querySelector('[data-promptbar] [aria-label="Preview Pasted image.png"]')`);
    await screenshot("clipboard-image");
    await chooseFiles([["discard.txt", "text/plain"]]);
    // Sidebar chats keep creation order, newest first: Other chat (session 5) is ⌘1, Attachment test (session 3) is ⌘2.
    await key("1", { metaKey: true });
    await waitFor(String.raw`document.querySelector("[aria-current=page]")?.textContent.includes("Other chat")`);
    assert.equal(
      await evaluate('!!document.querySelector("[data-promptbar] [aria-label=Attachments]")'),
      false,
      "Switching chats in same worktree clears attachments",
    );
    await evaluate('window.emitAgent({type:"text-delta", messageId:"test", text:"Done"}); window.emitAgent({type:"turn-completed"})');
    await waitFor(String.raw`window.notices.length === 1`);
    await waitFor(String.raw`window.synced.at(-1)?.unread.includes("/fixture#3")`);
    await key("2", { metaKey: true });
    await waitFor(String.raw`!window.synced.at(-1)?.unread.includes("/fixture#3")`);
    await waitFor(`!!document.querySelector('[data-promptbar] [aria-label="Preview discard.txt"]')`);
    await click('[data-promptbar] [aria-label="Remove discard.txt"]');
    await waitFor(String.raw`!!document.querySelector('[aria-label="Send"]') && !document.querySelector('[aria-label="Stop agent"]')`);
    await delay(250);
    require("node:fs").writeFileSync("/tmp/milagre-attachments.png", (await window.webContents.capturePage()).toPNG());
    await evaluate(
      `window.emitAgent({type:'subagent-update',agent:{id:'delta-child',title:'Streaming review',status:'running',startedAt:Date.now()-2000,updatedAt:Date.now(),transcript:[{id:'finding',kind:'message',text:'Both image formats render correctly.'}]}})`,
    );
    await waitFor(`!!document.querySelector('[data-slot=subagent-track] [data-face=pill] button')`);
    await click("[data-slot=subagent-track] [data-face=pill] button");
    await waitFor(`!!document.querySelector('[data-subagent-open]')`);
    await click("[data-subagent-open]");
    await waitFor(`document.querySelector('[data-slot=subagent-transcript]')?.textContent.includes('Both image formats render correctly.')`);
    await screenshot("subagent-delta");
    await click('[aria-label="Collapse subagents"]');
    await key(",", { metaKey: true });
    // Settings opens on General; the notification switches live in their own section.
    const notificationsNav = `[...document.querySelectorAll("button")].find((button) => button.textContent.trim() === "Notifications")`;
    await waitFor(`!!${notificationsNav}`);
    await evaluate(`${notificationsNav}.click()`);
    await waitFor(String.raw`!!document.querySelector('[role=checkbox][aria-label="Notify when finished"]')`);
    await screenshot("notification-settings");
    await click('[role=checkbox][aria-label="Notify when finished"]');
    await waitFor("window.synced.at(-1)?.notifyOnCompletion === false");
    await click('[role=checkbox][aria-label="Dock badge"]');
    await waitFor("window.synced.at(-1)?.showDockBadge === false");
    assert.equal(await evaluate('JSON.parse(localStorage.getItem("milagre-settings")).showDockBadge'), false, "Notification preferences persist");
    await evaluate('window.openNotification("/other#10")');
    await waitFor(String.raw`document.querySelector("[aria-current=page]")?.textContent.includes("Notification destination")`);
    await evaluate(`window.quitFailed('disk full')`);
    await waitFor(`document.querySelector('[role=alertdialog]')?.textContent.includes('Chats could not be saved')`);
    await screenshot("save-failure-retry");
    await evaluate(`document.querySelector('[role=alertdialog] button').click()`);
    assert.equal(await evaluate("window.retriedQuit"), true);
    console.log(
      "PASS: native picker trigger, file-only send, saved attachments, image/video lightbox (counter, arrows, click to zoom, click outside to close, right-click copy/save, focus return), Escape isolation, @ file selection, same-worktree draft isolation, real video playback/Range, completion request, unread/read sync and cross-project notification routing",
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.error(errors);
    if (error.code !== "ERR_RENDERER_READINESS") {
      console.error(await evaluate("document.body.innerText.slice(0, 2000)"));
      console.error(
        await evaluate(
          `(() => { const v = document.querySelector('dialog video'); return v ? { src:v.src, error:v.error?.message, code:v.error?.code, ready:v.readyState, network:v.networkState } : null; })()`,
        ),
      );
    }
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
        name: "issues-fixture",
        resolveId(id) {
          if (id === "/__issues.tsx") return id;
        },
        load(id) {
          if (id === "/__issues.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url !== "/__issues") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await server.transformIndexHtml(
                request.url,
                '<html><body><div id="root"></div><script type="module" src="/__issues.tsx"></script></body></html>',
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
    const child = spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__issues`], { env, stdio: "inherit" });
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
