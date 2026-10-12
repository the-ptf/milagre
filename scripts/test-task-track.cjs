// Run with node scripts/test-task-track.cjs. Uses the app's existing Vite and
// Electron dependencies to check subagent interactions and layout without an extra test runner.
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
function Fixture() {
  const [count, setCount] = useState(2);
  const [children, setChildren] = useState([
    {id:"review",title:"Review authentication",prompt:"Check auth for regressions",status:"running",startedAt:Date.now()-65000,updatedAt:Date.now(),latestActivity:"Reading auth.ts",transcript:[{id:"a",kind:"message",text:"Child-only finding"}]},
    {id:"tests",title:"Run tests",status:"failed",startedAt:Date.now()-40000,updatedAt:Date.now(),endedAt:Date.now(),transcript:[{id:"b",kind:"tool",text:"Tests failed"}]}
  ]);
  const [sending, setSending] = useState(true);
  const [tasks, setTasks] = useState([
    {id:"0",content:"Read the composer",status:"completed"},
    {id:"1",content:"Add the task pill",activeForm:"Adding the task pill",status:"in_progress"},
    {id:"2",content:"Write tests",status:"pending"},
    {id:"3",content:"Run the build",status:"pending"},
    {id:"4",content:"Take screenshots",status:"pending"},
    {id:"5",content:"Fix the A very long task name that has to wrap onto a second line because the popover is narrow",status:"completed"},
    {id:"6",content:"Commit",status:"pending"}
  ]);
  window.setTasks = setTasks;
  window.setDark = (dark) => document.documentElement.classList.toggle("dark", dark);
  const archive = (id,archived) => setChildren(items=>items.map(child=>child.id===id ? {...child,archived} : child));
  const archiveFinished = () => setChildren(items=>items.map(child=>["completed","failed","cancelled"].includes(child.status) ? {...child,archived:true} : child));
  window.setChildren = setChildren;
  window.finishChildren = () => {setChildren(items=>items.map(item=>({...item,status:"completed",endedAt:Date.now()})));setSending(false);};
  const [draft, setDraft] = useState("");
  const [usage, setUsage] = useState({ used: 366000, size: 1000000 });
  const [extra, setExtra] = useState([]);
  window.setContext = setUsage;
  window.setExtraMessages = setExtra;
  window.compacted = [];
  const [model, setModel] = useState(MODEL_CATALOG[0]);
  const [fastMode, setFastMode] = useState(false);
  window.setMessageCount = setCount;
  window.setDraft = setDraft;
  window.setModel = (id) => setModel(MODEL_CATALOG.find((item) => item.id === id));
  const messages = Array.from({ length: count }, (_, index) => ({
    id: index + 1, session_id: 1, context: null, role: index === 0 ? "user" : "assistant",
    body: index === 0 ? "Review authentication and run the relevant tests." : "I started two subagents. Their progress is available below.",
  }));
  return <div style={{ height: "100%", padding: 12 }}>
    <ChatComposer messages={[...messages, ...extra]} onCompact={() => window.compacted.push(Date.now())}
      imageDraft={{ images: [], files: [], attachFiles: noop, attachPath: noop, removeFile: noop, loading: false, error: "", onPaste: noop, clear: noop, remove: noop }}
      projectPath="/fixture" draft={draft} onDraftChange={setDraft} onSend={noop} isSending={sending} sendBlocked={false} tasks={tasks} contextUsage={usage} streamingText="" streamingSteps={[{ id: "c-1", kind: "other", title: "Compacting context", status: "running", offset: 0 }]} subagents={children} onArchiveFinishedSubagents={archiveFinished} onArchiveSubagent={archive} waitingForSubagents={true}
      models={MODEL_CATALOG} cliStatus={null} onModelPickerOpen={noop} selectedModel={model} onModelChange={noop}
      capability={capabilityFor(model, null)} onEffortChange={noop} ultracode={false} onUltracodeChange={noop}
      fastMode={fastMode} onFastModeChange={setFastMode} permissionMode="auto" onPermissionModeChange={noop}
      onRecommendationSelect={noop} worktrees={[]} onWorktreeChange={noop}
      isolation="local" onIsolationChange={noop} branches={[]} baseBranch="main" onBaseBranchChange={noop} newChatError={null} />
  </div>;
}
document.documentElement.classList.add("dark");
createRoot(document.getElementById("root")).render(<Fixture />);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", require("node:fs").mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-task-track-ui-")));
  await app.whenReady();
  const window = new BrowserWindow({ width: 800, height: 600, useContentSize: true, show: false, webPreferences: { backgroundThrottling: false } });
  window.webContents.on("console-message", (details) => {
    if (details.level === "error") console.error(details.message);
  });
  const evaluate = async (source) => {
    try {
      return await window.webContents.executeJavaScript(source);
    } catch (error) {
      throw new Error(`${source}: ${error.message}`);
    }
  };
  const clickLabel = (label) =>
    evaluate(`[...document.querySelectorAll("button")].find(button => button.getAttribute("aria-label") === ${JSON.stringify(label)}).click()`);
  const screenshotDir = process.env.MILAGRE_SCREENSHOT_DIR;
  async function screenshot(name) {
    if (!screenshotDir) return;
    await delay(300);
    const fs = require("node:fs");
    fs.mkdirSync(screenshotDir, { recursive: true });
    fs.writeFileSync(path.join(screenshotDir, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  }
  async function waitFor(source) {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw new Error(`Timed out: ${source}`);
  }
  const pill = "[data-slot=task-track] > span > button";
  try {
    await window.loadURL(process.argv[2]);
    await waitFor('!!document.querySelector("[data-slot=task-track]")');
    assert.equal(await evaluate(`document.querySelector("${pill}").textContent`), "2/7");
    // The context ring sits beside Send, on the same row.
    const ring = "button[aria-label^=Context]";
    assert.equal(await evaluate(`document.querySelector("${ring}").getAttribute("aria-label")`), "Context: 37% used (366k of 1M tokens)");
    assert.ok(
      await evaluate(
        `(() => {const r=document.querySelector("${ring}").getBoundingClientRect(), s=document.querySelector("button[aria-label=Send]").getBoundingClientRect();return r.right<=s.left && Math.abs(r.top-s.top)<1})()`,
      ),
    );
    // A click opens the context card above the ring, right-aligned with it; Escape closes it.
    for (const theme of ["dark", "light"]) {
      await evaluate(`window.setDark(${theme === "dark"})`);
      await evaluate(`document.querySelector("${ring}").click()`);
      await waitFor('!!document.querySelector("[data-context-card]")');
      assert.equal(await evaluate(`document.querySelector("${ring}").getAttribute("aria-expanded")`), "true");
      // A Claude chat's card offers Compact now, held while the turn runs.
      assert.equal(await evaluate('document.querySelector("[data-context-card]").textContent'), "Context37% used366k of 1M tokensCompact now");
      assert.equal(await evaluate('document.querySelector("[data-compact-now]").getAttribute("aria-disabled")'), "true");
      await evaluate('document.querySelector("[data-compact-now]").click()');
      assert.equal(await evaluate("window.compacted.length"), 0);
      await waitFor(
        `(() => {const b=document.querySelector("[data-compact-now]"), p=b.parentElement.parentElement; return Math.abs(b.getBoundingClientRect().width - (p.clientWidth - 32)) < 1})()`,
      );
      assert.ok(
        await evaluate(
          `(() => {const c=document.querySelector("[data-context-card]").getBoundingClientRect(), r=document.querySelector("${ring}").getBoundingClientRect();return c.bottom<=r.top && Math.abs(c.right-r.right)<1})()`,
        ),
      );
      await delay(220);
      await screenshot(`context-card-${theme}`);
      await evaluate('window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
      await waitFor('!document.querySelector("[data-context-card]")');
    }
    // The ring turns to the accent at 75% and red at 90%; the card keeps its concise footer.
    const stroke = () => evaluate(`document.querySelector("${ring} circle:last-child").getAttribute("stroke")`);
    assert.equal(await stroke(), "var(--ink-2)");
    assert.equal(await evaluate('document.querySelector("[data-context-attention]")'), null);
    await evaluate("window.setContext({ used: 800000, size: 1000000 })");
    await waitFor(`document.querySelector("${ring}").getAttribute("aria-label") === "Context: 80% used (800k of 1M tokens)"`);
    assert.equal(await stroke(), "var(--accent-ink)");
    assert.equal(await evaluate('document.querySelector("[data-context-attention]").getAttribute("data-tone")'), "warning");
    await evaluate(`document.querySelector("${ring}").click()`);
    await waitFor('!!document.querySelector("[data-context-card]")');
    assert.match(
      await evaluate('document.querySelector("[data-context-card]").textContent'),
      /Context above 75% may reduce response quality and slow replies\.Compact now$/,
    );
    await delay(220);
    await screenshot("context-card-warning");
    await evaluate('document.querySelector("[data-compact-now]").parentElement.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }))');
    await waitFor('document.querySelector("[role=tooltip]")?.textContent === "Wait for the agent to finish."');
    await screenshot("context-card-blocked-tooltip");
    await evaluate('document.querySelector("[data-compact-now]").parentElement.dispatchEvent(new PointerEvent("pointerout", { bubbles: true }))');
    await waitFor('!document.querySelector("[role=tooltip]")');
    await evaluate('window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
    await waitFor('!document.querySelector("[data-context-card]")');
    await evaluate("window.setContext({ used: 897000, size: 1000000 })");
    await waitFor(`document.querySelector("${ring}").getAttribute("aria-label") === "Context: 90% used (897k of 1M tokens)"`);
    assert.equal(await stroke(), "var(--red)");
    assert.equal(await evaluate('document.querySelector("[data-context-attention]").getAttribute("data-tone")'), "critical");
    // Once the turn ends, Compact now sends: the card closes and the chat shows the compaction as a divider.
    await evaluate("window.finishChildren()");
    await evaluate(`document.querySelector("${ring}").click()`);
    await waitFor('!!document.querySelector("[data-context-card]")');
    await waitFor('document.querySelector("[data-compact-now]") && document.querySelector("[data-compact-now]").getAttribute("aria-disabled") === "false"');
    assert.match(
      await evaluate('document.querySelector("[data-context-card]").textContent'),
      /Context above 75% may reduce response quality and slow replies\.Compact now$/,
    );
    await delay(220);
    await screenshot("context-card-critical");
    await evaluate('document.querySelector("[data-compact-now]").click()');
    await waitFor('!document.querySelector("[data-context-card]")');
    assert.equal(await evaluate("window.compacted.length"), 1);
    const compaction = (status, after) =>
      `({ id: 90, session_id: 1, role: "user", body: "/compact", context: { kind: "compaction", status: "${status}", before: 897000, size: 1000000${after ? `, after: ${after}` : ""} } })`;
    await evaluate(`window.setExtraMessages([${compaction("preparing")}])`);
    await waitFor('!!document.querySelector("[data-compaction-divider]")');
    assert.equal(await evaluate('document.querySelector("[data-compaction-divider]").getAttribute("aria-label")'), "Compacting context: 897k");
    assert.equal(await evaluate('document.querySelectorAll("[data-compaction-divider] svg").length'), 1);
    await evaluate(`window.setExtraMessages([${compaction("done", 42000)}])`);
    await waitFor('document.querySelector("[data-compaction-divider]")?.dataset.status === "done"');
    assert.equal(await evaluate('document.querySelector("[data-compaction-divider]").getAttribute("aria-label")'), "Context compacted: 897k → 42k");
    assert.equal(await evaluate('document.querySelector("[data-compaction-divider]").textContent'), "Context compacted897k → 42k");
    await evaluate("window.setContext({ used: 42000, size: 1000000 })");
    await waitFor(`document.querySelector("${ring}").getAttribute("aria-label") === "Context: 4% used (42k of 1M tokens)"`);
    assert.equal(await evaluate('document.querySelector("[data-context-attention]")'), null);
    for (const theme of ["dark", "light"]) {
      await evaluate(`window.setDark(${theme === "dark"})`);
      await screenshot(`compaction-divider-${theme}`);
    }
    await evaluate(`window.setExtraMessages([${compaction("failed")}])`);
    await waitFor('document.querySelector("[data-compaction-divider]")?.dataset.status === "failed"');
    assert.equal(await evaluate('document.querySelector("[data-compaction-divider]").textContent'), "Compaction failed897k");
    // Automatic compactions are assistant messages, rendered with the same divider.
    await evaluate(`window.setExtraMessages([{ ...${compaction("preparing")}, role: "assistant", body: "" }])`);
    await waitFor('document.querySelector("[data-compaction-divider]")?.dataset.status === "preparing"');
    await screenshot("automatic-compaction-pending");
    await evaluate(`window.setExtraMessages([{ ...${compaction("done", 42000)}, role: "assistant", body: "" }])`);
    await waitFor('document.querySelector("[data-compaction-divider]")?.dataset.status === "done"');
    assert.equal(await evaluate('document.querySelectorAll("[data-compaction-divider]").length'), 1);
    await screenshot("automatic-compaction-done");
    await evaluate("window.setExtraMessages([])");
    await evaluate("window.setContext({ used: 366000, size: 1000000 })");
    assert.ok(await evaluate(`document.querySelector("${pill}").getBoundingClientRect().height <= 24`));
    // The pill sits right next to Subagents, on the same row.
    const gap = await evaluate(
      `(() => {const a=document.querySelector("${pill}").getBoundingClientRect(), b=document.querySelector("[data-slot=subagent-track] > button").getBoundingClientRect();return {gap:b.left-a.right,dy:Math.abs(a.top-b.top)}})()`,
    );
    assert.ok(gap.gap >= 0 && gap.gap <= 12 && gap.dy < 1, `Pill is not beside Subagents: ${JSON.stringify(gap)}`);
    for (const theme of ["dark", "light"]) {
      await evaluate(`window.setDark(${theme === "dark"})`);
      await screenshot(`task-pill-closed-${theme}`);
      await evaluate(`document.querySelector("${pill}").click()`);
      await waitFor('!!document.querySelector("[data-slot=task-popover]")');
      assert.equal(await evaluate(`document.querySelector("${pill}").getAttribute("aria-expanded")`), "true");
      assert.equal(await evaluate('document.querySelectorAll("dialog[open], [aria-modal=true]").length'), 0);
      assert.equal(await evaluate('document.querySelectorAll("[data-task-row]").length'), 7);
      assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-task-row]")].slice(0,3).map(row => row.dataset.status + ":" + row.textContent)'), [
        "completed:Completed: Read the composer",
        "in_progress:In progress: Adding the task pill",
        "pending:Pending: Write tests",
      ]);
      assert.equal(await evaluate('document.querySelectorAll("[data-task-row][data-status=in_progress] svg").length'), 1);
      const bounds = await evaluate(
        '(() => {const r=document.querySelector("[data-slot=task-popover]").getBoundingClientRect(), t=document.querySelector("[data-slot=task-track] button").getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,w:innerWidth,h:innerHeight,gap:t.top-r.bottom}})()',
      );
      assert.ok(
        bounds.left >= 0 && bounds.right <= bounds.w && bounds.top >= 0 && bounds.gap >= 0 && bounds.gap < 16,
        `Popover is misplaced: ${JSON.stringify(bounds)}`,
      );
      await screenshot(`task-popover-${theme}`);
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
      await waitFor('!document.querySelector("[data-slot=task-popover]")');
      assert.equal(await evaluate(`document.activeElement === document.querySelector("${pill}")`), true);
    }
    await evaluate(`document.querySelector("${pill}").click()`);
    await waitFor('!!document.querySelector("[data-slot=task-popover]")');
    await evaluate('document.querySelector("textarea[aria-label=Prompt]").dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}))');
    await waitFor('!document.querySelector("[data-slot=task-popover]")');
    window.setContentSize(390, 500);
    await delay(200);
    await evaluate(`document.querySelector("${pill}").click()`);
    await waitFor('!!document.querySelector("[data-slot=task-popover]")');
    assert.ok(
      await evaluate(
        '(() => {const r=document.querySelector("[data-slot=task-popover]").getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.top>=0})()',
      ),
      "Popover escapes the narrow viewport",
    );
    await screenshot("task-popover-narrow");
    window.setContentSize(800, 600);
    await evaluate('window.setTasks(items => items.map(task => ({...task, status: "completed"})))');
    await waitFor(`document.querySelector("${pill}").textContent === "7/7"`);
    await evaluate("window.setTasks([])");
    await waitFor('!document.querySelector("[data-slot=task-track]") && !document.querySelector("[data-slot=task-popover]")');
    assert.ok(await evaluate('!!document.querySelector("[data-slot=subagent-track] > button")'));
    console.log(
      "PASS: pill label, placement beside Subagents, rows and statuses, light and dark, Escape and outside click, focus return, narrow layout, hidden when empty, context card tones and Compact now, compaction divider",
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
        name: "task-track-fixture",
        resolveId(id) {
          if (id === "/__task_track_fixture.tsx") return id;
        },
        load(id) {
          if (id === "/__task_track_fixture.tsx") return fixture;
        },
        configureServer(server) {
          server.middlewares.use(async (request, response, next) => {
            if (request.url !== "/__task_track__") return next();
            const html = await server.transformIndexHtml(
              request.url,
              '<html><body><div id="root"></div><script type="module" src="/__task_track_fixture.tsx"></script></body></html>',
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
    const child = spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__task_track__`], { env, stdio: "inherit" });
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
