// Run with node scripts/test-design-live.cjs. Checks that the Designs canvas shows the agent at work: Claude's
// design_apply input, streamed as step-draft events, builds over the design's frame with Claude's cursor on the layer
// it touched last, then hands over to the saved version without a replay; a design_show of a new design builds on a
// placeholder frame that hands over to the new frame; and a new version from an agent that doesn't stream its input
// (Codex) plays back layer by layer over the frame, which holds the old version until it settles on the new one.
// In a Chat with no design yet, the Designs open by themselves when the agent starts designing, without taking the
// composer's focus, and open again for each later design call after the user closed them; a dock opened mid-call
// still shows the whole draft. Set MILAGRE_SCREENSHOT_DIR to keep screenshots.
const assert = require("node:assert/strict");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const text = (id, y, value, extra = {}) => ({
  id,
  parentId: "card",
  type: "text",
  x: 32,
  y,
  width: 340,
  height: 28,
  text: value,
  fontSize: 16,
  fill: "#3b3631",
  ...extra,
});
const login = {
  schemaVersion: 1,
  width: 1280,
  height: 800,
  background: "#f4f1ec",
  nodes: [
    { id: "card", type: "frame", x: 438, y: 180, width: 404, height: 440, fill: "#ffffff", radius: 18 },
    text("heading", 32, "Welcome back", { fontSize: 26, fontWeight: 700, height: 36 }),
    text("caption", 74, "Sign in to continue"),
    { id: "email", parentId: "card", type: "rectangle", x: 32, y: 124, width: 340, height: 46, fill: "#ffffff", stroke: "#e3ded7", strokeWidth: 1, radius: 10 },
    {
      id: "password",
      parentId: "card",
      type: "rectangle",
      x: 32,
      y: 184,
      width: 340,
      height: 46,
      fill: "#ffffff",
      stroke: "#e3ded7",
      strokeWidth: 1,
      radius: 10,
    },
    { id: "submit", parentId: "card", type: "rectangle", x: 32, y: 256, width: 340, height: 46, fill: "#8a7f74", radius: 10 },
  ],
};
// Claude's edit: a warmer button, a new heading, a badge and a footnote.
const applyInput = {
  id: "login",
  expectedVersion: 1,
  operations: [
    { op: "update", id: "submit", patch: { fill: "#c2410c" } },
    { op: "update", id: "heading", patch: { text: "Good to see you" } },
    { op: "insert", node: { id: "badge", parentId: "card", type: "rectangle", x: 300, y: 32, width: 72, height: 26, fill: "#fde4d5", radius: 13 } },
    {
      op: "insert",
      node: text("badge-label", 36, "New", { x: 300, width: 72, height: 20, fontSize: 12, fontWeight: 600, textAlign: "center", fill: "#c2410c" }),
    },
    { op: "insert", node: text("footnote", 330, "Forgot your password?", { fontSize: 14, fill: "#c2410c" }) },
  ],
};
const home = {
  schemaVersion: 1,
  width: 390,
  height: 844,
  background: "#1f2a24",
  nodes: [
    { id: "greeting", type: "text", x: 24, y: 64, width: 342, height: 40, text: "Good morning", fontSize: 32, fontWeight: 700, fill: "#ffffff" },
    ...["Drink water", "Morning run", "Read 20 pages", "Stretch"].flatMap((label, index) => [
      { id: `habit-${index}`, type: "rectangle", x: 24, y: 128 + index * 78, width: 342, height: 64, fill: "#ffffff14", radius: 16 },
      { id: `habit-label-${index}`, type: "text", x: 44, y: 148 + index * 78, width: 300, height: 24, text: label, fontSize: 17, fill: "#ffffff" },
    ]),
  ],
};
const showInput = { title: "Home", document: home, id: "home" };

const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatComposer } from "/src/components/ChatComposer";
import { designHtml, applyDesignOperations } from "@milagre/shared/design";
import { MODEL_CATALOG, capabilityFor } from "/src/model";
import "/src/styles.css";
const noop = () => {};
const v1 = ${JSON.stringify(login)};
const v2 = applyDesignOperations(v1, ${JSON.stringify(applyInput.operations)});
// Codex's later edit, replayed: a new subtitle, a second button and the footnote gone.
const v3 = applyDesignOperations(v2, [
  { op: "update", id: "caption", patch: { text: "Sign in with your work account" } },
  { op: "insert", node: { id: "sso", parentId: "card", type: "rectangle", x: 32, y: 316, width: 340, height: 46, fill: "#1f2937", radius: 10 } },
  { op: "insert", node: { id: "sso-label", parentId: "card", type: "text", x: 32, y: 328, width: 340, height: 22, text: "Continue with SSO", fontSize: 15, fontWeight: 600, textAlign: "center", fill: "#ffffff" } },
  { op: "delete", id: "footnote" },
  { op: "update", id: "card", patch: { height: 400 } },
]);
const logins = { 1: v1, 2: v2, 3: v3 };
const home = ${JSON.stringify(home)};
const chatId = "milagre-link:fixture#1";
// ?fresh: a Chat with no design yet.
const fresh = new URLSearchParams(location.search).has("fresh");
window.latest = 1;
window.homeShown = false;
window.listeners = [];
window.milagre = {
  listEditors: async () => [],
  readDesignsEnabled: async () => ({ enabled: true }),
  onDesignsEnabledChanged: () => () => {},
  onAgentEvent: (listener) => { window.listeners.push(listener); return () => {}; },
  artifacts: {
    sharingStatus: async () => ({ available: false }),
    list: async () => [
      ...(fresh ? [] : [{ id: "login", version: window.latest, title: "Login", format: "design", versions: window.latest, width: 1280, height: 800 }]),
      ...(window.homeShown ? [{ id: "home", version: 1, title: "Home", format: "design", versions: 1, width: 390, height: 844 }] : []),
    ],
    comments: async () => [],
    get: async ({ id, version }) => {
      if (id === "home") return { id, version: 1, title: "Home", versions: 1, latest: 1, width: 390, height: 844, format: "design", document: home, html: designHtml(home) };
      const shown = version ?? window.latest;
      return { id, version: shown, title: "Login", versions: window.latest, latest: window.latest, width: 1280, height: 800, format: "design", document: logins[shown], html: designHtml(logins[shown]) };
    },
  },
};
window.emit = (event) => { for (const listener of window.listeners) listener({ chatId, event }); };
// Streams a tool call's input as Claude does, in pieces; resolves once whole. pause() holds it at the next piece.
window.stream = (id, tool, input, { size = 48, every = 40, pauseAt = Infinity } = {}) => new Promise((resolve) => {
  window.emit({ type: "step-draft", id, tool, offset: 0, text: "" });
  let sent = 0;
  const next = () => {
    if (sent >= pauseAt && !window.resumed) window.paused = true;
    if (window.paused) return setTimeout(next, every);
    const piece = input.slice(sent, sent + size);
    const done = sent + piece.length >= input.length;
    window.emit({ type: "step-draft", id, tool, offset: sent, text: piece, ...(done ? { done: true } : {}) });
    sent += piece.length;
    if (done) resolve();
    else setTimeout(next, every);
  };
  setTimeout(next, every);
});
const step = (id, artifact) => ({ id, kind: "artifact", title: "Showed \`" + artifact.title + "\`", status: "done", offset: 0, artifact: { format: "design", ...artifact } });
function Fixture() {
  const [replies, setReplies] = useState([]);
  const [provider, setProvider] = useState("claude");
  window.reply = (body, steps) => setReplies((current) => [...current, { id: 10 + current.length, session_id: 1, context: null, role: "assistant", body, steps }]);
  window.step = step;
  window.setProvider = setProvider;
  const messages = [
    { id: 1, session_id: 1, context: null, role: "user", body: "design a login screen" },
    ...(fresh ? [] : [{ id: 2, session_id: 1, context: null, role: "assistant", body: "Here is a first pass.", steps: [step("s1", { id: "login", version: 1, title: "Login" })] }]),
    ...replies,
  ];
  return <div style={{ display: "flex", height: "100%" }}><main data-workspace-main style={{ display: "flex", flex: 1, minWidth: 0, height: "100%" }}><div data-chat-pane style={{ flex: 1, minWidth: 0, height: "100%", padding: 12 }}>
    <ChatComposer messages={messages} onSendDesignMessage={async () => true} sessionProvider={provider}
      imageDraft={{ images: [], files: [], attachFiles: noop, attachPath: noop, removeFile: noop, loading: false, error: "", onPaste: noop, clear: noop, remove: noop }}
      scopeKind="link" projectPath="/fixture" messageScope="milagre-link:fixture" agentChatId={chatId} draft="" onDraftChange={noop} onSend={noop} isSending={false} sendBlocked={false}
      streamingText="" asking={false}
      models={MODEL_CATALOG} cliStatus={null} onModelPickerOpen={noop} selectedModel={MODEL_CATALOG[0]} onModelChange={noop}
      capability={capabilityFor(MODEL_CATALOG[0], null)} onEffortChange={noop} ultracode={false} onUltracodeChange={noop}
      fastMode={false} onFastModeChange={noop} permissionMode="auto" onPermissionModeChange={noop}
      onRecommendationSelect={noop} worktrees={[]} onWorktreeChange={noop}
      isolation="local" onIsolationChange={noop} branches={[]} baseBranch="main" onBaseBranchChange={noop} newChatError={null} />
  </div></main></div>;
}
document.documentElement.classList.add("dark");
createRoot(document.getElementById("root")).render(<Fixture />);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", require("node:fs").mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-design-live-")));
  await app.whenReady();
  const window = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, webPreferences: { backgroundThrottling: false } });
  window.webContents.on("console-message", (details) => {
    if (details.level === "error" && !/Content Security Policy/.test(details.message)) console.error(details.message);
  });
  const evaluate = (source) =>
    window.webContents.executeJavaScript(source).catch((error) => {
      throw new Error(`${error.message}\n  in: ${source.slice(0, 300)}`);
    });
  async function screenshot(name, wait = 300) {
    if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
    await delay(wait);
    const fs = require("node:fs");
    fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  }
  async function waitFor(source, attempts = 240) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw new Error(`Timed out: ${source}`);
  }
  const dock = 'document.querySelector("[data-slot=artifact-dock]")';
  const frame = (id) => `${dock}.querySelector("[data-slot=artifact-frame][data-artifact=${id}]")`;
  const live = (id) => `${frame(id)}?.querySelector("[data-slot=live-design]")`;
  const cursor = (scope) => `${scope}?.querySelector("[data-slot=agent-cursor]")`;
  const draft = `${dock}?.querySelector("[data-slot=artifact-draft-frame]")`;
  try {
    await window.loadURL(process.argv[2]);
    await waitFor('document.querySelector("[data-slot=artifact-card] button")?.textContent === "Open"');
    await evaluate('[...document.querySelectorAll("[data-slot=artifact-card] button")].find((b) => b.textContent === "Open").click()');
    await waitFor(`${frame("login")}?.querySelector("[data-design-body] iframe") && ${frame("login")}.dataset.version === "1"`);
    await delay(400);

    // 1. Claude writes a design_apply: the edit builds over the frame, with Claude's cursor on the last layer it touched.
    // Paused halfway through, once the heading's operation is whole: two operations applied, the cursor on the heading.
    const applyText = JSON.stringify(applyInput);
    const half = applyText.indexOf('{"op":"insert"');
    // A design_apply changes a design the canvas has: no placeholder frame for a new one shows, even before its id.
    await evaluate(
      `window.sawDraft = false; window.draftWatch = new MutationObserver(() => { window.sawDraft ||= !!${draft}; }); window.draftWatch.observe(document.body, { childList: true, subtree: true }); true`,
    );
    await evaluate(
      `window.paused = false; window.resumed = false; window.applied = window.stream("toolu_apply", "design_apply", ${JSON.stringify(applyText)}, { size: 40, every: 60, pauseAt: ${half} }); true`,
    );
    await waitFor(`${live("login")}?.dataset.live === "draft"`);
    assert.match(await evaluate(`${cursor(live("login"))}.textContent`), /^Claude/, "the cursor carries the agent's name");
    await waitFor(
      `${live("login")}.querySelector("[data-slot=live-design-frame][data-painted]") && ${live("login")}.querySelector("[data-slot=agent-cursor-target]")`,
    );
    await waitFor(`(() => { const c = ${cursor(live("login"))}; return window.paused && c && +c.dataset.y > 180 && +c.dataset.y < 260; })()`);
    assert.equal(await evaluate(`${frame("login")}.dataset.version`), "1", "the frame still shows the saved version under the draft");
    await screenshot("1-apply-mid-build");
    await evaluate("window.resumed = true; window.paused = false");
    await evaluate("window.applied");
    await waitFor(`${live("login")}.querySelector("[data-slot=live-design-frame]").dataset.layers === "9"`);
    // The step completes with the saved version: the frame takes over, and no replay follows.
    await evaluate(
      `window.latest = 2; window.emit({ type: "step-completed", id: "toolu_apply", status: "done", artifact: { id: "login", version: 2, title: "Login", format: "design" } }); window.reply("Warmer.", [window.step("toolu_apply", { id: "login", version: 2, title: "Login" })])`,
    );
    await waitFor(`${frame("login")}.dataset.version === "2" && !${live("login")}`);
    await delay(500);
    assert.equal(await evaluate(`!!${live("login")}`), false, "a version a draft showed being written doesn't replay");
    assert.equal(await evaluate("window.draftWatch.disconnect(), window.sawDraft"), false, "a design_apply draft never shows a new design's frame");
    await screenshot("2-apply-settled");

    // 2. Claude shows a new design: a placeholder frame builds it, then hands over to the new frame.
    const showText = JSON.stringify(showInput);
    await evaluate(
      `window.paused = false; window.resumed = false; window.shown = window.stream("toolu_show", "design_show", ${JSON.stringify(showText)}, { size: 60, every: 50, pauseAt: ${showText.indexOf('"id":"habit-2"')} }); true`,
    );
    await waitFor(`!!${draft}`);
    // Titled once the title has streamed in.
    await waitFor(`/^Home.*Claude is designing/.test(${draft}.textContent)`);
    await waitFor(
      `window.paused && +(${draft}.querySelector("[data-slot=live-design-frame]")?.dataset.layers ?? 0) >= 4 && !!${draft}.querySelector("[data-slot=live-design-frame][data-painted]")`,
    );
    await screenshot("3-show-mid-build");
    await evaluate("window.resumed = true; window.paused = false");
    await evaluate("window.shown");
    await waitFor(`${draft}.querySelector("[data-slot=live-design-frame]").dataset.layers === "9"`);
    await evaluate(
      `window.homeShown = true; window.emit({ type: "step-completed", id: "toolu_show", status: "done", artifact: { id: "home", version: 1, title: "Home", format: "design" } }); window.reply("And a home screen.", [window.step("toolu_show", { id: "home", version: 1, title: "Home" })])`,
    );
    await waitFor(`!!${frame("home")}?.querySelector("[data-design-body] iframe") && !${draft}`);
    assert.equal(await evaluate(`!!${live("home")}`), false, "the new design doesn't replay either");
    await screenshot("4-show-settled");

    // 3. Codex saves a new version without streaming it: the change plays back over the frame, which holds v2.
    await evaluate(
      `window.setProvider("codex"); window.latest = 3; window.reply("SSO too.", [window.step("c3", { id: "login", version: 3, title: "Login" })])`,
    );
    await waitFor(`${live("login")}?.dataset.live === "replay"`);
    assert.match(await evaluate(`${cursor(live("login"))}.textContent`), /^Codex/);
    await waitFor(`!!${live("login")}?.querySelector("[data-slot=live-design-frame][data-painted]")`);
    assert.equal(await evaluate(`${frame("login")}.dataset.version`), "2", "the frame holds the old version while the change plays");
    await screenshot("5-replay-mid", 250);
    await waitFor(`${frame("login")}.dataset.version === "3" && !${live("login")}`, 400);
    await screenshot("6-replay-settled");

    // 4. A Chat with no design yet: the first design_show opens the Designs by itself, and the composer keeps the focus.
    await window.loadURL(`${process.argv[2]}?fresh`);
    const prompt = 'document.querySelector("textarea[aria-label=Prompt]")';
    await waitFor(`!!${prompt}`);
    await evaluate(`${prompt}.focus(); true`);
    assert.equal(await evaluate(`!!${dock}`), false, "a Chat with no design has no Designs open");
    await evaluate(
      `window.paused = false; window.resumed = false; window.shown = window.stream("toolu_first", "design_show", ${JSON.stringify(showText)}, { size: 60, every: 50, pauseAt: ${showText.indexOf('"id":"habit-2"')} }); true`,
    );
    await waitFor(`!!${dock}`);
    // Before the document starts, the empty canvas says the agent is at work.
    await waitFor(`!!${draft} || /Claude is designing/.test(${dock}.querySelector("[data-slot=artifact-canvas-waiting]")?.textContent ?? "")`);
    await waitFor(`window.paused && +(${draft}?.querySelector("[data-slot=live-design-frame]")?.dataset.layers ?? 0) >= 4`);
    assert.equal(await evaluate(`document.activeElement === ${prompt}`), true, "opening the Designs leaves the focus in the composer");
    assert.equal(await evaluate(`!!${dock}.querySelector("[data-slot=artifact-canvas-waiting]")`), false, "the placeholder frame replaces the waiting note");
    await screenshot("7-fresh-opened-mid-build");
    await evaluate("window.resumed = true; window.paused = false");
    await evaluate("window.shown");
    await evaluate(
      `window.homeShown = true; window.emit({ type: "step-completed", id: "toolu_first", status: "done", artifact: { id: "home", version: 1, title: "Home", format: "design" } }); window.reply("A home screen.", [window.step("toolu_first", { id: "home", version: 1, title: "Home" })]); window.emit({ type: "turn-completed" })`,
    );
    await waitFor(`!!${frame("home")}?.querySelector("[data-design-body] iframe") && !${draft}`);
    await screenshot("8-fresh-settled");

    // 5. Closed by the user, the Designs open again for the next design call. Closed and opened again mid-call, the
    // canvas still shows everything written so far.
    const close = () => evaluate(`${dock}.querySelector("[aria-label='Close designs']").click()`);
    await close();
    await waitFor(`!${dock}`);
    const profileText = JSON.stringify({ ...showInput, title: "Profile", id: "profile" });
    await evaluate(
      `window.paused = false; window.resumed = false; window.profile = window.stream("toolu_second", "design_show", ${JSON.stringify(profileText)}, { size: 60, every: 50, pauseAt: ${profileText.indexOf('"id":"habit-2"')} }); true`,
    );
    await waitFor(`!!${dock} && window.paused && +(${draft}?.querySelector("[data-slot=live-design-frame]")?.dataset.layers ?? 0) >= 4`);
    const layers = await evaluate(`${draft}.querySelector("[data-slot=live-design-frame]").dataset.layers`);
    await close();
    await waitFor(`!${dock}`);
    await evaluate('[...document.querySelectorAll("[data-slot=artifact-card] button")].find((b) => b.textContent === "Open").click()');
    await waitFor(`+(${draft}?.querySelector("[data-slot=live-design-frame]")?.dataset.layers ?? 0) >= ${layers}`);
    await screenshot("9-reopened-mid-call");
    await evaluate("window.resumed = true; window.paused = false");
    await evaluate("window.profile");
    await evaluate('window.emit({ type: "turn-cancelled" })');
    await waitFor(`!${draft}`);

    // 6. An agent that doesn't stream its input (Codex): its design call opens the Designs as it starts; an artifact
    // page's call doesn't.
    await evaluate('window.setProvider("codex")');
    await close();
    await waitFor(`!${dock}`);
    await evaluate('window.emit({ type: "step-started", step: { id: "c-page", kind: "artifact", title: "Showed `Notes`", tool: "artifact_show" } })');
    await delay(400);
    assert.equal(await evaluate(`!!${dock}`), false, "an artifact page's call doesn't open the Designs");
    await evaluate('window.emit({ type: "step-started", step: { id: "c-design", kind: "artifact", title: "Edited `a design`", tool: "design_apply" } })');
    await waitFor(`!!${dock}`);
    assert.equal(await evaluate(`document.activeElement === ${prompt}`), true, "the composer keeps the focus");
    await evaluate('window.emit({ type: "step-completed", id: "c-design", status: "failed" }); window.emit({ type: "turn-completed" })');
    console.log(
      "PASS: Claude's streamed design_apply builds over the frame with its cursor and hands over without a replay; a streamed design_show builds on a placeholder that hands over to the new frame; a Codex version plays back over the held frame and settles on the new one; the Designs open by themselves for each design call, in a Chat with no design too, keep the composer's focus and show a draft begun before they opened",
    );
    app.exit(0);
  } catch (error) {
    console.error("draft frame:", await evaluate(`${draft}?.outerHTML.replace(/srcdoc="[^"]*"/g, "").slice(0, 1500) ?? "none"`).catch(() => "?"));
    await screenshot("failure", 0);
    console.error(error);
    app.exit(1);
  }
}

async function main() {
  const { createServer } = await import("vite");
  const { spawn } = require("node:child_process");
  const server = await createServer({
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
    plugins: [
      {
        name: "design-live-fixture",
        resolveId(id) {
          if (id === "/__design_live_fixture.tsx") return id;
        },
        load(id) {
          if (id === "/__design_live_fixture.tsx") return fixture;
        },
        configureServer(server) {
          server.middlewares.use(async (request, response, next) => {
            if (request.url.split("?")[0] !== "/__design_live__") return next();
            const html = await server.transformIndexHtml(
              request.url,
              '<html><body><div id="root"></div><script type="module" src="/__design_live_fixture.tsx"></script></body></html>',
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
    const child = spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__design_live__`], { env, stdio: "inherit" });
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
