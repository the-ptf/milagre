const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");
const fixture =
  "\nimport React, { useState } from 'react';\nimport { createRoot } from 'react-dom/client';\nimport { FlowPage } from '/src/components/routines/FlowPage';\nimport '/src/styles.css';\nconst now = Date.now();\nconst agent = (id, name) => ({ id, name, kind:'agent', prompt:'Read {{trigger.issue.title}}', chat:'run', output:[], retries:0, onInvalid:'stop' });\nconst steps = [agent('classify','Classify'),{id:'if',name:'If issue',kind:'if',field:'trigger.issue.key',test:'is-set',yes:[{id:'ask',name:'Approve work',kind:'ask',message:'Please check the scope',expiresInHours:24}],otherwise:[]},agent('implement','Implement'),{id:'pr',name:'Open pull request',kind:'pull-request',title:'Fix issue',body:'',draft:true,askFirst:true},{id:'wait',name:'Wait for review',kind:'wait',until:{kind:'pr-review'},timeoutHours:24},{id:'comment',name:'Comment on Linear',kind:'linear-comment',body:'PR ready'}];\nlet current = {id:'flow1',name:'Issue to PR',prompt:'Flow',enabled:false,createdBy:{kind:'user'},runCount:1,createdAt:now,updatedAt:now,trigger:{kind:'linear',workspace:'test',event:'label-added',label:'agent'},target:{kind:'new-chat',projectPath:'/fixture',workspace:'worktree'},flow:{revision:1,steps,publishedAt:now},runs:[{id:'r1',routineId:'flow1',startedAt:now,status:'running',chatId:'/fixture#1',flow:{revision:1,steps,state:{classify:{status:'done',output:{}},if:{status:'done',taken:'yes'},ask:{status:'waiting',approval:{askedAt:now,expiresAt:now+86400000,message:'Please check the scope'}}},status:'waiting'}}]};\nlet setCurrent;\nwindow.saved = [];\nwindow.milagre = {\n computers:{list:async()=>({thisMac:'Fixture',computers:[]})},\n onComputersChanged:()=>()=>{},\n readRoutinesEnabled:async()=>({enabled:true}),\n listRoutines:async()=>({routines:[current]}),\n onRoutinesChanged:()=>()=>{},\n updateRoutine:async(id,patch)=>{\n  if(window.holdNextSave && patch.flowDraft && !patch.publishFlow){window.holdNextSave=false;await new Promise(resolve=>{window.releaseSave=resolve;});}\n  const next=structuredClone(current);\n  if('flowDraft' in patch){if(patch.flowDraft===null)delete next.flow.draft;else next.flow.draft={steps:patch.flowDraft,updatedAt:Date.now()};}\n  if(patch.publishFlow){next.flow={revision:next.flow.revision+1,steps:next.flow.draft.steps,publishedAt:Date.now()};}\n  next.updatedAt=Date.now();current=next;window.saved.push(patch);setCurrent(next);return next;\n },\n flowRunAct:async(id,runId,action,options)=>{\n  window.lastAction={id,runId,action,options};\n  const next=structuredClone(current);const run=next.runs[0];\n  if(action==='approve'){run.flow.state.ask={...run.flow.state.ask,status:'done',approval:{...run.flow.state.ask.approval,decision:'approved'}};run.flow.status='running';}\n  if(action==='reject'){run.flow.state.ask.approval.decision='rejected';run.status='ended';run.flow.status='ended';run.error='approval rejected';}\n  current=next;setCurrent(next);return {run};\n },\n routineTargets:async()=>({projects:[]}),\n routineLinearOptions:async()=>({workspaces:[],teams:[],labels:[],states:[]}),\n};\nconst models=[];\nfunction Host(){const [routine,setRoutine]=useState(current);const [narrow,setNarrow]=useState(false);setCurrent=setRoutine;window.setNarrow=setNarrow;window.current=()=>current;window.emptyFlow=()=>{current={...current,id:'empty',runs:[],flow:{revision:0,steps:[],draft:{steps:[],updatedAt:Date.now()},publishedAt:0}};setRoutine(current);};return <FlowPage key={routine.id} routine={routine} models={models} capabilities={null} unreadChats={new Set()} narrow={narrow} canOpen={()=>true} onBack={()=>{}} onOpenChat={key=>{window.opened=key}}/>;}\ncreateRoot(document.getElementById('root')).render(<Host/>);\n";
async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", fs.mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-routines-ui-")));
  await app.whenReady();
  if (process.platform === "darwin") app.dock?.hide();
  const win = new BrowserWindow({ width: 1280, height: 900, show: false, webPreferences: { backgroundThrottling: false } });
  const evaluate = (source) => win.webContents.executeJavaScript(source);
  const waitFor = async (source) => {
    for (let i = 0; i < 160; i++) {
      if (await evaluate(source)) return;
      await delay(50);
    }
    throw new Error("Timed out: " + source);
  };
  const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const type = (selector, value) =>
    evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      input.focus();
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
  const shot = async (name) => {
    const dir = process.env.MILAGRE_SCREENSHOT_DIR;
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
      await delay(250);
      fs.writeFileSync(path.join(dir, name + ".png"), (await win.webContents.capturePage()).toPNG());
    }
  };

  let failed = false;
  try {
    await win.loadURL(process.argv[2]);
    await waitFor(`!!document.querySelector('[data-flow-inspector="classify"]')`);
    await waitFor(`document.querySelectorAll('[data-flow-node][data-flow-kind]').length === 8`);
    for (const kind of ["trigger", "agent", "if", "ask", "pull-request", "wait", "linear-comment"])
      assert.equal(await evaluate(`!!document.querySelector('[data-flow-node][data-flow-kind="${kind}"]')`), true, kind);
    const box = (selector) =>
      evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width }; })()`);
    const yes = await box('[data-flow-node="ask"]');
    const otherwise = await box('[data-flow-empty-path="if:otherwise"]');
    assert.ok(yes.x + yes.w <= otherwise.x, "an If's paths sit side by side");
    assert.ok((await box('[data-flow-node="implement"]')).y > yes.y, "the step after an If sits below both paths");
    assert.equal(await evaluate(`!!document.querySelector('[data-flow-wire="trigger.issue.title"]')`), true, "the selected step's reads are wired");
    assert.equal(await evaluate(`document.querySelector('[data-flow-port="trigger.issue.title"]').dataset.lit`), "true");
    await shot("flow-editor");
    await click('[data-flow-add-here="top::1"]');
    await waitFor(`!!document.querySelector('[data-flow-add="wait"]')`);
    await click('[data-flow-add="wait"]');
    await waitFor(`window.current().flow.draft?.steps[1]?.kind === "wait"`);
    assert.equal(await evaluate(`!!document.querySelector('[data-flow-inspector]') && document.querySelector('[data-flow-step-name]').value`), "Wait");
    await click("[data-flow-toolbar-step] [data-flow-step-more]");
    await waitFor(`!!document.querySelector('[data-flow-action="delete"]')`);
    await click('[data-flow-action="delete"]');
    await waitFor(`!window.current().flow.draft && document.querySelectorAll('[data-flow-node][data-flow-kind="wait"]').length === 1`);
    await click('[data-flow-path-label="if:yes"]');
    await waitFor(`!!document.querySelector('[data-flow-collapsed="if:yes"]')`);
    assert.equal(await evaluate(`document.querySelector('[data-flow-collapsed="if:yes"]').textContent.trim()`), "1 step");
    assert.equal(await evaluate(`!!document.querySelector('[data-flow-node="ask"]')`), false, "a folded path hides its steps");
    await click('[data-flow-collapsed="if:yes"]');
    await waitFor(`!!document.querySelector('[data-flow-node="ask"]')`);
    await evaluate("window.holdNextSave=true");
    await click('[data-flow-node="classify"]');
    await type("[data-flow-step-name]", "Classify carefully");
    await waitFor("!!window.releaseSave");
    await click("[data-flow-publish]");
    await waitFor(`!!document.querySelector('[data-flow-publish-confirm]')`);
    await click("[data-flow-publish-confirm]");
    await delay(100);
    assert.equal(await evaluate("window.current().flow.revision"), 1);
    await evaluate("window.releaseSave()");
    await waitFor("window.current().flow.revision===2");
    assert.equal(await evaluate("window.current().flow.steps[0].name"), "Classify carefully");
    assert.equal(await evaluate("!!window.current().flow.draft"), false);
    assert.equal(await evaluate("window.current().runs[0].flow.revision"), 1);
    await click("[data-flow-show-waiting]");
    await waitFor(`!!document.querySelector('[data-flow-approval]')`);
    assert.equal(await evaluate(`document.querySelector('[data-flow-tab="runs"]').getAttribute('aria-selected')`), "true", "a Run opens in the Runs tab");
    assert.equal(await evaluate(`!!document.querySelector('[data-flow-step-name]')`), false, "Run view is locked");
    assert.match(await evaluate("document.body.textContent"), /revision 1/);
    assert.equal(await evaluate(`document.querySelector('[data-flow-node="ask"]').dataset.flowRunStatus`), "waiting");
    assert.equal(await evaluate(`document.querySelector('[data-flow-node="classify"]').dataset.flowRunStatus`), "done");
    assert.equal(await evaluate(`!!document.querySelector('[data-flow-line="trigger->classify"][data-on]')`), true, "the taken route is drawn");
    assert.equal(await evaluate(`!!document.querySelector('[data-flow-line="if->empty:if:otherwise"][data-on]')`), false, "the path not taken is not");
    await shot("flow-approval");
    await click("[data-flow-approve]");
    await waitFor(`window.lastAction?.action==='approve'`);
    assert.equal(await evaluate("window.current().runs[0].flow.state.ask.approval.decision"), "approved");
    await click("[data-flow-all-runs]");
    await waitFor(`!document.querySelector('[data-flow-canvas]')`);
    await evaluate("window.setNarrow(true)");
    win.setSize(760, 900);
    await delay(100);
    assert.equal(await evaluate("document.documentElement.scrollWidth <= window.innerWidth"), true, "narrow layout fits");
    await evaluate("window.emptyFlow()");
    await click('[data-flow-tab="steps"]');
    await waitFor(`!!document.querySelector('[data-flow-add-here="top::0"]')`);
    assert.equal(await evaluate(`document.querySelector('[data-flow-test]').hasAttribute('aria-disabled')`), true);
    await click('[data-flow-add-here="top::0"]');
    await waitFor(`document.querySelectorAll('[data-flow-add]').length === 6`);
    await shot("flow-empty");
    console.log(
      "PASS: canvas layout, wires, add and delete on the canvas, folding, serialized autosave and publish, immutable Run revision, Run route, approval, narrow layout and empty flow",
    );
  } catch (error) {
    failed = true;
    console.error(error);
  } finally {
    win.destroy();
    app.exit(failed ? 1 : 0);
  }
}
async function main() {
  const { createServer } = await import("vite");
  const { spawn } = require("node:child_process");
  const server = await createServer({
    configFile: path.resolve(__dirname, "../apps/desktop/vite.config.ts"),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "routine-flows-fixture",
        resolveId: (id) => (id === "/__routine_flows.tsx" ? id : null),
        load: (id) => (id === "/__routine_flows.tsx" ? fixture : null),
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (req, res, next) => {
            if (req.url !== "/__routine_flows__") return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await server.transformIndexHtml(
                req.url,
                '<html><body><div id="root"></div><script>localStorage.setItem("milagre-settings", JSON.stringify({ otherComputers: true }))</script><script type="module" src="/__routine_flows.tsx"></script></body></html>',
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
    const child = spawn(require("electron"), [__filename, server.resolvedUrls.local[0] + "__routine_flows__", "-ApplePersistenceIgnoreState", "YES"], {
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
  process.exitCode = 1;
});
