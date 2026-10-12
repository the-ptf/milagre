// Floating inbox interaction check with the real renderer and isolated data.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { setTimeout: delay } = require("node:timers/promises");
const fixture = `
import React, {useState} from "react";
import {createRoot} from "react-dom/client";
import {FloatingBar,InboxPanel,InboxPreview} from "/src/components/FloatingInbox";
import {updateSettings,applyThemeNow} from "/src/lib/settings";
import "/src/styles.css";
updateSettings({theme:"dark"}); applyThemeNow();
const common = {projectPath:"/work/shop",project:"shop",provider:"codex",at:1};
const initial = [
 {...common,key:"/work/shop#1",title:"Choose notification style",status:"question",question:{requestId:"q1",questions:[{id:"style",header:"Style",question:"Which notification style?",options:[{label:"Floating",description:"Desktop toolbar"},{label:"Inline"},{label:"Quiet"}],multiSelect:false,allowOther:true,secret:false}]}},
 {...common,key:"/work/shop#2",title:"Approve demo action",status:"approval",permission:{requestId:"p1",kind:"command",tool:"Shell",title:"Run the checks?",command:"npm test",allowForChat:true}},
 {...common,key:"/work/shop#3",title:"Review finished work",status:"completed",preview:"The notifications now share one inbox."},
];
function Fixture(){
 const [items,setItems]=useState(initial);
 const [preview,setPreview]=useState(null);
 const [selected,setSelected]=useState({key:null,revision:0});
 const [inboxOpen,setInboxOpen]=useState(false);
 const remove=key=>setItems(rows=>rows.filter(row=>row.key!==key));
 window.resetInbox=()=>setItems(initial);
 window.crowdInbox=()=>setItems(Array.from({length:20},(_,i)=>({...initial[i%3],key:'/work/shop#'+(i+1)})));
 window.milagre={resizeFloatingBar:async()=>{},expandFloatingBar:async()=>{},selectInboxItem:async key=>{window.selected=key;setInboxOpen(true);setSelected(previous=>({key,revision:previous.revision+1}))},resizeFloatingInbox:async(height)=>{window.inboxHeight=height},toggleFloatingInbox:async()=>{window.toggled=true;setInboxOpen(on=>!on)},closeFloatingInbox:async()=>{window.inboxClosed=true;setInboxOpen(false)},openInboxSettings:async()=>{window.settings=true},openInboxChat:async key=>{window.opened=key},
 showInboxPreview:async(key,y)=>{window.preview={key,y};setPreview(items.find(item=>item.key===key))},
 answerQuestion:async(key,id,answers,summary)=>{window.answer={key,id,answers,summary}; if(window.fail)throw Error("Connection lost"); remove(key);return true},
 respondToPermission:async(key,id,decision)=>{window.permissionCalls=(window.permissionCalls||0)+1;window.permission={key,id,decision};if(window.holdPermission)await new Promise(resolve=>{window.releasePermission=resolve});remove(key);return true},
 patchChat:async(project,id,patch)=>{window.patch={project,id,patch};remove(project+"#"+id)}
 };
 return <div style={{display:"flex",height:"100vh",background:"#1b1a24"}}><div style={{width:54}}><FloatingBar inboxOpen={inboxOpen} agents={items.length>3?items:[...items,{...common,key:"/work/shop#4",title:"Working",status:"working"}]} /></div><div style={{width:410}}><InboxPanel selectedChat={selected.key} selectionRevision={selected.revision} items={items} working={1} refresh={()=>{window.refreshed=true}} /></div>{preview&&<div style={{position:"absolute",left:64,top:30,width:280}}><InboxPreview item={preview}/></div>}</div>
}
createRoot(document.getElementById("root")).render(<Fixture/>);
`;
async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-floating-inbox-ui-"));
  app.setPath("userData", profile);
  await app.whenReady();
  const window = new BrowserWindow({ width: 464, height: 820, show: false, webPreferences: { backgroundThrottling: false } });
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  // Sample rendered frames instead of assuming the compositor has painted after a fixed 45ms.
  const sample = (read, trigger) =>
    evaluate(`new Promise(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        ${trigger};
        const frames = [], start = performance.now();
        function next() {
          frames.push(${read});
          if (performance.now() - start < 360) requestAnimationFrame(next);
          else resolve(frames);
        }
        requestAnimationFrame(next);
      }));
    })`);
  const errors = [];
  window.webContents.on("console-message", (details) => {
    if (details.level === "error") errors.push(details.message);
  });
  const waitFor = async (source) => {
    for (let i = 0; i < 200; i++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw Error("Timed out: " + source);
  };
  const click = async (selector) => {
    await waitFor(`!!document.querySelector(${JSON.stringify(selector)})`);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await delay(280);
    await waitFor('document.querySelectorAll("[data-inbox-item]").length <= 1');
  };
  const jump = async (page, count, settle = true) => {
    await evaluate(jumpSource(page, count));
    if (settle) {
      await delay(280);
      await waitFor('document.querySelectorAll("[data-inbox-item]").length <= 1');
    }
  };
  const jumpSource = (page, count) =>
    `(()=>{const track=document.querySelector('[data-position-track]');const rect=track.getBoundingClientRect();const x=rect.left+rect.width*${count > 1 ? (page - 1) / (count - 1) : 0};track.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:x,pointerId:1}));track.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,clientX:x,pointerId:1}));})()`;
  const button = async (key, label) => {
    await evaluate(
      `[...document.querySelectorAll('[data-inbox-item="${key}"] button')].find(b=>(b.getAttribute("aria-label")||b.textContent.trim())===${JSON.stringify(label)}).click()`,
    );
    await delay(280);
    await waitFor('document.querySelectorAll("[data-inbox-item]").length <= 1');
  };
  const shot = async (name) => {
    if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
    fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
    await delay(200);
    fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, name + ".png"), (await window.webContents.capturePage()).toPNG());
  };
  try {
    await window.loadURL(process.argv[2]);
    // Linux does not reliably advance compositor animations in an unmapped native window.
    window.showInactive();
    await waitFor('document.querySelectorAll("[data-inbox-item]").length===1');
    for (const [key, answer] of [
      ["1", "Floating"],
      ["2", "Inline"],
      ["3", "Quiet"],
    ]) {
      await evaluate(`document.activeElement.blur();window.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true}))`);
      await waitFor("window.answer != null && !document.querySelector('[data-inbox-item=\"/work/shop#1\"]')");
      assert.deepEqual(await evaluate("window.answer.answers"), { style: [answer] }, `number ${key} sends its answer immediately`);
      await evaluate("window.resetInbox();window.answer=undefined");
      await waitFor(
        'document.querySelectorAll("[data-inbox-item]").length === 1 && document.querySelector("[data-inbox-item]").dataset.inboxItem === "/work/shop#1"',
      );
    }
    assert.equal(await evaluate("window.answer"), undefined);
    assert.equal(await evaluate('document.querySelector("[data-floating-bar]").dataset.expanded'), "false");
    assert.equal(await evaluate('getComputedStyle(document.querySelector("[data-floating-bar]")).backgroundColor'), "rgb(0, 0, 0)");
    assert.equal(await evaluate('document.querySelectorAll("[data-inbox-loading]").length'), 1);
    assert.equal(await evaluate('document.querySelector("[data-inbox-trigger]").closest(".floating-inbox-reveal").inert'), true);
    const reveal = await sample(
      `({width:document.querySelector('[data-floating-bar]').getBoundingClientRect().width,lead:document.querySelector('.floating-inbox-leading').getBoundingClientRect().height})`,
      `document.querySelector('[data-floating-bar]').dispatchEvent(new MouseEvent('mouseover',{bubbles:true}))`,
    );
    await waitFor('document.querySelector("[data-floating-bar]").dataset.expanded === "true"');
    if (await evaluate('window.matchMedia("(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)").matches')) {
      assert.ok(
        reveal.some(({ width }) => width > 28 && width < 46),
        `bar morphs through intermediate widths (${JSON.stringify(reveal)})`,
      );
      assert.ok(
        reveal.some(({ lead }) => lead > 0 && lead < 45),
        "controls reveal through intermediate sizes",
      );
    }
    assert.equal(await evaluate('document.querySelector("[data-floating-bar]").getBoundingClientRect().width'), 46);
    assert.equal(await evaluate('document.querySelector("[data-inbox-badge]").textContent'), "2");
    assert.equal(await evaluate('getComputedStyle(document.querySelector("[data-floating-drag]")).touchAction'), "none");
    await evaluate(`document.querySelector('[data-inbox-agent="/work/shop#1"]').dispatchEvent(new MouseEvent('mouseover',{bubbles:true}))`);
    await waitFor('!!document.querySelector("[data-inbox-preview]")');
    assert.equal(await evaluate('document.querySelector("[data-inbox-preview]").textContent.includes("Choose notification style")'), true);
    assert.equal(await evaluate('getComputedStyle(document.querySelector("[data-inbox-preview]")).borderTopWidth'), "0px");
    await shot("floating-inbox-hover");
    await evaluate(`document.querySelector('[data-inbox-agent="/work/shop#1"]').dispatchEvent(new MouseEvent('mouseout',{bubbles:true}))`);
    await waitFor('!document.querySelector("[data-inbox-preview]")');
    assert.equal(await evaluate('document.querySelector("[data-inbox-pagination]").textContent.includes("1 of 3")'), true);
    const navigation = await sample(
      `(()=>{const style=getComputedStyle(document.querySelector('[data-inbox-arrow="right"] span'));const matrix=new DOMMatrix(style.transform);const page=document.querySelector('[data-inbox-item="/work/shop#2"]');return {x:matrix.m41,scale:matrix.m11,opacity:Number(style.opacity),color:style.color,thumbX:new DOMMatrix(getComputedStyle(document.querySelector('[data-position-thumb]')).transform).m41,slideX:page?new DOMMatrix(getComputedStyle(page.parentElement).transform).m41:null}})()`,
      jumpSource(2, 3),
    );
    assert.equal(navigation[0].color, "rgb(255, 255, 255)", "navigation feedback uses a white arrow");
    if (!(await evaluate('window.matchMedia("(prefers-reduced-motion: reduce)").matches'))) {
      assert.ok(
        navigation.some((arrow) => arrow.x > 0 && arrow.scale > 1 && arrow.opacity > 0.45),
        "the right arrow brightens, grows and nudges right during navigation",
      );
    }
    assert.equal(await evaluate('getComputedStyle(document.querySelector("[data-inbox-scroller]")).scrollbarWidth'), "none");
    assert.equal(await evaluate('getComputedStyle(document.querySelector("[data-inbox-scroller]")).overflowX'), "hidden");
    assert.equal(await evaluate('getComputedStyle(document.querySelector("[data-position-thumb]")).outlineStyle'), "none");
    assert.equal(await evaluate('document.querySelector("[data-inbox-navigation-hint]").textContent.includes("to move")'), true);
    if (!(await evaluate('window.matchMedia("(prefers-reduced-motion: reduce)").matches')))
      assert.ok(
        navigation.some(({ thumbX }) => thumbX > 0 && thumbX < 39),
        "position pill moves through intermediate positions",
      );
    if (!(await evaluate('window.matchMedia("(prefers-reduced-motion: reduce)").matches'))) {
      assert.ok(
        navigation.some(({ slideX }) => slideX > 0 && slideX < 48),
        "the next page enters from the right",
      );
    }
    await delay(300);
    assert.equal(
      await evaluate("getComputedStyle(document.querySelector('[data-inbox-arrow=\"right\"] span')).transform"),
      "none",
      "the arrow settles back after its feedback",
    );
    assert.equal(await evaluate('document.querySelector("[data-inbox-item]").dataset.inboxItem'), "/work/shop#2");
    assert.equal(
      await evaluate(`!!document.querySelector('[data-inbox-item] [role="dialog"]')`),
      false,
      "approval is part of the inbox rather than a nested card",
    );
    assert.equal(
      await evaluate('document.querySelector("[data-inbox-item]").textContent.includes("npm test")'),
      true,
      "the full action is visible before approval",
    );
    await click('[data-inbox-agent="/work/shop#3"]');
    assert.equal(await evaluate("window.selected"), "/work/shop#3");
    assert.equal(await evaluate('document.querySelector("[data-inbox-item]").dataset.inboxItem'), "/work/shop#3");
    await waitFor('document.querySelectorAll("[data-inbox-item]").length === 1');
    await evaluate("window.opened=undefined;document.querySelector('[data-position-thumb]').focus()");
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
    window.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
    await waitFor('window.opened === "/work/shop#3"');
    assert.equal(await evaluate('document.querySelector("[data-inbox-shortcuts]").textContent.includes("Enter to open Chat")'), true);
    await click('[aria-label="Previous message"]');
    assert.equal(await evaluate('document.querySelector("[data-inbox-item]").dataset.inboxItem'), "/work/shop#2");
    await evaluate('document.activeElement.blur(); window.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowLeft",bubbles:true}))');
    await waitFor('document.querySelectorAll("[data-inbox-item]").length === 1');
    assert.equal(await evaluate('document.querySelector("[data-inbox-item]").dataset.inboxItem'), "/work/shop#1");
    await click('[data-inbox-agent="/work/shop#2"]');
    await click('[aria-label="Previous message"]');
    await click('[data-inbox-agent="/work/shop#2"]');
    assert.equal(await evaluate('document.querySelector("[data-inbox-item]").dataset.inboxItem'), "/work/shop#2");
    await jump(1, 3);
    assert.equal(await evaluate('!!document.querySelector("[data-inbox-filter]")'), false);
    assert.equal(await evaluate('!!document.querySelector("[data-inbox-panel] h1")'), false);
    await shot("floating-inbox-desktop");
    await evaluate(`document.querySelector("[data-floating-bar]").dispatchEvent(new MouseEvent("mouseover",{bubbles:true}))`);
    await waitFor('!!document.querySelector("[data-inbox-trigger]")');
    await click("[data-inbox-trigger]");
    assert.equal(await evaluate("window.toggled"), true);
    await jump(3, 3);
    assert.equal(await evaluate('document.querySelectorAll("[data-inbox-item]").length'), 1);
    await button("/work/shop#3", "Open Chat");
    assert.equal(await evaluate("window.opened"), "/work/shop#3");
    await button("/work/shop#3", "Clear");
    assert.deepEqual(await evaluate("window.patch"), { project: "/work/shop", id: 3, patch: { unread: false } });
    await waitFor('document.querySelector("[data-inbox-item]").dataset.inboxItem === "/work/shop#1"');
    await button("/work/shop#1", "Floating");
    assert.equal(await evaluate("window.answer"), undefined, "selection requires confirmation");
    await evaluate('document.querySelector("[data-inbox-item] input").focus()');
    await button("/work/shop#1", "Floating");
    assert.equal(await evaluate('document.activeElement.getAttribute("role")'), "radio", "choosing an option moves focus out of the reply field");
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Right" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Right" });
    await waitFor(
      'document.querySelectorAll("[data-inbox-item]").length === 1 && document.querySelector("[data-inbox-item]").dataset.inboxItem === "/work/shop#2"',
    );
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Left" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Left" });
    await waitFor(
      'document.querySelectorAll("[data-inbox-item]").length === 1 && document.querySelector("[data-inbox-item]").dataset.inboxItem === "/work/shop#1"',
    );
    await button("/work/shop#1", "Floating");
    await jump(2, 2);
    await jump(1, 2);
    assert.equal(
      await evaluate('document.querySelector("[role=radio][aria-checked=true]").getAttribute("aria-label")'),
      "Floating",
      "paging keeps unsent answers",
    );
    assert.ok(await evaluate("window.inboxHeight < 700"), "one card determines the panel height");
    await evaluate("window.fail=true");
    await click('[aria-label="Send answer"]');
    assert.equal(await evaluate('document.querySelector("[role=alert]").textContent'), "Connection lost");
    assert.equal(await evaluate('document.querySelector("[role=radio][aria-checked=true]").getAttribute("aria-label")'), "Floating");
    await shot("floating-inbox-error");
    await evaluate("window.fail=false");
    await click('[aria-label="Send answer"]');
    assert.deepEqual(await evaluate("window.answer.answers"), { style: ["Floating"] });
    await waitFor(`!document.querySelector('[data-inbox-item="/work/shop#1"]')`);
    await button("/work/shop#2", "Allow once");
    assert.equal(await evaluate("window.permission.decision"), "allow");
    await waitFor('!!document.querySelector("[data-inbox-empty]")');
    await evaluate("window.resetInbox()");
    await waitFor('!!document.querySelector("[data-inbox-item] input")');
    await evaluate('document.querySelector("[data-inbox-item] input").focus()');
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "2" });
    window.webContents.sendInputEvent({ type: "char", keyCode: "2" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "2" });
    await waitFor('document.querySelector("[data-inbox-item] input").value === "2"');
    assert.equal(await evaluate('document.querySelectorAll("[role=radio][aria-checked=true]").length'), 0, "typing numbers in a reply does not pick an option");
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Right" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Right" });
    await delay(100);
    assert.equal(
      await evaluate('document.querySelector("[data-inbox-item]").dataset.inboxItem'),
      "/work/shop#1",
      "arrow keys keep editing the reply while input is focused",
    );
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
    window.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
    await waitFor(`!document.querySelector('[data-inbox-item="/work/shop#1"]')`);
    assert.deepEqual(await evaluate("window.answer.answers"), { style: ["2"] }, "Enter sends the typed reply");
    await evaluate("window.resetInbox()");
    await waitFor('!!document.querySelector("[data-inbox-item] input")');
    await button("/work/shop#1", "Inline");
    await evaluate(`[...document.querySelectorAll('[data-inbox-question] button')].find(b=>b.textContent==='Dismiss').focus()`);
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
    window.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
    await waitFor(`!document.querySelector('[data-inbox-item="/work/shop#1"]')`);
    assert.equal(await evaluate("window.answer.answers"), null, "Enter on Dismiss must dismiss rather than send a selected answer");
    await evaluate("window.resetInbox(); window.permissionCalls=0; window.permission=null");
    await click('[data-inbox-agent="/work/shop#2"]');
    assert.equal(await evaluate('document.querySelector("[data-inbox-shortcuts]").textContent.includes("Enter to allow once")'), true);
    await evaluate(`document.activeElement.blur();
      for(const extra of [{repeat:true},{isComposing:true},{shiftKey:true},{altKey:true},{ctrlKey:true},{metaKey:true}])
        window.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,...extra}));`);
    assert.equal(await evaluate("window.permissionCalls"), 0, "modified, repeated or composing Enter must not approve");
    await evaluate(`[...document.querySelectorAll('[data-inbox-item] button')].find(b=>b.textContent==='Deny').focus()`);
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
    window.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
    await waitFor('window.permission?.decision === "deny"');
    assert.equal(await evaluate("window.permissionCalls"), 1, "Enter on focused Deny keeps its own action");
    await evaluate("window.resetInbox(); window.permissionCalls=0; window.holdPermission=true");
    await click('[data-inbox-agent="/work/shop#2"]');
    await evaluate("document.activeElement.blur()");
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
    window.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
    await waitFor('window.permission?.decision === "allow" && window.permissionCalls === 1');
    await evaluate(
      `window.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));window.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,repeat:true}))`,
    );
    assert.equal(await evaluate("window.permissionCalls"), 1, "pending approval cannot submit twice");
    await evaluate("window.holdPermission=false;window.releasePermission()");
    await waitFor(`!document.querySelector('[data-inbox-item="/work/shop#2"]')`);
    await evaluate(`document.activeElement.blur(); window.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
    assert.equal(await evaluate("window.permissionCalls"), 1, "Enter cannot approve an offscreen Chat");
    await click('[data-inbox-agent="/work/shop#1"]');
    await evaluate(`document.querySelector('[data-floating-bar]').dispatchEvent(new MouseEvent('mouseout',{bubbles:true}))`);
    await delay(450);
    assert.equal(await evaluate('document.querySelector("[data-floating-bar]").dataset.expanded'), "true", "bar stays expanded while the inbox is open");
    const beforeDismiss = await evaluate("window.answer");
    await evaluate('window.inboxClosed=false; document.querySelector("[data-inbox-item] input").focus()');
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await waitFor("window.inboxClosed === true");
    await delay(220);
    assert.equal(await evaluate('document.querySelector("[data-floating-bar]").dataset.expanded'), "false");
    assert.deepEqual(await evaluate("window.answer"), beforeDismiss, "Escape closes without answering");
    await click('[data-inbox-agent="/work/shop#1"]');
    await evaluate('window.inboxClosed=false; document.querySelector("[data-inbox-item] input").focus()');
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "D", modifiers: [process.platform === "darwin" ? "meta" : "control"] });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "D", modifiers: [process.platform === "darwin" ? "meta" : "control"] });
    await waitFor("window.inboxClosed === true");
    assert.deepEqual(await evaluate("window.answer"), beforeDismiss, "Cmd/Ctrl+D closes without answering");
    const gap = await evaluate(
      `document.querySelector('[data-inbox-item] > button').getBoundingClientRect().top - document.querySelector('[data-inbox-panel] header').getBoundingClientRect().bottom`,
    );
    assert.ok(gap <= 6, `compact header leaves no empty strip above the Chat (got ${gap}px)`);
    await click('[aria-label="Floating inbox settings"]');
    assert.equal(await evaluate("window.settings"), true);
    await evaluate("window.crowdInbox();window.toggled=false");
    await waitFor('document.querySelectorAll("[data-inbox-agent]").length === 5');
    assert.equal(await evaluate("document.querySelector('[aria-label=\"15 more Chats. Open inbox\"]').textContent.trim()"), "+15");
    await click('[aria-label="15 more Chats. Open inbox"]');
    assert.equal(await evaluate("window.toggled"), true, "overflow opens the inbox containing all Chats");
    assert.equal(await evaluate('getComputedStyle(document.querySelector("[data-position-thumb]")).backgroundColor'), "rgb(255, 255, 255)");
    for (let index = 0; index < 20; index++) await click('[aria-label="Next message"]');
    assert.equal(await evaluate('document.querySelector("[data-inbox-count]").textContent.trim()'), "20 of 20");
    assert.equal(await evaluate('document.querySelectorAll("[data-position-track]").length'), 1);
    assert.equal(await evaluate('document.querySelector("[data-position-track]").getBoundingClientRect().width'), 100);
    assert.equal(await evaluate('new DOMMatrix(getComputedStyle(document.querySelector("[data-position-thumb]")).transform).m41'), 78);
    await jump(10, 20);
    assert.equal(await evaluate('document.querySelector("[data-inbox-count]").textContent.trim()'), "10 of 20");
    assert.equal(await evaluate('document.querySelector("[data-position-thumb]").getAttribute("aria-valuetext")'), "Chat 10 of 20");
    assert.ok(await evaluate('document.querySelector("[data-inbox-count]").getBoundingClientRect().width > 0'), "page count is visible");
    await evaluate('document.querySelector("[data-position-thumb]").focus()');
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Right" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Right" });
    await waitFor('document.querySelector("[data-inbox-count]").textContent.trim() === "11 of 20"');
    await evaluate('document.querySelector("[data-position-thumb]").dispatchEvent(new KeyboardEvent("keydown",{key:"Home",bubbles:true}))');
    await waitFor('document.querySelector("[data-inbox-count]").textContent.trim() === "1 of 20"');
    await evaluate('document.querySelector("[data-position-thumb]").dispatchEvent(new KeyboardEvent("keydown",{key:"End",bubbles:true}))');
    await waitFor('document.querySelector("[data-inbox-count]").textContent.trim() === "20 of 20"');
    await shot("floating-inbox-20-chats");
    assert.deepEqual(errors, []);
    console.log(
      "PASS: edge-connected bar, one Chat per page, draft retention, explicit question confirmation, retry keeps drafts, approval, clear and Chat navigation",
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.error(errors);
    app.exit(1);
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
async function main() {
  const { createServer } = await import("vite");
  const server = await createServer({
    configFile: path.resolve(__dirname, "../apps/desktop/vite.config.ts"),
    cacheDir: path.resolve(__dirname, "../node_modules/.vite-floating-inbox"),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "floating-inbox-fixture",
        resolveId(id) {
          if (id === "/__floating-inbox.tsx") return id;
        },
        load(id) {
          if (id === "/__floating-inbox.tsx") return fixture;
        },
        configureServer(server) {
          server.middlewares.use(async (request, response, next) => {
            if (request.url !== "/__floating-inbox") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await server.transformIndexHtml(
                request.url,
                '<html><body><div id="root"></div><script type="module" src="/__floating-inbox.tsx"></script></body></html>',
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
    const child = require("node:child_process").spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__floating-inbox`], {
      env,
      stdio: "inherit",
    });
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
  if (process.versions.electron) require("electron").app.exit(1);
  else process.exitCode = 1;
});
