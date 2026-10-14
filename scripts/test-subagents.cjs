// Run with node scripts/test-subagents.cjs. Uses the app's existing Vite and
// Electron dependencies to check subagent interactions and layout without an extra test runner.
const assert = require("node:assert/strict");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const fixture = `
window.milagre = Object.freeze({ listEditors: async () => [] });
import React, { Profiler, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatComposer } from "/src/components/ChatComposer";
import { DotBackground } from "/src/components/DotBackground";
import { MODEL_CATALOG, capabilityFor } from "/src/model";
import "/src/styles.css";
const noop = () => {};
window.subagentProfilerCommits = [];
window.advisorActions = [];
window.recordSubagentCommit = (id, phase, actualDuration) => window.subagentProfilerCommits.push({ id, phase, actualDuration });
function Fixture() {
  const [count, setCount] = useState(2);
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
  window.finishChildren = () => {setChildren(items=>items.map(item=>({...item,status:"completed",endedAt:Date.now()})));setSending(false);};
  const [draft, setDraft] = useState("");
  const [model, setModel] = useState(MODEL_CATALOG[0]);
  const [fastMode, setFastMode] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(44);
  const [paneHidden, setPaneHidden] = useState(false);
  window.setSidebarWidth = setSidebarWidth;
  window.setPaneHidden = setPaneHidden;
  window.setMessageCount = setCount;
  window.setDraft = setDraft;
  window.setModel = (id) => setModel(MODEL_CATALOG.find((item) => item.id === id));
  window.useAntigravity = () => setModel(MODEL_CATALOG.find((item) => item.provider === "antigravity"));
  const messages = Array.from({ length: count }, (_, index) => ({
    id: index + 1, session_id: 1, context: null, role: index === 0 ? "user" : "assistant",
    body: index === 0 ? "Review authentication and run the relevant tests." : "I started two subagents. Their progress is available below.",
  }));
  if(advisorResult)messages.push({id:999,session_id:1,role:"user",body:"Advisor finding: prefer validated reads.",context:{kind:"advisor-result",advisorId:"advisor:review",completionId:"completion",title:"Security",provider:"codex",outcome:"completed"}});
  return <div className="flex min-h-0 min-w-0 flex-1 gap-3 overflow-hidden text-ink">
    <div className="flex min-h-0 shrink-0 pt-[60px] pb-3 pl-3">
      <aside data-fixture-sidebar style={{ width: sidebarWidth }} className="relative flex min-h-0 shrink-0 flex-col overflow-hidden rounded-window bg-surface p-2 shadow-card">
        <div className="border-b border-line px-1 py-3 text-[13px] font-medium">{sidebarWidth > 44 ? "Milagre" : "M"}</div>
        {sidebarWidth > 44 && <><p className="px-2 pt-4 pb-2 text-[11px] text-ink-3">Chats</p><p className="rounded-md bg-hover px-2 py-2 text-[12px]">Review authentication</p></>}
      </aside>
    </div>
    <main data-workspace-main className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-transparent pr-3 pb-3">
    <div data-chat-pane className={"min-h-0 flex-1 overflow-hidden" + (paneHidden ? " hidden" : "")}>
    <Profiler id="composer" onRender={window.recordSubagentCommit}><ChatComposer messages={messages}
      imageDraft={{ images: [], files: [], attachFiles: noop, attachPath: noop, removeFile: noop, loading: false, error: "", onPaste: noop, clear: noop, remove: noop }}
      projectPath="/fixture" draft={draft} onDraftChange={setDraft} onSend={noop} isSending={sending} sendBlocked={false} subagents={children} onArchiveFinishedSubagents={archiveFinished} onArchiveSubagent={archive} onStopAdvisor={id=>controlAdvisor("stop",id)} onRetryAdvisor={id=>controlAdvisor("retry",id)} waitingForSubagents={true}
      models={MODEL_CATALOG} cliStatus={null} onModelPickerOpen={noop} selectedModel={model} onModelChange={noop}
      capability={capabilityFor(model, null)} onEffortChange={noop} ultracode={false} onUltracodeChange={noop}
      fastMode={fastMode} onFastModeChange={setFastMode} permissionMode="auto" onPermissionModeChange={noop}
      onRecommendationSelect={noop} worktrees={[]} onWorktreeChange={noop}
      isolation="local" onIsolationChange={noop} branches={[]} baseBranch="main" onBaseBranchChange={noop} newChatError={null} /></Profiler>
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
    communications: [
      { id: "task:6615864f0d7a4cf5a4c2b0f1e7a9d311", fromId: null, toId: "6615864f0d7a4cf5a4c2b0f1e7a9d311", text: "Run 'sleep 4; cat a.txt'", at: 1 },
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
  // Optional PR recordings use the actual Electron renderer and stay outside the repo.
  async function recordGif(name, action) {
    if (!process.env.MILAGRE_RECORD_GIFS || !process.env.MILAGRE_SCREENSHOT_DIR) return;
    const fs = require("node:fs");
    const directory = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-gif-"));
    let recording = true;
    const capture = (async () => {
      let frame = 0;
      // oxlint-disable-next-line no-unmodified-loop-condition -- the finally block below sets recording to false while this loop awaits
      while (recording) {
        const started = Date.now();
        fs.writeFileSync(path.join(directory, `${String(frame++).padStart(5, "0")}.png`), (await window.webContents.capturePage()).toPNG());
        await delay(Math.max(0, 100 - (Date.now() - started)));
      }
    })();
    try {
      await action();
    } finally {
      recording = false;
      await capture;
    }
    const output = path.join(process.env.MILAGRE_SCREENSHOT_DIR, `${name}.gif`);
    const result = require("node:child_process").spawnSync(
      "ffmpeg",
      [
        "-y",
        "-loglevel",
        "error",
        "-framerate",
        "10",
        "-i",
        path.join(directory, "%05d.png"),
        "-filter_complex",
        "[0:v]split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3",
        "-loop",
        "0",
        output,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    fs.rmSync(directory, { recursive: true });
    console.log(`Recorded ${output}`);
  }
  async function waitFor(source, timeout = 5000) {
    for (let attempt = 0; attempt < timeout / 25; attempt++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw new Error(`Timed out: ${source}`);
  }
  const assertCanvasEdges = async () => {
    const bounds = await evaluate(
      '(() => {const canvas=document.querySelector("[data-slot=subagent-canvas]").getBoundingClientRect(),surface=document.querySelector("[data-canvas-surface]").getBoundingClientRect(),sidebar=document.querySelector("[data-fixture-sidebar]").getBoundingClientRect();return {sidebarRight:sidebar.right,left:canvas.left,right:canvas.right,top:canvas.top,bottom:canvas.bottom,surfaceLeft:surface.left,surfaceRight:surface.right,surfaceTop:surface.top,surfaceBottom:surface.bottom,width:innerWidth,height:innerHeight}})()',
    );
    assert.equal(bounds.left, bounds.sidebarRight, "Canvas meets the sidebar edge without a gutter");
    assert.equal(bounds.right, bounds.width, "Canvas meets the window right edge");
    assert.equal(bounds.top, 0, "Canvas meets the window top edge");
    assert.equal(bounds.bottom, bounds.height, "Canvas meets the window bottom edge");
    assert.deepEqual(
      [bounds.surfaceLeft, bounds.surfaceRight, bounds.surfaceTop, bounds.surfaceBottom],
      [bounds.left, bounds.right, bounds.top, bounds.bottom],
      "Canvas fade follows the same outer edges",
    );
  };
  const assertMainGutters = async () => {
    const bounds = await evaluate(
      '(() => {const main=document.querySelector("[data-workspace-main]"),r=main.getBoundingClientRect(),sidebar=document.querySelector("[data-fixture-sidebar]").getBoundingClientRect(),style=getComputedStyle(main);return {gap:r.left-sidebar.right,right:style.paddingRight,bottom:style.paddingBottom}})()',
    );
    assert.deepEqual(bounds, { gap: 12, right: "12px", bottom: "12px" }, "Normal and hidden chat views retain their main gutters");
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
    const entryBounds = await evaluate(`(() => {
      const eye = document.querySelector('[aria-label="Open subagent canvas"]').getBoundingClientRect();
      const archive = document.querySelector('[data-subagent-archive-finished]').getBoundingClientRect();
      return { eye: { x: eye.x, y: eye.y, width: eye.width, height: eye.height }, archive: { right: archive.right, y: archive.y, height: archive.height } };
    })()`);
    assert.ok(
      entryBounds.eye.x >= entryBounds.archive.right &&
        Math.abs(entryBounds.eye.y + entryBounds.eye.height / 2 - entryBounds.archive.y - entryBounds.archive.height / 2) < 2,
      "Canvas entry sits beside Archive",
    );
    await clickLabel("Open subagent canvas");
    await waitFor('!!document.querySelector("[data-slot=subagent-canvas]")');
    await assertCanvasEdges();
    assert.equal(await evaluate('document.querySelector("[data-slot=subagent-canvas]").tagName'), "SECTION");
    assert.equal(
      await evaluate('getComputedStyle(document.querySelector("[data-slot=subagent-canvas]")).backgroundColor'),
      "rgba(0, 0, 0, 0)",
      "Canvas background is transparent",
    );
    assert.equal(
      await evaluate('getComputedStyle(document.querySelector("[data-canvas-surface]")).backgroundColor'),
      "rgba(0, 0, 0, 0)",
      "Canvas surface is transparent",
    );
    assert.equal(
      await evaluate('getComputedStyle(document.querySelector("[data-canvas-surface]")).backgroundImage'),
      "none",
      "Canvas uses the app background without adding another grid",
    );
    assert.equal(
      await evaluate('document.querySelectorAll("dialog[open], [aria-modal=true], [data-slot=subagent-popover][data-state=open]").length'),
      0,
      "Canvas replaces the conversation without opening a modal",
    );
    assert.equal(
      await evaluate('document.querySelector("textarea[aria-label=Prompt]").getClientRects().length'),
      0,
      "Composer is hidden while watching agents",
    );
    assert.equal(await evaluate('document.querySelector("[data-slot=message]").getClientRects().length'), 0, "Conversation is hidden while watching agents");
    assert.equal(await evaluate('document.querySelector("[data-diff-back]").textContent.trim()'), "Back");
    assert.equal(await evaluate('document.activeElement === document.querySelector("[data-diff-back]")'), true);
    assert.equal(
      await evaluate('document.querySelectorAll(".subagent-canvas-header, .subagent-canvas-footer, .subagent-canvas-controls, [data-canvas-zoom]").length'),
      0,
    );
    assert.deepEqual(await evaluate('[...document.querySelectorAll(".subagent-bot-name")].map(node => node.textContent)'), ["God", "Moses", "Noah"]);
    assert.ok(
      await evaluate(
        'document.querySelector("[data-canvas-agent=review]").title.includes("Review authentication") && document.querySelector("[data-canvas-agent=review]").title.includes("Reading auth.ts")',
      ),
    );
    assert.equal(await evaluate('document.querySelectorAll(".subagent-thinking-bubble").length'), 0, "Activity clouds are removed");
    assert.equal(
      await evaluate('document.querySelector("[data-canvas-agent=review]").parentElement.querySelector(".subagent-bot-status").textContent.trim()'),
      "Reading files",
    );
    assert.equal(await evaluate('document.querySelectorAll("[data-status=failed] .subagent-outcome").length'), 1, "Failed bots show an alert");

    // Profile the canvas itself: hidden conversation work must not count as a scene commit.
    await delay(250);
    await evaluate("window.subagentProfilerCommits = []");
    await delay(1250);
    const idleCommits = await evaluate('window.subagentProfilerCommits.filter(commit => commit.id === "canvas")');
    await evaluate("window.subagentProfilerCommits = []");
    for (let update = 0; update < 4; update++) {
      const before = await evaluate('window.subagentProfilerCommits.filter(commit => commit.id === "composer").length');
      await evaluate(`window.setDraft(${JSON.stringify(`Unrelated draft ${update}`)}); window.setMessageCount(count => count + 1)`);
      await waitFor(`window.subagentProfilerCommits.filter(commit => commit.id === "composer").length > ${before}`);
    }
    const parentCommits = await evaluate("window.subagentProfilerCommits");
    console.log(
      "Canvas profiler:",
      JSON.stringify({
        idleMilliseconds: 1250,
        idleCommits: idleCommits.length,
        parentCommits: parentCommits.filter((commit) => commit.id === "composer").length,
        sceneCommitsDuringParentUpdates: parentCommits.filter((commit) => commit.id === "canvas").length,
      }),
    );
    assert.equal(idleCommits.length, 0, "An idle canvas without recent messages does not commit on a timer");
    assert.equal(parentCommits.filter((commit) => commit.id === "canvas").length, 0, "Unrelated draft and conversation updates do not commit the canvas");
    await evaluate('window.setDraft(""); window.setMessageCount(2)');
    await evaluate(
      'window.setChildren(items => items.map(item => item.id === "review" ? {...item, communications:[{id:"near-expiry",fromId:"review",toId:"tests",text:"Temporary exchange",at:Date.now()-11400}]} : item))',
    );
    await waitFor('!!document.querySelector("[data-communication-from=review][data-communication-to=tests]")');
    await waitFor('!document.querySelector("[data-communication-from=review][data-communication-to=tests]")', 2200);
    assert.equal(
      await evaluate('document.querySelector("[data-canvas-agent=review] .subagent-bot").dataset.talking'),
      "false",
      "A message expiry clears the expression without a parent update",
    );
    await delay(100);
    await evaluate("window.subagentProfilerCommits = []");
    await delay(1250);
    assert.equal(
      await evaluate('window.subagentProfilerCommits.filter(commit => commit.id === "canvas").length'),
      0,
      "After its final message expires, the canvas stops committing",
    );
    await evaluate("window.setChildren(items => items.map(item => ({...item, communications:[]})))");

    const key = async (keyCode) => {
      window.webContents.sendInputEvent({ type: "keyDown", keyCode });
      if (keyCode === "Enter") window.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode });
      await delay(50);
    };
    const focusSurface = () => evaluate('document.querySelector("[data-canvas-surface]").focus()');
    const fit = async () => {
      await focusSurface();
      await key("0");
    };
    const world = () =>
      evaluate(
        '(() => { const m = new DOMMatrix(getComputedStyle(document.querySelector("[data-canvas-world]")).transform); return { x: m.e, y: m.f, scale: m.a }; })()',
      );
    const positions = () =>
      evaluate(
        'Object.fromEntries([...document.querySelectorAll("[data-canvas-agent]")].map(bot => [bot.dataset.canvasAgent, { x: parseFloat(bot.parentElement.style.left), y: parseFloat(bot.parentElement.style.top) }]))',
      );
    const botCenter = (id) =>
      evaluate(
        `(() => {const r=document.querySelector('[data-canvas-agent="${id}"]').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`,
      );
    const drag = async (start, dx, dy) => {
      window.webContents.sendInputEvent({ type: "mouseMove", ...start });
      window.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...start });
      window.webContents.sendInputEvent({ type: "mouseMove", x: start.x + dx, y: start.y + dy });
      window.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, x: start.x + dx, y: start.y + dy });
      await delay(100);
    };
    const beforeDrag = await botCenter("review");
    await drag(beforeDrag, 65, 35);
    const afterDrag = await botCenter("review");
    assert.ok(Math.abs(afterDrag.x - beforeDrag.x - 65) < 3 && Math.abs(afterDrag.y - beforeDrag.y - 35) < 3, "Dragging moves the bot with the pointer");
    assert.equal(await evaluate('!!document.querySelector("[data-slot=subagent-canvas] aside")'), false, "Dragging a bot does not open its transcript");
    await evaluate('document.querySelector("[data-canvas-agent=review]").focus()');
    const beforeArrow = await positions();
    await key("Right");
    assert.equal((await positions()).review.x, beforeArrow.review.x + 12, "Arrow keys move the focused bot in world coordinates");
    await key("Enter");
    await waitFor('!!document.querySelector("[data-slot=subagent-canvas] aside")');
    await waitFor('document.activeElement?.getAttribute("aria-label") === "Close transcript"');
    assert.ok(
      await evaluate('document.querySelector("[data-slot=subagent-canvas] aside").textContent.includes("Child-only finding")'),
      "First Enter after dragging opens the transcript",
    );
    await clickLabel("Close transcript");
    await waitFor('!document.querySelector("[data-slot=subagent-canvas] aside")');

    const beforePan = await world();
    const background = await evaluate(
      '(() => {const r=document.querySelector("[data-canvas-surface]").getBoundingClientRect();return {x:Math.round(r.left+15),y:Math.round(r.top+80)}})()',
    );
    assert.equal(
      await evaluate(`document.elementFromPoint(${background.x}, ${background.y}).hasAttribute('data-canvas-surface')`),
      true,
      "Pan starts on empty canvas below the Back bar",
    );
    await drag(background, 45, 25);
    const afterPan = await world();
    assert.ok(
      Math.abs(afterPan.x - beforePan.x - 45) < 1 && Math.abs(afterPan.y - beforePan.y - 25) < 1,
      `Dragging the background pans the canvas: ${JSON.stringify({ beforePan, afterPan, background })}`,
    );
    await evaluate('document.querySelector("[data-canvas-agent=review]").focus()');
    await key("Enter");
    await waitFor('!!document.querySelector("[data-slot=subagent-canvas] aside")');
    await screenshot("subagent-canvas-transcript");
    await key("Escape");
    assert.equal(await evaluate('!!document.querySelector("[data-slot=subagent-canvas] aside")'), false, "Escape first closes the inline transcript");
    await waitFor('document.activeElement === document.querySelector("[data-canvas-agent=review]")');
    assert.equal(await evaluate('!!document.querySelector("[data-slot=subagent-canvas]")'), true);

    await focusSurface();
    const beforeZoom = await world();
    await key("=");
    assert.ok((await world()).scale > beforeZoom.scale, "The plus shortcut zooms the canvas");
    await key("-");
    assert.ok(Math.abs((await world()).scale - beforeZoom.scale) < 0.00001, "The minus shortcut reverses zoom");
    const beforeWheel = await world();
    assert.equal(
      await evaluate(
        'document.querySelector("[data-canvas-surface]").dispatchEvent(new WheelEvent("wheel", {bubbles:true,cancelable:true,deltaX:22,deltaY:36}))',
      ),
      false,
      "Canvas consumes wheel gestures",
    );
    await delay(50);
    const afterWheel = await world();
    assert.ok(Math.abs(afterWheel.x - beforeWheel.x + 22) < 1 && Math.abs(afterWheel.y - beforeWheel.y + 36) < 1, "Trackpad scrolling pans");
    await evaluate(
      'document.querySelector("[data-canvas-surface]").dispatchEvent(new WheelEvent("wheel", {bubbles:true,cancelable:true,ctrlKey:true,deltaY:-20,clientX:300,clientY:200}))',
    );
    await delay(50);
    assert.ok((await world()).scale > afterWheel.scale, "Trackpad pinch zooms");

    const draggableCenter = async (id) => {
      const center = await botCenter(id);
      const hit = await evaluate(
        `(() => {const node=document.elementFromPoint(${center.x},${center.y});return {id:node?.closest('[data-canvas-agent]')?.dataset.canvasAgent,className:node?.className}})()`,
      );
      assert.equal(hit.id, id, `Bot ${id} remains draggable after collisions: ${JSON.stringify(hit)}`);
      return center;
    };
    const moveBotTo = async (id, target) => {
      const current = (await positions())[id];
      const scale = (await world()).scale;
      const center = await draggableCenter(id);
      await drag(center, Math.round((target.x - current.x) * scale), Math.round((target.y - current.y) * scale));
    };
    const assertBodiesSeparate = async () => {
      const bodies = await evaluate(
        '[...document.querySelectorAll("[data-canvas-agent]")].map(button => {const r=button.querySelector(".subagent-bot").getBoundingClientRect();return {id:button.dataset.canvasAgent,x:r.left+r.width/2,y:r.top+r.height/2,radius:Math.max(r.width,r.height)/2}})',
      );
      for (let a = 0; a < bodies.length; a++)
        for (let b = a + 1; b < bodies.length; b++) {
          const first = bodies[a],
            second = bodies[b];
          assert.ok(
            Math.hypot(first.x - second.x, first.y - second.y) + 1 >= first.radius + second.radius,
            `Collision keeps ${first.id} and ${second.id} bodies apart`,
          );
        }
    };
    const collisionView = await world();
    await moveBotTo("tests", { x: 100, y: 180 });
    await moveBotTo("review", { x: -140, y: 180 });
    const beforeChildCollision = await positions();
    await moveBotTo("review", { x: 80, y: 180 });
    const afterChildCollision = await positions();
    assert.ok(afterChildCollision.tests.x > beforeChildCollision.tests.x + 30, "Dragging one child into another pushes the second child");
    assert.ok(
      Math.abs(afterChildCollision.review.x - 80) < 1 && Math.abs(afterChildCollision.review.y - 180) < 1,
      "The dragged child remains under the pointer at non-default zoom",
    );
    await assertBodiesSeparate();
    await draggableCenter("review");
    assert.equal(await evaluate('!!document.querySelector("[data-slot=subagent-canvas] aside")'), false, "Collision drags do not open a transcript");
    assert.deepEqual(await world(), collisionView, "Child collisions preserve canvas pan and zoom");

    await focusSurface();
    await key("R");
    await key("=");
    const chainView = await world();
    await moveBotTo("tests", { x: 120, y: 0 });
    await moveBotTo("review", { x: -120, y: 0 });
    const beforeChain = await positions();
    await moveBotTo("review", { x: -20, y: 0 });
    const afterChain = await positions();
    assert.ok(afterChain.main.x > beforeChain.main.x + 30, `A dragged child pushes the larger main bot: ${JSON.stringify({ beforeChain, afterChain })}`);
    assert.ok(afterChain.tests.x > beforeChain.tests.x + 20, `The main bot passes the push to the next child: ${JSON.stringify({ beforeChain, afterChain })}`);
    await assertBodiesSeparate();
    await evaluate('document.querySelector("[data-canvas-agent=review]").focus()');
    await key("Right");
    const afterKeyboardCollision = await positions();
    assert.ok(Math.abs(afterKeyboardCollision.review.x - afterChain.review.x - 12) < 0.001, "Keyboard movement keeps its normal step during collisions");
    assert.ok(
      afterKeyboardCollision.main.x > afterChain.main.x && afterKeyboardCollision.tests.x > afterChain.tests.x,
      "Keyboard movement also pushes the chain",
    );
    await assertBodiesSeparate();
    assert.deepEqual(await world(), chainView, "Chain collisions preserve canvas pan and zoom");
    await screenshot("subagent-canvas-collision");

    const arranged = await positions();
    const arrangedView = await world();
    await evaluate('window.setChildren(items=>items.map(item=>item.id==="review" ? {...item,latestActivity:"Running auth tests"} : item))');
    await waitFor('document.querySelector("[data-canvas-agent=review]").title.includes("Running auth tests")');
    assert.equal(
      await evaluate('document.querySelector("[data-canvas-agent=review]").parentElement.querySelector(".subagent-bot-status").textContent.trim()'),
      "Running tests",
    );
    assert.deepEqual(await positions(), arranged, "Live activity updates preserve bot positions");
    assert.deepEqual(await world(), arrangedView, "Live activity updates preserve the viewport");
    await evaluate('document.querySelector("[data-diff-back]").click()');
    await waitFor('!document.querySelector("[data-slot=subagent-canvas]")');
    await waitFor('document.activeElement === document.querySelector("[data-slot=subagent-track] [data-face=pill] button")');
    await assertMainGutters();
    assert.ok(await evaluate('document.querySelector("textarea[aria-label=Prompt]").getClientRects().length > 0'), "Back restores the composer");
    await evaluate('document.querySelector("[data-slot=subagent-track] [data-face=pill] button").click()');
    await waitFor('document.querySelector("[data-slot=subagent-popover]")?.dataset.state === "open"');
    await clickLabel("Open subagent canvas");
    await waitFor('!!document.querySelector("[data-slot=subagent-canvas]")');
    assert.deepEqual(await positions(), arranged, "Closing and reopening preserves the arrangement");
    assert.deepEqual(await world(), arrangedView, "Closing and reopening preserves pan and zoom");

    await focusSurface();
    await key("R");
    assert.notDeepEqual((await positions()).review, arranged.review, "R restores the initial bot positions");
    for (let index = 0; index < 3; index++) {
      const beforeArrival = await positions();
      await evaluate(
        `window.setChildren(items => [...items, {id:"arrival-${index}",title:"Extra task ${index}",status:"${index === 0 ? "completed" : index === 1 ? "cancelled" : "waiting"}",startedAt:Date.now(),updatedAt:Date.now(),transcript:[]}])`,
      );
      await waitFor(`!!document.querySelector('[data-canvas-agent="arrival-${index}"]')`);
      const afterArrival = await positions();
      for (const [id, point] of Object.entries(beforeArrival)) assert.deepEqual(afterArrival[id], point, "A new bot never moves an existing bot");
    }
    await fit();
    const nodeBounds = await evaluate(
      '[...document.querySelectorAll(".subagent-canvas-node")].map(node => {const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}})',
    );
    for (let a = 0; a < nodeBounds.length; a++)
      for (let b = a + 1; b < nodeBounds.length; b++) {
        const first = nodeBounds[a],
          second = nodeBounds[b];
        assert.ok(
          first.right <= second.left || second.right <= first.left || first.bottom <= second.top || second.bottom <= first.top,
          `Sequential bots ${a} and ${b} do not overlap`,
        );
      }
    assert.equal(
      await evaluate('document.querySelectorAll("[data-canvas-agent]:not([data-canvas-agent=main]) .subagent-bot[data-dead=true]").length'),
      3,
      "Completed, cancelled, and failed children have dead expressions",
    );
    assert.equal(
      await evaluate(
        'document.querySelectorAll("[data-status=completed] .subagent-sleep, [data-status=cancelled] .subagent-sleep, [data-status=failed] .subagent-sleep").length',
      ),
      0,
      "Finished children have no Zzz",
    );
    assert.ok(
      await evaluate(
        '[...document.querySelectorAll(".subagent-bot[data-dead=true] .subagent-bot-face i")].every(eye => {const a=getComputedStyle(eye,"::before"),b=getComputedStyle(eye,"::after");return a.content!=="none" && b.content!=="none" && parseFloat(a.width)>0 && parseFloat(b.width)>0 && a.transform!=="none" && b.transform!=="none" && a.transform!==b.transform})',
      ),
      "Each dead eye has two crossing strokes",
    );
    assert.equal(
      await evaluate('document.querySelectorAll("[data-status=completed] .subagent-outcome, [data-status=cancelled] .subagent-outcome").length'),
      0,
      "Completed and cancelled children have no avatar badge",
    );
    assert.equal(
      await evaluate('document.querySelectorAll("[data-status=completed] .subagent-bot-name .subagent-name-check").length'),
      1,
      "Completed bots show a check beside their name",
    );
    assert.equal(
      await evaluate('document.querySelectorAll("[data-status=completed] .subagent-bot-status").length'),
      0,
      "Completed bots do not show a Done row",
    );
    const namesBeforeArchive = await evaluate(
      'Object.fromEntries([...document.querySelectorAll("[data-canvas-agent]")].map(bot => [bot.dataset.canvasAgent, bot.parentElement.querySelector(".subagent-bot-name").textContent]))',
    );
    await evaluate('window.setChildren(items=>items.map(item=>item.id==="review" ? {...item,archived:true} : item))');
    await waitFor('!document.querySelector("[data-canvas-agent=review]")');
    assert.equal(
      await evaluate('document.querySelector("[data-canvas-agent=tests]").parentElement.querySelector(".subagent-bot-name").textContent'),
      namesBeforeArchive.tests,
      "Archiving a bot does not rename later bots",
    );
    await evaluate("window.setChildren(items=>items.map(item=>({...item,archived:false})))");
    await waitFor('!!document.querySelector("[data-canvas-agent=review]")');
    await evaluate(
      'window.setChildren(items=>items.map(item=>item.id==="tests" ? {...item,communications:[{id:"peer",fromId:"review",toId:"tests",text:"Can you check the token expiry test?",at:Date.now()}]} : item))',
    );
    await waitFor('!!document.querySelector("[data-communication-from=review][data-communication-to=tests]")');
    assert.ok(await evaluate('document.querySelector("[data-canvas-agent=review]").title.includes("Can you check the token expiry test?")'));

    window.setContentSize(1100, 800);
    await evaluate("window.setSidebarWidth(224)");
    await delay(100);
    await assertCanvasEdges();
    const beforeSidebarResize = await positions();
    for (const width of [320, 44, 224]) {
      await evaluate(`window.setSidebarWidth(${width})`);
      await waitFor(`document.querySelector('[data-fixture-sidebar]').getBoundingClientRect().width === ${width}`);
      await delay(50);
      await assertCanvasEdges();
      assert.deepEqual(await positions(), beforeSidebarResize, "Sidebar resize and collapse preserve bot positions");
    }
    await evaluate("window.setPaneHidden(true)");
    await waitFor('document.querySelector("[data-chat-pane]").classList.contains("hidden")');
    await assertMainGutters();
    await evaluate("window.setPaneHidden(false)");
    await waitFor('!document.querySelector("[data-chat-pane]").classList.contains("hidden")');
    await assertCanvasEdges();
    await fit();
    const edgeStyles = await evaluate(
      '(() => {const surface=document.querySelector("[data-canvas-surface]"),fade=getComputedStyle(surface),blur=getComputedStyle(surface,"::after");return {size:fade.getPropertyValue("--subagent-edge-size").trim(),fade:fade.maskImage,composite:fade.maskComposite,blur:blur.backdropFilter,blurMask:blur.maskImage,pointerEvents:blur.pointerEvents}})()',
    );
    assert.equal(edgeStyles.size, "16px", "The edge fade stays narrow");
    assert.equal((edgeStyles.fade.match(/linear-gradient/g) ?? []).length, 2, "Canvas fades horizontally and vertically");
    assert.ok(edgeStyles.composite.includes("intersect"), "The four fades combine at the corners");
    assert.equal((edgeStyles.blurMask.match(/linear-gradient/g) ?? []).length, 4, "The blur covers all four canvas edges");
    assert.ok(edgeStyles.blur.includes("blur("));
    assert.equal(edgeStyles.pointerEvents, "none", "Edge blur does not intercept pointer input");
    const beforeEdges = await positions();
    const edgeView = await world();
    const edgeSize = await evaluate(
      '(() => {const surface=document.querySelector("[data-canvas-surface]");return {width:surface.clientWidth,height:surface.clientHeight}})()',
    );
    for (const [id, target] of [
      ["review", { x: (18 - edgeView.x) / edgeView.scale, y: 0 }],
      ["tests", { x: (edgeSize.width - 18 - edgeView.x) / edgeView.scale, y: 0 }],
      ["arrival-0", { x: 0, y: (18 - edgeView.y) / edgeView.scale }],
      ["arrival-1", { x: 0, y: (edgeSize.height - 18 - edgeView.y) / edgeView.scale }],
    ]) {
      await moveBotTo(id, target);
      await draggableCenter(id);
    }
    assert.ok(
      await evaluate(
        '(() => {const surface=document.querySelector("[data-canvas-surface]").getBoundingClientRect(),body=id=>document.querySelector(`[data-canvas-agent="${id}"] .subagent-bot`).getBoundingClientRect();return body("review").left<surface.left && body("tests").right>surface.right && body("arrival-0").top<surface.top && body("arrival-1").bottom>surface.bottom})()',
      ),
      "Four bots straddle the canvas edges",
    );
    await screenshot("subagent-canvas-edges");
    await evaluate('document.documentElement.classList.remove("dark")');
    await screenshot("subagent-canvas-edges-light");
    await evaluate('document.documentElement.classList.add("dark")');
    await moveBotTo("review", beforeEdges.review);
    assert.ok(Math.abs((await positions()).review.x - beforeEdges.review.x) < 1, "A bot can be dragged back through the blurred edge");
    await focusSurface();
    await key("R");
    const godAngry = () => evaluate('document.querySelector("[data-canvas-agent=main] .subagent-bot").dataset.angry === "true"');
    const godGaze = () =>
      evaluate(
        '(() => {const style=getComputedStyle(document.querySelector("[data-canvas-agent=main] .subagent-bot"));return {x:parseFloat(style.getPropertyValue("--gaze-x")),y:parseFloat(style.getPropertyValue("--gaze-y"))}})()',
      );
    const lookingAt = () => evaluate('document.querySelector("[data-canvas-agent=main] .subagent-bot").dataset.lookingAt');
    const exchange = (id, fromId, toId, at = Date.now() - 50) => ({ id, fromId, toId, text: id, at });
    const setExchanges = (messages) =>
      evaluate(`window.setChildren(items=>items.map(item=>({...item,communications:item.id==="review" ? ${JSON.stringify(messages)} : []})))`);
    let outgoing = [exchange("Earlier left message", null, "review", Date.now() - 2000), exchange("Latest right message", null, "tests", Date.now() - 1000)];
    await setExchanges(outgoing);
    await waitFor('document.querySelector("[data-canvas-agent=main] .subagent-bot").dataset.lookingAt === "tests"');
    assert.ok((await godGaze()).x > 0, "God looks right toward the latest outgoing recipient");
    outgoing.push(exchange("New latest left message", null, "review", Date.now() - 250));
    await setExchanges(outgoing);
    await waitFor('document.querySelector("[data-canvas-agent=main] .subagent-bot").dataset.lookingAt === "review"');
    const leftMessageGaze = await godGaze();
    assert.ok(leftMessageGaze.x < 0, "A newer outgoing message redirects God to the left recipient");
    await setExchanges([
      ...outgoing,
      exchange("New peer message", "review", "tests", Date.now() - 100),
      exchange("New incoming message", "tests", null, Date.now() - 50),
    ]);
    await delay(50);
    assert.equal(await lookingAt(), "review", "Peer and incoming messages do not redirect God");
    assert.deepEqual(await godGaze(), leftMessageGaze);
    await moveBotTo("review", { x: -350, y: 138 });
    await moveBotTo("review", { x: -350, y: -250 });
    await moveBotTo("review", { x: 350, y: -250 });
    assert.equal(await lookingAt(), "review", "Moving the recipient keeps the same message target");
    const movedRecipient = await positions();
    assert.ok(movedRecipient.review.x > movedRecipient.main.x, "The recipient moved around God to the right side");
    assert.ok((await godGaze()).x > 0, "God follows the recipient when it moves to the right");
    assert.equal(await godAngry(), false, "Message gaze never makes working God angry");
    await focusSurface();
    await key("R");
    await setExchanges([exchange("Latest message to Moses", null, "review")]);
    await waitFor('document.querySelector("[data-canvas-agent=main]").title.includes("Latest message to Moses")');
    await screenshot("subagent-canvas-message-gaze");
    await setExchanges([exchange("Expired outgoing message", null, "review", Date.now() - 13001)]);
    await waitFor('document.querySelector("[data-canvas-agent=main] .subagent-bot").dataset.looking !== "true"');
    assert.equal(
      await evaluate('getComputedStyle(document.querySelector("[data-canvas-agent=main] .subagent-bot-face")).animationName'),
      "subagent-glance",
      "Expired messages restore the normal glance",
    );
    await setExchanges([
      exchange("Older message to visible recipient", null, "review", Date.now() - 2000),
      exchange("Message to disappearing recipient", null, "arrival-2"),
    ]);
    await waitFor('document.querySelector("[data-canvas-agent=main] .subagent-bot").dataset.lookingAt === "arrival-2"');
    await evaluate('window.setChildren(items=>items.map(item=>item.id==="arrival-2" ? {...item,archived:true} : item))');
    await waitFor('document.querySelector("[data-canvas-agent=main] .subagent-bot").dataset.looking !== "true"');
    await evaluate("window.setChildren(items=>items.map(item=>({...item,archived:false})))");
    await waitFor('document.querySelector("[data-canvas-agent=main] .subagent-bot").dataset.lookingAt === "arrival-2"');
    await evaluate('window.setChildren(items=>items.filter(item=>item.id!=="arrival-2"))');
    await waitFor('document.querySelector("[data-canvas-agent=main] .subagent-bot").dataset.looking !== "true"');
    await evaluate(
      'window.setChildren(items=>[...items,{id:"arrival-2",title:"Extra task 2",status:"waiting",startedAt:Date.now(),updatedAt:Date.now(),transcript:[]}])',
    );
    await waitFor('!!document.querySelector("[data-canvas-agent=arrival-2]")');
    await evaluate(
      'window.setChildren(items=>items.map(item=>({...item,communications:item.id==="review" ? [{id:"older-retained",fromId:null,toId:"review",text:"Older retained message",at:Date.now()-2000}] : item.id==="arrival-2" ? [{id:"newest-removed",fromId:null,toId:"arrival-2",text:"Only record belongs to removed recipient",at:Date.now()-10}] : []})))',
    );
    await waitFor('document.querySelector("[data-canvas-agent=main] .subagent-bot").dataset.lookingAt === "arrival-2"');
    await evaluate('window.setChildren(items=>items.filter(item=>item.id!=="arrival-2"))');
    await waitFor('document.querySelector("[data-canvas-agent=main] .subagent-bot").dataset.looking !== "true"');
    await evaluate(
      'window.setChildren(items=>[...items,{id:"arrival-2",title:"Extra task 2",status:"waiting",startedAt:Date.now(),updatedAt:Date.now(),transcript:[]}])',
    );
    await waitFor('!!document.querySelector("[data-canvas-agent=arrival-2]")');
    await setExchanges([exchange("Can you check the token expiry test?", "review", "tests")]);
    await focusSurface();
    await key("R");
    await waitFor('document.querySelector("[data-canvas-agent=main] .subagent-bot").dataset.looking !== "true"');
    await screenshot("subagent-canvas");
    await recordGif("working-and-collisions", async () => {
      await setExchanges([exchange("Check authentication", null, "review")]);
      await delay(1800);
      await setExchanges([exchange("Run the token expiry test", null, "tests"), exchange("Compare the auth findings", "review", "tests")]);
      await delay(1800);
      await moveBotTo("tests", { x: 100, y: 180 });
      await moveBotTo("review", { x: -140, y: 180 });
      await delay(500);
      const start = await botCenter("review");
      const scale = (await world()).scale;
      window.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...start });
      for (let step = 1; step <= 24; step++) {
        window.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(start.x + (step * 220 * scale) / 24), y: start.y });
        await delay(50);
      }
      window.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, x: Math.round(start.x + 220 * scale), y: start.y });
      await assertBodiesSeparate();
      await delay(1000);
      await focusSurface();
      await key("R");
      await setExchanges([]);
    });
    await evaluate("window.setSending(false)");
    await waitFor('document.querySelector("[data-canvas-agent=main]").parentElement.dataset.status === "completed"');
    assert.equal(
      await evaluate('document.querySelector("[data-canvas-agent=main]").parentElement.querySelector(".subagent-bot-status")'),
      null,
      "Idle God does not show a Resting row",
    );
    assert.equal(
      await evaluate('document.querySelector("[data-canvas-agent=main]").parentElement.querySelector(".subagent-name-check")'),
      null,
      "Idle God does not show a child completion check",
    );
    assert.equal(
      await evaluate('document.querySelector("[data-canvas-agent=main] .subagent-bot").dataset.dead'),
      "false",
      "Idle God sleeps without using the dead expression",
    );
    assert.ok(await evaluate('!!document.querySelector("[data-canvas-agent=main]").parentElement.querySelector(".subagent-sleep")'), "Idle God sleeps");
    await screenshot("subagent-canvas-idle");
    await recordGif("wake-and-sleep", async () => {
      await delay(700);
      await drag(await botCenter("main"), 35, 20);
      const center = await botCenter("main");
      for (const offset of [100, -100, 100]) {
        window.webContents.sendInputEvent({ type: "mouseMove", x: center.x + offset, y: center.y - 60 });
        await delay(800);
      }
      await waitFor('document.querySelector("[data-canvas-agent=main] .subagent-bot").dataset.angry !== "true"', 7000);
      await delay(1000);
    });

    await drag(await botCenter("main"), 2, 1);
    assert.equal(await godAngry(), false, "A sub-threshold drag leaves idle God asleep");
    const idleCenter = await botCenter("main");
    window.webContents.sendInputEvent({ type: "mouseMove", ...idleCenter });
    window.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...idleCenter });
    window.webContents.sendInputEvent({ type: "mouseMove", x: idleCenter.x + 30, y: idleCenter.y + 20 });
    await waitFor('document.querySelector("[data-canvas-agent=main] .subagent-bot").dataset.angry === "true"');
    assert.equal(
      await evaluate('!!document.querySelector("[data-canvas-agent=main]").parentElement.querySelector(".subagent-sleep")'),
      false,
      "Waking God hides Zzz",
    );
    await delay(6100);
    assert.equal(await godAngry(), true, "God stays awake while the drag is held beyond six seconds");
    const releasedAt = Date.now();
    window.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, x: idleCenter.x + 30, y: idleCenter.y + 20 });
    const awakeCenter = await botCenter("main");
    window.webContents.sendInputEvent({ type: "mouseMove", x: awakeCenter.x + 120, y: awakeCenter.y - 100 });
    await delay(50);
    const rightGaze = await godGaze();
    window.webContents.sendInputEvent({ type: "mouseMove", x: awakeCenter.x - 120, y: awakeCenter.y + 100 });
    await delay(50);
    const leftGaze = await godGaze();
    assert.ok(rightGaze.x > leftGaze.x && rightGaze.y < leftGaze.y, "Awake eyes follow the pointer in both directions");
    for (const gaze of [rightGaze, leftGaze]) assert.ok(Math.abs(gaze.x) <= 7 && Math.abs(gaze.y) <= 4, "Eye movement stays within the face");
    assert.equal(await godAngry(), true, "Pointer tracking keeps the awake expression before its timeout");
    await screenshot("subagent-canvas-angry");
    await waitFor(
      '[...document.querySelectorAll("[data-canvas-agent=main] .subagent-bot-face i")].every(eye => parseFloat(getComputedStyle(eye).scale.split(" ")[1]) < 0.3)',
    );
    assert.equal(await godAngry(), true, "God visibly blinks while still angry after release");
    await waitFor('document.querySelector("[data-canvas-agent=main] .subagent-bot").dataset.angry !== "true"', 7000);
    assert.ok(Date.now() - releasedAt >= 5800, "God stays awake for about six seconds after release");
    assert.ok(
      await evaluate('!!document.querySelector("[data-canvas-agent=main]").parentElement.querySelector(".subagent-sleep")'),
      "God returns to sleep after release",
    );
    await evaluate('document.querySelector("[data-canvas-agent=main]").focus()');
    await key("Right");
    assert.equal(await godAngry(), true, "Keyboard movement also wakes idle God");
    assert.ok(
      await evaluate('document.querySelector("[data-canvas-agent=main]").getAttribute("aria-label").includes("God. Awake.")'),
      "The accessible label announces the awake expression",
    );
    await waitFor('document.querySelector("[data-canvas-agent=main] .subagent-bot").dataset.angry !== "true"', 7000);
    assert.ok(
      await evaluate('document.querySelector("[data-canvas-agent=main]").getAttribute("aria-label").includes("God. Sleeping.")'),
      "The accessible label announces sleep when the keyboard wake timer ends",
    );
    assert.equal(
      await evaluate('document.querySelector("[data-canvas-agent=main]").parentElement.querySelector(".subagent-bot-status")'),
      null,
      "Accessible sleep status does not add a visible row",
    );
    await key("Right");
    assert.equal(await godAngry(), true);
    await evaluate('document.querySelector("[data-diff-back]").click()');
    await waitFor('!document.querySelector("[data-slot=subagent-canvas]")');
    await evaluate('document.querySelector("[data-slot=subagent-track] [data-face=pill] button").click()');
    await waitFor('document.querySelector("[data-slot=subagent-popover]")?.dataset.state === "open"');
    await clickLabel("Open subagent canvas");
    await waitFor('!!document.querySelector("[data-slot=subagent-canvas]")');
    assert.equal(await godAngry(), false, "Closing the canvas clears the awake expression");
    assert.ok(
      await evaluate('!!document.querySelector("[data-canvas-agent=main]").parentElement.querySelector(".subagent-sleep")'),
      "Reopening the canvas leaves idle God asleep",
    );
    await evaluate('document.querySelector("[data-canvas-agent=main]").focus()');
    await key("Right");
    assert.equal(await godAngry(), true);
    await evaluate("window.setSending(true)");
    await waitFor('document.querySelector("[data-canvas-agent=main]").parentElement.dataset.status === "running"');
    assert.equal(await godAngry(), false, "Starting work clears the angry expression");
    await drag(await botCenter("main"), 20, 10);
    assert.equal(await godAngry(), false, "Dragging working God never makes it angry");
    await focusSurface();
    await key("R");
    await evaluate('document.documentElement.classList.remove("dark")');
    await screenshot("subagent-canvas-light");
    await evaluate('document.documentElement.classList.add("dark")');
    window.webContents.debugger.attach("1.3");
    await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await waitFor('matchMedia("(prefers-reduced-motion: reduce)").matches');
    assert.deepEqual(
      await evaluate(
        '[...document.querySelectorAll(".subagent-bot, .subagent-bot-face, .subagent-bot-face i, .subagent-thinking-bubble, .subagent-thinking-bubble i, .subagent-sleep i, .subagent-canvas-message-wire")].filter(node => getComputedStyle(node).animationName !== "none").map(node => node.className)',
      ),
      [],
      "Reduced motion stops bot, eyes, cloud, sleep, and message animations",
    );
    await screenshot("subagent-canvas-reduced-motion");
    await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [] });
    window.webContents.debugger.detach();
    window.setContentSize(390, 500);
    await evaluate("window.setSidebarWidth(44)");
    await delay(100);
    await assertCanvasEdges();
    await fit();
    const canvasBounds = await evaluate(
      '(() => {const r=document.querySelector("[data-slot=subagent-canvas]").getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}})()',
    );
    assert.ok(canvasBounds.left >= 0 && canvasBounds.right <= 390 && canvasBounds.top >= 0 && canvasBounds.bottom <= 500, "Canvas fits a narrow window");
    assert.ok(canvasBounds.bottom - canvasBounds.top > 450, "Canvas fills the available chat height");
    await screenshot("subagent-canvas-narrow");
    await key("Escape");
    await waitFor('!document.querySelector("[data-slot=subagent-canvas]")');
    await waitFor('document.activeElement === document.querySelector("[data-slot=subagent-track] [data-face=pill] button")');
    await assertMainGutters();
    await evaluate('window.setChildren(items => items.filter(item => !item.id.startsWith("arrival-")))');
    window.setContentSize(800, 600);
    await evaluate('document.querySelector("[data-slot=subagent-track] [data-face=pill] button").click()');
    await waitFor('document.querySelector("[data-slot=subagent-popover]")?.dataset.state === "open"');
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
    await clickLabel("Close subagents");
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
    await clickLabel("Close subagents");
    assert.ok(await evaluate('document.querySelector("[data-advisor-result]").textContent.includes("Codex advisor result: Security")'));
    assert.equal(await evaluate('document.querySelector("[data-advisor-result]").closest("article").dataset.from'), "app");
    await screenshot("advisor-result");
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
    assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-subagent-row]")].map(row => row.textContent.trim())'), [
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
    for (const text of ["Ran `sleep 4; cat a.txt`", "Read `a.txt`", "File a: hello from a."])
      assert.ok(await evaluate(`document.querySelector("[data-slot=subagent-transcript]").textContent.includes(${JSON.stringify(text)})`), text);
    await screenshot("antigravity-subagent-transcript");
    await clickLabel("Close subagents");
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
    await waitFor('[...document.querySelectorAll("[data-slot=subagent-transcript] > div.min-w-0")].length === 30');
    assert.deepEqual(await evaluate("window.subagentReads"), [["/fixture", 1, "long"]]);
    await evaluate("window.setChildren([window.tailOf(31)])");
    await waitFor('[...document.querySelectorAll("[data-slot=subagent-transcript] > div.min-w-0")].length === 31');
    const shown = await evaluate('[...document.querySelectorAll("[data-slot=subagent-transcript] > div.min-w-0")].map(row => row.textContent)');
    assert.equal(shown[0], "Long entry 1");
    assert.equal(shown.at(-1), "Long entry 31");
    assert.equal(await evaluate("window.subagentReads.length"), 1, "A tail that follows on doesn't read the transcript again");
    await screenshot("subagent-transcript-tails");
    await clickLabel("Close subagents");
    await evaluate("window.setChildren([])");
    await waitFor('!document.querySelector("[data-slot=subagent-track]")');
    // A host that sends archived subagents as summaries (archived-subagent-summaries-v1): opening one from the Archived
    // list reads its prompt, latest activity and transcript, and a newer summary reads them again.
    await evaluate(`(() => {
      const started = Date.now() - 90000;
      const whole = (updatedAt, activity) => ({ id: "old", title: "Archived review", status: "completed", archived: true, startedAt: started, updatedAt, endedAt: updatedAt,
        prompt: "Check the token refresh path", latestActivity: activity,
        communications: [{ id: "c1", fromId: null, toId: "old", text: "Look at expiry too", at: started }],
        transcript: [{ id: "t1", kind: "tool", text: "Ran \`npm test -- auth\`" }, { id: "t2", kind: "message", text: "Token refresh is covered." }] });
      const summary = (updatedAt) => { const { prompt, latestActivity, communications, transcript, ...rest } = whole(updatedAt, ""); return { ...rest, transcript: [], detailsOnDemand: true }; };
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
    await waitFor('[...document.querySelectorAll("[data-subagent-row]")].map(row => row.textContent.trim()).join() === "Archived review"');
    await evaluate('document.querySelector("[data-subagent-open]").click()');
    await waitFor('!!document.querySelector("[data-subagent-loading]")');
    assert.equal(await evaluate('document.querySelector("[data-slot=subagent-transcript]").textContent.includes("No child output")'), false);
    assert.deepEqual(await evaluate("window.summaryReads"), [["/fixture", 1, "old"]]);
    await screenshot("archived-subagent-loading");
    await evaluate("window.releaseSummaryRead()");
    await waitFor('!document.querySelector("[data-subagent-loading]")');
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
    await evaluate('[...document.querySelectorAll("[data-slot=subagent-popover] button")].find(button => button.textContent === "Back").click()');
    await waitFor('[...document.querySelectorAll("[data-subagent-open]")].some(button => button.textContent.includes("Offline review"))');
    await evaluate('[...document.querySelectorAll("[data-subagent-open]")].find(button => button.textContent.includes("Offline review")).click()');
    await waitFor('!!document.querySelector("[data-subagent-failed]")');
    await delay(300);
    assert.equal(await evaluate("window.summaryReads.length"), 1, "a failed read isn't retried while the panel stays open");
    await screenshot("archived-subagent-failed");
    await evaluate('[...document.querySelectorAll("[data-slot=subagent-popover] button")].find(button => button.textContent === "Back").click()');
    await waitFor('!!document.querySelector("[data-subagent-open]")');
    await evaluate('[...document.querySelectorAll("[data-subagent-open]")].find(button => button.textContent.includes("Offline review")).click()');
    await waitFor('document.querySelector("[data-slot=subagent-transcript]").textContent.includes("After reconnecting")');
    assert.equal(await evaluate("window.summaryReads.length"), 2, "opening it again reads again");
    await clickLabel("Close subagents");
    await evaluate("window.setChildren([])");
    await waitFor('!document.querySelector("[data-slot=subagent-track]")');
    console.log(
      "PASS: embedded canvas, drag/pan/zoom, collision pushes, keyboard transcript, persistent layout, sequential arrivals, stable names, dead/sleeping/angry states, message/pointer gaze, reduced motion, compact layout, original subagent list/archive/transcript checks, whole transcripts from a host that sends tails, and archived subagents read on demand",
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
        transform(source, id) {
          if (!id.endsWith("/components/agents/SubagentCanvas.tsx")) return;
          assert.match(source, /return\s*\(\s*<section\s+ref=\{panel\}/, "Canvas profiler must wrap the rendered scene");
          return (
            'import { Profiler as FixtureCanvasProfiler } from "react";\n' +
            source
              .replace(
                /return\s*\(\s*<section\s+ref=\{panel\}/,
                'return (<FixtureCanvasProfiler id="canvas" onRender={window.recordSubagentCommit}><section ref={panel}',
              )
              .replace("</section>", "</section></FixtureCanvasProfiler>")
          );
        },
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
