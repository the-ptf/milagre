// Run with node scripts/test-reply-thought.cjs. Checks that a reply which only thought shows its
// last thinking under the fold (once done, or while it waits on a question), that so does one which
// wrote text before that thinking, and that a reply which wrote text after it doesn't. Set MILAGRE_SCREENSHOT_DIR to keep screenshots.
const assert = require("node:assert/strict");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatComposer } from "/src/components/ChatComposer";
import { MODEL_CATALOG, capabilityFor } from "/src/model";
import "/src/styles.css";
window.milagre = Object.freeze({});
const noop = () => {};
const thought = (id, detail, durationMs) => ({ id, kind: "thinking", title: "Thought for " + Math.round(durationMs / 1000) + "s", status: "done", detail, durationMs, offset: 0 });
const ran = (id, command) => ({ id, kind: "shell", title: "Ran \\u0060" + command + "\\u0060", status: "done", detail: "$ " + command + "\\n", offset: 0 });
const silentSteps = [thought("t1", "Checking whether the Subagents button covers the to-do list.", 4000), ran("r1", "grep -rn todo app/src"), thought("t2", "So the answer is no: the Subagents button only shows child agents, not the agent's own to-do list. #44 is still open.", 6000)];
const preamble = "Checking the sidebar first.";
function Fixture() {
  const [state, setState] = useState("asking");
  window.setFixture = setState;
  const done = state === "done";
  const messages = [
    { id: 1, session_id: 1, context: null, role: "user", body: "Is the agent to-do list already covered?" },
    { id: 2, session_id: 1, context: null, role: "assistant", body: "Yes, it already shows in the sidebar.", steps: [thought("w1", "The sidebar has it.", 2000), ran("w2", "grep -rn Sidebar app/src")].map((step) => ({ ...step, offset: 0 })) },
    { id: 3, session_id: 1, context: null, role: "user", body: "for that 44, dont we have it already with the agents?" },
    ...(done ? [{ id: 4, session_id: 1, context: null, role: "assistant", body: "", steps: silentSteps }] : []),
  ];
  return <div style={{ height: "100%", padding: 12 }}>
    <ChatComposer messages={messages}
      imageDraft={{ images: [], files: [], attachFiles: noop, attachPath: noop, removeFile: noop, loading: false, error: "", onPaste: noop, clear: noop, remove: noop }}
      projectPath="/fixture" draft="" onDraftChange={noop} onSend={noop} isSending={!done} sendBlocked={false}
      streamingText={state === "preamble" ? preamble : ""}
      streamingSteps={done ? undefined : state === "preamble" ? silentSteps.map((step) => ({ ...step, offset: preamble.length })) : silentSteps}
      asking={state === "asking" || state === "preamble"}
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
  app.setPath("userData", require("node:fs").mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-reply-thought-")));
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
  const thoughts = '[...document.querySelectorAll("[data-slot=message-thought]")].map((node) => node.textContent)';
  try {
    await window.loadURL(process.argv[2]);
    await waitFor('!!document.querySelector("[data-slot=message-thought]")');
    assert.deepEqual(await evaluate(thoughts), [
      "So the answer is no: the Subagents button only shows child agents, not the agent's own to-do list. #44 is still open.",
    ]);
    await screenshot("asking");
    await evaluate('window.setFixture("working")');
    await waitFor('!document.querySelector("[data-slot=message-thought]")');
    await screenshot("working");
    await evaluate('window.setFixture("done")');
    await waitFor('!!document.querySelector("[data-slot=message-thought]")');
    assert.equal((await evaluate(thoughts)).length, 1, "the reply that wrote text shows no thought");
    await screenshot("done");
    await evaluate('window.setFixture("preamble")');
    await waitFor('document.body.textContent.includes("Checking the sidebar first.")');
    assert.deepEqual(await evaluate(thoughts), [
      "So the answer is no: the Subagents button only shows child agents, not the agent's own to-do list. #44 is still open.",
    ]);
    await screenshot("preamble");
    console.log(
      "PASS: a reply's last thinking shows when nothing was written after it (asking or done), not while working; a reply with text after its thinking shows none",
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
        name: "reply-thought-fixture",
        resolveId(id) {
          if (id === "/__reply_thought_fixture.tsx") return id;
        },
        load(id) {
          if (id === "/__reply_thought_fixture.tsx") return fixture;
        },
        configureServer(server) {
          server.middlewares.use(async (request, response, next) => {
            if (request.url !== "/__reply_thought__") return next();
            const html = await server.transformIndexHtml(
              request.url,
              '<html><body><div id="root"></div><script type="module" src="/__reply_thought_fixture.tsx"></script></body></html>',
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
    const child = spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__reply_thought__`], { env, stdio: "inherit" });
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
