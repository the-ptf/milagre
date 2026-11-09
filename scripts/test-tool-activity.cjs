// Real renderer regression: source marks, bounded output and approvals in the normal Chat area.
const assert = require("node:assert/strict");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatComposer } from "/src/components/ChatComposer";
import { MODEL_CATALOG, capabilityFor } from "/src/model";
import { applyRunEvent, startRun } from "@milagre/shared/agent-runs";
import "/src/styles.css";
document.documentElement.classList.add("dark");
document.body.style.background = "var(--page)";
window.milagre = { listEditors: async () => [] };
const noop = () => {};
const now = Date.now();
let runs = startRun({}, '/fixture#1', 'gpt-6.1-sol');
for (const event of [
 { type: 'step-started', step: { id: 'public-summary', kind: 'thinking', title: 'Thinking' } },
 { type: 'step-output', id: 'public-summary', text: Array.from({length: 50}, (_, i) => 'Public summary paragraph ' + (i + 1) + '.').join('\\n\\n') },
 { type: 'step-completed', id: 'public-summary', status: 'done', title: 'Thought' }
]) runs = applyRunEvent(runs, '/fixture#1', event);
const calls = [
 { type: "step", step: { id: "linear", kind: "other", title: "Used \\u0060list_issues\\u0060 from linear", source: { server: "linear", name: "list_issues" }, input: JSON.stringify({ query: "Tool call UI" }, null, 2), summary: "2 results", detail: '[{"id":"ENG-12"},{"id":"ENG-13"}]', status: "done", startedAt: now - 8400, endedAt: now - 7200, durationMs: 1200 } },
 { type: "step", step: { id: "failed", kind: "shell", title: "Ran \\u0060npm test\\u0060", input: "npm test", summary: "Failed", error: "Error: missing Authorization header", detail: "$ npm test\\n" + Array.from({ length: 65 }, (_, i) => "line " + i).join("\\n") + "\\nError: missing Authorization header", status: "failed", startedAt: now - 7000, endedAt: now - 2800, durationMs: 4200 } },
 { type: "step", step: { id: "push", kind: "shell", title: "Ran \\u0060git push\\u0060", detail: "$ git push\\n", status: "running", startedAt: now - 1000 } }
];
function Fixture() {
 const [waiting, setWaiting] = useState(true);
 return <main style={{ height: "100%", padding: 12 }}>
  <ChatComposer messages={[{ id: 1, session_id: 1, role: "user", body: "Review the tool calls.", context: null }]} messageScope="/fixture" projectPath="/fixture"
   imageDraft={{ images: [], files: [], attachFiles: noop, attachPath: noop, removeFile: noop, loading: false, error: "", onPaste: noop, clear: noop, remove: noop }}
   draft="" onDraftChange={noop} onSend={noop} isSending sendBlocked={false}
   streamingText="I'll review the tool calls and run their checks." streamingSteps={[...calls.map(entry => entry.step), ...runs['/fixture#1'].steps]}
   waitingStepIds={waiting ? ["push"] : []}
   approval={waiting ? <button id="allow" onClick={() => setWaiting(false)}>Allow once</button> : null}
   models={MODEL_CATALOG} cliStatus={null} onModelPickerOpen={noop} selectedModel={MODEL_CATALOG[0]} onModelChange={noop}
   capability={capabilityFor(MODEL_CATALOG[0], null)} onEffortChange={noop} ultracode={false} onUltracodeChange={noop}
   fastMode={false} onFastModeChange={noop} permissionMode="ask" onPermissionModeChange={noop}
   onRecommendationSelect={noop} worktrees={[]} onWorktreeChange={noop}
   isolation="local" onIsolationChange={noop} branches={[]} baseBranch="main" onBaseBranchChange={noop} newChatError={null} />
 </main>;
}
createRoot(document.getElementById("root")).render(<Fixture />);
`;

async function check() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", require("node:fs").mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-tool-activity-")));
  await app.whenReady();
  const window = new BrowserWindow({ width: 1000, height: 800, show: false, webPreferences: { backgroundThrottling: false } });
  window.webContents.on("console-message", (details) => {
    if (details.level === "error") console.error(details.message);
  });
  const run = (code) => window.webContents.executeJavaScript(code);
  const wait = async (code) => {
    for (let i = 0; i < 160; i++) {
      if (await run(code)) return;
      await delay(25);
    }
    throw new Error(`Timed out: ${code}`);
  };
  try {
    await window.loadURL(process.argv[2]);
    await wait('!!document.querySelector("[data-slot=activity]")');
    assert.equal(await run('document.querySelectorAll("#allow").length'), 1, "a collapsed group does not hide or duplicate its approval");
    assert.equal(
      await run('!!document.getElementById("allow").closest("[data-slot=activity], [data-slot=step]")'),
      false,
      "asks stay in the normal Chat approval area",
    );
    assert.ok(
      await run(
        '(() => { const node = document.querySelector("[data-slot=activity-sources] > span"); return parseFloat(getComputedStyle(node).borderRadius) >= node.getBoundingClientRect().width / 2; })()',
      ),
      "source marks are fully circular",
    );
    assert.ok(await run('!!document.querySelector("[data-slot=activity-sources] [data-linear-logo]")'));
    await run('document.querySelector("[data-slot=activity] > button").click()');
    await wait('document.querySelectorAll("[data-slot=step]").length === 4');
    assert.equal(await run('document.querySelectorAll("#allow").length'), 1);
    assert.equal(
      await run('!!document.getElementById("allow").closest("[data-slot=activity], [data-slot=step]")'),
      false,
      "opening calls never moves an ask into them",
    );
    await run('document.querySelector("[data-slot=activity] > button").click()');
    assert.equal(await run('document.querySelectorAll("#allow").length'), 1, "closing mounted rows keeps one usable approval");
    await run('document.querySelector("[data-slot=activity] > button").click()');
    assert.ok(
      await run('document.querySelector("[data-status=failed]").textContent.includes("Error: missing Authorization header")'),
      "the reason is available before disclosure",
    );
    await run('document.querySelector("[data-slot=step] button[aria-expanded]").click()');
    await wait('document.querySelector("[data-slot=step]").textContent.includes("Tool call UI")');
    assert.ok(await run('document.querySelector("[data-slot=step]").textContent.includes("Input")'));
    assert.ok(await run('document.querySelector("[data-slot=step]").textContent.includes("2 results")'));
    await run('document.querySelector("[data-status=failed] button[aria-expanded]").click()');
    await wait('document.querySelector("[data-status=failed]").textContent.includes("Show 26 earlier lines")');
    assert.equal(await run('document.querySelector("[data-status=failed]").textContent.includes("line 0")'), false);
    await run('[...document.querySelectorAll("[data-status=failed] button")].find(b => b.textContent.includes("earlier lines")).click()');
    await wait('document.querySelector("[data-status=failed]").textContent.includes("line 0")');
    await run('document.getElementById("allow").click()');
    await wait('!document.getElementById("allow")');
    assert.equal(
      await run('document.querySelector("[data-slot=step] button[aria-expanded]").getAttribute("aria-expanded")'),
      "true",
      "resolving approval preserves open output",
    );
    await run('[...document.querySelectorAll("[data-slot=step] button[aria-expanded]")].find(b=>b.textContent.includes("Thought")).click()');
    await wait('document.body.textContent.includes("Public summary paragraph 50.")');
    assert.equal(
      await run(`(() => {
      const step = [...document.querySelectorAll('[data-slot=step]')].find(n=>n.textContent.includes('Public summary paragraph 1.'));
      const scroll = step.querySelector('.scroll-fade');
      if (!scroll) return false;
      scroll.scrollTop = scroll.scrollHeight;
      return scroll.scrollHeight > scroll.clientHeight && scroll.scrollTop > 0 && step.textContent.includes('Public summary paragraph 50.');
    })()`),
      true,
      "long public summaries remain reachable in their bounded scroll area after completion",
    );
    if (process.env.MILAGRE_SCREENSHOT_DIR) {
      await delay(400);
      const fs = require("node:fs");
      fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, "tool-activity.png"), (await window.webContents.capturePage()).toPNG());
    }
    console.log("PASS: source stack, Linear logo, exact input, bounded output, visible failure cause, normal Chat approval and retained disclosure");
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
    cacheDir: "node_modules/.vite-tool-activity",
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "tool-activity-fixture",
        resolveId(id) {
          if (id === "/__tool_activity.tsx") return id;
        },
        load(id) {
          if (id === "/__tool_activity.tsx") return fixture;
        },
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== "/__tool_activity") return next();
            server
              .transformIndexHtml(request.url, '<html><body><div id="root"></div><script type="module" src="/__tool_activity.tsx"></script></body></html>')
              .then((html) => {
                response.setHeader("Content-Type", "text/html");
                return response.end(html);
              })
              .catch((error) => {
                response.statusCode = 500;
                return response.end(String(error));
              });
          });
        },
      },
    ],
  });
  try {
    await server.listen();
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require("electron"), [__filename, `${server.resolvedUrls.local[0]}__tool_activity`], { env, stdio: "inherit" });
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    await server.close();
  }
}
(process.versions.electron ? check() : main()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
