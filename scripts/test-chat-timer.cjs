// Run with node scripts/test-chat-timer.cjs. Set MILAGRE_SCREENSHOT_DIR to keep screenshots.
const assert = require("node:assert/strict");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");

const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatComposer } from "/src/components/ChatComposer";
import { SpinnerRing } from "/src/components/primitives/SpinnerRing";
import { followDisplayVisibility } from "/src/lib/display-clock";
followDisplayVisibility();
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
    <div data-rings style={{ display: "flex", alignItems: "center", gap: 4 }}>{[10, 12, 16].map(size => <SpinnerRing key={size} size={size} color="rgb(255, 0, 0)" />)}</div>
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
    // The SVG pixels stay still; only their HTML boxes animate. Exercise the
    // shared primitive at rail, row and normal sizes, plus the real running mark.
    assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.spinner-ring')).slice(0, 3).map(el => [el.offsetWidth, el.offsetHeight])`), [
      [10, 10],
      [12, 12],
      [16, 16],
    ]);
    assert.equal(await evaluate(`document.querySelector('.spinner-ring circle:last-child').getAttribute('stroke')`), "rgb(255, 0, 0)");
    const targets = `document.getAnimations().filter(a => ['spin', 'running-logo-glow', 'running-logo-twinkle'].includes(a.animationName))`;
    assert.equal(await evaluate(`${targets}.length >= 6 && ${targets}.every(a => a.effect.target instanceof HTMLSpanElement)`), true);
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.spinner-ring')).animationTimingFunction`), "steps(24)");
    assert.equal(await evaluate(`document.querySelector('.running-logo').getAttribute('aria-hidden')`), "true");
    assert.equal(await evaluate(`document.querySelectorAll('.running-logo > span > svg > path').length`), 3);
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.running-logo-leg-right')).animationDelay`), "0.24s");
    // Seek the actual browser animations to check the retained holds and peaks.
    async function seek(time) {
      return evaluate(
        `(() => { const result = {}; for (const a of ${targets}) { a.pause(); a.currentTime = ${time}; if (a.animationName.startsWith('running-logo')) result[a.effect.target.className] = getComputedStyle(a.effect.target).opacity; } return result; })()`,
      );
    }
    assert.equal((await seek(0))["running-logo-leg running-logo-leg-left"], "0.15");
    assert.equal((await seek(288))["running-logo-leg running-logo-leg-left"], "0.55");
    assert.equal((await seek(528))["running-logo-leg running-logo-leg-left"], "0.55");
    assert.equal((await seek(960))["running-logo-leg running-logo-leg-left"], "0.15");
    assert.equal((await seek(1200))["running-logo-star"], "0.45");
    assert.equal((await seek(1680))["running-logo-star"], "1");
    assert.equal((await seek(2040))["running-logo-star"], "1");
    await evaluate(`${targets}.forEach(a => a.play())`);
    await evaluate(`document.documentElement.setAttribute('data-display-hidden', '')`);
    assert.equal(await evaluate(`${targets}.every(a => getComputedStyle(a.effect.target).animationPlayState === 'paused')`), true);
    await evaluate(`document.documentElement.removeAttribute('data-display-hidden')`);
    assert.equal(
      await evaluate(`${targets}.every(a => getComputedStyle(a.effect.target).animationPlayState === 'running')`),
      true,
      "visible unfocused window keeps animating",
    );
    window.webContents.debugger.attach("1.3");
    await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    assert.equal(await evaluate(`${targets}.length`), 0, "reduced motion leaves both indicators static");
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.running-logo-star')).opacity`), "0.45");
    await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [] });
    window.webContents.debugger.detach();
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
    console.log(
      "PASS: compositor indicator targets, sizes, sampled holds, hidden and reduced motion; timers survive chat switches, remounts, question waits and delayed ticks; new turns reset",
    );
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
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
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
