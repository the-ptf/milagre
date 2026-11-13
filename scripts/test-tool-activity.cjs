// Real renderer regression: source marks, bounded output and an approval on the tool row it is about.
const assert = require("node:assert/strict");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatComposer } from "/src/components/ChatComposer";
import { useStepApprovalScope } from "/src/components/agents/step-approval";
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
 const [liveSteps, setLiveSteps] = useState([...calls.map(entry => entry.step), ...runs['/fixture#1'].steps]);
 window.setActivitySteps = setLiveSteps;
 const request = waiting ? { requestId: "push-approval", kind: "command", tool: "Bash", title: "Run \u0060git push\u0060", description: "Push the branch", command: "git push", cwd: "/fixture", allowForChat: true, stepId: "push" } : undefined;
 window.decisions ??= [];
 // As App does: the row that shows the approval claims it, and the card above the composer stays away while it does.
 const scope = useStepApprovalScope(request, 0, null, (decision) => { window.decisions.push(decision); setWaiting(false); });
 return <main style={{ height: "100%", padding: 12 }}>
  <ChatComposer messages={[{ id: 1, session_id: 1, role: "user", body: "Review the tool calls.", context: null }]} messageScope="/fixture" projectPath="/fixture"
   imageDraft={{ images: [], files: [], attachFiles: noop, attachPath: noop, removeFile: noop, loading: false, error: "", onPaste: noop, clear: noop, remove: noop }}
   draft="" onDraftChange={noop} onSend={noop} isSending sendBlocked={false}
   streamingText="I'll review the tool calls and run their checks." streamingSteps={liveSteps}
   waitingStepIds={waiting ? ["push"] : []}
   stepApproval={scope.value}
   approval={waiting && !scope.inline ? <button id="card">Allow once</button> : null}
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
    const allowButtons = '[...document.querySelectorAll("button")].filter((b) => b.textContent.trim() === "Allow once")';
    await wait('!!document.querySelector("[data-slot=activity]")');
    await wait('!document.getElementById("card")');
    assert.equal(await run(`${allowButtons}.length`), 1, "a collapsed group does not hide or duplicate its approval");
    assert.ok(
      await run(`!!${allowButtons}[0].closest("[data-slot=activity] [data-slot=step-approval]")`),
      "the approval sits on the waiting tool row, not on a card above the composer",
    );
    assert.ok(await run('document.querySelector("[data-slot=step-approval]").textContent.includes("Waiting for approval")'), "the row says it is waiting");
    assert.equal(
      await run('[...document.querySelectorAll("[data-slot=step-approval] code")].filter((c) => c.textContent === "git push").length'),
      1,
      "the command shows once, as a code chip, without backticks",
    );
    assert.equal(
      await run('document.querySelector("[data-slot=activity] > [data-slot=step-approval] > button [data-slot=activity-sources]")'),
      null,
      "a waiting line leads with the pending call's glyph alone, not the reply's mix",
    );
    assert.ok(
      await run('document.querySelector("[data-slot=step-approval] [data-waiting-approval]")?.className.includes("text-orange-ink")'),
      "waiting for approval reads in orange-ink, as the top bar's waiting chip",
    );
    await run('document.querySelector("[data-slot=activity] button[aria-expanded]").click()');
    await wait('document.querySelectorAll("[data-slot=step]").length === 4');
    assert.equal(await run(`${allowButtons}.length`), 1, "opening calls never repeats the approval on the inner row");
    await run('document.querySelector("[data-slot=activity] button[aria-expanded]").click()');
    assert.equal(await run(`${allowButtons}.length`), 1, "closing mounted rows keeps one usable approval");
    await run('document.querySelector("[data-slot=activity] button[aria-expanded]").click()');
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
    await run(`${allowButtons}[0].click()`);
    await wait(`${allowButtons}.length === 0 && !document.getElementById("card")`);
    assert.deepEqual(await run("window.decisions"), ["allow"]);
    assert.ok(
      await run(
        '(() => { const nodes = [...document.querySelectorAll("[data-slot=activity-sources] > span")]; return nodes.length > 0 && nodes.length <= 4 && nodes.every((node) => parseFloat(getComputedStyle(node).borderRadius) >= node.getBoundingClientRect().width / 2); })()',
      ),
      "once nothing waits, source marks are at most four fully circular marks",
    );
    assert.ok(await run('!!document.querySelector("[data-slot=activity-sources] [data-linear-logo]")'));
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
    const thought = {
      id: "live-thought",
      kind: "thinking",
      title: "Thinking",
      status: "running",
      startedAt: Date.now(),
      detail: "**Inspecting recorded swipe events**\n\nCompare the fields.",
    };
    await run(`window.setActivitySteps(${JSON.stringify([thought])})`);
    await wait('document.querySelector("[data-slot=step]").textContent.includes("Inspecting recorded swipe events")');
    await run(`window.setActivitySteps(${JSON.stringify([{ ...thought, detail: `${thought.detail}\n\n**Testing both post orders**` }])})`);
    await wait('document.querySelector("[data-slot=step]").textContent.includes("Testing both post orders")');
    const command = {
      id: "live-command",
      kind: "shell",
      title: "Ran `npm test`",
      description: "Check recorded swipe events",
      status: "running",
      startedAt: Date.now(),
      detail: "$ npm test\n",
    };
    await run(`window.setActivitySteps(${JSON.stringify([command, thought])})`);
    await wait('document.querySelector("[data-slot=activity] > button")?.textContent.includes("Running 2 calls")');
    // The activity row names the command; the running mark beside the timer doesn't repeat it.
    assert.equal(
      await run(`[...document.querySelectorAll('[role="status"]')].some((node) => node.textContent.includes("Check recorded swipe events"))`),
      false,
    );
    await run('document.querySelector("[data-slot=activity] > button").click()');
    await wait('document.querySelectorAll("[data-slot=step]").length === 2');
    await run('document.querySelector("[data-slot=step] button[aria-expanded]").click()');
    await wait('document.querySelector("[data-slot=step]").textContent.includes("npm test")');
    if (process.env.MILAGRE_SCREENSHOT_DIR) {
      await delay(400);
      const fs = require("node:fs");
      fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, "tool-activity.png"), (await window.webContents.capturePage()).toPNG());
    }
    console.log("PASS: source stack, Linear logo, exact input, bounded output, visible failure cause, approval on its tool row and retained disclosure");
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
