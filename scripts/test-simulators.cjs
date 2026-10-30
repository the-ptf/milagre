// Real Electron rendering of the composer and simulator entry point. No simulator required.
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");
const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatComposer } from "/src/components/ChatComposer";
import { PanelToggles } from "/src/components/agents/PanelToggles";
import { MODEL_CATALOG, capabilityFor } from "/src/model";
import "/src/styles.css";
const noop = () => {};
window.deviceCount = 3;
window.attachedIds = [0,1];
window.stoppedIds = [];
window.simulatorCalls = [];
window.simulatorClosed = [];
window.simulatorVideo = false;
window.simulatorControlling = true;
window.simulatorReady = true;
window.simulatorInputs = [];
window.simulatorInputHint = {};
window.simulatorHinge = {};
window.deviceOverrides = {};
const viewers = new Map();
const device = i => ({...(i === 0 ? {id:'device-0',name:'iPhone 17',deviceType:'com.apple.CoreSimulator.SimDeviceType.iPhone-17',platform:'ios',version:'27'} : i === 3 ? {id:'device-3',name:'iPhone 13',deviceType:'com.apple.CoreSimulator.SimDeviceType.iPhone-13',platform:'ios',version:'27'} : {id:'device-'+i,name:i===1?'Pixel 9':'Other Chat device',platform:'android',version:'16'}),...(window.deviceOverrides[i]??{})});
function paintStreamCutout(ctx,width,height) {
  if(!window.simulatorCutout) return;
  ctx.fillStyle='#e144b4';ctx.fillRect(0,0,width,height*.16);
  ctx.fillStyle='#000';
  if(window.simulatorCutout==='island'){ctx.beginPath();ctx.roundRect(width*.27,height*.055,width*.30,height*.035,height*.0175);ctx.fill();}
  if(window.simulatorCutout==='notch'){ctx.beginPath();ctx.roundRect(width*.08,-20,width*.38,height*.075+20,20);ctx.fill();}
}
async function liveOffer({viewerId,sdp}) {
  if (!window.simulatorVideo) throw Error('Test connection failed. Retry to reconnect.');
  const viewer = viewers.get(viewerId), canvas = document.createElement('canvas');
  canvas.width = 588; canvas.height = 1280;
  const ctx = canvas.getContext('2d');
  const draw = () => {
    const sideways = viewer.platform === 'android' && viewer.orientation.startsWith('landscape');
    if(canvas.width !== (sideways ? 1280 : 588)){canvas.width=sideways ? 1280 : 588;canvas.height=sideways ? 588 : 1280;}
    ctx.save();
    ctx.setTransform(sideways ? 0 : 1,sideways ? -1 : 0,sideways ? 1 : 0,sideways ? 0 : 1,0,sideways ? 588 : 0);
    ctx.fillStyle='#0d1624';ctx.fillRect(0,0,588,1280);
    ctx.fillStyle='#e9eff7';ctx.font='bold 24px sans-serif';ctx.fillText('9:41',40,55);
    ctx.font='bold 38px sans-serif';ctx.fillText('Milagre',34,154);
    ctx.font='28px sans-serif';ctx.fillText('milagre-ade',34,255);
    ctx.fillStyle='#9199a4';ctx.font='18px sans-serif';ctx.fillText('CHATS',34,326);
    ctx.fillStyle='#172232';ctx.beginPath();ctx.roundRect(24,353,540,130,16);ctx.fill();
    ctx.fillStyle='#e9eff7';ctx.font='24px sans-serif';ctx.fillText('Improve the simulator shell',44,401);
    ctx.fillStyle='#9199a4';ctx.font='20px sans-serif';ctx.fillText('Rounded frame and compact controls',44,445);
    ctx.fillStyle='#e9eff7';ctx.font='24px sans-serif';ctx.fillText('Fix host recovery',44,543);
    ctx.fillText('Polish the floating inbox',44,653);
    ctx.fillStyle='#80b9fd';ctx.fillText('+  New Chat',34,764);
    ctx.fillStyle='#9199a4';ctx.font='18px sans-serif';ctx.fillText('Chats           Projects           Settings',44,1192);
    ctx.fillStyle='#e9eff7';ctx.beginPath();ctx.roundRect(205,1243,178,6,3);ctx.fill();
    ctx.restore();
    paintStreamCutout(ctx,canvas.width,canvas.height);
  };
  draw();
  const stream=canvas.captureStream(5), peer=new RTCPeerConnection({iceServers:[]});
  viewer.peer=peer;viewer.stream=stream;viewer.timer=setInterval(draw,200);
  for (const track of stream.getTracks()) peer.addTrack(track,stream);
  await peer.setRemoteDescription({type:'offer',sdp});
  await peer.setLocalDescription(await peer.createAnswer());
  if(peer.iceGatheringState!=='complete') await new Promise(resolve=>peer.addEventListener('icegatheringstatechange',()=>{if(peer.iceGatheringState==='complete')resolve()}));
  return {type:'answer',sdp:peer.localDescription.sdp};
}
const status = viewerId => {
 const viewer=viewers.get(viewerId),sideways=viewer?.platform==='android' && viewer.orientation.startsWith('landscape');
 return {width:sideways?1280:588,height:sideways?588:1280,orientation:viewer?.orientation??'portrait',generation:viewer?.generation??1,displayGeneration:viewer?.displayGeneration??1,controlling:window.simulatorControlling,ready:window.simulatorReady,...window.simulatorInputHint,...window.simulatorHinge};
};
window.milagre = { simulators: {
 list: async ({chatId}) => ({chatId,devices:window.attachedIds.filter(i=>!window.stoppedIds.includes(i)).map(device),attached:window.attachedIds.map(device),available:Array.from({length:window.deviceCount},(_,i)=>i).filter(i=>!window.attachedIds.includes(i)).map(device),supported:true}),
 attach: async ({chatId,deviceId}) => {window.attachedIds.push(Number(deviceId.split('-')[1]));return window.milagre.simulators.list({chatId});},
 detach: async ({chatId,deviceId}) => {window.attachedIds=window.attachedIds.filter(i=>device(i).id!==deviceId);return window.milagre.simulators.list({chatId});},
 open: async args => { window.simulatorCalls.push(args);const viewerId='view-'+window.simulatorCalls.length,currentDevice=device(Number(args.deviceId.split('-')[1]));viewers.set(viewerId,{orientation:'portrait',generation:1,displayGeneration:1,platform:currentDevice.platform});return {viewerId,device:currentDevice,iceServers:[],...(window.simulatorFrames?{transport:"frames"}:{})}; },
 frame: async ({viewerId}) => {
   if(window.simulatorFrameBroken) throw Error('Frame link interrupted');
   const v=viewers.get(viewerId),state=status(viewerId),canvas=document.createElement('canvas');
   canvas.width=state.width;canvas.height=state.height;
   const c=canvas.getContext('2d');c.fillStyle='#0d1624';c.fillRect(0,0,canvas.width,canvas.height);c.fillStyle='#e9eff7';c.font='30px sans-serif';c.fillText('Relayed simulator',30,100);
   paintStreamCutout(c,canvas.width,canvas.height);
   return {sequence:v.frameSequence=(v.frameSequence??0)+1,data:canvas.toDataURL('image/jpeg').split(',')[1],mimeType:'image/jpeg',status:state};
 },
 offer: liveOffer,
 status: async ({viewerId}) => status(viewerId),
 control: async ({viewerId,takeOver}) => {if(takeOver)window.simulatorControlling=true;return status(viewerId);},
 close: async args => {window.simulatorClosed.push(args.viewerId);const v=viewers.get(args.viewerId);clearInterval(v?.timer);v?.peer?.close();for(const t of v?.stream?.getTracks()??[])t.stop();viewers.delete(args.viewerId);return null;},
 input: async args => {window.simulatorInputs.push(args.event);const v=viewers.get(args.viewerId);if(args.event.kind==='rotate'){v.orientation=args.event.orientation;v.generation++;v.displayGeneration++;}if(args.event.kind==='pose'||args.event.kind==='hinge'){v.generation++;v.displayGeneration++;window.simulatorHinge={supportsHingeAngle:true,hingePose:args.event.pose,hingeAngle:args.event.angle??(args.event.pose==='open'?180:args.event.pose==='closed'?0:90)};}return {accepted:true};},
}};
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
  const [model, setModel] = useState(MODEL_CATALOG[0]);
  const [fastMode, setFastMode] = useState(false);
  window.setMessageCount = setCount;
  window.setDraft = setDraft;
  window.setModel = (id) => setModel(MODEL_CATALOG.find((item) => item.id === id));
  const messages = Array.from({ length: count }, (_, index) => ({
    id: index + 1, session_id: 1, context: null, role: index === 0 ? "user" : "assistant",
    body: index === 0 ? "Review authentication and run the relevant tests." : "I started two subagents. Their progress is available below.",
  }));
  return <div data-chat-pane style={{ height: "100%", padding: 12 }}>
    <ChatComposer messages={messages}
      imageDraft={{ images: [], files: [], attachFiles: noop, attachPath: noop, removeFile: noop, loading: false, error: "", onPaste: noop, clear: noop, remove: noop }}
      projectPath="/fixture/.worktrees/login" messageScope="/fixture" agentChatId="/fixture#1" draft={draft} onDraftChange={setDraft} onSend={noop} isSending={sending} sendBlocked={false} tasks={tasks} subagents={children} onArchiveFinishedSubagents={archiveFinished} onArchiveSubagent={archive} waitingForSubagents={true}
      models={MODEL_CATALOG} cliStatus={null} onModelPickerOpen={noop} selectedModel={model} onModelChange={noop}
      capability={capabilityFor(model, null)} onEffortChange={noop} ultracode={false} onUltracodeChange={noop}
      fastMode={fastMode} onFastModeChange={setFastMode} permissionMode="auto" onPermissionModeChange={noop}
      onRecommendationSelect={noop} worktrees={[]} onWorktreeChange={noop}
      isolation="local" onIsolationChange={noop} branches={[]} baseBranch="main" onBaseBranchChange={noop} newChatError={null} />
  </div>;
}
document.documentElement.classList.add("dark");
createRoot(document.getElementById("root")).render(<><Fixture /><PanelToggles right={12} /></>);
`;
async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", fs.mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-simulator-ui-")));
  await app.whenReady();
  console.log("Electron ready");
  setTimeout(() => {
    console.error("Electron UI check timed out");
    app.exit(1);
  }, 60000);
  const window = new BrowserWindow({
    width: 1000,
    height: 800,
    show: false,
    webPreferences: { backgroundThrottling: false },
  });
  window.webContents.on("console-message", (details) => {
    if (details.level === "error") console.error(details.message);
  });
  window.webContents.on("did-fail-load", (_e, code, message) => console.error("Page load failed", code, message));
  window.webContents.on("render-process-gone", (_e, details) => console.error("Renderer gone", details));
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  const { evaluatePanel, waitForPanel } = require("./panel-menu-test.cjs").panelMenuHelpers(evaluate);
  const waitFor = async (source) => {
    for (let i = 0; i < 200; i++) {
      if (await evaluate(source)) return;
      await delay(50);
    }
    throw Error("Timed out: " + source);
  };
  const click = (selector) =>
    (selector.includes("data-panel-toggle") ? evaluatePanel : evaluate)("document.querySelector(" + JSON.stringify(selector) + ").click()");
  const screenshot = async (name) => {
    if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
    fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
    await delay(150);
    fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, name + ".png"), (await window.webContents.capturePage()).toPNG());
  };
  try {
    console.log("Loading fixture");
    await window.loadURL(process.argv[2]);
    console.log("Fixture loaded");
    await waitFor('document.querySelector("[data-slot=simulator-track]")?.textContent.includes("2")');
    assert.equal(await evaluate("window.simulatorCalls.length"), 0, "closed pill must not start capture");
    assert.ok(await evaluate('!!document.querySelector("[data-slot=simulator-track] svg")'), "phone icon");
    assert.ok(
      await evaluate(
        'document.querySelector("[data-slot=simulator-track]").parentElement === document.querySelector("[data-slot=subagent-track]").parentElement',
      ),
      "same composer pill row",
    );
    await evaluate("window.setMessageCount(0)");
    await waitFor('!document.querySelector("[data-slot=simulator-track]")');
    await screenshot("new-chat");
    await evaluate("window.setMessageCount(2)");
    await waitFor('!!document.querySelector("[data-slot=simulator-track]")');
    await click("[data-slot=simulator-track] button");
    await evaluate('window.attachedIds=[]; document.dispatchEvent(new Event("visibilitychange"))');
    await waitFor('!document.querySelector("[data-slot=simulator-track]") && !document.querySelector("[data-slot=simulator-popover]")');
    assert.equal(await evaluatePanel('!!document.querySelector("[data-panel-toggle=simulator]")'), false, "no corner button without an attached simulator");
    await screenshot("no-attachments");
    await evaluate('window.attachedIds=[0,1]; document.dispatchEvent(new Event("visibilitychange"))');
    await waitFor('!!document.querySelector("[data-slot=simulator-track]")');
    assert.equal(await evaluate('!!document.querySelector("[data-slot=simulator-popover]")'), false, "reattaching must not reopen the viewer");
    // The corner button shows while a simulator is attached, and opens the same list as the pill.
    await waitForPanel('!!document.querySelector("[data-panel-toggle=simulator]")');
    await click("[data-panel-toggle=simulator]");
    await waitFor('document.querySelectorAll("[data-simulator-device]").length===2');
    await click("[data-panel-toggle=simulator]");
    await waitFor('!document.querySelector("[data-slot=simulator-popover]")');
    await screenshot("composer-dark");
    await click("[data-slot=simulator-track] button");
    await waitFor('document.querySelectorAll("[data-simulator-device]").length===2');
    assert.equal(await evaluate("window.simulatorCalls.length"), 0, "chooser must not capture every device");
    assert.ok(await evaluate('document.querySelector("[data-simulator-device=device-1]").textContent.includes("Android 16")'), "Android device label");
    await screenshot("chooser-dark");
    await click('[data-simulator-device="device-0"]');
    await waitFor("window.simulatorCalls.length===1");
    await waitFor('document.querySelector("[data-slot=simulator-frame]")');
    // A device's viewer docks beside the chat on its own; there is no undocked viewer.
    await waitFor('document.querySelector("[data-slot=simulator-popover]").dataset.docked==="true"');
    assert.equal(
      await evaluate('!!document.querySelector(\'[aria-label="Dock simulator to the right"], [aria-label="Undock simulator"]\')'),
      false,
      "no dock toggle",
    );
    // Once the viewer has slid in and the chat has made room for it.
    await waitFor(
      '(()=>{const pane=document.querySelector("[data-chat-pane]").getBoundingClientRect(),dock=document.querySelector("[data-slot=simulator-popover]").getBoundingClientRect();return pane.right<=dock.left&&dock.right<=innerWidth})()',
    );
    await click("[data-prompt-editor]");
    await delay(100);
    assert.ok(await evaluate('!!document.querySelector("[data-slot=simulator-popover]")'), "pressing the chat keeps the docked viewer");
    await screenshot("docked-dark");
    await waitFor('document.querySelector("[data-slot=simulator-connection]").dataset.state==="error"');
    assert.ok(
      await evaluate(`(()=>{const s=document.querySelector('[aria-label="iPhone 17, choose simulator"] span');return s.scrollWidth<=s.clientWidth})()`),
      "device name fits beside the connection status",
    );
    const footerMatches =
      '(()=>{const doc=document.querySelector("[data-slot=simulator-frame]").contentDocument;return doc && getComputedStyle(doc.body).backgroundColor===getComputedStyle(document.querySelector("[data-slot=simulator-popover] > div")).backgroundColor})()';
    await waitFor(footerMatches);
    // Failed connections retry automatically, so count opens only once the stream is live.
    await evaluate('void(window.simulatorThemeDocument=document.querySelector("[data-slot=simulator-frame]").contentDocument)');
    await evaluate("window.setDark(false)");
    await waitFor(footerMatches);
    assert.equal(
      await evaluate('document.querySelector("[data-slot=simulator-frame]").contentDocument===window.simulatorThemeDocument'),
      true,
      "theme changes must preserve the receiver document",
    );
    await screenshot("docked-light");
    // Real WebRTC video in the receiver, with deterministic pixels at the capture boundary.
    await evaluate("window.simulatorVideo=true");
    const receiver = 'document.querySelector("[data-slot=simulator-frame]").contentDocument';
    const streamPixel = async (x, y) => {
      const point = await evaluate(`(()=>{
        const frame=document.querySelector('[data-slot=simulator-frame]'),doc=frame.contentDocument;
        const media=doc.querySelector('#image').hidden?doc.querySelector('video'):doc.querySelector('#image');
        const f=frame.getBoundingClientRect(),b=media.getBoundingClientRect(),style=getComputedStyle(media),m=new DOMMatrix(style.transform);
        const vx=(${x}-.5)*parseFloat(style.width),vy=(${y}-.5)*parseFloat(style.height);
        return {x:Math.floor(f.left+b.left+b.width/2+m.a*vx+m.c*vy),y:Math.floor(f.top+b.top+b.height/2+m.b*vx+m.d*vy)};
      })()`);
      // Wake the hidden Linux window's compositor before sampling a newly decoded frame.
      // Keep the same two-capture sequence as test-appearance.cjs.
      window.webContents.invalidate();
      await window.webContents.capturePage();
      await delay(100);
      const pixels = (await window.webContents.capturePage({ ...point, width: 2, height: 2 })).resize({ width: 1, height: 1 }).toBitmap();
      return { r: pixels[2], g: pixels[1], b: pixels[0] };
    };
    const assertStreamCutout = async (kind) => {
      await evaluate(`window.simulatorCutout=${JSON.stringify(kind)}`);
      await delay(600);
      await screenshot(`stream-${kind}-probe`);
      const clear = await streamPixel(kind === "notch" ? 0.64 : 0.5, 0.025);
      assert.ok(
        clear.r > 140 && clear.b > 100 && clear.g < 140,
        `${kind}: shell must preserve source pixels where a guessed cutout would be (${JSON.stringify(clear)})`,
      );
      if (kind !== "clean") {
        const black = await streamPixel(kind === "notch" ? 0.25 : 0.42, kind === "notch" ? 0.025 : 0.0725);
        assert.ok(Math.max(black.r, black.g, black.b) < 45, `${kind}: transmitted cutout remains in its original position (${JSON.stringify(black)})`);
      }
      assert.equal(await evaluate(receiver + '.querySelectorAll("#hardware,#cutout").length'), 0);
    };
    await evaluate(`if(${receiver}.querySelector("#extras").hidden) ${receiver}.querySelector("#more").click()`);
    await evaluate(receiver + '.querySelector("#retry").click()');
    await waitFor('document.querySelector("[data-slot=simulator-connection]").dataset.state==="live"');
    await waitFor(receiver + '.querySelector("video").videoWidth>0');
    assert.equal(await evaluate(receiver + '.querySelector("#device").dataset.cutout'), "stream");
    assert.equal(await evaluate(receiver + '.querySelector("#back").hidden'), true);
    assert.equal(await evaluate(receiver + '.querySelector("#control").hidden'), true);
    await assertStreamCutout("island");
    await screenshot("stream-island-priority");
    await assertStreamCutout("clean");
    await evaluate("window.simulatorCutout=null");
    await evaluate(receiver + '.querySelector("#more").click()');
    for (const hint of [{ inputBlocked: true }, { deviceHubInputActive: true }]) {
      await evaluate(`window.simulatorInputHint=${JSON.stringify(hint)}`);
      await waitFor(receiver + '.querySelector("#blocked").hidden===false');
      assert.equal(
        await evaluate('document.querySelector("[data-slot=simulator-connection]").dataset.state'),
        "live",
        "an input-mode hint must not claim delivery is blocked",
      );
      assert.match(await evaluate(receiver + '.querySelector("#blocked-text").textContent'), /^If touches/);
      const beforeInput = await evaluate("window.simulatorInputs.length");
      await evaluate(receiver + '.querySelector("#home").click()');
      await waitFor(`window.simulatorInputs.length>${beforeInput}`);
    }
    await screenshot("input-reset-advisory");
    await evaluate("window.simulatorInputHint={}");
    await waitFor(receiver + '.querySelector("#blocked").hidden===true');
    await evaluate(receiver + '.querySelector("#more").click()');
    assert.equal(await evaluate(receiver + '.querySelector("#duo").hidden'), true, "ordinary phones have no hinge controls");
    await evaluate("window.simulatorHinge={supportsHingeAngle:true,hingePose:'closed',hingeAngle:0}");
    await waitFor(receiver + '.querySelector("#duo").hidden===false');
    for (const pose of ["open", "book", "laptop", "tent", "closed"]) {
      assert.equal(await evaluate(receiver + `.querySelector('#pose-${pose}').textContent`), "", "pose actions are icons");
      assert.equal(await evaluate(receiver + `.querySelector('#pose-${pose}').getAttribute('aria-label')`), pose[0].toUpperCase() + pose.slice(1));
      assert.equal(await evaluate(receiver + `.querySelector('#pose-${pose}').querySelectorAll('svg').length`), 1);
      await evaluate(receiver + `.querySelector("#pose-${pose}").click()`);
      await waitFor(receiver + `.querySelector('#pose-${pose}').getAttribute('aria-pressed')==='true' && !${receiver}.querySelector('#pose-${pose}').disabled`);
      assert.deepEqual(await evaluate("window.simulatorInputs.at(-1)"), { kind: "pose", pose });
    }
    assert.equal(await evaluate(receiver + '.querySelector("#pose-book").parentElement.getAttribute("aria-label")'), "Fold shape");
    assert.equal(await evaluate(receiver + '.querySelector("#pose-tent").parentElement.getAttribute("aria-label")'), "Device stand");
    await screenshot("duo-grouped-rail");
    await evaluate(receiver + '.querySelector("#more").click()');
    await evaluate(
      `(()=>{const doc=${receiver},input=doc.querySelector('#hinge-angle');input.focus();input.value='123';input.dispatchEvent(new Event('input',{bubbles:true}));doc.querySelector('#hinge-apply').focus();})()`,
    );
    await delay(1100);
    assert.equal(await evaluate(receiver + '.querySelector("#hinge-angle").value'), "123", "live status updates preserve a draft after blur");
    await evaluate(receiver + '.querySelector("#hinge-apply").click()');
    await waitFor(receiver + '.querySelector("#hinge-angle").value==="123" && !' + receiver + '.querySelector("#hinge-apply").disabled');
    assert.deepEqual(await evaluate("window.simulatorInputs.at(-1)"), { kind: "hinge", angle: 123 });
    await screenshot("duo-actions");
    await evaluate("window.simulatorControlling=false");
    await waitFor(receiver + '.querySelector("#pose-open").disabled===true');
    // Match a short phone WebView with More expanded and Take control visible.
    await evaluate(
      `(()=>{const iframe=document.querySelector('[data-slot=simulator-frame]');window.savedSimulatorStyle=iframe.style.cssText;iframe.style.cssText='position:fixed;left:0;top:0;width:390px;height:561px;z-index:99999';iframe.contentDocument.documentElement.dataset.touchControls='true';})()`,
    );
    await delay(100);
    const shortControls = await evaluate(
      `(()=>{const doc=${receiver};return [...doc.querySelectorAll('#rail button')].filter(b=>!b.hidden).map(b=>{const r=b.getBoundingClientRect();return {id:b.id,top:r.top,bottom:r.bottom,height:r.height};});})()`,
    );
    await screenshot("duo-short-phone-more");
    for (const button of shortControls) {
      assert.ok(button.top >= 0 && button.bottom <= 561, `${button.id} stays inside the short viewer`);
      assert.ok(button.height >= 44, `${button.id} retains its touch target: ${button.height}`);
    }
    await evaluate(
      `(()=>{const iframe=document.querySelector('[data-slot=simulator-frame]');iframe.style.cssText=window.savedSimulatorStyle;iframe.contentDocument.documentElement.dataset.touchControls='false';})()`,
    );
    await evaluate("window.simulatorControlling=true;window.simulatorHinge={}");
    await waitFor(receiver + '.querySelector("#duo").hidden===true');
    await screenshot("iphone-live-light");
    const beforeTheme = await evaluate("window.simulatorCalls.length");
    await evaluate("window.setDark(true)");
    await waitFor(footerMatches);
    assert.equal(await evaluate("window.simulatorCalls.length"), beforeTheme, "theme changes must preserve the live viewer session");
    await screenshot("iphone-live-dark");
    await evaluate("window.simulatorReady=false");
    await waitFor('document.querySelector("[data-slot=simulator-connection]").dataset.state==="connecting"');
    assert.equal(
      await evaluate(receiver + '.querySelector("#retry").disabled'),
      false,
      "Reconnect stays available when a live input channel stops being ready",
    );
    await evaluate("window.simulatorReady=true");
    await evaluate(receiver + '.querySelector("#retry").click()');
    await waitFor('document.querySelector("[data-slot=simulator-connection]").dataset.state==="live"');
    const openCount = await evaluate("window.simulatorCalls.length");
    await evaluate('window.deviceOverrides[0]={name:"QA iPhone",version:"27.1",deviceType:undefined};document.dispatchEvent(new Event("visibilitychange"))');
    await waitFor(`!!document.querySelector('[aria-label="QA iPhone, choose simulator"]')`);
    assert.equal(await evaluate("window.simulatorCalls.length"), openCount, "renaming and refreshed model metadata must not reload the viewer");
    assert.equal(await evaluate(receiver + '.querySelector("video").paused'), false);
    await evaluate('window.deviceOverrides={};document.dispatchEvent(new Event("visibilitychange"))');
    await waitFor(`!!document.querySelector('[aria-label="iPhone 17, choose simulator"]')`);
    await evaluate(receiver + '.querySelector("#home").click()');
    await waitFor('window.simulatorInputs.some(e=>e.kind==="button"&&e.button==="home")');
    await evaluate(receiver + '.querySelector("#rotate").click()');
    await waitFor(receiver + '.querySelector("#device").dataset.sideways==="true"');
    await waitFor('document.querySelector("[data-slot=simulator-connection]").dataset.state==="live"');
    await screenshot("iphone-landscape-dark");
    await assertStreamCutout("island");
    await screenshot("stream-island-landscape");
    await evaluate("window.simulatorCutout=null");
    await evaluate(receiver + '.querySelector("#rotate").click()');
    await waitFor(receiver + '.querySelector("#device").dataset.sideways==="false"');
    await evaluate("window.simulatorControlling=false");
    await waitFor('document.querySelector("[data-slot=simulator-connection]").dataset.state==="view-only"');
    assert.equal(await evaluate(receiver + '.querySelector("#home").disabled'), true);
    await screenshot("view-only-dark");
    await evaluate(receiver + '.querySelector("#control").click()');
    await waitFor('document.querySelector("[data-slot=simulator-connection]").dataset.state==="live"');
    await click('[aria-label="iPhone 17, choose simulator"]');
    await click('[data-simulator-device="device-1"]');
    await waitFor('document.querySelector("[data-slot=simulator-connection]").dataset.state==="live"');
    assert.equal(await evaluate(receiver + '.querySelector("#device").dataset.cutout'), "stream");
    assert.equal(await evaluate(receiver + '.querySelector("#back").hidden'), false);
    await screenshot("android-live-dark");
    await evaluate(receiver + '.querySelector("#back").click()');
    await waitFor('window.simulatorInputs.some(e=>e.kind==="button"&&e.button==="back")');
    await evaluate(receiver + '.querySelector("#rotate").click()');
    await waitFor(receiver + '.querySelector("#device").dataset.sideways==="true"');
    await waitFor(
      receiver + '.querySelector("video").videoWidth>document.querySelector("[data-slot=simulator-frame]").contentDocument.querySelector("video").videoHeight',
    );
    await waitFor('document.querySelector("[data-slot=simulator-connection]").dataset.state==="live"');
    assert.equal(await evaluate(receiver + '.querySelector("#device").dataset.cutout'), "stream");
    assert.equal(
      await evaluate(receiver + '.querySelector("video").style.transform'),
      "translate(-50%, -50%) rotate(0deg)",
      "Android buffers are already rotated",
    );
    await screenshot("android-landscape-dark");
    await evaluate(receiver + '.querySelector("#rotate").click()');
    await waitFor(receiver + '.querySelector("#device").dataset.sideways==="false"');
    await waitFor('document.querySelector("[data-slot=simulator-connection]").dataset.state==="live"');
    assert.equal(await evaluate(receiver + '.querySelector("#device").dataset.cutout'), "stream", "portrait keeps the streamed camera pixels");
    await evaluate('window.deviceCount=4;window.attachedIds.push(3);document.dispatchEvent(new Event("visibilitychange"))');
    await click('[aria-label="Pixel 9, choose simulator"]');
    await waitFor('!!document.querySelector("[data-simulator-device=device-3]")');
    await click('[data-simulator-device="device-3"]');
    await waitFor('document.querySelector("[data-slot=simulator-connection]").dataset.state==="live"');
    assert.equal(await evaluate(receiver + '.querySelector("#device").dataset.cutout'), "stream");
    await screenshot("iphone-notch-dark");
    await assertStreamCutout("notch");
    await evaluate("window.simulatorFrames=true");
    await evaluate(receiver + '.querySelector("#retry").click()');
    await waitFor('document.querySelector("[data-slot=simulator-connection]").dataset.state==="live"');
    await waitFor(receiver + '.querySelector("#image").naturalWidth>0');
    assert.equal(await evaluate(receiver + '.querySelector("video").hidden'), true, "relayed frames do not open a direct video path");
    await assertStreamCutout("notch");
    await assertStreamCutout("island");
    await assertStreamCutout("clean");
    await evaluate("window.simulatorCutout=null");
    const beforeRecovery = await evaluate("window.simulatorCalls.length");
    await evaluate("window.simulatorFrameBroken=true");
    await waitFor('document.querySelector("[data-slot=simulator-connection]").dataset.state==="error"');
    await evaluate("window.simulatorFrameBroken=false");
    await waitFor('document.querySelector("[data-slot=simulator-connection]").dataset.state==="live"');
    assert.equal(await evaluate("window.simulatorCalls.length"), beforeRecovery + 1, "a frame link interruption automatically opens fresh ownership");
    await screenshot("relayed-live-dark");
    await evaluate("window.simulatorFrames=false");
    await evaluate('window.deviceCount=3;window.attachedIds=[0,1];window.simulatorVideo=false;document.dispatchEvent(new Event("visibilitychange"))');
    await click('[aria-label="Close simulator"]');
    await click("[data-slot=simulator-track] button");
    await click('[data-simulator-device="device-0"]');
    await waitFor('!!document.querySelector("[data-slot=simulator-frame]")');
    await evaluate("window.setDark(true)");
    await waitFor(footerMatches);
    await click('[aria-label="Close simulator"]');
    await waitFor('!document.querySelector("[data-slot=simulator-popover]") && window.simulatorClosed.length>0');
    assert.equal(
      await evaluate('(document.querySelector("[data-dock-layer]") ?? document.body).style.getPropertyValue("--simulator-dock")'),
      "",
      "closing returns the space",
    );
    window.setContentSize(1000, 800);
    await evaluate("window.setDark(false)");
    await screenshot("composer-light");
    await click("[data-slot=simulator-track] button");
    await waitFor('!!document.querySelector("[data-slot=simulator-popover]")');
    assert.equal(await evaluate('!!document.querySelector("[data-simulator-device=device-2]")'), false, "other Chat device is excluded");
    await screenshot("chooser-light");
    await evaluate('Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="Attach simulator").click()');
    await waitFor('!!document.querySelector("[data-simulator-device=device-2]")');
    assert.equal(await evaluate('!!document.querySelector("[data-simulator-device=device-0]")'), false);
    await screenshot("attach-light");
    await click("[data-simulator-device=device-2]");
    await waitFor('document.querySelector("[data-slot=simulator-track]").textContent.includes("3")');
    assert.equal(await evaluate("window.simulatorCalls.at(-1).chatId"), "/fixture#1");
    // Once the device list has gone and the docked viewer has come in.
    await waitFor("!document.querySelector(\"[aria-label='Back to devices']\")");
    assert.equal(
      await evaluate('document.querySelector("[data-slot=simulator-popover] header").textContent.includes("This Chat")'),
      false,
      "the viewer has no subtitle",
    );
    await click('[aria-label="Other Chat device, choose simulator"]');
    await click('[aria-label="Detach Other Chat device from Chat"]');
    await waitFor('document.querySelector("[data-slot=simulator-track]").textContent.includes("2")');
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    await waitFor('!document.querySelector("[data-slot=simulator-popover]")');
    await evaluate('window.stoppedIds=[0,1]; document.dispatchEvent(new Event("visibilitychange"))');
    await click("[data-slot=simulator-track] button");
    await waitFor('document.querySelector("[data-slot=simulator-popover]")?.textContent.includes("Stopped")');
    assert.equal(
      await evaluate('document.querySelector("[data-slot=simulator-track] button").getAttribute("aria-label")'),
      "Simulators, 2 attached to this Chat",
    );
    await click('[aria-label="Detach iPhone 17 from Chat"]');
    await waitFor('document.querySelector("[data-slot=simulator-track]").textContent.includes("1")');
    await click('[aria-label="Detach Pixel 9 from Chat"]');
    await waitFor('!document.querySelector("[data-slot=simulator-track]") && !document.querySelector("[data-slot=simulator-popover]")');
    await screenshot("last-detached");
    console.log(
      "PASS: icon/count and composer placement, on-demand capture, chooser, the viewer docked beside the chat, close cleanup, Escape, light/dark screenshots",
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
        name: "simulator-fixture",
        resolveId(id) {
          if (id === "/__simulators_fixture.tsx") return id;
        },
        load(id) {
          if (id === "/__simulators_fixture.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (req, res, next) => {
            if (req.url !== "/__simulators__") return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await server.transformIndexHtml(
                req.url,
                '<html><body><div id="root"></div><script type="module" src="/__simulators_fixture.tsx"></script></body></html>',
              ),
            );
          });
        },
      },
    ],
  });
  try {
    await server.listen();
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require("electron"), [__filename, server.resolvedUrls.local[0] + "__simulators__"], { env, stdio: "inherit" });
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
