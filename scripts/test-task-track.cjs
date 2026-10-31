// Run with node scripts/test-task-track.cjs. Uses the app's existing Vite and
// Electron dependencies to check subagent interactions and layout without an extra test runner.
const assert = require("node:assert/strict");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");

const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatComposer } from "/src/components/ChatComposer";
import { updateSettings } from "/src/lib/settings";
window.updateContextSettings = updateSettings;
import { MODEL_CATALOG, capabilityFor } from "/src/model";
import "/src/styles.css";
window.milagre = Object.freeze({ listEditors: async () => [] });
const noop = () => {};
function Fixture() {
  const [count, setCount] = useState(2);
  const [children, setChildren] = useState([
    {id:"review",title:"Review authentication",prompt:"Check auth for regressions",status:"running",startedAt:Date.now()-65000,updatedAt:Date.now(),latestActivity:"Reading auth.ts",transcript:[{id:"a",kind:"message",text:"Child-only finding"}]},
    {id:"tests",title:"Run tests",status:"failed",startedAt:Date.now()-40000,updatedAt:Date.now(),endedAt:Date.now(),transcript:[{id:"b",kind:"tool",text:"Tests failed"}]}
  ]);
  const [sending, setSending] = useState(true);
  const [plan, setPlan] = useState({ source: "milagre", updatedAt: 0, tasks: [
    {id:"1",title:"Persist wishlist items",activeForm:"Persisting wishlist items",status:"in_progress",children:[
      {id:"1.1",title:"Save wishlist changes on this device",activeForm:"Saving wishlist changes",status:"in_progress"},
      {id:"1.2",title:"Restore the wishlist on startup",status:"completed"}]},
    {id:"2",title:"Verify wishlist persistence",status:"completed",children:[
      {id:"2.1",title:"Verify items survive a browser restart",status:"completed",children:[
        {id:"2.1.1",title:"Chrome",status:"completed"}]},
      {id:"2.2",title:"Verify removed items stay removed",status:"completed"}]},
    {id:"3",title:"Prepare the wishlist evidence for review",status:"pending"}],
    phases: [
      {phase:"start",at:Date.now()-5*3600e3},{phase:"plan",at:Date.now()-4.8*3600e3},{phase:"build",at:Date.now()-4.5*3600e3},
      {phase:"test",at:Date.now()-4.2*3600e3},{phase:"review",at:Date.now()-1*3600e3}] });
  window.setPlan = setPlan;
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
  window.compacted ??= [];
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
      projectPath="/fixture" draft={draft} onDraftChange={setDraft} onSend={noop} isSending={sending} sendBlocked={false} plan={plan} contextUsage={usage} streamingText="" streamingSteps={[{ id: "c-1", kind: "other", title: "Compacting context", status: "running", offset: 0 }]} subagents={children} onArchiveFinishedSubagents={archiveFinished} onArchiveSubagent={archive} waitingForSubagents={true}
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
      throw new Error(`${source}: ${error.message}`, { cause: error });
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
  const pill = "[data-slot=task-track] [data-face=pill] button";
  // The pill and its panel are two faces of one surface; both stay mounted and only the shown one is live.
  const surface = "[data-slot=task-surface]";
  const panel = "[data-slot=task-popover]";
  const isOpen = `document.querySelector("${panel}")?.dataset.state === "open"`;
  const isClosed = `document.querySelector("${panel}")?.dataset.state === "closed"`;
  const assertFaces = async (open) => {
    const faces = await evaluate(
      `(() => {const p=document.querySelector("[data-slot=task-track] [data-face=pill]"), c=document.querySelector("${panel}");return {pill:[p.inert,p.getAttribute("aria-hidden")], panel:[c.inert,c.getAttribute("aria-hidden")]}})()`,
    );
    assert.deepEqual(
      faces,
      open ? { pill: [true, "true"], panel: [false, null] } : { pill: [false, null], panel: [true, "true"] },
      `Faces (${open ? "open" : "closed"})`,
    );
  };
  // The surface has stopped moving and takes the size of the face on show.
  const settle = () =>
    waitFor(
      `(() => {const s=document.querySelector("${surface}"), open=${isOpen}, face=open ? document.querySelector("${panel}") : document.querySelector("[data-slot=task-track] [data-face=pill]"), r=s.getBoundingClientRect();return !s.getAnimations().length && Math.abs(r.width-face.offsetWidth)<1 && Math.abs(r.height-face.offsetHeight)<1})()`,
    );
  const rect = (selector) =>
    evaluate(
      `(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}})()`,
    );
  // The open surface grows up and to the left from the pill: its bottom-right corner stays on the pill's, unless the
  // panel would cross the window's 12px left padding; then it moves right just enough, never past innerWidth - 12.
  const assertGrownFromPill = async (pillBox, when) => {
    const box = await rect(surface);
    const content = await evaluate(`(() => {const c=document.querySelector("${panel}");return {width:c.offsetWidth,height:c.offsetHeight,w:innerWidth}})()`);
    const right = Math.max(pillBox.right, 12 + box.width);
    assert.ok(
      Math.abs(box.right - right) <= 1 && Math.abs(box.bottom - pillBox.bottom) <= 1,
      `Surface left the pill's corner (${when}): ${JSON.stringify({ box, pillBox })}`,
    );
    assert.ok(box.left >= 11 && box.right <= content.w - 11, `Surface crosses the window's padding (${when}): ${JSON.stringify(box)}`);
    assert.ok(
      Math.abs(box.width - content.width) <= 1 && Math.abs(box.height - content.height) <= 1,
      `Surface does not fit its panel (${when}): ${JSON.stringify({ box, content })}`,
    );
    assert.ok(box.width <= 380 && box.height > pillBox.height, `Surface did not open (${when}): ${JSON.stringify(box)}`);
  };
  // The surface overlays the transcript: opening it never moves the composer row's other controls.
  const rowControls = () =>
    evaluate(
      `["[data-slot=subagent-track] [data-face=pill] button","button[aria-label=Send]"].map(s=>{const r=document.querySelector(s).getBoundingClientRect();return [r.left,r.top,r.width,r.height]})`,
    );
  const assertRowStill = (before, after, when) =>
    assert.ok(
      before.every((box, index) => box.every((value, axis) => Math.abs(value - after[index][axis]) <= 0.5)),
      `The composer row moved when the panel opened (${when}): ${JSON.stringify({ before, after })}`,
    );
  // Clicks the pill and reads the surface's target once React has committed (a microtask), before any frame or
  // ResizeObserver callback: it must already be the panel's box.
  const openAndReadTarget = () =>
    evaluate(
      `(async () => {document.querySelector("${pill}").click();for (let i=0;i<3;i++) await Promise.resolve();const s=document.querySelector("${surface}").style, c=document.querySelector("${panel}");return {width:parseFloat(s.width),height:parseFloat(s.height),panelWidth:c.offsetWidth,panelHeight:c.offsetHeight}})()`,
    );
  const assertTargetsPanel = (target, when) =>
    assert.ok(
      Math.abs(target.width - target.panelWidth) <= 1 && Math.abs(target.height - target.panelHeight) <= 1,
      `The first frame aims at a stale box (${when}): ${JSON.stringify(target)}`,
    );
  // A short frame sequence of the morph, for the PR: Electron's frame subscription paints ~30fps even in a hidden window.
  async function record(name, run) {
    if (!screenshotDir) return run();
    const fs = require("node:fs");
    const frames = [];
    window.webContents.beginFrameSubscription(false, (image) => frames.push({ at: Date.now(), image }));
    try {
      await run();
    } finally {
      window.webContents.endFrameSubscription();
    }
    const dir = path.join(screenshotDir, name);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const list = [];
    frames.forEach((frame, index) => {
      const file = `${String(index).padStart(4, "0")}.png`;
      fs.writeFileSync(path.join(dir, file), frame.image.toPNG());
      list.push(`file '${file}'`, `duration ${(((frames[index + 1]?.at ?? frame.at + 33) - frame.at) / 1000).toFixed(3)}`);
    });
    fs.writeFileSync(path.join(dir, "frames.txt"), list.join("\n") + "\n");
  }
  const assertDotOnRow = async () => {
    const offset = await evaluate(
      `(() => {const c=[...document.querySelectorAll("[data-slot=phase-graph] circle")].at(-1).getBoundingClientRect(), l=document.querySelector("[data-slot=phase-graph] [data-current-phase]").getBoundingClientRect();return Math.abs((c.top+c.bottom)/2-(l.top+l.bottom)/2)})()`,
    );
    assert.ok(offset <= 2, `Phase dot is ${offset}px off its row label`);
  };
  // Every dot, tick label and "Now" sits fully inside the graph's SVG: iOS draws nothing outside it.
  const assertGraphInsideBox = async (when) => {
    const outside = await evaluate(
      `(() => {const svg=document.querySelector("[data-slot=phase-graph] svg[role=img]").getBoundingClientRect();return [...document.querySelectorAll("[data-slot=phase-graph] circle, [data-slot=phase-graph] text")].filter(e=>{const r=e.getBoundingClientRect();return r.left<svg.left-0.5||r.right>svg.right+0.5||r.top<svg.top-0.5||r.bottom>svg.bottom+0.5}).map(e=>{const r=e.getBoundingClientRect();return e.tagName+":"+e.textContent+":"+[r.left,r.right,r.top,r.bottom,svg.left,svg.right,svg.top,svg.bottom].map(Math.round)})})()`,
    );
    assert.deepEqual(outside, [], `Phase graph leaves its box (${when})`);
    assert.ok(await evaluate('[...document.querySelectorAll("[data-slot=phase-graph] text")].some(e=>e.textContent==="Now")'), `No "Now" label (${when})`);
    assert.ok(await evaluate('document.querySelectorAll("[data-slot=phase-graph] circle").length>=2'), `Dots missing (${when})`);
    // Every gap chip sits on the line: its centre is within 1.5 px of the path.
    const chip = await evaluate(
      `(() => {const path=document.querySelector("[data-slot=phase-graph] svg[role=img] path"), len=path.getTotalLength();return [...document.querySelectorAll("[data-slot=phase-graph] [data-gap] rect")].map(r=>{const cx=r.x.baseVal.value+r.width.baseVal.value/2, cy=r.y.baseVal.value+r.height.baseVal.value/2;let best=Infinity;for(let i=0;i<=len;i+=0.5){const p=path.getPointAtLength(i);best=Math.min(best,Math.hypot(p.x-cx,p.y-cy))}return best})})()`,
    );
    assert.ok(chip.length >= 2 && chip.every((distance) => distance <= 1.5), `Gap chip is off the line (${when}): ${JSON.stringify(chip)}`);
  };
  try {
    await window.loadURL(process.argv[2]);
    await waitFor('!!document.querySelector("[data-slot=task-track]")');
    assert.equal(await evaluate(`document.querySelector("${pill}").textContent`), "3/5");
    // The context ring sits beside Send, on the same row.
    const ring = "button[aria-label^=Context]";
    assert.equal(await evaluate(`document.querySelector("${ring}").getAttribute("aria-label")`), "Context: 37% used (366k of 1M tokens)");
    assert.ok(
      await evaluate(
        `(() => {const r=document.querySelector("${ring}").getBoundingClientRect(), s=document.querySelector("button[aria-label=Send]").getBoundingClientRect();return r.right<=s.left && Math.abs(r.top-s.top)<1})()`,
      ),
    );
    assert.equal(await evaluate('!!document.querySelector("[data-compact-context]")'), false, "threshold action is hidden at 37%");
    await evaluate('window.updateContextSettings({ showContextSize: false, compactButtonDisplay: "always" })');
    await waitFor('!!document.querySelector("[data-compact-context]")');
    assert.equal(await evaluate('document.querySelector("[data-compact-context]").disabled'), false, "manual compaction may queue during the turn");
    assert.equal(await evaluate('document.querySelector("[data-compact-context]").title'), "Compact after turn");
    await evaluate('window.updateContextSettings({ showContextSize: true, compactButtonDisplay: "threshold" })');
    await waitFor('!!document.querySelector("button[aria-label^=Context]")');
    for (const theme of ["dark", "light"]) {
      await evaluate(`window.setDark(${theme === "dark"})`);
      await evaluate(`document.querySelector("${ring}").click()`);
      await waitFor('!!document.querySelector("[data-context-card]")');
      assert.equal(await evaluate('document.querySelector("[data-context-card]").textContent'), "366k of 1M tokens70%85%Compact after turn");
      assert.equal(await evaluate('document.querySelector("[data-compact-now]").disabled'), false);
      assert.ok(await evaluate('getComputedStyle(document.querySelector("[data-context-bar] > div > div")).backgroundImage.includes("linear-gradient")'));
      await screenshot(`context-card-${theme}`);
      await evaluate('window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
      await waitFor('!document.querySelector("[data-context-card]")');
    }
    await evaluate("window.setContext({ used: 780000, size: 1000000 })");
    await waitFor('!!document.querySelector("[data-compact-context]")');
    assert.ok(await evaluate('document.querySelector("[data-context-capsule]").classList.contains("text-orange-ink")'));
    await evaluate("window.finishChildren()");
    await evaluate(`document.querySelector("${ring}").click()`);
    await waitFor('document.querySelector("[data-compact-now]")?.textContent === "Compact now"');
    assert.equal(await evaluate('document.querySelector("[data-context-card]").textContent'), "780k of 1M tokens70%85%Compact now");
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
    await waitFor(`document.querySelector("${ring}")?.getAttribute("aria-label") === "Context: 4% used (42k of 1M tokens)"`);
    await waitFor('!document.querySelector("[data-compact-context]")');
    await evaluate('window.updateContextSettings({ showContextSize: false, compactButtonDisplay: "always" })');
    await waitFor('!!document.querySelector("[data-compact-context]")');
    await evaluate('document.querySelector("[data-compact-context]").click()');
    assert.equal(await evaluate("window.compacted.length"), 2, "direct compaction works while the context size is hidden");
    await screenshot("compact-always-context-hidden");
    await evaluate('window.updateContextSettings({ showContextSize: true, compactButtonDisplay: "threshold" })');

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
      `(() => {const a=document.querySelector("${pill}").getBoundingClientRect(), b=document.querySelector("[data-slot=subagent-track] [data-face=pill] button").getBoundingClientRect();return {gap:b.left-a.right,dy:Math.abs(a.top-b.top)}})()`,
    );
    assert.ok(gap.gap >= 0 && gap.gap <= 12 && gap.dy < 1, `Pill is not beside Subagents: ${JSON.stringify(gap)}`);
    // Closed, the panel face is mounted but out of reach.
    await assertFaces(false);
    for (const theme of ["dark", "light"]) {
      await evaluate(`window.setDark(${theme === "dark"})`);
      await screenshot(`task-pill-closed-${theme}`);
      const pillBox = await rect(pill);
      if (theme === "dark") {
        // The recording covers open and close: the pill grows into the panel and shrinks back.
        await record("task-morph", async () => {
          await delay(150);
          await evaluate(`document.querySelector("${pill}").click()`);
          await waitFor(isOpen);
          await settle();
          await delay(400);
          await clickLabel("Collapse tasks");
          await waitFor(isClosed);
          await settle();
          await delay(250);
        });
        assert.equal(await evaluate(`document.activeElement === document.querySelector("${pill}")`), true, "The collapse control returns focus to the pill");
      }
      const rowBefore = await rowControls();
      await evaluate(`document.querySelector("${pill}").click()`);
      await waitFor(isOpen);
      await assertFaces(true);
      await settle();
      await assertGrownFromPill(pillBox, theme);
      if (theme === "dark") assertRowStill(rowBefore, await rowControls(), theme);
      assert.equal(await evaluate(`document.querySelector("${pill}").getAttribute("aria-expanded")`), "true");
      assert.equal(await evaluate('document.querySelectorAll("dialog[open], [aria-modal=true]").length'), 0);
      assert.equal(await evaluate('document.querySelectorAll("[data-task-row]").length'), 8);
      assert.deepEqual(
        await evaluate('[...document.querySelectorAll("[data-task-row]")].slice(0,2).map(row => row.dataset.depth + ":" + row.dataset.status)'),
        ["0:in_progress", "1:in_progress"],
      );
      assert.match(await evaluate('document.querySelector("[data-task-row][data-depth=\\"1\\"]").textContent'), /Saving wishlist changes/);
      // Only the in-progress leaf shows its activeForm; its parent keeps the title.
      const parentRow = await evaluate('document.querySelector("[data-task-row][data-depth=\\"0\\"]").textContent');
      assert.match(parentRow, /Persist wishlist items/);
      assert.doesNotMatch(parentRow, /Persisting/);
      assert.ok(await evaluate('!!document.querySelector("[data-slot=phase-graph] path")'));
      assert.equal(await evaluate('document.querySelector("[data-slot=phase-graph] [data-current-phase]").textContent'), "Review");
      assert.match(await evaluate('document.querySelector("[data-slot=phase-graph] [data-gap]").textContent'), /^3h$/);
      // Every dot sits on its legend row: the current phase's dot is level with its label.
      await assertDotOnRow();
      await assertGraphInsideBox(theme);
      // Collapsing a parent hides its children.
      await evaluate('document.querySelector("[data-task-row] button[aria-expanded]").click()');
      assert.equal(await evaluate('document.querySelectorAll("[data-task-row]").length'), 6);
      await evaluate('document.querySelector("[data-task-row] button[aria-expanded]").click()');
      assert.equal(await evaluate('document.querySelectorAll("[data-task-row]").length'), 8);
      const bounds = await evaluate(
        `(() => {const r=document.querySelector("${panel}").getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,w:innerWidth,h:innerHeight}})()`,
      );
      assert.ok(bounds.left >= 0 && bounds.right <= bounds.w && bounds.top >= 0, `Popover is misplaced: ${JSON.stringify(bounds)}`);
      await screenshot(`task-popover-${theme}`);
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
      await waitFor(isClosed);
      assert.equal(await evaluate(`document.activeElement === document.querySelector("${pill}")`), true);
      await assertFaces(false);
      await settle();
    }
    await evaluate(`document.querySelector("${pill}").click()`);
    await waitFor(isOpen);
    await evaluate('document.querySelector("[data-prompt-editor]").dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}))');
    await waitFor(isClosed);
    await settle();
    // Reduced motion: the surface jumps straight to the panel, with no transition.
    const devtools = window.webContents.debugger;
    devtools.attach("1.3");
    await devtools.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    assert.equal(await evaluate('matchMedia("(prefers-reduced-motion: reduce)").matches'), true);
    await evaluate(`document.querySelector("${pill}").click()`);
    await waitFor(isOpen);
    // styles.css's global reduced-motion rule turns every transition into 0.01ms, which is no transition.
    const durations = await evaluate(`getComputedStyle(document.querySelector("${surface}")).transitionDuration.split(", ").map(parseFloat)`);
    assert.ok(
      durations.every((seconds) => seconds <= 0.00001),
      `The surface still transitions under reduced motion: ${durations}`,
    );
    assert.ok(
      await evaluate(
        `new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => {const s=document.querySelector("${surface}").getBoundingClientRect(), c=document.querySelector("${panel}");done(Math.abs(s.width-c.offsetWidth)<1 && Math.abs(s.height-c.offsetHeight)<1)})))`,
      ),
      "The surface did not open at once under reduced motion",
    );
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await waitFor(isClosed);
    await devtools.sendCommand("Emulation.setEmulatedMedia", { features: [] });
    devtools.detach();
    await settle();
    window.setContentSize(390, 500);
    await evaluate("window.setContext({ used: 800000, size: 1000000 })");
    await waitFor('!!document.querySelector("[data-compact-context]")');
    assert.ok(
      await evaluate(
        '(() => { const b = document.querySelector("[data-compact-context]").getBoundingClientRect(), s = document.querySelector("button[aria-label=Send]").getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth && s.right <= innerWidth; })()',
      ),
      "Compact and Send stay inside a narrow Chat with context size visible",
    );
    await screenshot("compact-narrow");
    await delay(200);
    const narrowPill = await rect(pill);
    const narrowRow = await rowControls();
    // Here the panel also moves right of the pill to keep the window's padding; the recording shows it. The window
    // shrank while the panel was closed, so its room changes at this click: the first frame must still aim right.
    let narrowTarget;
    await record("task-morph-narrow", async () => {
      await delay(150);
      narrowTarget = await openAndReadTarget();
      await waitFor(isOpen);
      await settle();
      await delay(250);
    });
    assertTargetsPanel(narrowTarget, "narrow");
    await assertGrownFromPill(narrowPill, "narrow");
    assertRowStill(narrowRow, await rowControls(), "narrow");
    assert.ok(
      await evaluate(`(() => {const r=document.querySelector("${panel}").getBoundingClientRect();return r.left>=12 && r.right<=innerWidth-12 && r.top>=0})()`),
      "Popover escapes the narrow viewport",
    );
    // A narrow window takes the full width less its padding, rather than squeezing left of the pill.
    const narrowWidth = (await rect(panel)).width;
    assert.ok(narrowWidth >= 360, `Narrow panel is ${narrowWidth}px wide`);
    // The tree and the graph scroll as one body, so the tree keeps room: at least four rows show unscrolled.
    const visibleRows = await evaluate(
      `(() => {const b=document.querySelector("[data-slot=task-body]");b.scrollTop=0;const r=b.getBoundingClientRect();return [...b.querySelectorAll("[data-task-row]")].filter(e=>{const x=e.getBoundingClientRect();return x.top>=r.top-0.5 && x.bottom<=r.bottom+0.5}).length})()`,
    );
    assert.ok(visibleRows >= 4, `Only ${visibleRows} task rows show in the narrow window`);
    assert.ok(
      await evaluate(
        `(() => {const b=document.querySelector("[data-slot=task-body]");return b.contains(document.querySelector("[data-slot=phase-graph]")) && !b.contains(document.querySelector("button[aria-label='Collapse tasks']"))})()`,
      ),
      "The graph scrolls with the tree under a fixed header",
    );
    await assertDotOnRow();
    await assertGraphInsideBox("narrow");
    await screenshot("task-popover-narrow");
    window.setContentSize(1200, 600);
    await evaluate('document.getElementById("root").style.width = "390px"');
    await delay(200);
    assert.ok(
      await evaluate('document.querySelector("button[aria-label=Send]").getBoundingClientRect().right <= 390'),
      "a narrow pane also fits inside a wide window",
    );
    await evaluate('window.setDraft("A multiline draft\\nkeeps the controls visible")');
    await delay(200);
    assert.ok(
      await evaluate('document.querySelector("button[aria-label=Send]").getBoundingClientRect().right <= 390'),
      "expanded narrow panes keep Send visible",
    );
    await evaluate('document.getElementById("root").style.width = ""; window.setDraft("")');
    window.setContentSize(800, 600);
    await evaluate("window.setPlan(p => ({...p, tasks: []}))");
    await waitFor(`document.querySelector("${pill}").textContent === "Review"`);
    await evaluate("window.setPlan(undefined)");
    await waitFor('!document.querySelector("[data-slot=task-track]") && !document.querySelector("[data-slot=task-popover]")');
    assert.ok(await evaluate('!!document.querySelector("[data-slot=subagent-track] [data-face=pill] button")'));
    console.log(
      "PASS: pill label, placement beside Subagents, pill-to-panel morph (faces, corner, size, reduced motion), rows and statuses, light and dark, Escape, collapse and outside click, focus return, narrow layout, hidden when empty, context card tones and Compact now, compaction divider",
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
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
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
