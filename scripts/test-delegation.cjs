// Run with node scripts/test-delegation.cjs. Checks the Delegation UI with a stubbed bridge: the approval
// card in the requesting Chat, the message with its sender in the receiving Chat, the report and the
// Negotiation agreement coming back, and a Link on the canvas showing a running Negotiation with Stop.
// Set MILAGRE_SCREENSHOT_DIR to keep screenshots.
const assert = require("node:assert/strict");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatComposer } from "/src/components/ChatComposer";
import { PermissionCard } from "/src/components/agents/PermissionCard";
import { CanvasView } from "/src/components/CanvasView";
import { MODEL_CATALOG, capabilityFor } from "/src/model";
import "/src/styles.css";
const noop = () => {};
const card = { requestId: "d-1", kind: "delegation", tool: "Delegation", title: "Open a Negotiation with web / main / Health client?", allowForChat: true,
  delegation: { target: "web / main / Health client", message: "Agree on the /health payload: I propose { ok: boolean, version: string }.", negotiation: true } };
const requester = [
  { id: 1, session_id: 2, context: null, role: "user", body: "Add a health check and make sure web reads it the same way." },
  { id: 2, session_id: 2, context: null, role: "assistant", body: "Added GET /health in the API. Opening a Negotiation with web on the payload." },
  { id: 3, session_id: 2, role: "user", body: "Works for me if version is optional; web doesn't show it yet.",
    context: { kind: "delegation-report", delegationId: "d1", from: "/web#4", fromLabel: "web / main / Health client", status: "done", negotiation: { id: "n1", round: 1 } } },
  { id: 4, session_id: 2, role: "assistant", body: "The payload is { ok: boolean, version?: string }. The API sends both; web reads ok and ignores version for now.",
    context: { kind: "negotiation-agreement", negotiationId: "n1", with: "web / main / Health client" } },
];
const receiver = [
  { id: 7, session_id: 4, role: "user", body: "Agree on the /health payload: I propose { ok: boolean, version: string }.",
    context: { kind: "delegation", delegationId: "d1", from: "/api#2", fromLabel: "api / main / Health check", negotiation: { id: "n1", round: 1 } } },
  { id: 8, session_id: 4, context: null, role: "assistant", body: "Works for me if version is optional; web doesn't show it yet." },
  { id: 9, session_id: 4, role: "assistant", body: "The Link between api / main / Health check and web / main / Health client was removed, so this Delegation was cancelled before delivery: \\"Also add a retry\\"",
    context: { kind: "linked-notice", delegationId: "d2" } },
];
const state = (id, title) => ({ next_id: 9, projects: {}, worktrees: { 1: { id: 1, project_id: 1, path: "/" + id, name: "main", diff: { added: 12, removed: 3 } } }, sessions: { 2: { id: 2, worktree_id: 1, agent_name: "main", status: "Stopped", title, provider: id === "web" ? "codex" : "claude", summary: { count: 2, firstId: 2, lastId: 2 } } }, messages: [], tasks: {} });
window.milagre = {
  getCanvas: async () => ({ projects: [{ id: "a", path: "/api", name: "api", openedAt: "", position: { x: 0, y: 0 } }, { id: "w", path: "/web", name: "web", openedAt: "", position: { x: 460, y: 0 } }],
    links: [{ id: "link-1", a: { project_id: "a" }, b: { project_id: "w" }, created_at: "" }], worktreePositions: {}, states: [{ path: "/api", state: state("api", "Health check") }, { path: "/web", state: state("web", "Health client") }] }),
  stopNegotiation: async (id) => { window.stopped = id; },
  addLink: async () => [], removeLink: async () => [], setProjectPosition: async () => [], setWorktreePosition: async () => null, getProjectImage: async () => null,
};
const work = { delegations: [{ id: "d1", link_id: "link-1", from_chat: "/api#2", to_chat: "/web#2", from_label: "api / main / Health check", to_label: "web / main / Health client", status: "running", negotiation_id: "n1", round: 1, message: "Agree on the payload" }],
  negotiations: [{ id: "n1", link_id: "link-1", chats: ["/api#2", "/web#2"], labels: ["api / main / Health check", "web / main / Health client"], round: 1 }], receiveOnly: ["/web#2"] };
function Fixture() {
  const [view, setView] = useState("approval");
  const [answer, setAnswer] = useState(null);
  const [opened, setOpened] = useState(null);
  window.setFixture = setView;
  window.answer = () => answer;
  window.opened = () => opened;
  if (view === "canvas") return <div style={{ display: "flex", height: "100vh", padding: 20 }}><CanvasView states={{}} runs={{}} linkedWork={work} onOpenChat={noop} onBack={noop} /></div>;
  return <div style={{ height: "100vh", padding: 12 }}>
    <ChatComposer messages={view === "receiver" ? receiver : view === "approval" ? requester.slice(0, 2) : requester}
      approval={view === "approval" ? <PermissionCard request={card} waiting={0} answering={answer} onAnswer={setAnswer} /> : undefined}
      onOpenLinkedChat={setOpened}
      imageDraft={{ images: [], files: [], attachFiles: noop, attachPath: noop, removeFile: noop, loading: false, error: "", onPaste: noop, clear: noop, remove: noop }}
      projectPath="/fixture" draft="" onDraftChange={noop} onSend={noop} isSending={false} sendBlocked={false}
      models={MODEL_CATALOG} cliStatus={null} onModelPickerOpen={noop} selectedModel={MODEL_CATALOG[0]} onModelChange={noop}
      capability={capabilityFor(MODEL_CATALOG[0], null)} onEffortChange={noop} ultracode={false} onUltracodeChange={noop}
      fastMode={false} onFastModeChange={noop} permissionMode="ask" onPermissionModeChange={noop}
      onRecommendationSelect={noop} worktrees={[]} onWorktreeChange={noop}
      isolation="local" onIsolationChange={noop} branches={[]} baseBranch="main" onBaseBranchChange={noop} newChatError={null} />
  </div>;
}
document.documentElement.classList.add("dark");
createRoot(document.getElementById("root")).render(<Fixture />);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", require("node:fs").mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-delegation-")));
  await app.whenReady();
  const window = new BrowserWindow({ width: 900, height: 720, useContentSize: true, show: false, webPreferences: { backgroundThrottling: false } });
  window.webContents.on("console-message", (details) => {
    if (details.level === "error") console.error(details.message);
  });
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  async function screenshot(name) {
    if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
    await delay(900);
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
  const text = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ""`);
  const button = (label) => `[...document.querySelectorAll("button")].find((item) => item.textContent.trim() === ${JSON.stringify(label)})`;
  try {
    await window.loadURL(process.argv[2]);
    await waitFor(`!!${button("Always allow for this Link in this chat")}`);
    const cardText = await evaluate("document.body.textContent");
    assert.match(cardText, /Open a Negotiation with web \/ main \/ Health client\?/);
    assert.match(cardText, /Negotiation, up to 10 rounds\./);
    assert.match(cardText, /Agree on the \/health payload: I propose \{ ok: boolean, version: string \}\./);
    await screenshot("approval-card");
    await evaluate(`${button("Always allow for this Link in this chat")}.click()`);
    assert.equal(await evaluate("window.answer()"), "allow-for-chat");

    await evaluate('window.setFixture("receiver")');
    await waitFor('!!document.querySelector("[data-linked=delegation]")');
    assert.match(await text("[data-linked=delegation]"), /^Delegation from api \/ main \/ Health check · Negotiation round 1/);
    assert.equal(
      await evaluate('document.querySelector("[data-linked=delegation]").classList.contains("items-end")'),
      false,
      "a Delegation isn't drawn as the user's own message",
    );
    assert.match(await text("[data-linked=linked-notice]"), /was cancelled before delivery/);
    await screenshot("receiver");
    await evaluate('document.querySelector("[data-linked-from]").click()');
    assert.equal(await evaluate("window.opened()"), "/api#2");

    await evaluate('window.setFixture("requester")');
    await waitFor('!!document.querySelector("[data-linked=negotiation-agreement]")');
    assert.match(await text("[data-linked=delegation-report]"), /^Delegation report from web \/ main \/ Health client · Negotiation round 1/);
    assert.match(await text("[data-linked=negotiation-agreement]"), /^Negotiation agreement with web \/ main \/ Health client/);
    await screenshot("requester");

    await evaluate('window.setFixture("canvas")');
    await waitFor('!!document.querySelector("[data-link-activity]")');
    assert.match(await text("[data-link-activity]"), /Negotiation · round 1 of 10/);
    await waitFor('document.body.textContent.includes("receive-only")');
    await screenshot("canvas");
    await evaluate('document.querySelector("[data-link-activity] button").click()');
    assert.equal(await evaluate("window.stopped"), "n1");
    console.log("PASS: Delegation card, sender message, report and agreement, canvas Link with a stoppable Negotiation, receive-only Codex Chat");
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
        name: "delegation-fixture",
        resolveId(id) {
          if (id === "/__delegation_fixture.tsx") return id;
        },
        load(id) {
          if (id === "/__delegation_fixture.tsx") return fixture;
        },
        configureServer(server) {
          server.middlewares.use(async (request, response, next) => {
            if (request.url !== "/__delegation__") return next();
            const html = await server.transformIndexHtml(
              request.url,
              '<html><body><div id="root"></div><script type="module" src="/__delegation_fixture.tsx"></script></body></html>',
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
    const child = spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__delegation__`], { env, stdio: "inherit" });
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
