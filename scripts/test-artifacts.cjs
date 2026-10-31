// Run with node scripts/test-artifacts.cjs. Checks that a design an agent shows with design_show is a card in the
// reply, outside the folded activity, with a sandboxed preview that can't make requests of its own; that Open docks a
// canvas of every design of the Chat beside it, where frames follow revisions and step back through versions, and the
// user can zoom, choose a design and pin comments for the agent; and where the canvas sits as the layout changes. The
// Chat runs in a Worktree, as most do: designs are still read through the Project's key, which is all the daemon knows.
// Set MILAGRE_SCREENSHOT_DIR to keep screenshots.
const assert = require("node:assert/strict");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");

const design = (version, accent) => ({
  schemaVersion: 1,
  width: 1280,
  height: 800,
  background: "#f4f1ec",
  nodes: [
    {
      id: "card",
      type: "frame",
      x: 438,
      y: 213,
      width: 404,
      height: 374,
      fill: "#ffffff",
      radius: 18,
    },
    {
      id: "heading",
      parentId: "card",
      type: "text",
      x: 32,
      y: 32,
      width: 340,
      height: 34,
      text: "Welcome back",
      fontSize: 24,
      fontWeight: 700,
      fill: "#282420",
    },
    {
      id: "caption",
      parentId: "card",
      type: "text",
      x: 32,
      y: 72,
      width: 340,
      height: 24,
      text: `Version ${version} of the login screen`,
      fontSize: 16,
      fill: "#6b6560",
    },
    {
      id: "email",
      parentId: "card",
      type: "rectangle",
      x: 32,
      y: 120,
      width: 340,
      height: 46,
      fill: "#ffffff",
      stroke: "#e3ded7",
      strokeWidth: 1,
      radius: 10,
    },
    {
      id: "email-label",
      parentId: "card",
      type: "text",
      x: 46,
      y: 132,
      width: 310,
      height: 22,
      text: "Email",
      fontSize: 15,
      fill: "#6b6560",
    },
    {
      id: "password",
      parentId: "card",
      type: "rectangle",
      x: 32,
      y: 178,
      width: 340,
      height: 46,
      fill: "#ffffff",
      stroke: "#e3ded7",
      strokeWidth: 1,
      radius: 10,
    },
    {
      id: "password-label",
      parentId: "card",
      type: "text",
      x: 46,
      y: 190,
      width: 310,
      height: 22,
      text: "Password",
      fontSize: 15,
      fill: "#6b6560",
    },
    {
      id: "submit",
      parentId: "card",
      type: "rectangle",
      x: 32,
      y: 248,
      width: 340,
      height: 46,
      fill: accent,
      radius: 10,
    },
    {
      id: "submit-label",
      parentId: "card",
      type: "text",
      x: 46,
      y: 260,
      width: 310,
      height: 22,
      text: "Sign in",
      fontSize: 15,
      fontWeight: 600,
      textAlign: "center",
      fill: "#ffffff",
    },
  ],
});
const phone = {
  schemaVersion: 1,
  width: 390,
  height: 844,
  background: "#1f2a24",
  nodes: [
    {
      id: "greeting",
      type: "text",
      x: 24,
      y: 48,
      width: 342,
      height: 40,
      text: "Good morning",
      fontSize: 32,
      fontWeight: 700,
      fill: "#ffffff",
    },
    ...["Drink water", "Morning run", "Read 20 pages"].flatMap((text, index) => [
      {
        id: `habit-${index}`,
        type: "rectangle",
        x: 24,
        y: 112 + index * 74,
        width: 342,
        height: 62,
        fill: "#ffffff14",
        radius: 16,
      },
      {
        id: `habit-label-${index}`,
        type: "text",
        x: 42,
        y: 130 + index * 74,
        width: 306,
        height: 26,
        text,
        fontSize: 17,
        fill: "#ffffff",
      },
    ]),
  ],
};

const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatComposer } from "/src/components/ChatComposer";
import { PanelToggles, useSidePanel } from "/src/components/agents/PanelToggles";
import { useSidePanelRoom } from "/src/components/agents/dock-area";
import { ChangesToggle } from "/src/components/changes/ChangesChrome";
import { designHtml } from "@milagre/shared/design";
import { designFeedbackMessage } from "@milagre/shared/artifact";
import { MODEL_CATALOG, capabilityFor } from "/src/model";
import "/src/styles.css";
const noop = () => {};
const designs = { 1: ${JSON.stringify(design(1, "#8a7f74"))}, 2: ${JSON.stringify(design(2, "#2f6f4f"))}, 3: ${JSON.stringify(design(3, "#c2410c"))} };
const home = ${JSON.stringify(phone)};
window.calls = [];
window.shareCalls = [];
window.shares = [];
window.milagre = {
  listEditors: async () => [],
  readDesignsEnabled: async () => ({ enabled: window.designsEnabled !== false }),
  onDesignsEnabledChanged: (listener) => { window.designsChanged = listener; return () => {}; },
  artifacts: {
    sharingStatus: async () => {
      if (window.holdHealth) await new Promise((resolve) => { window.finishHealth = resolve; });
      return window.sharingOffline ? { available: false, reason: "The sharing service could not be reached." } : { available: true };
    },
    // Like the host: a page has one current link, its newest live one, and sharing again updates it.
    pageShares: async ({ chatId, kind = "designs" }) => {
      window.shareCalls.push(["list", chatId]);
      if (window.shareListError) throw new Error("Sharing is unavailable. Try again.");
      return window.shares.filter(share => (share.kind ?? "designs") === kind && !share.revoked).slice(0, 1);
    },
    sharePage: async (input) => {
      window.shareCalls.push(["publish", input]);
      if (window.sharePublishError) throw new Error("Publish failed. Try again.");
      if (window.holdPublish) await new Promise((resolve) => { window.finishPublish = resolve; });
      const live = window.shares.find(share => (share.kind ?? "designs") === (input.kind ?? "designs") && !share.revoked);
      if (live && !window.uncertainShare) {
        const wasPublished = !live.pending;
        delete live.pending;
        Object.assign(live, { title: input.title }, wasPublished ? { updatedAt: 1780000600000 } : {});
        return { ...live };
      }
      const row = { id: "snapshot-" + (window.shares.length + 1), url: "https://share.milagre.cloud/s/snapshot-" + (window.shares.length + 1), title: input.title, createdAt: 1780000000000, designCount: input.kind === "artifacts" ? 1 : 2, ...(input.kind === "artifacts" ? { kind: "artifacts" } : {}) };
      if (window.uncertainShare) row.pending = true;
      window.shares.unshift(row);
      if (window.uncertainShare) throw new Error("Publication could not be confirmed.");
      return row;
    },
    revokePageShare: async ({ chatId, id }) => {
      window.shareCalls.push(["revoke", chatId, id]);
      if (window.shareRevokeError) throw new Error("Revoke failed. Try again.");
      window.shares = window.shares.map((row) => row.id === id ? { ...row, revoked: true } : row);
    },
    list: async () => [
      { id: "login", version: window.latest, title: "Login screen, warmer", format: "design", versions: window.latest, width: 1280, height: 800 },
      { id: "home", version: 1, title: "Home", format: "design", versions: 1, width: 390, height: 844 },
      { id: window.htmlId ?? "legacy", version: window.htmlVersion ?? 1, title: "Explanation", format: "html", versions: 1, width: 1280, height: 800 },
    ].filter((ref) => (window.designsEnabled !== false || ref.format === "html") && !(window.deletedIds ?? []).includes(ref.id)),
    delete: async ({ id }) => {
      window.deletedIds = [...(window.deletedIds ?? []), id];
      return { id };
    },
    addComments: async ({ comments }) => {
      const added = comments.map((comment) => ({ ...comment, createdAt: 1 }));
      window.kept = [...(window.kept ?? []), ...added];
      return added;
    },
    comments: async () => window.kept ?? [],
    get: async ({ chatId, id, version }) => {
      window.calls.push([chatId, id, version ?? null]);
      // As the daemon: a key under a Worktree's path is no open Chat.
      if (chatId !== "milagre-link:fixture#1") throw new Error("Open an existing Chat before showing a design.");
      if (window.designsEnabled === false && id !== "legacy" && id !== "current-artifact") throw new Error("Designs is disabled.");
      if (id === "home") return { id, version: 1, title: "Home", versions: 1, latest: 1, width: 390, height: 844, format: "design", document: home, html: designHtml(home) };
      if (id === "legacy" || id === "current-artifact") return { id: window.htmlId ?? "legacy", version: window.htmlVersion ?? 1, title: "Explanation", format: "html", versions: 1, latest: window.htmlVersion ?? 1, width: 1280, height: 800, ...(window.htmlTabs ? { tabs: window.htmlTabs } : {}), html: "<!doctype html><h1>How this works " + (window.htmlVersion ?? 1) + "</h1>" };
      const latest = window.latest;
      const shown = version ?? latest;
      return { id, version: shown, title: shown === 1 ? "Login screen" : "Login screen, warmer", versions: latest, latest, width: 1280, height: 800, format: "design", document: designs[shown], html: designHtml(designs[shown]) };
    },
  },
};
window.latest = 2;
window.sent = [];
const step = (version, offset) => ({ id: "s" + version, kind: "artifact", title: "Showed \`Login screen\`", status: "done", offset, artifact: { id: "login", format: "design", version, title: version === 1 ? "Login screen" : "Login screen, warmer" } });
function Fixture() {
  const [revised, setRevised] = useState(false);
  const [changes, setChanges] = useState(false);
  const [diff, setDiff] = useState(false);
  window.setChanges = setChanges;
  // Stand-ins for the git changes panel and a docked simulator, counted against the window's room as the real ones are.
  const [simulator, setSimulator] = useState(false);
  // Offered once the check first opens it: until then the corner has no simulator button.
  const [offered, setOffered] = useState(false);
  window.setSimulator = (open) => { setOffered(true); setSimulator(open); };
  window.simulatorOpen = simulator;
  useSidePanel("simulator", offered ? { open: simulator, toggle: () => setSimulator((open) => !open) } : null);
  useSidePanelRoom("simulator", simulator, 412, () => setSimulator(false));
  useSidePanelRoom("changes", changes, 332, () => setChanges(false));
  window.setDiff = setDiff;
  window.revise = () => { window.latest = 3; setRevised(true); };
  const [htmlRevised, setHtmlRevised] = useState(false);
  window.reviseHtml = () => { window.htmlVersion = 2; window.htmlId = "current-artifact"; setHtmlRevised(true); };
  const [said, setSaid] = useState([]);
  window.appendFeedback = (feedback) => setSaid((current) => [...current, designFeedbackMessage(feedback)]);
  const [resolvedReply, setResolvedReply] = useState(false);
  // The agent resolves the comment, then replies: the Chat moving on is what reads the comments again.
  window.agentResolves = (note) => { window.kept = window.kept.map((comment) => ({ ...comment, resolved: { note, at: 2 } })); setResolvedReply(true); };
  const onSendDesignMessage = async (text) => { window.sent.push(text); setSaid((current) => [...current, text]); return true; };
  const messages = [
    { id: 1, session_id: 1, context: null, role: "user", body: "design a login screen" },
    { id: 2, session_id: 1, context: null, role: "assistant", body: "Here is a first pass.", steps: [step(1, 0), { id: "retired", kind: "artifact", title: "Explanation", status: "done", offset: 0, artifact: { id: "legacy", version: 1, title: "Explanation" } }] },
    { id: 3, session_id: 1, context: null, role: "user", body: "warmer, please" },
    { id: 4, session_id: 1, context: null, role: "assistant", body: "Warmer greens, and the home screen.", steps: [step(2, 0), { id: "h1", kind: "artifact", title: "Showed \`Home\`", status: "done", offset: 0, artifact: { id: "home", version: 1, title: "Home" } }] },
    ...(revised ? [{ id: 5, session_id: 1, context: null, role: "assistant", body: "Orange accent.", steps: [step(3, 0)] }] : []),
    ...(htmlRevised ? [{ id: 31, session_id: 1, context: null, role: "assistant", body: "Updated explanation.", steps: [{ id: "html-update", kind: "artifact", status: "done", title: "Updated artifact", offset: 0, artifact: { id: "current-artifact", version: 2, title: "Explanation", format: "html" } }] }] : []),
    ...said.map((body, index) => ({ id: 10 + index, session_id: 1, context: null, role: "user", body })),
    ...(resolvedReply ? [{ id: 30, session_id: 1, context: null, role: "assistant", body: "Made it bigger.", steps: [{ id: "r1", kind: "other", title: "Resolved a design comment", status: "done", offset: 0 }] }] : []),
  ];
  // The app's layout: the chat pane inside the workspace, beside a 260px sidebar.
  return <div style={{ display: "flex", height: "100%" }}><div style={{ width: 260, flexShrink: 0, padding: "56px 12px 12px", boxSizing: "border-box" }}><aside aria-label="Workspace navigation" style={{ height: "100%" }} /></div><main data-workspace-main style={{ display: "flex", flex: 1, minWidth: 0, height: "100%" }}><div data-chat-pane className={diff ? "hidden" : undefined} style={{ flex: 1, minWidth: 0, height: "100%", padding: 12 }}>
    <ChatComposer messages={messages} onSendDesignMessage={onSendDesignMessage}
      imageDraft={{ images: [], files: [], attachFiles: noop, attachPath: noop, removeFile: noop, loading: false, error: "", onPaste: noop, clear: noop, remove: noop }}
      scopeKind="link" projectPath="/fixture/.worktrees/login" messageScope="milagre-link:fixture" agentChatId="milagre-link:fixture#1" draft="" onDraftChange={noop} onSend={noop} isSending={false} sendBlocked={false}
      streamingText="" asking={false}
      models={MODEL_CATALOG} cliStatus={null} onModelPickerOpen={noop} selectedModel={MODEL_CATALOG[0]} onModelChange={noop}
      capability={capabilityFor(MODEL_CATALOG[0], null)} onEffortChange={noop} ultracode={false} onUltracodeChange={noop}
      fastMode={false} onFastModeChange={noop} permissionMode="auto" onPermissionModeChange={noop}
      onRecommendationSelect={noop} worktrees={[]} onWorktreeChange={noop}
      isolation="local" onIsolationChange={noop} branches={[]} baseBranch="main" onBaseBranchChange={noop} newChatError={null} />
  </div></main>{changes && <div data-changes-slot style={{ width: 300, flexShrink: 0 }} />}</div>;
}
document.documentElement.classList.add("dark");
createRoot(document.getElementById("root")).render(<><Fixture /><ChangesToggle open={false} onToggle={() => {}} /><PanelToggles right={52} /></>);
`;

async function browserChecks() {
  const { app, BrowserWindow, clipboard } = require("electron");
  // `--preview` leaves the window open on the comment layer; `frameGuard` below checks the first card's frame.
  const keepOpen = process.argv.includes("--preview");
  app.setPath("userData", require("node:fs").mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-artifacts-")));
  await app.whenReady();
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    useContentSize: true,
    show: keepOpen,
    webPreferences: { backgroundThrottling: false },
  });
  // The app's own guard: a design's frame can't navigate away from its srcdoc.
  require("../apps/desktop/electron/links.cjs").guardNavigation(window.webContents, { appUrl: new URL(process.argv[2]).origin + "/", openExternal: () => {} });
  window.webContents.on("console-message", (details) => {
    if (details.level === "error" && !/Content Security Policy|example\.com/.test(details.message)) console.error(details.message);
  });
  // A failing script names itself: Electron's own error says only that one failed.
  const evaluate = (source) =>
    window.webContents.executeJavaScript(source).catch((error) => {
      throw new Error(`${error.message}\n  in: ${source.slice(0, 300)}`);
    });
  const { evaluatePanel, waitForPanel } = require("./panel-menu-test.cjs").panelMenuHelpers(evaluate);
  // 250 ms lets a transition end before the capture; at 900 ms the 35 screenshots cost the CI shard half a minute.
  async function screenshot(name) {
    if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
    await delay(250);
    const fs = require("node:fs");
    fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  }
  async function waitFor(source) {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw new Error(`Timed out: ${source}`);
  }
  const cards = 'document.querySelectorAll("[data-slot=artifact-card]:not([data-artifact=legacy])")';
  const group = 'document.querySelector("[data-slot=artifact-group]")';
  const thumb = (id) => `${group}.querySelector("[data-slot=artifact-thumb][data-artifact=${id}]")`;
  const dock = 'document.querySelector("[data-slot=artifact-dock]")';
  try {
    await window.loadURL(process.argv[2]);
    // The reply that showed two designs has one card for both, a thumbnail each.
    await waitFor(
      `${cards}.length === 1 && !!${cards}[0].querySelector("iframe") && ${group}?.querySelectorAll("[data-slot=artifact-thumb] iframe").length === 2`,
    );
    assert.match(await evaluate(`${group}.textContent`), /2 designs.*Login screen, warmer · Home/);
    assert.equal(await evaluate(`[...${cards}].some((card) => card.closest("[data-slot=activity]"))`), false, "designs are not folded into the activity");
    assert.deepEqual(await evaluate("window.calls.slice().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))"), [
      ["milagre-link:fixture#1", "home", 1],
      ["milagre-link:fixture#1", "legacy", null],
      ["milagre-link:fixture#1", "login", 1],
      ["milagre-link:fixture#1", "login", 2],
    ]);
    const frameGuard = await evaluate(
      `(() => { const f = ${cards}[0].querySelector("iframe"); return { sandbox: f.getAttribute("sandbox"), csp: f.srcdoc.includes("Content-Security-Policy") }; })()`,
    );
    assert.deepEqual(frameGuard, { sandbox: "allow-scripts", csp: true }, "the preview runs without same origin, under the policy");
    assert.equal(await evaluate('!!document.querySelector("[data-artifact=legacy]")'), true, "legacy HTML is restored as an Artifact");
    // CSP still blocks script-issued requests inside the generated sandbox.
    let previews = [];
    for (let attempt = 0; attempt < 100; attempt++) {
      previews = window.webContents.mainFrame.framesInSubtree.filter((frame) => frame !== window.webContents.mainFrame && frame.url.startsWith("about:"));
      if (previews.length >= 3) break;
      await delay(25);
    }
    assert.ok(previews.length >= 3);
    const blocked = await Promise.all(previews.map((frame) => frame.executeJavaScript('fetch("https://example.com/collect").then(() => false, () => true)')));
    assert.ok(blocked.every(Boolean), "generated previews cannot make requests of their own");
    // Generated designs stay inside the sandbox.
    assert.deepEqual(
      window.webContents.mainFrame.framesInSubtree
        .map((frame) => frame.url)
        .filter((url) => !url.startsWith("about:") && !url.startsWith(new URL(process.argv[2]).origin)),
      [],
      "no frame left its design",
    );
    assert.ok(
      await evaluate(
        `(() => { const f = ${thumb("home")}.querySelector("iframe").parentElement; return f.style.width === "390px" && f.style.height === "844px"; })()`,
      ),
      "a phone design previews at the phone screen it was made for",
    );
    // Structured documents preview at their explicit screen size.
    assert.deepEqual(
      await evaluate(
        `(() => { const f = ${cards}[0].querySelector("iframe").parentElement; return { width: f.style.width, scaled: /scale\\(0\\.\\d+\\)/.test(f.style.transform) }; })()`,
      ),
      { width: "1280px", scaled: true },
    );
    assert.match(await evaluate(`${cards}[0].textContent`), /Login screen.*Version 1.*version 2 is newer/);
    await evaluate(`${group}.scrollIntoView()`);
    await screenshot("card");

    // Open docks the canvas beside the chat with every design of the Chat, and brings the opened one into view.
    const frames = `${dock}.querySelectorAll("[data-slot=artifact-frame]")`;
    const frame = (id) => `${dock}.querySelector("[data-slot=artifact-frame][data-artifact=${id}]")`;
    await evaluate(`window.holdHealth = true; window.sharingOffline = true; ${thumb("login")}.click()`);
    await waitFor(`${frames}?.length === 2 && [...${frames}].every((f) => f.querySelector("[data-design-body][data-painted]"))`);
    assert.match(await evaluate(`${frame("login")}.textContent`), /Login screen, warmer.*v2 of 2/);
    // The chat's room springs open with the panel, to the panel's width and its gap.
    await waitFor('getComputedStyle((document.querySelector("[data-dock-layer]") ?? document.body)).getPropertyValue("--artifact-dock").trim() === "572px"');
    const inView = (id) =>
      `(() => { const c = ${dock}.querySelector("[data-slot=artifact-canvas]").getBoundingClientRect(); const f = ${frame(id)}.getBoundingClientRect(); return f.left >= c.left - 1 && f.right <= c.right + 1 && f.top >= c.top - 1 && f.bottom <= c.bottom + 1; })()`;
    await waitFor(inView("login"));
    // Once the canvas has slid in and the chat has made room for it.
    await waitFor(
      `(() => { const d = ${dock}.getBoundingClientRect(); const p = document.querySelector("[data-chat-pane]").getBoundingClientRect(); return p.right <= d.left && Math.round(d.top) === 56; })()`,
    );
    const layout = await evaluate(
      `(() => { const d = ${dock}.getBoundingClientRect(); const p = document.querySelector("[data-chat-pane]").getBoundingClientRect(); return { dock: d.left, pane: p.right, top: d.top }; })()`,
    );
    assert.ok(layout.pane <= layout.dock, "the chat ends where the canvas begins");
    assert.ok(layout.dock - 260 > 400, "the chat keeps its room: the workspace reserves the dock once, not again in the chat pane");
    assert.equal(layout.top, 56, "the canvas lines up with the top of the sidebar's card");
    assert.equal(
      await evaluate(`Math.round(${dock}.getBoundingClientRect().bottom) === Math.round(document.querySelector("aside").getBoundingClientRect().bottom)`),
      true,
      "and with its bottom",
    );
    await screenshot("docked");
    assert.equal(await evaluate(`!!${dock}.querySelector("[aria-label='Share page']")`), false, "Share stays hidden during the initial health check");
    await evaluate("window.holdHealth = false; window.finishHealth();");
    await delay(50);
    assert.equal(await evaluate(`!!${dock}.querySelector("[aria-label='Share page']")`), false, "an unavailable service has no Share entry point");
    await screenshot("share-hidden-unavailable");
    await evaluate('window.sharingOffline = false; window.dispatchEvent(new Event("online"))');
    await waitFor(`!!${dock}.querySelector("[aria-label='Share page']")`);
    // Sharing is a page-level action; merely opening its modal uploads nothing.
    const shareDialog = 'document.querySelector("[data-slot=design-page-share]")';
    const publish = `${shareDialog}.querySelector("[data-slot=design-page-publish]")`;
    await evaluate(`window.holdHealth = true; window.sharingOffline = true; ${dock}.querySelector("[aria-label='Share page']").click()`);
    await waitFor(`${shareDialog}?.open && !!window.finishHealth`);
    assert.equal(await evaluate(`${publish}.disabled`), true, "publishing waits for the host health check");
    await evaluate("window.holdHealth = false; window.finishHealth();");
    await waitFor(`${shareDialog}.textContent.includes("Publishing is unavailable")`);
    assert.equal(await evaluate(`!!${dock}.querySelector("[aria-label='Share page']")`), false, "a failed recheck also hides Share behind the open dialog");
    assert.equal(await evaluate(`${publish}.disabled`), true, "unreachable service cannot publish");
    assert.equal(await evaluate('window.shareCalls.some(([kind]) => kind === "publish")'), false);
    await screenshot("share-page-unavailable");
    await evaluate(`window.sharingOffline = false; [...${shareDialog}.querySelectorAll("button")].find((b) => b.textContent === "Retry check").click()`);
    await waitFor(`!${publish}.disabled`);
    assert.equal(await evaluate(`document.querySelectorAll("[aria-label='Share page']").length`), 1);
    assert.equal(await evaluate('window.shareCalls.some(([kind]) => kind === "publish")'), false, "opening sharing never publishes");
    const shareText = `${shareDialog}.textContent`;
    const publishLabel = `${publish}.textContent`;
    assert.match(await evaluate(shareText), /^Share/, "a short title");
    assert.match(await evaluate(shareText), /Anyone with the link can view it\./);
    assert.equal(await evaluate(`!!${shareDialog}.querySelector("input")`), false, "no title field: the host names the page after its Chat");
    assert.equal(await evaluate(`document.getElementById(${shareDialog}.getAttribute("aria-describedby")).textContent`), "Anyone with the link can view it.");
    assert.equal(await evaluate(publishLabel), "Publish");
    assert.doesNotMatch(await evaluate(shareText), /Published snapshots|frozen|Public access/);
    await screenshot("share-page-warning");
    // Publishing failures retain the draft title, and retries send only whole-page scope and explicit consent.
    await evaluate(`window.sharePublishError = true; ${publish}.click()`);
    await waitFor(`${shareDialog}.querySelector("[role=alert]")?.textContent.includes("Publish failed")`);
    await evaluate(`window.sharePublishError = false; window.holdPublish = true; ${publish}.click(); ${publish}.click()`);
    await waitFor(`${publish}.disabled && !!window.finishPublish`);
    assert.equal(await evaluate('window.shareCalls.filter(([kind]) => kind === "publish").length'), 2, "double click sends one request");
    await evaluate("window.finishPublish(); window.holdPublish = false;");
    await waitFor(`${shareDialog}.querySelectorAll("[data-share-id]").length === 1 && ${publishLabel} === "Update snapshot"`);
    assert.deepEqual(await evaluate('window.shareCalls.filter(([kind]) => kind === "publish").at(-1)[1]'), {
      chatId: "milagre-link:fixture#1",
      title: "Designs",
      acknowledgePublic: true,
      kind: "designs",
    });
    assert.equal(await evaluate(`${shareDialog}.querySelector("a").getAttribute("href")`), "https://share.milagre.cloud/s/snapshot-1");
    assert.match(await evaluate(shareText), /Published /);
    // What an action did shows as a toast over the sheet, not in it; publishing copies the link right away.
    const toastText = `(document.querySelector("[data-toast]:popover-open")?.textContent ?? "")`;
    await waitFor(`${toastText}.startsWith("Published.")`);
    assert.doesNotMatch(await evaluate(shareText), /Published\.|Link copied/);
    assert.equal(await evaluate("document.querySelector('[data-toast]').matches(':popover-open')"), true, "the toast sits in the top layer, over the modal");
    if ((await evaluate(toastText)).includes("Link copied.")) assert.equal(clipboard.readText(), "https://share.milagre.cloud/s/snapshot-1");
    await screenshot("share-page-published-first");
    // Sharing again updates the same link; no history list appears.
    await evaluate(`${publish}.click()`);
    await waitFor(`${toastText}.startsWith("Snapshot updated.")`);
    assert.equal(await evaluate('window.shareCalls.filter(([kind]) => kind === "publish").at(-1)[1].title'), "Designs", "only an older host needs a title");
    assert.equal(await evaluate(`${shareDialog}.querySelectorAll("[data-share-id]").length`), 1);
    assert.equal(
      await evaluate(`${shareDialog}.querySelector("a").getAttribute("href")`),
      "https://share.milagre.cloud/s/snapshot-1",
      "the link stays the same",
    );
    assert.match(await evaluate(shareText), /Updated /);
    assert.doesNotMatch(await evaluate(shareText), /Published snapshots/);
    await screenshot("share-page-updated");
    // Confirmation and failed revocation keep a working link. Success removes it and offers Publish again.
    const shareRow = `${shareDialog}.querySelector('[data-share-id="snapshot-1"]')`;
    await evaluate(`[...${shareDialog}.querySelectorAll("button")].find((b) => b.textContent === "Revoke link").click()`);
    assert.equal(await evaluate('window.shareCalls.some(([kind]) => kind === "revoke")'), false);
    await screenshot("share-page-revoke-confirm");
    await evaluate(`window.shareRevokeError = true; ${shareDialog}.querySelector("[data-slot=design-page-revoke-confirm]").click()`);
    await waitFor(`${shareDialog}.querySelector("[role=alert]")?.textContent.includes("Revoke failed")`);
    assert.ok(await evaluate(`${shareRow}.querySelector("a") !== null`));
    await evaluate(`window.shareRevokeError = false; ${shareDialog}.querySelector("[data-slot=design-page-revoke-confirm]").click()`);
    await waitFor(`!${shareRow} && ${publishLabel} === "Publish"`);
    await waitFor(`${toastText}.startsWith("Link revoked")`);
    await screenshot("share-page-revoked");
    // Native modal Escape returns to the canvas, without closing it too.
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "ESCAPE" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "ESCAPE" });
    await waitFor(`!${shareDialog} && !!${dock}`);
    await evaluate(`window.shareListError = true; ${dock}.querySelector("[aria-label='Share page']").click()`);
    await waitFor(`${shareDialog}.querySelector("[role=alert]")?.textContent.includes("Sharing is unavailable")`);
    assert.equal(await evaluate(`${publish}.disabled`), true, "failed history read cannot accidentally publish before state is known");
    await evaluate(`window.shareListError = false; [...${shareDialog}.querySelectorAll("button")].find((b) => b.textContent === "Retry").click()`);
    await waitFor(`!${publish}.disabled && ${publishLabel} === "Publish"`);
    assert.equal(await evaluate(`${shareDialog}.querySelectorAll("[data-share-id]").length`), 0, "a revoked link is not offered again");
    await evaluate(`window.uncertainShare = true; ${publish}.click()`);
    await waitFor(`${shareDialog}.querySelectorAll("[data-share-id]").length === 1 && !${publish}.disabled`);
    assert.match(await evaluate(`${shareDialog}.querySelector("[role=alert]").textContent`), /Publication could not be confirmed/);
    const pendingShare = `${shareDialog}.querySelector('[data-share-id="snapshot-2"]')`;
    assert.match(await evaluate(`${pendingShare}.textContent`), /Not confirmed yet/);
    assert.ok(await evaluate(`${pendingShare}.querySelector("a") !== null`), "an uncertain upload keeps its URL accessible and revocable");
    assert.equal(await evaluate(publishLabel), "Update snapshot", "a retry goes to the same link");
    await screenshot("share-page-uncertain");
    await evaluate(`[...${shareDialog}.querySelectorAll("button")].find((b) => b.textContent === "Close").click()`);
    await waitFor(`!${shareDialog}`);
    await evaluate(`${dock}.querySelector("[aria-label='Share page']").click()`);
    await waitFor(`!!${pendingShare}`);
    assert.match(await evaluate(`${pendingShare}.textContent`), /Not confirmed yet/, "reopening Share keeps an uncertain publication visible");
    await waitFor(`!${publish}.disabled`);
    await evaluate(`window.uncertainShare = false; ${publish}.click()`);
    await waitFor(`!!${pendingShare} && !${pendingShare}.textContent.includes("Not confirmed")`);
    assert.equal(
      await evaluate(`${shareDialog}.querySelector("a").getAttribute("href")`),
      "https://share.milagre.cloud/s/snapshot-2",
      "the retry confirmed the same link",
    );

    await evaluate(`[...${shareDialog}.querySelectorAll("button")].find((b) => b.textContent === "Close").click()`);
    await waitFor(`!${shareDialog} && !!${dock}`);

    // The group card's Open frames every design it showed.
    await evaluate(`${group}.querySelector(":scope > div:last-child button").click()`);
    await waitFor(`${inView("login")} && ${inView("home")}`);
    // Fit shows every design, the phone one at its own size beside the laptop one.
    await evaluate(`${dock}.querySelector("[aria-label='Fit every design']").click()`);
    await waitFor(`${inView("login")} && ${inView("home")}`);
    assert.equal(await evaluate(`${frame("home")}.querySelector("[data-design-body]").parentElement.style.width`), "390px");
    // The zoom floats at the canvas's bottom-left, as on the main Canvas; the header keeps Share as an icon.
    const zoomBar = `${dock}.querySelector("[data-slot=artifact-zoom-bar]")`;
    const barPlace = await evaluate(
      `(() => { const c = ${dock}.querySelector("[data-slot=artifact-canvas]").getBoundingClientRect(); const b = ${zoomBar}.getBoundingClientRect(); return { left: b.left - c.left, bottom: c.bottom - b.bottom, right: c.right - b.right }; })()`,
    );
    assert.ok(
      barPlace.left > 0 && barPlace.left <= 24 && barPlace.bottom > 0 && barPlace.bottom <= 24 && barPlace.right > 100,
      "the zoom bar sits at the bottom-left",
    );
    assert.equal(await evaluate(`!!${dock}.querySelector("header [aria-label='Zoom in']")`), false, "the zoom left the header");
    assert.equal(await evaluate(`${dock}.querySelector("header [aria-label='Share page']").textContent.trim()`), "", "Share is an icon button");
    const zoom = await evaluate(`${dock}.querySelector("[data-slot=artifact-zoom]").textContent`);
    await evaluate(`${zoomBar}.querySelector("[aria-label='Zoom in']").click()`);
    await waitFor(`${dock}.querySelector("[data-slot=artifact-zoom]").textContent !== ${JSON.stringify(zoom)}`);
    // The zoom reading goes back to 100%.
    await evaluate(`${zoomBar}.querySelector("[aria-label='Zoom to 100%']").click()`);
    await waitFor(`${dock}.querySelector("[data-slot=artifact-zoom]").textContent === "100%"`);
    // A press, a drag or the wheel over the bar leaves the canvas where it is.
    const boardAt = `${dock}.querySelector("[data-slot=artifact-canvas] > div").style.transform`;
    const still = await evaluate(boardAt);
    const divider = await evaluate(
      `(() => { const r = ${zoomBar}.querySelector("span").getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`,
    );
    window.webContents.sendInputEvent({ type: "mouseDown", x: divider.x, y: divider.y, button: "left", clickCount: 1 });
    window.webContents.sendInputEvent({ type: "mouseMove", x: divider.x - 80, y: divider.y - 60, button: "left" });
    window.webContents.sendInputEvent({ type: "mouseUp", x: divider.x - 80, y: divider.y - 60, button: "left", clickCount: 1 });
    window.webContents.sendInputEvent({ type: "mouseWheel", x: divider.x, y: divider.y, deltaX: 0, deltaY: -120 });
    await delay(150);
    assert.equal(await evaluate(boardAt), still, "the zoom bar doesn't pan or zoom the canvas");
    await evaluate(`${zoomBar}.querySelector("[aria-label='Fit every design']").click()`);
    // Fit keeps every design clear of the bar.
    await waitFor(
      `(() => { const bar = ${zoomBar}.getBoundingClientRect().top; return [...${dock}.querySelectorAll("[data-slot=artifact-frame], [data-slot=artifact-canvas-group]")].every((f) => f.getBoundingClientRect().bottom <= bar); })()`,
    );
    await screenshot("canvas");
    if (process.env.MILAGRE_SCREENSHOT_DIR) {
      await delay(250);
      const fs = require("node:fs");
      const bounds = (selector) =>
        evaluate(
          `(() => { const r = ${selector}.getBoundingClientRect(); return { x: Math.floor(r.left), y: Math.floor(r.top), width: Math.ceil(r.width), height: Math.ceil(r.height) }; })()`,
        );
      const pad = ({ x, y, width, height }, by) => ({ x: x - by, y: y - by, width: width + 2 * by, height: height + 2 * by });
      fs.writeFileSync(
        path.join(process.env.MILAGRE_SCREENSHOT_DIR, "zoom-bar.png"),
        (await window.webContents.capturePage(pad(await bounds(zoomBar), 16))).toPNG(),
      );
      fs.writeFileSync(
        path.join(process.env.MILAGRE_SCREENSHOT_DIR, "header.png"),
        (await window.webContents.capturePage(await bounds(`${dock}.querySelector("header")`))).toPNG(),
      );
    }

    // Zoomed far out, a frame's row keeps its number and title; its controls float above it only while it has focus.
    const homeControls = `${frame("home")}.querySelector("[data-slot=artifact-frame-controls]")`;
    const loginControls = `${frame("login")}.querySelector("[data-slot=artifact-frame-controls]")`;
    for (let step = 0; step < 12 && !(await evaluate(`!!${homeControls} && !!${loginControls}`)); step++) {
      await evaluate(`${dock}.querySelector("[aria-label='Zoom out']").click()`);
      await delay(50);
    }
    await waitFor(`!!${homeControls} && !!${loginControls}`);
    assert.equal(await evaluate(`getComputedStyle(${homeControls}).opacity`), "0");
    await screenshot("canvas-zoomed-out");
    await evaluate(`${homeControls}.querySelector("[data-slot=artifact-edit]").focus()`);
    await waitFor(`getComputedStyle(${homeControls}).opacity === "1"`);
    await screenshot("canvas-zoomed-out-focus");
    await evaluate(`document.activeElement.blur()`);
    await waitFor(`getComputedStyle(${homeControls}).opacity === "0"`);
    await evaluate(`${dock}.querySelector("[aria-label='Fit every design']").click()`);

    // Wheel over a design pans the canvas until the design is clicked; then the design takes the mouse, and Escape hands
    // it back without closing the canvas.
    const board = `${dock}.querySelector("[data-slot=artifact-canvas] > div").style.transform`;
    const over = await evaluate(
      `(() => { const r = ${frame("login")}.querySelector("[data-design-body]").getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`,
    );
    const before = await evaluate(board);
    window.webContents.sendInputEvent({
      type: "mouseWheel",
      x: over.x,
      y: over.y,
      deltaX: 0,
      deltaY: -120,
    });
    await waitFor(`${board} !== ${JSON.stringify(before)}`);
    const moved = await evaluate(
      `(() => { const r = ${frame("login")}.querySelector("[data-design-body]").getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`,
    );
    window.webContents.sendInputEvent({
      type: "mouseDown",
      x: moved.x,
      y: moved.y,
      button: "left",
      clickCount: 1,
    });
    window.webContents.sendInputEvent({
      type: "mouseUp",
      x: moved.x,
      y: moved.y,
      button: "left",
      clickCount: 1,
    });
    await waitFor(`${frame("login")}.querySelector("[data-design-body]").dataset.active === "true"`);
    assert.equal(await evaluate(`!!${frame("login")}.querySelector("[data-slot=artifact-shield]")`), false, "the design has the mouse");
    await waitFor(`(() => { const iframe = ${frame("login")}.querySelector("iframe"); return iframe && !iframe.closest("[inert]"); })()`);
    // A click in the design gives it the focus, so the window never sees the key: Escape still leaves the design.
    window.webContents.sendInputEvent({
      type: "mouseDown",
      x: moved.x,
      y: moved.y,
      button: "left",
      clickCount: 1,
    });
    window.webContents.sendInputEvent({
      type: "mouseUp",
      x: moved.x,
      y: moved.y,
      button: "left",
      clickCount: 1,
    });
    await waitFor('document.activeElement?.tagName === "IFRAME"');
    // The key is pressed in the design's own document (sendInputEvent always reaches the window first).
    const at = await evaluate(`[...document.querySelectorAll("iframe")].indexOf(${frame("login")}.querySelector("iframe"))`);
    const login = window.webContents.mainFrame.frames[at];
    assert.equal(await login.executeJavaScript('document.querySelector("[data-design-node=heading]").textContent'), "Welcome back");
    await login.executeJavaScript('document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
    await waitFor(`!${frame("login")}.querySelector("[data-design-body]").dataset.active && !!${dock}`);
    assert.notEqual(await evaluate("document.activeElement?.tagName"), "IFRAME", "the focus comes back to the canvas");

    // Designs grouped by the part of the app they belong to sit in one named block per group, numbered across blocks.
    // (Last of the iframe checks: regrouping remounts the frames, which reorders mainFrame.frames.)
    const regroup = (groups) =>
      evaluate(`(() => {
        const groups = ${JSON.stringify(groups)};
        const refs = [
          { id: "login", version: window.latest, title: "Login screen, warmer", width: 1280, height: 800 },
          { id: "home", version: 1, title: "Home", width: 390, height: 844 },
        ];
        for (const ref of refs) {
          const artifact = { ...ref, format: "design", versions: ref.version, ...(groups[ref.id] ? { group: groups[ref.id] } : {}) };
          window.dispatchEvent(new CustomEvent("milagre:design-saved", { detail: { chatId: "milagre-link:fixture#1", artifact } }));
        }
      })()`);
    const groups = `[...${dock}.querySelectorAll("[data-slot=artifact-canvas-group]")]`;
    await regroup({ login: "Sign in", home: "Home tab" });
    await waitFor(`${groups}.length === 2`);
    assert.deepEqual(await evaluate(`${groups}.map((group) => group.getAttribute("aria-label"))`), ["Sign in", "Home tab"]);
    assert.equal(await evaluate(`${groups}[1].textContent.startsWith("Home tab")`), true, "each block shows its group's name");
    assert.equal(
      await evaluate(`${frame("home")}.getBoundingClientRect().top > ${frame("login")}.getBoundingClientRect().bottom`),
      true,
      "a group's block sits below the one before it",
    );
    assert.equal(await evaluate(`${frame("home")}.textContent.trim().startsWith("2")`), true, "frames are numbered across blocks");
    await evaluate(`${dock}.querySelector("[aria-label='Fit every design']").click()`);
    await screenshot("canvas-groups");
    // Zoomed out, a frame's floating controls sit over its top edge, clear of its group's name above the row.
    for (let step = 0; step < 12 && !(await evaluate(`!!${homeControls}`)); step++) {
      await evaluate(`${dock}.querySelector("[aria-label='Zoom out']").click()`);
      await delay(50);
    }
    await evaluate(`${homeControls}.querySelector("[data-slot=artifact-edit]").focus()`);
    await waitFor(`getComputedStyle(${homeControls}).opacity === "1"`);
    const clear = await evaluate(`(() => {
      const box = (element) => element.getBoundingClientRect();
      const controls = box(${homeControls});
      const label = box(${groups}[1].querySelector("span"));
      const body = box(${frame("home")}.querySelector("[data-design-body]"));
      const overlaps = controls.left < label.right && controls.right > label.left && controls.top < label.bottom && controls.bottom > label.top;
      return { overlaps, inside: controls.top >= body.top && controls.left >= body.left, controls: [controls.left, controls.top], body: [body.left, body.top] };
    })()`);
    assert.equal(clear.overlaps, false, `the controls leave the group's name in view: ${JSON.stringify(clear)}`);
    assert.equal(clear.inside, true, `the controls float over the frame's top edge: ${JSON.stringify(clear)}`);
    await screenshot("canvas-groups-controls");
    await evaluate(`document.activeElement.blur()`);
    await waitFor(`getComputedStyle(${homeControls}).opacity === "0"`);
    await regroup({ login: "Sign in" });
    await waitFor(`${groups}.map((group) => group.getAttribute("aria-label")).join() === "Sign in,Ungrouped"`);
    await regroup({});
    await waitFor(`${groups}.length === 0 && !!${frame("home")}`);
    await evaluate(`${dock}.querySelector("[aria-label='Fit every design']").click()`);
    // A closing dock stays in the page while it slides out, so the room it keeps is what tells it is still open.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(
      await evaluate('getComputedStyle((document.querySelector("[data-dock-layer]") ?? document.body)).getPropertyValue("--artifact-dock")'),
      "572px",
      "leaving the design doesn't close the canvas",
    );
    await evaluate(`${dock}.querySelector("[aria-label='Fit every design']").click()`);

    // A revision from the agent replaces what its frame shows, since the frame follows the newest.
    await evaluate("window.revise()");
    await waitFor(`/v3 of 3/.test(${frame("login")}.textContent)`);
    await screenshot("revised");
    await evaluate(`${frame("login")}.querySelector("[aria-label='Previous version of Login screen, warmer']").click()`);
    await waitFor(`/v2 of 3/.test(${frame("login")}.textContent)`);
    await screenshot("earlier-version");

    // Choosing marks the design but sends nothing until Send.
    await evaluate(`${frame("home")}.querySelector("[aria-label='Choose Home, version 1']").click()`);
    await waitFor(`!!${frame("home")}.querySelector("[data-slot=artifact-choice-pending]")`);
    assert.deepEqual(await evaluate("window.sent"), [], "choosing alone sends nothing");
    assert.match(await evaluate(`${dock}.querySelector("[data-slot=artifact-send]").textContent`), /Send\s*1/);

    // In comment mode a click on a design drops a numbered pin with its bubble open, Figma-like; the comment is written
    // there, and Enter keeps it for Send.
    // C turns comment mode on and off, as the button does, but not while typing.
    const commentButton = `${dock}.querySelector("[aria-label='Comment on a design'], [aria-label='Stop commenting']")`;
    const pressC = () => {
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: "C" });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: "C" });
    };
    await evaluate("document.activeElement?.blur()");
    pressC();
    await waitFor(`${commentButton}.getAttribute("aria-pressed") === "true" && !!${frame("login")}.querySelector("[data-slot=artifact-comment-layer]")`);
    pressC();
    await waitFor(`${commentButton}.getAttribute("aria-pressed") === "false"`);
    await evaluate(`document.querySelector("[data-slot=composer] textarea, textarea, [contenteditable=true]").focus()`);
    pressC();
    await delay(100);
    assert.equal(await evaluate(`${commentButton}.getAttribute("aria-pressed")`), "false", "C typed in a field stays text");
    await evaluate("document.activeElement?.blur()");
    await evaluate(`${dock}.querySelector("[aria-label='Comment on a design']").click()`);
    await waitFor(`!!${frame("login")}.querySelector("[data-slot=artifact-comment-layer]")`);
    assert.equal(await evaluate(`/pin a comment/i.test(${dock}.textContent)`), false, "no instruction banner");
    // Over a design, the pointer is the pin's own shape, its point on the spot a click pins.
    assert.match(
      await evaluate(`getComputedStyle(${frame("login")}.querySelector("[data-slot=artifact-comment-layer]")).cursor`),
      /image-set\(url\("data:image\/svg\+xml/,
    );
    const point = await evaluate(
      `(() => { const r = ${frame("login")}.querySelector("[data-slot=artifact-comment-layer]").getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 4) }; })()`,
    );
    window.webContents.sendInputEvent({
      type: "mouseDown",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
    window.webContents.sendInputEvent({
      type: "mouseUp",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
    await waitFor(`!!${frame("login")}.querySelector("[data-slot=artifact-comment-bubble] textarea") && document.activeElement?.tagName === "TEXTAREA"`);
    // The pin's point, its top-left corner, is where the click landed; the bubble grows from that point, at screen size.
    const bubble = await evaluate(
      `(() => { const p = ${frame("login")}.querySelector("[data-slot=artifact-pin]").getBoundingClientRect(); const b = ${frame("login")}.querySelector("[data-slot=artifact-comment-bubble]").getBoundingClientRect(); return { pin: [p.left, p.top, p.width], bubble: [b.left, b.top, Math.round(b.width)] }; })()`,
    );
    assert.ok(
      Math.abs(bubble.pin[0] - point.x) < 1.5 && Math.abs(bubble.pin[1] - point.y) < 1.5 && Math.round(bubble.pin[2]) === 24,
      `the pin's point is on the click: ${JSON.stringify(bubble)}`,
    );
    assert.ok(
      Math.abs(bubble.bubble[0] - point.x) < 1.5 && Math.abs(bubble.bubble[1] - point.y) < 1.5 && bubble.bubble[2] === 256,
      "the bubble opens from the pin's point",
    );
    // The pin became the bubble: its surface grows to the bubble's size, its number hidden meanwhile.
    await waitFor(
      `(() => { const s = ${frame("login")}.querySelector("[data-slot=artifact-comment-surface]").getBoundingClientRect(); return Math.round(s.width) === 256; })()`,
    );
    assert.equal(await evaluate(`${frame("login")}.querySelector("[data-slot=artifact-pin]").inert`), true, "the pin's number steps aside for the bubble");
    assert.equal(await evaluate(`!!${dock}.querySelector("footer")`), false, "comments are written on the canvas, not in a list below it");
    await evaluate(`(() => {
      const box = document.activeElement;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(box, "Make the button bigger");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await screenshot("comment");
    // The box grows with the comment, the bubble and its surface with it, up to eight lines; then it scrolls.
    const commentBox = `${frame("login")}.querySelector("[data-slot=artifact-comment-bubble] textarea")`;
    const typeComment = (value) =>
      evaluate(`(() => {
        const box = ${commentBox};
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(box, ${JSON.stringify(value)});
        box.dispatchEvent(new Event("input", { bubbles: true }));
      })()`);
    const boxSize = () =>
      evaluate(
        `(() => { const b = ${commentBox}; const line = parseFloat(getComputedStyle(b).lineHeight); return { height: b.clientHeight, scroll: b.scrollHeight, line }; })()`,
      );
    const oneLine = await boxSize();
    await typeComment("Make the button bigger\nand warmer\nwith a softer shadow\nand round corners");
    const fourLines = await boxSize();
    assert.ok(fourLines.height > oneLine.height + fourLines.line * 1.5, `the box grows with the comment: ${JSON.stringify({ oneLine, fourLines })}`);
    assert.equal(fourLines.scroll, fourLines.height, "four lines show whole");
    await typeComment(Array.from({ length: 14 }, (_, index) => `Line ${index + 1} of a long comment`).join("\n"));
    const long = await boxSize();
    assert.ok(Math.abs(long.height - long.line * 8) <= 2, `eight lines at most: ${JSON.stringify(long)}`);
    assert.ok(long.scroll > long.height + long.line * 4, "the rest scrolls");
    // The surface the pin morphed into follows the bubble's new size.
    await waitFor(
      `(() => { const s = ${frame("login")}.querySelector("[data-slot=artifact-comment-surface]").getBoundingClientRect(); const b = ${frame("login")}.querySelector("[data-slot=artifact-comment-bubble]").getBoundingClientRect(); return Math.abs(s.height - b.height) < 1 && b.height > ${long.line * 8}; })()`,
    );
    await screenshot("comment-long");
    await typeComment("Make the button bigger");
    await waitFor(`${commentBox}.clientHeight === ${oneLine.height}`);
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
    await waitFor(`!${frame("login")}.querySelector("[data-slot=artifact-comment-bubble]") && !!${dock}`);
    assert.match(await evaluate(`${frame("login")}.querySelector("[data-slot=artifact-pin]").getAttribute("aria-label")`), /Comment 1: Make the button bigger/);
    assert.match(await evaluate(`${dock}.querySelector("[data-slot=artifact-send]").textContent`), /Send\s*2/);
    await screenshot("pending-feedback");

    // Closing the Designs keeps what waits for Send: they open again with the pin, on the version it was left on, and
    // the choice.
    await evaluate(`${dock}.querySelector("[aria-label='Close designs']").click()`);
    await waitFor(`!${dock}`);
    await evaluate(`${thumb("home")}.click()`);
    await waitFor(`!!${frame("login")}?.querySelector("[data-slot=artifact-pin]") && !!${frame("home")}?.querySelector("[data-slot=artifact-choice-pending]")`);
    assert.match(await evaluate(`${frame("login")}.querySelector("[data-slot=artifact-pin]").getAttribute("aria-label")`), /Comment 1: Make the button bigger/);
    assert.match(await evaluate(`${frame("login")}.textContent`), /v2 of 3/, "the pin's version shows again");
    assert.match(await evaluate(`${dock}.querySelector("[data-slot=artifact-send]").textContent`), /Send\s*2/);
    await screenshot("pending-kept-after-close");

    // Send carries the choice and the comments in one message.
    assert.equal(await evaluate("(window.kept ?? []).length"), 0, "nothing is recorded before it is sent");
    await evaluate(`${dock}.querySelector("[data-slot=artifact-send]").click()`);
    await waitFor("window.sent.length === 1");
    // The comment goes with the id the app named it by, and is recorded under it once the message went.
    const commentId = /\(comment ([a-f0-9]{8})\)/.exec(await evaluate("window.sent[0]"))?.[1];
    await waitFor(`window.kept?.[0]?.id === "${commentId}"`);
    assert.match(
      await evaluate("window.sent[0]"),
      /^I chose the design "Home" \(home, version 1\)\. Continue from this one\.\n\nA comment on the designs:\n\n1\. \(comment [a-f0-9]{8}\) On the design "Login screen, warmer" \(login, version 2\), 50% across and 2\d% down(?:, layer "[^"]+")?: Make the button bigger\n\n.*artifact_resolve_comment/s,
    );
    assert.match(await evaluate("window.sent[0]"), /Read the latest design with design_read, then revise its layers with design_apply and expectedVersion/);
    assert.doesNotMatch(await evaluate("window.sent[0]"), /artifact_show|artifact_read/);
    await waitFor(`!!${frame("home")}.querySelector("[data-slot=artifact-chosen]") && !${dock}.querySelector("[data-slot=artifact-send]")`);
    assert.equal(await evaluate(`${dock}.querySelectorAll("[data-slot=artifact-pin]").length`), 0, "nothing is left waiting to send");
    // A sent comment stays where it was left, to read back.
    await waitFor(`${frame("login")}.querySelectorAll("[data-slot=artifact-sent-pin]").length === 1`);
    // In the chat the feedback is a card, not the text the agent reads: the choice, and the comment beside its spot.
    const card = 'document.querySelector("[data-slot=design-feedback]")';
    await waitFor(`!!${card}?.querySelector("[data-slot=design-feedback-comment] iframe")`);
    assert.match(await evaluate(`${card}.querySelector("[data-slot=design-feedback-choice]").textContent`), /Chose Home/);
    assert.match(
      await evaluate(`${card}.querySelector("[data-slot=design-feedback-comment]").textContent`),
      /Make the button bigger.*Login screen, warmer · v2/,
    );
    assert.equal(
      await evaluate(`/design_read|design_apply/.test(${card}.closest("[data-slot=message]").textContent)`),
      false,
      "the agent's instructions stay out of sight",
    );
    await evaluate(`${card}.scrollIntoView()`);
    await screenshot("feedback-card");
    // The card's comment opens the canvas on it, its bubble open; the choice is only a record.
    assert.equal(await evaluate(`${card}.querySelector("[data-slot=design-feedback-choice]").tagName`), "DIV");
    await evaluate(`${dock}.querySelector("[aria-label='Close designs']").click()`);
    await waitFor(`!${dock}`);
    await evaluate(`${card}.querySelector("[data-slot=design-feedback-comment]").click()`);
    await waitFor(`!!${dock} && /Make the button bigger/.test(${frame("login")}?.querySelector("[data-slot=artifact-comment-bubble]")?.textContent ?? "")`);
    assert.match(await evaluate(`${frame("login")}.querySelector("[data-slot=artifact-comment-bubble]").textContent`), /Sent to the agent/);
    assert.equal(await evaluate(`!!${frame("login")}.querySelector("[data-slot=artifact-comment-bubble] textarea")`), false, "a sent comment can't change");
    await screenshot("sent-comment");
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    await waitFor(`!${frame("login")}.querySelector("[data-slot=artifact-comment-bubble]") && !!${dock}`);

    // The agent resolves the comment with a note: the pin turns green and its bubble and the chat's card show the note.
    await evaluate('window.agentResolves("Sign in button is 48px tall now")');
    await waitFor(`/resolved/.test(${frame("login")}.querySelector("[data-slot=artifact-sent-pin]").getAttribute("aria-label"))`);
    assert.match(await evaluate(`${card}.querySelector("[data-slot=design-feedback-resolved]").textContent`), /Sign in button is 48px tall now/);
    // Mid-morph, slowed down: the green pin growing from its point into the bubble.
    if (process.env.MILAGRE_SCREENSHOT_DIR) {
      await evaluate(
        `document.head.appendChild(Object.assign(document.createElement("style"), { id: "slow-morph", textContent: "[data-slot=artifact-comment-surface] { transition-duration: 2400ms !important; }" }))`,
      );
    }
    await evaluate(`${frame("login")}.querySelector("[data-slot=artifact-sent-pin]").click()`);
    if (process.env.MILAGRE_SCREENSHOT_DIR) {
      await delay(250);
      const fs = require("node:fs");
      fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, "comment-mid-morph.png"), (await window.webContents.capturePage()).toPNG());
      await evaluate(`document.getElementById("slow-morph").remove()`);
    }
    await waitFor(`/48px tall/.test(${frame("login")}.querySelector("[data-slot=artifact-comment-resolved]")?.textContent ?? "")`);
    await screenshot("resolved-comment");
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    await waitFor(`!${frame("login")}.querySelector("[data-slot=artifact-comment-bubble]") && !!${dock}`);

    // ⌘Enter (Control+Enter off the Mac) in a bubble sends the comment right away, without the Send button. A canvas
    // filling the workspace steps back beside the chat to show the reply coming.
    await evaluate(`${dock}.querySelector("[aria-label='Fill the window with the designs']").click()`);
    await waitFor(`${dock}.dataset.full === "true"`);
    await evaluate(`${dock}.querySelector("[aria-label='Comment on a design']").click()`);
    await waitFor(`!!${frame("login")}.querySelector("[data-slot=artifact-comment-layer]")`);
    const second = await evaluate(
      `(() => { const r = ${frame("login")}.querySelector("[data-slot=artifact-comment-layer]").getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + (r.height * 3) / 4) }; })()`,
    );
    window.webContents.sendInputEvent({
      type: "mouseDown",
      x: second.x,
      y: second.y,
      button: "left",
      clickCount: 1,
    });
    window.webContents.sendInputEvent({
      type: "mouseUp",
      x: second.x,
      y: second.y,
      button: "left",
      clickCount: 1,
    });
    await waitFor(`!!${frame("login")}.querySelector("[data-slot=artifact-comment-bubble] textarea") && document.activeElement?.tagName === "TEXTAREA"`);
    await evaluate(`(() => {
      const box = document.activeElement;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(box, "Round the corners");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    window.webContents.sendInputEvent({
      type: "keyDown",
      keyCode: "Enter",
      modifiers: [process.platform === "darwin" ? "meta" : "control"],
    });
    await waitFor("window.sent.length === 2");
    assert.match(await evaluate("window.sent[1]"), /Round the corners/);
    await waitFor(`!${dock}.querySelector("[data-slot=artifact-send]") && ${frame("login")}.querySelectorAll("[data-slot=artifact-sent-pin]").length === 2`);
    await waitFor(`!${dock}.dataset.full`);
    await screenshot("sent-with-shortcut");
    // ⌘Enter anywhere in the Designs sends what waits there, not only from a comment box: keep a comment with Enter
    // (its box closes and the focus leaves it), then press ⌘Enter on the canvas.
    await evaluate(`${dock}.querySelector("[aria-label='Comment on a design']")?.click()`);
    await waitFor(`!!${frame("login")}.querySelector("[data-slot=artifact-comment-layer]")`);
    const third = await evaluate(
      `(() => { const r = ${frame("login")}.querySelector("[data-slot=artifact-comment-layer]").getBoundingClientRect(); return { x: Math.round(r.left + r.width / 4), y: Math.round(r.top + r.height / 4) }; })()`,
    );
    for (const type of ["mouseDown", "mouseUp"]) window.webContents.sendInputEvent({ type, x: third.x, y: third.y, button: "left", clickCount: 1 });
    await waitFor(`document.activeElement?.tagName === "TEXTAREA"`);
    await evaluate(`(() => {
      const box = document.activeElement;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(box, "Tighter spacing");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
    await waitFor(`!${frame("login")}.querySelector("[data-slot=artifact-comment-bubble]") && !!${dock}.querySelector("[data-slot=artifact-send]")`);
    assert.notEqual(await evaluate("document.activeElement?.tagName"), "TEXTAREA");
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter", modifiers: [process.platform === "darwin" ? "meta" : "control"] });
    await waitFor("window.sent.length === 3");
    assert.match(await evaluate("window.sent[2]"), /Tighter spacing/);
    await waitFor(`!${dock}.querySelector("[data-slot=artifact-send]")`);

    // The corner button shows while the Chat has designs, and closes and reopens the canvas.
    const toggle = 'document.querySelector("[data-panel-toggle=designs]")';
    assert.equal(await evaluatePanel(`${toggle}.getAttribute("aria-checked")`), "true");
    assert.equal(await evaluatePanel('!!document.querySelector("[data-panel-toggle=simulator]")'), false, "no simulator button without a simulator");
    await evaluatePanel(`${toggle}.click()`);
    await waitForPanel(`!${dock} && ${toggle}.getAttribute("aria-checked") === "false"`);
    // Shortcuts remain visible beside the actions in the overflow menu.
    assert.ok(await evaluatePanel(`${toggle}.textContent.length > "designs".length`));
    await screenshot("panel-menu-shortcuts");
    // Closed and opened again before it finishes closing, the panel turns around and opens whole, not stuck at nothing.
    await evaluatePanel(`${toggle}.click()`);
    await waitFor(`!!${dock} && Math.round(${dock}.getBoundingClientRect().width) === 560`);
    await evaluatePanel(`${toggle}.click()`);
    await delay(80);
    await evaluatePanel(`${toggle}.click()`);
    await waitFor(`!!${dock} && Math.round(${dock}.getBoundingClientRect().width) === 560`);
    await waitFor('getComputedStyle((document.querySelector("[data-dock-layer]") ?? document.body)).getPropertyValue("--artifact-dock").trim() === "572px"');
    await evaluatePanel(`${toggle}.click()`);
    await waitFor(`!${dock}`);

    // ⌘⇧E does the same as the button, also while typing in the composer.
    await evaluate('document.querySelector("[data-prompt-editor]").focus()');
    window.webContents.sendInputEvent({
      type: "keyDown",
      keyCode: "E",
      modifiers: ["meta", "shift"],
    });
    await waitFor(`!!${dock} && ${dock}.querySelectorAll("[data-slot=artifact-frame]").length === 2`);
    window.webContents.sendInputEvent({
      type: "keyDown",
      keyCode: "E",
      modifiers: ["meta", "shift"],
    });
    await waitFor(`!${dock}`);
    await evaluatePanel(`${toggle}.click()`);
    await waitFor(`!!${dock} && ${dock}.querySelectorAll("[data-slot=artifact-frame]").length === 2`);

    // The git changes panel opens at the window's right edge: the design docks beside it instead of covering it.
    await evaluate("window.setChanges(true)");
    await waitFor(`Math.round(window.innerWidth - ${dock}.getBoundingClientRect().right) === 312`);
    // With the diff in the chat's place, the design steps aside, and comes back with the chat.
    await evaluate("window.setDiff(true)");
    await waitFor(`!${dock}`);
    assert.equal(
      await evaluate('getComputedStyle((document.querySelector("[data-dock-layer]") ?? document.body)).getPropertyValue("--artifact-dock")'),
      "",
      "a hidden design reserves nothing",
    );
    await evaluate("window.setDiff(false)");
    await waitFor(`!!${dock}`);
    await evaluate("window.setChanges(false)");
    await waitFor(`Math.round(window.innerWidth - ${dock}.getBoundingClientRect().right) === 12`);

    // Too narrow for all three side panels beside a usable chat, the third to open closes the one opened first, and
    // its button at the top lets go.
    const pressed = (name) => evaluatePanel(`document.querySelector("[data-panel-toggle=${name}]").getAttribute("aria-checked")`);
    await evaluate("window.setSimulator(true)");
    await waitForPanel(`document.querySelector("[data-panel-toggle=simulator]")?.getAttribute("aria-checked") === "true"`);
    assert.equal(await pressed("designs"), "true");
    await evaluate("window.setChanges(true)");
    await waitFor(`!${dock}`);
    assert.equal(await pressed("designs"), "false", "the designs, opened first, close");
    assert.equal(await pressed("simulator"), "true");
    await evaluatePanel(`${toggle}.click()`);
    await waitFor("!window.simulatorOpen");
    assert.equal(await pressed("simulator"), "false", "then the simulator, opened before the changes panel");
    assert.equal(await pressed("designs"), "true");
    await evaluate("window.setChanges(false)");
    await waitFor(`!!${dock} && Math.round(window.innerWidth - ${dock}.getBoundingClientRect().right) === 12`);

    // The design can fill the workspace beside the sidebar, covering the chat, and go back beside it.
    await evaluate('window.expandedEvents = 0; window.addEventListener("milagre:designs-expanded", () => window.expandedEvents++)');
    await evaluate(`${dock}.querySelector("[aria-label='Fill the window with the designs']").click()`);
    await waitFor(`${dock}.dataset.full === "true" && Math.round(${dock}.getBoundingClientRect().left) === 260`);
    assert.equal(
      await evaluate('getComputedStyle((document.querySelector("[data-dock-layer]") ?? document.body)).getPropertyValue("--artifact-dock")'),
      "",
      "a full design reserves nothing",
    );
    assert.equal(await evaluate("window.expandedEvents"), 1, "expanding asks the other side panels to close");
    await screenshot("expanded");
    await evaluate(`${dock}.querySelector("[aria-label='Show the chat beside the designs']").click()`);
    await waitFor(`!${dock}.dataset.full`);
    // Back beside the chat, the chat makes room for the panel again.
    await waitFor('getComputedStyle((document.querySelector("[data-dock-layer]") ?? document.body)).getPropertyValue("--artifact-dock").trim() === "572px"');
    // Too narrow for a useful chat beside it, the design fills the workspace on its own.
    window.setContentSize(1100, 820);
    await waitFor(`${dock}.dataset.full === "true" && !${dock}.querySelector("[aria-label='Fill the window with the designs']")`);
    await screenshot("narrow");
    window.setContentSize(1280, 820);
    await waitFor(`!${dock}.dataset.full`);

    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    await waitFor(`!${dock}`);
    assert.equal(
      await evaluate('getComputedStyle((document.querySelector("[data-dock-layer]") ?? document.body)).getPropertyValue("--artifact-dock")'),
      "",
      "closing gives the chat its width back",
    );
    // Restored HTML feedback keeps the person's words without exposing revision controls.
    await evaluate(
      'window.appendFeedback({ choice: { id: "legacy", version: 1, title: "Explanation" }, comments: [{ design: { id: "legacy", version: 1, title: "Explanation" }, text: "Keep the original wording" }] })',
    );
    await waitFor('[...document.querySelectorAll("[data-slot=design-feedback]")].some(node => node.textContent.includes("Keep the original wording"))');
    const legacyFeedback = await evaluate(
      '[...document.querySelectorAll("[data-slot=design-feedback]")].find(node => node.textContent.includes("Keep the original wording")).textContent',
    );
    assert.match(legacyFeedback, /Explanation/);
    assert.match(legacyFeedback, /Artifact/);
    assert.doesNotMatch(legacyFeedback, /v1|version 1|design_read|design_apply|artifact_show|artifact_resolve_comment/);
    // Unknown references still fall back to readable feedback instead of empty bubbles.
    await evaluate(
      'window.appendFeedback({ choice: { id: "missing", version: 1, title: "Missing design", format: "design" }, comments: [{ design: { id: "missing", version: 1, title: "Missing design", format: "design" }, text: "Preserve this older feedback too" }] })',
    );
    await waitFor('!!document.querySelector("[data-slot=design-feedback-text]")');
    assert.match(await evaluate('document.querySelector("[data-slot=design-feedback-text]").textContent'), /Preserve this older feedback too/);
    await evaluate('document.querySelector("[data-slot=design-feedback-text]").scrollIntoView()');
    await screenshot("historical-feedback-text");
    // A design is deleted from its frame on the canvas after a second press, and leaves the canvas and the Chat's cards.
    await evaluatePanel('document.querySelector("[data-panel-toggle=designs]").click()');
    await waitFor(`${frames}?.length === 2`);
    await evaluate(`${frame("home")}.querySelector("[data-slot=artifact-delete]").click()`);
    await waitFor(`!!${frame("home")}.querySelector("[data-slot=artifact-delete-confirm]")`);
    await screenshot("delete-confirm");
    await evaluate(`[...${frame("home")}.querySelectorAll("button")].find((button) => button.textContent === "Cancel").click()`);
    await waitFor(`!!${frame("home")}.querySelector("[data-slot=artifact-delete]")`);
    assert.equal(await evaluate("window.deletedIds"), undefined, "Cancel deletes nothing");
    await evaluate(`${frame("home")}.querySelector("[data-slot=artifact-delete]").click()`);
    await waitFor(`!!${frame("home")}.querySelector("[data-slot=artifact-delete-confirm]")`);
    await evaluate(`${frame("home")}.querySelector("[data-slot=artifact-delete-confirm]").click()`);
    await waitFor(`${frames}.length === 1 && !${frame("home")}`);
    assert.deepEqual(await evaluate("window.deletedIds"), ["home"]);
    assert.doesNotMatch(await evaluate(`${dock}.querySelector("header").textContent`), /in this Chat/, "the header is one row, with no count under the title");
    await waitFor('!document.querySelector("[data-slot=artifact-thumb][data-artifact=home]") && !document.querySelector("[data-slot=artifact-group]")');
    await screenshot("deleted");
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    await waitFor(`!${dock}`);
    // The one HTML page is independent of Designs, with no version/choice/editor controls.
    await evaluate("window.designsEnabled=false; window.designsChanged({enabled:false})");
    await waitForPanel('!document.querySelector("[data-panel-toggle=designs]") && !!document.querySelector("[data-panel-toggle=artifacts]")');
    await evaluatePanel('document.querySelector("[data-panel-toggle=artifacts]").click()');
    await waitFor(`${dock}?.getAttribute("aria-label") === "Artifacts" && !!document.querySelector("[data-slot=artifact-page] iframe")`);
    assert.equal(await evaluate(`${dock}.querySelectorAll('[data-slot=artifact-edit], [data-slot=artifact-frame-version], [aria-label^="Choose"]').length`), 0);
    assert.equal(await evaluate(`${dock}.querySelectorAll('iframe').length`), 1, "a single HTML page is shown");
    assert.equal(await evaluate('!!document.querySelector("[data-artifact=legacy]")'), true);
    assert.equal(await evaluate('!!document.querySelector("[data-artifact=login]")'), false, "Designs OFF hides only structured designs");
    assert.equal(await evaluate('!!document.querySelector("[data-artifact=home]")'), false, "unmarked structured refs stay hidden when Designs is OFF");
    await waitFor(`${dock}.querySelector('[aria-label="Share page"]')`);
    // The page fills the dock, named in the header, with the zoom bar bottom-left; no comment box under it.
    assert.equal(await evaluate(`${dock}.querySelector("[data-slot=artifact-dock-title]").textContent`), "Explanation");
    await waitFor(`${dock}.querySelector("[data-slot=artifact-zoom]")?.textContent === "100%"`);
    assert.equal(await evaluate(`!!${dock}.querySelector("textarea")`), false);
    // In comment mode a click on the page pins a comment there; its bubble opens in the dock, at the pin.
    await evaluate(`${dock}.querySelector('button[aria-label="Comment on the page"]').click()`);
    await waitFor(`${dock}.querySelector('button[aria-label="Stop commenting"]')?.getAttribute("aria-pressed") === "true"`);
    // Leave room for the 264px bubble so this checks anchoring rather than its right-edge clamp.
    const heading = await evaluate(
      `(() => { const r = ${dock}.querySelector("[data-slot=artifact-page] iframe").getBoundingClientRect(); return { x: Math.round(r.left + 20), y: Math.round(r.top + 40) }; })()`,
    );
    // The page's helper may still be starting: click until the bubble opens.
    // sendInputEvent stops at the page's frame; input through the DevTools protocol is hit-tested into it, as a real click.
    const input = window.webContents.debugger;
    if (!input.isAttached()) input.attach("1.3");
    for (let attempt = 0; attempt < 20 && !(await evaluate(`!!${dock}.querySelector("[data-slot=artifact-comment-bubble] textarea")`)); attempt++) {
      for (const type of ["mousePressed", "mouseReleased"])
        await input.sendCommand("Input.dispatchMouseEvent", { type, x: heading.x, y: heading.y, button: "left", clickCount: 1 });
      await delay(250);
    }
    await waitFor(`!!${dock}.querySelector("[data-slot=artifact-comment-bubble] textarea")`);
    const pinAt = await evaluate(
      `(() => { const r = ${dock}.querySelector("[data-slot=artifact-comment-bubble]").getBoundingClientRect(); return { x: r.left, y: r.top }; })()`,
    );
    assert.ok(Math.abs(pinAt.x - heading.x) < 2 && Math.abs(pinAt.y - heading.y) < 2, `the bubble opens at the click: ${JSON.stringify({ pinAt, heading })}`);
    await evaluate(`(() => {
      const input = ${dock}.querySelector("[data-slot=artifact-comment-bubble] textarea");
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(input, "Explain the next step");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await screenshot("artifact-comment-designs-off");
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
    await waitFor(
      `!${dock}.querySelector("[data-slot=artifact-comment-bubble]") && /Send\\s*1/.test(${dock}.querySelector('[data-slot="artifact-send"]')?.textContent ?? "")`,
    );
    await screenshot("artifact-pending-designs-off");
    await evaluate(`${dock}.querySelector('[data-slot="artifact-send"]').click()`);
    await waitFor('window.sent.at(-1).includes("Explain the next step")');
    const htmlComment = await evaluate("window.sent.at(-1)");
    assert.match(htmlComment, /On the artifact "Explanation" \(legacy\), \d+% across and \d+% down, near "How this works 1": Explain the next step/);
    assert.match(htmlComment, /artifact_read.*artifact_show/s);
    assert.doesNotMatch(htmlComment, /version|design_read|design_apply|I chose/);
    await waitFor('window.kept.at(-1).design.format === "html"');
    assert.match(await evaluate("window.kept.at(-1).anchor"), /^h1:1@/, "the host keeps where on the page it was left");
    await evaluate("window.reviseHtml()");
    // A card's preview mounts only once it nears the view, and the first reply's card sits above the fold: scroll to it
    // once the new reply has landed, or the transcript follows that reply down again.
    await waitFor('!!document.querySelector("[data-artifact=current-artifact]")');
    // Scroll on every check: on a slow runner the transcript can follow the new reply down again before the preview mounts.
    await waitFor(
      '(document.querySelector("[data-artifact=legacy]").scrollIntoView(), document.querySelector("[data-artifact=legacy] iframe")?.srcdoc.includes("How this works 2"))',
    );
    await waitFor(
      '[...document.querySelectorAll("[data-slot=design-feedback-comment]")].filter(node => /Keep the original wording|Explain the next step/.test(node.textContent)).every(node => node.querySelector("iframe")?.srcdoc.includes("How this works 2"))',
    );
    await waitFor('document.querySelector("[data-slot=artifact-page] iframe")?.srcdoc.includes("How this works 2")');
    await screenshot("artifact-page-designs-off");
    await evaluate(`${dock}.querySelector('[aria-label="Share page"]').click()`);
    await waitFor(`${shareDialog}.querySelector('[data-slot="design-page-publish"]')?.disabled === false`);
    await evaluate(`${shareDialog}.querySelector('[data-slot="design-page-publish"]').click()`);
    await waitFor(`${shareDialog}.querySelector('[data-slot="design-page-publish"]').textContent === "Update snapshot"`);
    assert.equal(await evaluate('window.shareCalls.filter(([kind])=>kind==="publish").at(-1)[1].kind'), "artifacts");
    assert.match(await evaluate(`${shareDialog}.textContent`), /hidden HTML included/);
    assert.equal(
      await evaluate(`${shareDialog}.querySelector("a").getAttribute("href")`),
      "https://share.milagre.cloud/s/snapshot-3",
      "the Artifact page gets its own link, not the Designs one",
    );
    await screenshot("artifact-share");
    await evaluate(`[...${shareDialog}.querySelectorAll("button")].find((button) => button.textContent === "Close").click()`);
    await evaluate(`(() => {
      window.htmlTabs = [
        { id: "overview", title: "Overview", html: "<h1>How this works 2</h1>" },
        { id: "headers", title: "Headers", html: "<h1>Cache headers</h1>" },
      ];
      const comment = { id: "ab123456", design: { id: "current-artifact", title: "Explanation", version: 2, format: "html" }, tab: { id: "headers", title: "Headers" }, x: 0.2, y: 0.2, text: "Explain cache headers" };
      window.kept.push(comment);
      window.appendFeedback({ comments: [comment] });
    })()`);
    const tabFeedback =
      '[...document.querySelectorAll("[data-slot=design-feedback-comment]")].find(node => node.textContent.includes("Explain cache headers"))';
    await waitFor(`!!${tabFeedback}`);
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    await waitFor(`!${dock}`);
    await evaluate(`${tabFeedback}.click()`);
    await waitFor('document.querySelector("[data-slot=artifact-page] iframe")?.srcdoc.includes("Cache headers")');
    assert.match(await evaluate(`${dock}.querySelector("header").textContent`), /Headers/);
    if (keepOpen) {
      await evaluate("window.designsEnabled=true; window.designsChanged({enabled:true})");
      await waitForPanel('!!document.querySelector("[data-panel-toggle=designs]")');
      await evaluatePanel('document.querySelector("[data-panel-toggle=artifacts]")?.click()');
      await evaluatePanel('document.querySelector("[data-panel-toggle=designs]").click()');
      await waitFor(`${dock}?.getAttribute("aria-label") === "Designs"`);
      await evaluate(`${dock}.querySelector("[aria-label='Comment on a design']").click()`);
      await waitFor(`!!${frame("login")}.querySelector("[data-slot=artifact-comment-layer]")`);
    }
    console.log(
      "PASS: a shown design is a card outside the activity with a sandboxed preview at its own screen size that can't make requests; Open docks a canvas of every design at the top right beside the chat (beside the git changes panel, away while the diff replaces the chat, filling the workspace when expanded or narrow), where frames follow revisions and step back through versions, zoom and fit work, wheel over a design pans until the design is clicked, choosing and Figma-like pinned comments wait for Send and reach the agent in one message, and Escape closes it",
    );
    if (!keepOpen) app.exit(0);
  } catch (error) {
    await screenshot("failure");
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
        name: "artifacts-fixture",
        resolveId(id) {
          if (id === "/__artifacts_fixture.tsx") return id;
        },
        load(id) {
          if (id === "/__artifacts_fixture.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url !== "/__artifacts__") return next();
            const html = await server.transformIndexHtml(
              request.url,
              '<html><body><div id="root"></div><script type="module" src="/__artifacts_fixture.tsx"></script></body></html>',
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
    const child = spawn(
      require("electron"),
      [path.resolve(__filename), `${server.resolvedUrls.local[0]}__artifacts__`, ...(process.argv.includes("--preview") ? ["--preview"] : [])],
      { env, stdio: "inherit" },
    );
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
