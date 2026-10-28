// Run with node scripts/test-step-details.cjs. Checks that a saved step whose long output the host keeps in a sidecar
// (hasDetail, no detail) still opens: it reads its message from the host once, shows "Loading output…" until then, and
// says so when the output can't be read. A step with its output inline opens without asking the host, and a reply
// still streaming never asks. Set MILAGRE_SCREENSHOT_DIR to keep screenshots.
const assert = require("node:assert/strict");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");

const fixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import { ChatComposer } from "/src/components/ChatComposer";
import { MODEL_CATALOG, capabilityFor } from "/src/model";
import "/src/styles.css";
const noop = () => {};
const output = "$ npm test\\n" + Array.from({ length: 40 }, (_, index) => "ok " + (index + 1) + " - test " + (index + 1)).join("\\n");
const ran = (id, command, extra) => ({ id, kind: "shell", title: "Ran \\u0060" + command + "\\u0060", status: "done", offset: 0, ...extra });
const messages = [
  { id: 1, session_id: 1, context: null, role: "user", body: "Run the tests" },
  { id: 2, session_id: 1, context: null, role: "assistant", body: "All 40 pass.", detailFile: "a".repeat(64) + ".json",
    steps: [ran("long", "npm test", { hasDetail: true }), ran("short", "git status", { detail: "$ git status\\nnothing to commit" })] },
  { id: 3, session_id: 1, context: null, role: "user", body: "And the old run?" },
  { id: 4, session_id: 1, context: null, role: "assistant", body: "Its output is gone.", detailFile: "b".repeat(64) + ".json",
    steps: [ran("gone", "npm run e2e", { hasDetail: true })] },
];
window.hostReads = [];
window.recoverRead = false;
let release;
window.releaseRead = () => release();
window.milagre = {
  listEditors: () => Promise.resolve([]),
  getMessage: (scope, id) => {
    window.hostReads.push(scope + "#" + id);
    if (id === 4) return window.recoverRead
      ? Promise.resolve({ ...messages[3], steps: [ran("gone", "npm run e2e", { detail: "$ npm run e2e\\nRecovered output" })] })
      : Promise.reject(new Error("Connection lost."));
    return new Promise((resolve) => {
      release = () => resolve({ ...messages[1], detailFile: undefined, steps: [ran("long", "npm test", { detail: output }), messages[1].steps[1]] });
    });
  },
};
function Fixture() {
  return <div style={{ height: "100%", padding: 12 }}>
    <ChatComposer messages={messages} messageScope="/fixture"
      imageDraft={{ images: [], files: [], attachFiles: noop, attachPath: noop, removeFile: noop, loading: false, error: "", onPaste: noop, clear: noop, remove: noop }}
      projectPath="/fixture/worktree" draft="" onDraftChange={noop} onSend={noop} isSending={true} sendBlocked={false}
      streamingText="" streamingSteps={[ran("live", "npm run build", { status: "running", hasDetail: true })]}
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
  app.setPath("userData", require("node:fs").mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-step-details-")));
  await app.whenReady();
  const window = new BrowserWindow({ width: 800, height: 700, useContentSize: true, show: false, webPreferences: { backgroundThrottling: false } });
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
  // The step row's toggle, found by the command its title shows.
  const toggle = (command) =>
    `[...document.querySelectorAll("[data-slot=step]")].find((step) => step.textContent.includes(${JSON.stringify(command)}))?.querySelector("button[aria-expanded]")`;
  const stepText = (command) =>
    `[...document.querySelectorAll("[data-slot=step]")].find((step) => step.textContent.includes(${JSON.stringify(command)}))?.textContent ?? ""`;
  try {
    await window.loadURL(process.argv[2]);
    await waitFor(`!!document.querySelector("[data-slot=activity] > button")`);
    // Replies inside an activity block start collapsed: open the blocks so their steps show.
    await evaluate(
      `[...document.querySelectorAll("[data-slot=message] button[aria-expanded=false]")].filter((button) => !button.closest("[data-slot=step]")).forEach((button) => button.click())`,
    );
    await waitFor(`!!${toggle("git status")}`);

    await evaluate(`${toggle("git status")}.click()`);
    await waitFor(`${stepText("git status")}.includes("nothing to commit")`);
    assert.deepEqual(await evaluate("window.hostReads"), [], "inline output opens without asking the host");

    await evaluate(`${toggle("npm test")}.click()`);
    await waitFor(`${stepText("npm test")}.includes("Loading output")`);
    await screenshot("loading");
    await evaluate("window.releaseRead()");
    await waitFor(`${stepText("npm test")}.includes("ok 40 - test 40")`);
    assert.deepEqual(await evaluate("window.hostReads"), ["/fixture#2"], "the step reads its message by the chat's scope, not the worktree path");
    await screenshot("loaded");
    // Closed and opened again, it shows from what it already read.
    await evaluate(`${toggle("npm test")}.click()`);
    await evaluate(`${toggle("npm test")}.click()`);
    await waitFor(`${stepText("npm test")}.includes("ok 40 - test 40")`);
    assert.equal((await evaluate("window.hostReads")).length, 1);

    await evaluate(`${toggle("npm run e2e")}.click()`);
    await waitFor(`${stepText("npm run e2e")}.includes("Could not load tool output")`);
    await screenshot("unavailable");
    await evaluate(
      'window.recoverRead = true; [...document.querySelectorAll("[data-slot=step] button")].find(button => button.textContent === "Try again").click()',
    );
    await waitFor(`${stepText("npm run e2e")}.includes("Recovered output")`);
    assert.deepEqual(await evaluate("window.hostReads"), ["/fixture#2", "/fixture#4", "/fixture#4"], "Retry asks the host again after a failed read");
    assert.equal(await evaluate('!![...document.querySelectorAll("button")].find(button => button.textContent === "Try again")'), false);

    assert.equal(await evaluate(`!!${toggle("npm run build")}`), false, "a step still streaming has nothing to read yet");
    console.log("PASS: a step with its output in a sidecar opens from the host (loading, then the output, read once); one that can't be read says so");
    app.exit(0);
  } catch (error) {
    console.error(error);
    await screenshot("failure").catch(() => {});
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
        name: "step-details-fixture",
        resolveId(id) {
          if (id === "/__step_details_fixture.tsx") return id;
        },
        load(id) {
          if (id === "/__step_details_fixture.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url !== "/__step_details__") return next();
            const html = await server.transformIndexHtml(
              request.url,
              '<html><body><div id="root"></div><script type="module" src="/__step_details_fixture.tsx"></script></body></html>',
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
    const child = spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__step_details__`], { env, stdio: "inherit" });
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
