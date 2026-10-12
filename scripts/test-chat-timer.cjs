// Run with node scripts/test-chat-timer.cjs. Set MILAGRE_SCREENSHOT_DIR to keep screenshots.
const assert = require("node:assert/strict");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatComposer } from "/src/components/ChatComposer";
import { MODEL_CATALOG, capabilityFor } from "/src/model";
import { startRun } from "@milagre/shared/agent-runs";
import "/src/styles.css";
window.milagre = Object.freeze({ listEditors: async () => [] });
const noop = () => {};
window.clock = 100000;
Date.now = () => window.clock;
let runs = startRun({}, "a", "gpt-6-sol");
window.clock = 120000;
runs = startRun(runs, "b", "gpt-6-sol");
window.clock = 165000;
function Fixture() {
  const [chat, setChat] = useState("a");
  const [asking, setAsking] = useState(false);
  const [, setVersion] = useState(0);
  window.openChat = setChat;
  window.ask = setAsking;
  window.newTurn = () => { runs = startRun(runs, chat, "gpt-6-sol"); setVersion(v => v + 1); };
  if (!chat) return <div>Chat closed</div>;
  return <div style={{ height: "100%", padding: 12 }}>
    <ChatComposer messages={[{ id: 1, session_id: chat === "a" ? 1 : 2, context: null, role: "user", body: "Check the chat timer" }]}
      imageDraft={{ images: [], files: [], attachFiles: noop, attachPath: noop, removeFile: noop, loading: false, error: "", onPaste: noop, clear: noop, remove: noop }}
      projectPath="/fixture" draft="" onDraftChange={noop} onSend={noop} isSending={true} sendBlocked={false}
      runStartedAt={runs[chat].startedAt} asking={asking}
      models={MODEL_CATALOG} cliStatus={null} onModelPickerOpen={noop} selectedModel={MODEL_CATALOG[0]} onModelChange={noop}
      capability={capabilityFor(MODEL_CATALOG[0], null)} onEffortChange={noop} ultracode={false} onUltracodeChange={noop}
      fastMode={false} onFastModeChange={noop} permissionMode="auto" onPermissionModeChange={noop}
      onRecommendationSelect={noop} worktrees={[]} onWorktreeChange={noop}
      isolation="local" onIsolationChange={noop} branches={[]} baseBranch="main" onBaseBranchChange={noop} newChatError={null} />
  </div>;
}
document.documentElement.classList.add("dark");
createRoot(document.getElementById("root")).render(<Fixture />);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", require("node:fs").mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-chat-timer-")));
  await app.whenReady();
  const window = new BrowserWindow({ width: 800, height: 600, useContentSize: true, show: false, webPreferences: { backgroundThrottling: false } });
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
  const timer = `document.querySelector('[role="status"][aria-label^="Working with"]')?.textContent`;
  try {
    await window.loadURL(process.argv[2]);
    await waitFor(`!!(${timer})`);
    await screenshot("initial");
    assert.equal(await evaluate(timer), "1m 5.0s", "opening mid-turn shows time since the turn began");
    await evaluate('window.openChat("b")');
    await waitFor(`(${timer}) === "45.0s"`);
    await screenshot("other-chat");
    await evaluate("window.openChat(null)");
    await waitFor(`!(${timer})`);
    await evaluate('window.clock = 185000; window.openChat("a")');
    await waitFor(`(${timer}) === "1m 25.0s"`);
    await screenshot("reopened");
    await evaluate("window.ask(true)");
    await delay(50);
    assert.equal(await evaluate(timer), "1m 25.0s", "question waits keep the turn's timer");
    await evaluate("window.clock = 190000; window.ask(false)");
    await waitFor(`(${timer}) === "1m 30.0s"`);
    await evaluate("window.clock = 250000");
    await waitFor(`(${timer}) === "2m 30.0s"`);
    await evaluate("window.newTurn()");
    await waitFor(`(${timer}) === "0.0s"`);
    await screenshot("new-turn");
    console.log("PASS: timers survive chat switches, remounts, question waits and delayed ticks; new turns reset");
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
        name: "chat-timer-fixture",
        resolveId(id) {
          if (id === "/__chat_timer_fixture.tsx") return id;
        },
        load(id) {
          if (id === "/__chat_timer_fixture.tsx") return fixture;
        },
        configureServer(server) {
          server.middlewares.use(async (request, response, next) => {
            if (request.url !== "/__chat_timer__") return next();
            const html = await server.transformIndexHtml(
              request.url,
              '<html><body><div id="root"></div><script type="module" src="/__chat_timer_fixture.tsx"></script></body></html>',
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
    const child = spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__chat_timer__`], { env, stdio: "inherit" });
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
