// Run with node scripts/test-subagents.cjs. Uses the app's existing Vite and
// Electron dependencies to check subagent interactions and layout without an extra test runner.
const assert = require("node:assert/strict");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const fixture = `
window.outputReads = [];
window.milagre = Object.freeze({ listEditors: async () => [], readTaskOutput: async (chatId, taskId) => {
  window.outputReads.push({chatId,taskId});
  if(window.outputError) throw new Error("The command output is unavailable.");
  return {output:window.outputText ?? "\\u001b[32mPublish watcher ready\\u001b[0m\\n",totalBytes:9000,truncated:true};
} });
import React, { useState } from "react";
import { chatActivity } from "@milagre/shared/chat-activity";
import { createRoot } from "react-dom/client";
import { ChatComposer } from "/src/components/ChatComposer";
import { DotBackground } from "/src/components/DotBackground";
import { MODEL_CATALOG, capabilityFor } from "/src/model";
import "/src/styles.css";
const noop = () => {};
window.advisorActions = [];
function Fixture() {
  const [count] = useState(2);
  const [children, setChildren] = useState([
    {id:"review",title:"Review authentication",prompt:"Check auth for regressions",status:"running",startedAt:Date.now()-65000,updatedAt:Date.now(),latestActivity:"Reading auth.ts",transcript:[{id:"a",kind:"message",text:"Child-only finding"}]},
    {id:"tests",title:"Run tests",status:"failed",startedAt:Date.now()-40000,updatedAt:Date.now(),endedAt:Date.now(),transcript:[{id:"b",kind:"tool",text:"Tests failed"}]}
  ]);
  const [sending, setSending] = useState(true);
  const archive = (id,archived) => setChildren(items=>items.map(child=>child.id===id ? {...child,archived} : child));
  const archiveFinished = () => setChildren(items=>items.map(child=>["completed","failed","cancelled"].includes(child.status) ? {...child,archived:true} : child));
  window.setChildren = setChildren;
  const controlAdvisor = (action,id) => {window.advisorActions.push({action,id});setChildren(items=>items.map(item=>item.id===id?{...item,status:action==="stop"?"cancelled":"running",retryable:action==="stop"}:item));};
  const [advisorResult,setAdvisorResult]=useState(false);window.setAdvisorResult=setAdvisorResult;
  window.setSending = setSending;
  const [backgroundTasks, setBackgroundTasks] = useState([]);
  const [fixtureChat, setFixtureChat] = useState(false);
  window.setBackgroundTasks = (tasks) => { setFixtureChat(true); setBackgroundTasks(tasks); };
  window.finishChildren = () => {setChildren(items=>items.map(item=>({...item,status:"completed",endedAt:Date.now()})));setSending(false);};
  const [draft, setDraft] = useState("");
  const [model, setModel] = useState(MODEL_CATALOG[0]);
  const [fastMode, setFastMode] = useState(false);
  window.setModel = (id) => setModel(MODEL_CATALOG.find((item) => item.id === id));
  window.useAntigravity = () => setModel(MODEL_CATALOG.find((item) => item.provider === "antigravity"));
  const messages = Array.from({ length: count }, (_, index) => ({
    id: index + 1, session_id: 1, context: null, role: index === 0 ? "user" : "assistant",
    body: index === 0 ? "Review authentication and run the relevant tests." : "I started two subagents. Their progress is available below.",
  }));
  if(advisorResult)messages.push({id:999,session_id:1,role:"user",body:advisorResult.body || "Advisor finding: prefer validated reads.",context:{kind:"advisor-result",advisorId:"advisor:review",completionId:"completion",title:advisorResult.title || "Security",provider:advisorResult.provider || "codex",outcome:advisorResult.outcome || "completed"}});
  return <div className="flex min-h-0 min-w-0 flex-1 gap-3 overflow-hidden text-ink">
    <div className="flex min-h-0 shrink-0 pt-[60px] pb-3 pl-3">
      <aside data-fixture-sidebar style={{ width: 44 }} className="relative flex min-h-0 shrink-0 flex-col overflow-hidden rounded-window bg-surface p-2 shadow-card">
        <div className="border-b border-line px-1 py-3 text-[13px] font-medium">M</div>
      </aside>
    </div>
    <main data-workspace-main className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-transparent pr-3 pb-3">
    <div data-chat-pane className="min-h-0 flex-1 overflow-hidden">
    <ChatComposer messages={messages} chatId={fixtureChat ? 1 : undefined}
      imageDraft={{ images: [], files: [], attachFiles: noop, attachPath: noop, removeFile: noop, loading: false, error: "", onPaste: noop, clear: noop, remove: noop }}
      projectPath="/fixture" draft={draft} onDraftChange={setDraft} onSend={noop} isSending={sending} sendBlocked={false} subagents={children} onArchiveFinishedSubagents={archiveFinished} onArchiveSubagent={archive} onStopAdvisor={id=>controlAdvisor("stop",id)} onRetryAdvisor={id=>controlAdvisor("retry",id)} waitingForSubagents={true}
      backgroundTasks={backgroundTasks} sessionProvider={backgroundTasks.length ? "claude" : undefined} activity={chatActivity({provider:"claude",subagents:children,backgroundTasks},sending ? {} : undefined)} agentChatId={fixtureChat ? "/fixture#1" : undefined}
      models={MODEL_CATALOG} cliStatus={null} onModelPickerOpen={noop} selectedModel={model} onModelChange={noop}
      capability={capabilityFor(model, null)} onEffortChange={noop} ultracode={false} onUltracodeChange={noop}
      fastMode={fastMode} onFastModeChange={setFastMode} permissionMode="auto" onPermissionModeChange={noop}
      onRecommendationSelect={noop} worktrees={[]} onWorktreeChange={noop}
      isolation="local" onIsolationChange={noop} branches={[]} baseBranch="main" onBaseBranchChange={noop} newChatError={null} />
    </div>
    </main>
  </div>;
}
document.documentElement.classList.add("dark");
createRoot(document.getElementById("root")).render(<DotBackground><Fixture /></DotBackground>);
`;

// Two Antigravity children as a live run of agy 1.3.0 reported them (ids, titles, prompts and rows).
const ANTIGRAVITY_CHILDREN = [
  {
    id: "6615864f0d7a4cf5a4c2b0f1e7a9d311",
    title: "Subagent One",
    prompt: "Run 'sleep 4; cat a.txt' using run_command, then read a.txt with view_file, and report.",
    status: "running",
    latestActivity: "Read `a.txt`",
    transcript: [
      { id: "6615864f0d7a4cf5a4c2b0f1e7a9d311:1", kind: "tool", text: "Ran `sleep 4; cat a.txt`\n$ sleep 4; cat a.txt\nFile a: hello from a." },
      { id: "step:3:0", kind: "tool", text: "Read `a.txt`" },
    ],
  },
  {
    id: "45dea2d0b8e34a7c9a0f62d1c4b7e815",
    title: "Subagent Two",
    prompt: "Read b.txt with view_file and run 'wc -c b.txt', and report.",
    status: "completed",
    latestActivity: "Finished",
    transcript: [
      { id: "45dea2d0b8e34a7c9a0f62d1c4b7e815:1", kind: "tool", text: "Ran `wc -c b.txt`\n$ wc -c b.txt\n      22 b.txt" },
      { id: "step:1:0", kind: "tool", text: "Read `b.txt`" },
      { id: "result", kind: "message", text: "Here are the exact outputs:\n\nFile b: hello from b.\n22 b.txt" },
    ],
  },
];

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", require("node:fs").mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-subagent-ui-")));
  await app.whenReady();
  const window = new BrowserWindow({
    width: 800,
    height: 600,
    useContentSize: true,
    show: false,
    title: "Subagent checks",
    webPreferences: { backgroundThrottling: false },
  });
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
  async function screenshot(name) {
    if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
    await delay(300);
    const fs = require("node:fs");
    fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  }
  async function waitFor(source, timeout = 5000) {
    for (let attempt = 0; attempt < timeout / 25; attempt++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw new Error(`Timed out: ${source}`);
  }
  const assertMainGutters = async () => {
    const bounds = await evaluate(
      '(() => {const main=document.querySelector("[data-workspace-main]"),r=main.getBoundingClientRect(),sidebar=document.querySelector("[data-fixture-sidebar]").getBoundingClientRect(),style=getComputedStyle(main);return {gap:r.left-sidebar.right,right:style.paddingRight,bottom:style.paddingBottom}})()',
    );
    assert.deepEqual(bounds, { gap: 12, right: "12px", bottom: "12px" }, "The chat view retains its main gutters");
  };
  try {
    await window.loadURL(process.argv[2]);
    await waitFor('!!document.querySelector("[data-slot=subagent-track]")');
    await assertMainGutters();
    assert.equal(await evaluate('document.querySelector("[data-slot=subagent-track]").textContent.includes("active")'), false);
    assert.equal(await evaluate('document.querySelector("[data-slot=subagent-track]").textContent.includes("failed")'), false);
    await evaluate('document.querySelector("[data-slot=subagent-track] [data-face=pill] button").click()');
    await waitFor('document.querySelector("[data-slot=subagent-popover]")?.dataset.state === "open"');
    assert.equal(await evaluate('document.querySelectorAll("dialog[open], [aria-modal=true]").length'), 0);
    assert.equal(await evaluate('document.querySelectorAll("[data-subagent-row]").length'), 2);
    assert.ok(await evaluate('document.querySelector("[data-slot=subagent-track] [data-face=pill] button").getBoundingClientRect().height <= 24'));
    const rowPosition = await evaluate(
      '(() => {const r=document.querySelector("[data-subagent-row]").getBoundingClientRect();return {x:Math.round(r.right-38),y:Math.round(r.top+r.height/2)}})()',
    );
    window.webContents.sendInputEvent({ type: "mouseMove", ...rowPosition });
    await screenshot("subagents-list");
    window.setContentSize(800, 600);
    await clickLabel("Archive Run tests");
    await waitFor('document.querySelectorAll("[data-subagent-row]").length === 1');
    await evaluate('document.querySelector("[data-subagent-archived-toggle]").click()');
    await waitFor(`!!document.querySelector('[aria-label="Restore Run tests"]')`);
    await clickLabel("Restore Run tests");
    await evaluate('document.querySelector("[data-subagent-archived-toggle]").click()');
    await waitFor('document.querySelectorAll("[data-subagent-row]").length === 2');
    await evaluate('document.querySelector("[data-subagent-open]").click()');
    await waitFor('!!document.querySelector("[data-slot=subagent-transcript]")');
    assert.ok(await evaluate('document.querySelector("[data-slot=subagent-transcript]").textContent.includes("Child-only finding")'));
    for (const [width, height] of [
      [800, 600],
      [390, 500],
    ]) {
      window.setContentSize(width, height);
      await delay(200);
      const bounds = await evaluate(
        '(() => {const r=document.querySelector("[data-slot=subagent-popover]").getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight}})()',
      );
      assert.ok(bounds.left >= 0 && bounds.right <= bounds.width && bounds.top >= 0 && bounds.bottom <= bounds.height, "Subagent popover escapes viewport");
    }
    window.setContentSize(800, 600);
    await delay(200);
    await screenshot("subagent-transcript");
    // A subagent with its own to-do list: the detail is its plan, the current item carrying what it says and runs now.
    await evaluate(`window.setChildren(items => (window.savedChildren = items, items.map(item => item.id === "review" ? {
      ...item,
      latestActivity: "Ran \`npm test -- auth\`",
      tasks: [
        { id: "0", content: "Read the login and refresh code", status: "completed" },
        { id: "1", content: "Run the auth tests", activeForm: "Running the auth tests", status: "in_progress" },
        { id: "2", content: "Write up regressions", status: "pending" },
      ],
      progress: { steps: 3, said: "Now running the auth suite to confirm.", tools: { reads: 6, commands: 2, searches: 1 } },
      transcript: [
        { id: "m1", kind: "message", text: "Child-only finding. The refresh path skips the expiry check." },
        { id: "t1", kind: "tool", tool: "read", text: "Read \`auth.ts\`" },
        { id: "m2", kind: "message", text: "Now running the auth suite to confirm." },
        { id: "t2", kind: "tool", tool: "shell", text: "Ran \`npm test -- auth\`" },
      ],
    } : item)))`);
    await waitFor('!!document.querySelector("[data-subagent-plan]")');
    assert.equal(
      await evaluate('document.querySelector("[data-subagent-plan] [data-status=in_progress]").textContent.includes("Running the auth tests")'),
      true,
    );
    assert.equal(
      await evaluate('document.querySelector("[data-subagent-plan] [data-status=in_progress]").textContent.includes("Now running the auth suite to confirm.")'),
      true,
    );
    assert.equal(await evaluate('document.querySelector("[data-subagent-plan]").textContent.includes("1 of 3 done")'), true);
    await screenshot("subagent-plan");
    await clickLabel("Back to subagents");
    await waitFor('document.querySelectorAll("[data-subagent-row]").length === 2');
    assert.ok(await evaluate('document.querySelector("[data-subagent-row]").textContent.includes("1 of 3 · 6 files read · 2 commands")'));
    assert.ok(await evaluate('document.querySelector("[data-subagent-row]").textContent.includes("Now running the auth suite to confirm.")'));
    await screenshot("subagents-glance-list");
    await evaluate("window.setChildren(window.savedChildren)");
    await clickLabel("Collapse subagents");
    assert.equal(await evaluate('document.activeElement === document.querySelector("[data-slot=subagent-track] [data-face=pill] button")'), true);
    await evaluate('document.querySelector("[data-slot=subagent-track] [data-face=pill] button").click()');
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await waitFor('document.querySelector("[data-slot=subagent-popover]")?.dataset.state !== "open"');
    await evaluate('document.querySelector("[data-slot=subagent-track] [data-face=pill] button").click()');
    await waitFor('document.querySelector("[data-slot=subagent-popover]")?.dataset.state === "open"');
    await evaluate('document.querySelector("textarea[aria-label=Prompt]").dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}))');
    await waitFor('document.querySelector("[data-slot=subagent-popover]")?.dataset.state !== "open"');
    await evaluate('document.querySelector("[data-slot=subagent-track] [data-face=pill] button").click()');
    await waitFor('document.querySelector("[data-slot=subagent-popover]")?.dataset.state === "open"');
    assert.equal(await evaluate(`document.querySelectorAll('[aria-label^="Unlink"]').length`), 0);
    await evaluate('document.querySelector("[data-subagent-archive-finished]").click()');
    await waitFor('document.querySelectorAll("[data-subagent-row]").length===1');
    assert.ok(await evaluate('document.querySelector("[data-subagent-archive-finished]").disabled'));
    assert.ok(await evaluate('document.querySelector("[data-subagent-row]").textContent.includes("Review authentication")'));
    await evaluate("window.finishChildren()");
    await waitFor('!document.querySelector("[data-slot=subagent-track] [data-face=pill] button svg")');
    await waitFor('!document.querySelector("[data-subagent-archive-finished]").disabled');
    await evaluate('document.querySelector("[data-subagent-archive-finished]").click()');
    await waitFor('document.querySelectorAll("[data-subagent-row]").length===0');
    // The open panel stands in for the pill; once it closes the empty slot leaves the row.
    assert.ok(
      await evaluate('(() => {const face=document.querySelector("[data-slot=subagent-track] [data-face=pill]");return !face || face.inert})()'),
      "Archiving the last visible child hides the pill",
    );
    await screenshot("subagents-all-archived");
    await evaluate('document.querySelector("[data-subagent-archived-toggle]").click()');
    await waitFor('document.querySelectorAll("[data-subagent-row]").length===2');
    await clickLabel("Restore Review authentication");
    await waitFor('document.querySelectorAll("[data-subagent-row]").length===1');
    await evaluate("window.setChildren([])");
    await waitFor('!document.querySelector("[data-slot=subagent-track]")');
    await evaluate(
      'window.setSending(false); window.setBackgroundTasks([{id:"publish",kind:"local_bash",title:"Publish watcher",startedAt:Date.now()-5000},{id:"flow",kind:"local_workflow",title:"Deploy workflow",startedAt:Date.now()}])',
    );
    await waitFor('!!document.querySelector("button[data-background-work]")');
    assert.equal(
      await evaluate(
        '(() => {const probe=document.createElement("span");probe.style.color="var(--ink-2)";document.body.append(probe);const same=getComputedStyle(document.querySelector("button[data-background-work]")).color===getComputedStyle(probe).color;probe.remove();return same})()',
      ),
      true,
      "Background text uses the activity summary color",
    );
    await evaluate('document.querySelector("button[data-background-work]").click()');
    await waitFor('document.querySelector("[data-background-tasks]")?.textContent.includes("Publish watcher")');
    assert.deepEqual(await evaluate("window.outputReads"), [], "Opening the list does not poll unselected tasks");
    await evaluate('document.querySelector("[data-background-task=publish]").click()');
    await waitFor('document.querySelector("[data-task-output]")?.textContent.includes("Publish watcher ready")');
    assert.deepEqual(await evaluate("window.outputReads[0]"), { chatId: "/fixture#1", taskId: "publish" });
    assert.equal(await evaluate('document.querySelector("[data-task-output]").textContent.includes("\\u001b")'), false);
    assert.ok(await evaluate('document.querySelector("[data-background-tasks]").textContent.includes("Showing the latest output")'));
    await screenshot("background-command-output");
    await evaluate('document.querySelector("button[data-background-work]").click()');
    await delay(100);
    const reads = await evaluate("window.outputReads.length");
    await delay(1700);
    assert.equal(await evaluate("window.outputReads.length"), reads, "Closing the details stops output polling");
    await evaluate('window.outputError=true; document.querySelector("button[data-background-work]").click()');
    await waitFor('document.querySelector("[data-background-tasks] [role=alert]")?.textContent.includes("unavailable")');
    await evaluate("window.outputError=false");
    await waitFor(
      'document.querySelector("[data-task-output]")?.textContent.includes("Publish watcher ready") && !document.querySelector("[data-background-tasks] [role=alert]")',
    );
    await evaluate(
      'Object.defineProperty(document,"visibilityState",{configurable:true,value:"hidden"}); document.dispatchEvent(new Event("visibilitychange"))',
    );
    await delay(100);
    const hiddenReads = await evaluate("window.outputReads.length");
    await delay(1700);
    assert.equal(await evaluate("window.outputReads.length"), hiddenReads, "Hidden windows stop output polling");
    await evaluate(
      'Object.defineProperty(document,"visibilityState",{configurable:true,value:"visible"}); document.dispatchEvent(new Event("visibilitychange"))',
    );
    await waitFor(`window.outputReads.length > ${hiddenReads}`);
    await evaluate(
      'window.outputText="Publish completed successfully"; window.setBackgroundTasks([{id:"flow",kind:"local_workflow",title:"Deploy workflow",startedAt:Date.now()}])',
    );
    await waitFor('document.querySelector("[data-task-output]")?.textContent === "Publish completed successfully"');
    assert.ok(await evaluate('document.querySelector("[data-background-tasks]").textContent.includes("No longer running")'));
    const completedReads = await evaluate("window.outputReads.length");
    await delay(1700);
    assert.equal(await evaluate("window.outputReads.length"), completedReads, "Completed commands fetch final output once and stop polling");
    await evaluate('[...document.querySelectorAll("[data-background-tasks] button")].find(button=>button.textContent==="Back to tasks").click()');
    const beforeWorkflow = await evaluate("window.outputReads.length");
    await evaluate('document.querySelector("[data-background-task=flow]").click()');
    await waitFor('document.querySelector("[data-background-tasks]")?.textContent.includes("reports its progress back")');
    assert.equal(await evaluate("window.outputReads.length"), beforeWorkflow, "Workflows do not request shell output");
    await evaluate('[...document.querySelectorAll("[data-background-tasks] button")].find(button=>button.textContent==="Back to tasks").click()');
    await evaluate('window.setBackgroundTasks([{id:"last",kind:"local_bash",title:"Final command",startedAt:Date.now()}])');
    await waitFor('!!document.querySelector("[data-background-task=last]")');
    await evaluate('document.querySelector("[data-background-task=last]").click()');
    await waitFor('!!document.querySelector("[data-task-output]")');
    await evaluate('window.outputText="Final command done"; window.setBackgroundTasks([]); window.setSending(true)');
    await waitFor('document.querySelector("[data-task-output]")?.textContent === "Final command done"');
    assert.equal(
      await evaluate('!!document.querySelector("[data-background-work]")'),
      false,
      "The running indicator disappears without closing the last command's output",
    );
    await evaluate(
      '[...document.querySelectorAll("[data-background-tasks] button")].find(button=>button.textContent==="Close").click(); window.setSending(false)',
    );
    await waitFor('!document.querySelector("[data-background-tasks]")');
    await evaluate(
      'window.setChildren([{id:"advisor:review",source:"milagre-advisor",provider:"codex",model:"reported",title:"Security",status:"running",startedAt:Date.now(),updatedAt:Date.now(),transcript:[{id:"answer",kind:"message",text:"Advisor finding: prefer validated reads."}]}]); window.setAdvisorResult(true)',
    );
    await waitFor('!!document.querySelector("[data-slot=subagent-track]")');
    if (await evaluate('document.querySelector("[data-slot=subagent-popover]")?.dataset.state === "open"'))
      await evaluate('document.querySelector("[data-slot=subagent-track] [data-face=pill] button").click()');
    await evaluate('document.querySelector("[data-slot=subagent-track] [data-face=pill] button").click()');
    await waitFor('!!document.querySelector("[data-advisor-stop]")');
    assert.ok(await evaluate('document.querySelector("[data-subagent-row]").textContent.includes("Codex advisor")'));
    await screenshot("advisor-running");
    await clickLabel("Stop Security");
    await waitFor('!!document.querySelector("[data-advisor-retry]")');
    await screenshot("advisor-interrupted");
    await clickLabel("Retry Security");
    assert.deepEqual(await evaluate("window.advisorActions"), [
      { action: "stop", id: "advisor:review" },
      { action: "retry", id: "advisor:review" },
    ]);
    await evaluate('document.querySelector("[data-subagent-open]").click()');
    await waitFor('!!document.querySelector("[data-slot=subagent-transcript]")');
    assert.ok(await evaluate('document.querySelector("[data-slot=subagent-transcript]").textContent.includes("Advisor finding")'));
    await screenshot("advisor-output");
    await clickLabel("Collapse subagents");
    assert.equal(await evaluate('document.querySelector("[data-advisor-result]").getAttribute("aria-label")'), "Codex advisor result: Security");
    assert.equal(await evaluate('document.querySelector("[data-advisor-result]").closest("article").dataset.from'), "app");
    assert.equal(await evaluate('document.querySelector("[data-advisor-result] h3").textContent'), "Security");
    assert.equal(await evaluate('document.querySelector("[data-advisor-result]").textContent.includes("Completed")'), false);
    const shortAdvisorHeight = await evaluate('document.querySelector("[data-advisor-result]").getBoundingClientRect().height');
    await screenshot("advisor-result");
    const longAdvisorBody = Array.from({ length: 24 }, (_, index) => `**Finding ${index + 1}**: Keep validated reads and retained identities intact.`).join(
      "\n\n",
    );
    await evaluate(`window.setAdvisorResult(${JSON.stringify({ body: longAdvisorBody })})`);
    await waitFor('!!document.querySelector("[data-advisor-result] strong")');
    assert.equal(
      await evaluate('document.querySelector("[data-advisor-result]").getBoundingClientRect().height'),
      shortAdvisorHeight,
      "long output keeps the card's height",
    );
    assert.ok(
      await evaluate('(() => { const body = document.querySelector("[data-advisor-result] [role=region]"); return body.scrollHeight > body.clientHeight; })()'),
      "long output scrolls inside the card",
    );
    const advisorHeadingOffset = () =>
      evaluate(
        '(() => { const card = document.querySelector("[data-advisor-result]"); return card.querySelector("h3").getBoundingClientRect().top - card.getBoundingClientRect().top; })()',
      );
    const advisorHeadingTop = await advisorHeadingOffset();
    await evaluate('document.querySelector("[data-advisor-result] [role=region]").focus()');
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Down" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Down" });
    await waitFor('document.querySelector("[data-advisor-result] [role=region]").scrollTop > 0');
    await waitFor('document.querySelector("[data-advisor-result] [role=region]").hasAttribute("data-fade-top")');
    await waitFor('parseFloat(getComputedStyle(document.querySelector("[data-advisor-result] [role=region]")).getPropertyValue("--fade-top")) >= 27');
    assert.equal(await advisorHeadingOffset(), advisorHeadingTop, "scrolling leaves the title in place");
    await evaluate('document.querySelector("[data-advisor-result] [role=region]").scrollTop = 99999');
    await waitFor(
      '(() => { const body = document.querySelector("[data-advisor-result] [role=region]"); return body.scrollTop + body.clientHeight >= body.scrollHeight - 1; })()',
    );
    assert.ok(
      await evaluate('document.querySelector("[data-advisor-result] [role=region]").textContent.includes("Finding 24")'),
      "the full result remains reachable",
    );
    await screenshot("advisor-result-scrolled");
    await clickLabel("Expand advisor result");
    await waitFor('document.querySelector("[data-advisor-result]").dataset.expanded === "true"');
    assert.ok(
      (await evaluate('document.querySelector("[data-advisor-result]").getBoundingClientRect().height')) > shortAdvisorHeight * 2,
      "expanded, the card grows to the whole result",
    );
    assert.ok(
      await evaluate(
        '(() => { const body = document.querySelector("[data-advisor-result] [role=region]"); return body.scrollHeight <= body.clientHeight + 1; })()',
      ),
      "expanded, nothing scrolls inside the card",
    );
    await screenshot("advisor-result-expanded");
    await clickLabel("Collapse advisor result");
    await waitFor('document.querySelector("[data-advisor-result]").dataset.expanded === "false"');
    assert.equal(
      await evaluate('document.querySelector("[data-advisor-result]").getBoundingClientRect().height'),
      shortAdvisorHeight,
      "collapsing restores the height",
    );
    for (const [outcome, label] of [
      ["failed", "Failed"],
      ["cancelled", "Stopped"],
    ]) {
      await evaluate(`window.setAdvisorResult(${JSON.stringify({ outcome, provider: "claude" })})`);
      await waitFor(`document.querySelector("[data-advisor-result]").textContent.includes(${JSON.stringify(label)})`);
      assert.ok(await evaluate('document.querySelector("[data-advisor-result]").textContent.includes("Claude advisor")'));
    }
    await evaluate("window.setAdvisorResult(false)");
    // Antigravity's children (read from its transcripts, see antigravity-subagents.cjs) render like any other provider's.
    await evaluate(
      `window.useAntigravity(); window.setChildren(${JSON.stringify(ANTIGRAVITY_CHILDREN)}.map(child => ({...child, startedAt: Date.now() - 16000, updatedAt: Date.now(), ...(child.status === "completed" ? { endedAt: Date.now() } : {})})))`,
    );
    await waitFor('!!document.querySelector("[data-slot=subagent-track] [data-face=pill] button")');
    await evaluate(
      'document.querySelector("[data-slot=subagent-popover][data-state=open]") || document.querySelector("[data-slot=subagent-track] [data-face=pill] button").click()',
    );
    await waitFor('document.querySelector("[data-slot=subagent-popover]")?.dataset.state === "open"');
    // The list may still show the archived children from the checks above.
    await evaluate(
      'document.querySelector("[data-subagent-archived-toggle]")?.textContent === "Back to subagents" && document.querySelector("[data-subagent-archived-toggle]").click()',
    );
    await waitFor('document.querySelectorAll("[data-subagent-row]").length === 2');
    assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-subagent-title]")].map(title => title.textContent.trim())'), [
      "Subagent One",
      "Subagent Two",
    ]);
    assert.ok(
      await evaluate('[...document.querySelectorAll("[data-subagent-row] path")].some(path => path.getAttribute("d").startsWith("M21.751"))'),
      "A finished Antigravity child shows the Antigravity mark",
    );
    await screenshot("antigravity-subagents");
    await evaluate('document.querySelector("[data-subagent-open]").click()');
    await waitFor('!!document.querySelector("[data-slot=subagent-transcript]")');
    // Tool calls are counted in the detail; the calls themselves are in its full log.
    await evaluate('document.querySelector("[data-subagent-log-toggle]").click()');
    for (const text of ["Ran `sleep 4; cat a.txt`", "Read `a.txt`", "File a: hello from a."])
      assert.ok(await evaluate(`document.querySelector("[data-slot=subagent-transcript]").textContent.includes(${JSON.stringify(text)})`), text);
    await screenshot("antigravity-subagent-transcript");
    await clickLabel("Collapse subagents");
    await evaluate("window.setChildren([])");
    await waitFor('!document.querySelector("[data-slot=subagent-track]")');
    // A host that sends only the end of each transcript (subagent-tails-v1): the panel reads the whole one once, then
    // follows the tails of later updates without reading it again.
    await evaluate(`(() => {
      const entry = (n) => ({ id: "e" + n, kind: "message", text: "Long entry " + n });
      const child = (count) => ({ id: "long", title: "Long child", status: "running", startedAt: Date.now() - 5000, updatedAt: Date.now(),
        transcript: Array.from({ length: count }, (_, index) => entry(index + 1)) });
      const tail = (count) => { const whole = child(count); return { ...whole, transcript: whole.transcript.slice(-4), transcriptLength: count }; };
      window.subagentReads = [];
      window.milagre = { ...window.milagre, readSubagent: async (scope, chatId, agentId) => { window.subagentReads.push([scope, chatId, agentId]); return child(30); } };
      window.tailOf = tail;
      window.setChildren([tail(30)]);
    })()`);
    await waitFor('!!document.querySelector("[data-slot=subagent-track] [data-face=pill] button")');
    await evaluate(
      'document.querySelector("[data-slot=subagent-popover][data-state=open]") || document.querySelector("[data-slot=subagent-track] [data-face=pill] button").click()',
    );
    await waitFor('!!document.querySelector("[data-subagent-open]")');
    await evaluate('document.querySelector("[data-subagent-open]").click()');
    await waitFor('!!document.querySelector("[data-subagent-log-toggle]")');
    await evaluate('document.querySelector("[data-subagent-log-toggle]").click()');
    await waitFor('document.querySelectorAll("[data-subagent-log-entry]").length === 30');
    assert.deepEqual(await evaluate("window.subagentReads"), [["/fixture", 1, "long"]]);
    await evaluate("window.setChildren([window.tailOf(31)])");
    await waitFor('document.querySelectorAll("[data-subagent-log-entry]").length === 31');
    const shown = await evaluate('[...document.querySelectorAll("[data-subagent-log-entry]")].map(row => row.textContent)');
    assert.equal(shown[0], "Long entry 1");
    assert.equal(shown.at(-1), "Long entry 31");
    assert.equal(await evaluate("window.subagentReads.length"), 1, "A tail that follows on doesn't read the transcript again");
    await screenshot("subagent-transcript-tails");
    await clickLabel("Collapse subagents");
    await evaluate("window.setChildren([])");
    await waitFor('!document.querySelector("[data-slot=subagent-track]")');
    // A host that sends archived subagents as summaries (archived-subagent-summaries-v1): opening one from the Archived
    // list reads its prompt, latest activity and transcript, and a newer summary reads them again.
    await evaluate(`(() => {
      const started = Date.now() - 90000;
      const whole = (updatedAt, activity) => ({ id: "old", title: "Archived review", status: "completed", archived: true, startedAt: started, updatedAt, endedAt: updatedAt,
        prompt: "Check the token refresh path", latestActivity: activity,
        transcript: [{ id: "t1", kind: "tool", text: "Ran \`npm test -- auth\`" }, { id: "t2", kind: "message", text: "Token refresh is covered." }] });
      const summary = (updatedAt) => { const { prompt, latestActivity, transcript, ...rest } = whole(updatedAt, ""); return { ...rest, transcript: [], detailsOnDemand: true }; };
      window.summaryReads = [];
      window.releaseSummaryRead = null;
      window.summaryActivity = "Finished the review";
      window.milagre = { ...window.milagre, readSubagent: (scope, chatId, agentId) => new Promise((resolve) => {
        window.summaryReads.push([scope, chatId, agentId]);
        const activity = window.summaryActivity;
        window.releaseSummaryRead = () => resolve(whole(Date.now(), activity));
      }) };
      window.summaryOf = summary;
      window.summaryAt = started + 60000;
      window.setChildren([{ id: "live", title: "Live child", status: "running", startedAt: Date.now() - 5000, updatedAt: Date.now(), transcript: [] }, summary(window.summaryAt)]);
    })()`);
    await waitFor('!!document.querySelector("[data-slot=subagent-track] [data-face=pill] button")');
    await evaluate(
      'document.querySelector("[data-slot=subagent-popover][data-state=open]") || document.querySelector("[data-slot=subagent-track] [data-face=pill] button").click()',
    );
    await waitFor('!!document.querySelector("[data-subagent-archived-toggle]")');
    await evaluate('document.querySelector("[data-subagent-archived-toggle]").click()');
    await waitFor('[...document.querySelectorAll("[data-subagent-title]")].map(title => title.textContent.trim()).join() === "Archived review"');
    await evaluate('document.querySelector("[data-subagent-open]").click()');
    await waitFor('!!document.querySelector("[data-subagent-loading]")');
    assert.equal(await evaluate('document.querySelector("[data-slot=subagent-transcript]").textContent.includes("No child output")'), false);
    assert.deepEqual(await evaluate("window.summaryReads"), [["/fixture", 1, "old"]]);
    await screenshot("archived-subagent-loading");
    await evaluate("window.releaseSummaryRead()");
    await waitFor('!document.querySelector("[data-subagent-loading]")');
    await evaluate('document.querySelector("[data-subagent-log-toggle]").click()');
    for (const text of ["Check the token refresh path", "Finished the review", "Ran `npm test -- auth`", "Token refresh is covered."])
      assert.ok(await evaluate(`document.querySelector("[data-slot=subagent-transcript]").textContent.includes(${JSON.stringify(text)})`), text);
    await screenshot("archived-subagent-loaded");
    // A newer summary (the archived child ran again) keeps what was read on screen while it reads again.
    await evaluate(
      `window.summaryActivity = "Reviewed again"; window.setChildren(items => items.map(item => item.id === "old" ? window.summaryOf(window.summaryAt + 1000) : item))`,
    );
    await waitFor("window.summaryReads.length === 2");
    assert.ok(await evaluate('document.querySelector("[data-slot=subagent-transcript]").textContent.includes("Finished the review")'));
    assert.equal(await evaluate('!!document.querySelector("[data-subagent-loading]")'), false);
    await evaluate("window.releaseSummaryRead()");
    await waitFor('document.querySelector("[data-slot=subagent-transcript]").textContent.includes("Reviewed again")');
    // A read that fails (the computer is offline) says so and isn't retried on its own; opening the subagent again reads
    // again.
    await evaluate(`window.summaryReads = []; window.milagre = { ...window.milagre, readSubagent: (scope, chatId, agentId) => {
      window.summaryReads.push([scope, chatId, agentId]);
      return window.summaryReads.length === 1 ? Promise.reject(new Error("offline")) : Promise.resolve({ ...window.summaryOf(1), id: "offline", prompt: "After reconnecting", transcript: [] });
    } }; window.setChildren(items => [...items, { ...window.summaryOf(window.summaryAt), id: "offline", title: "Offline review" }])`);
    await evaluate("document.querySelector(\"[data-slot=subagent-popover] [aria-label='Back to subagents']\").click()");
    await waitFor('[...document.querySelectorAll("[data-subagent-open]")].some(button => button.textContent.includes("Offline review"))');
    await evaluate('[...document.querySelectorAll("[data-subagent-open]")].find(button => button.textContent.includes("Offline review")).click()');
    await waitFor('!!document.querySelector("[data-subagent-failed]")');
    await delay(300);
    assert.equal(await evaluate("window.summaryReads.length"), 1, "a failed read isn't retried while the panel stays open");
    await screenshot("archived-subagent-failed");
    await evaluate("document.querySelector(\"[data-slot=subagent-popover] [aria-label='Back to subagents']\").click()");
    await waitFor('!!document.querySelector("[data-subagent-open]")');
    await evaluate('[...document.querySelectorAll("[data-subagent-open]")].find(button => button.textContent.includes("Offline review")).click()');
    await waitFor('document.querySelector("[data-slot=subagent-transcript]").textContent.includes("After reconnecting")');
    assert.equal(await evaluate("window.summaryReads.length"), 2, "opening it again reads again");
    await clickLabel("Collapse subagents");
    await evaluate("window.setChildren([])");
    await waitFor('!document.querySelector("[data-slot=subagent-track]")');
    console.log(
      "PASS: subagent list/archive/transcript checks, subagent plan and glance, advisor rows and result cards, Antigravity children, whole transcripts from a host that sends tails, and archived subagents read on demand",
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
        name: "subagents-fixture",
        enforce: "pre",
        resolveId(id) {
          if (id === "/__subagents_fixture.tsx") return id;
        },
        load(id) {
          if (id === "/__subagents_fixture.tsx") return fixture;
        },
        configureServer(server) {
          server.middlewares.use(async (request, response, next) => {
            if (request.url !== "/__subagents__") return next();
            const html = await server.transformIndexHtml(
              request.url,
              '<html><body><div id="root"></div><script type="module" src="/__subagents_fixture.tsx"></script></body></html>',
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
    const child = spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__subagents__`], { env, stdio: "inherit" });
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
