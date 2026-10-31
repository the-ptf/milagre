// Real renderer and browser isolation checks. Screenshots from this fixture are test evidence, not PR images.
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");
const html = fs.readFileSync(path.join(__dirname, "fixtures/html-replies/report.html"), "utf8");
const page = { id: "inline-one", title: "Interactive chart", version: 1, format: "html", inline: true, height: 600 };
const fixture = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {ArtifactsProvider, ArtifactCards} from '/src/components/agents/ArtifactCard';
import '/src/styles.css';
const page=${JSON.stringify(page)};
const steps=[{id:'step-1',kind:'artifact',status:'done',tool:'html_render',artifact:page}];
let unavailable=true;
window.milagre={readDesignsEnabled:async()=>({enabled:false}),onDesignsEnabledChanged:()=>()=>{},artifacts:{list:async()=>[],comments:async()=>[],get:async()=>{if(unavailable){unavailable=false;throw Error('Offline')}return {...page,html:${JSON.stringify(html)}}}}};
window.external=[]; window.open=(url)=>window.external.push(url);
document.body.className='bg-page';
createRoot(document.getElementById('root')).render(<main style={{maxWidth:768,margin:'0 auto',padding:'24px 16px'}}><div className="min-w-0 max-w-full text-[length:var(--chat-size)] leading-[1.55] text-ink"><p className="mb-2">Here is the quarter, with the controls to explore it.</p><ArtifactsProvider chatId="/fixture#1" steps={steps} userMessages={[]}><ArtifactCards steps={steps}/></ArtifactsProvider><p>Written answer below the HTML.</p></div></main>);
`;
async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", fs.mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-html-ui-")));
  await app.whenReady();
  const window = new BrowserWindow({ width: 1000, height: 1000, show: false, webPreferences: { backgroundThrottling: false } });
  require("../apps/desktop/electron/links.cjs").guardNavigation(window.webContents, { appUrl: new URL(process.argv[2]).origin + "/", openExternal: () => {} });
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  const waitFor = async (source) => {
    for (let i = 0; i < 150; i++) {
      if (await evaluate(source)) return;
      await delay(100);
    }
    throw Error("Timed out: " + source);
  };
  try {
    await window.loadURL(process.argv[2]);
    await waitFor('document.querySelector("[data-slot=html-reply]")?.textContent.includes("Could not load")');
    await evaluate('Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="Retry").click()');
    await waitFor('document.querySelector("[data-slot=html-reply] iframe")');
    let guest;
    for (let i = 0; i < 100 && !guest; i++) {
      for (const frame of window.webContents.mainFrame.framesInSubtree)
        if (frame !== window.webContents.mainFrame && (await frame.executeJavaScript('!!document.querySelector("#count")').catch(() => false))) guest = frame;
      if (!guest) await delay(100);
    }
    assert.ok(guest, "the page renders inside the transcript");
    const waitForGuest = async (source) => {
      for (let i = 0; i < 100; i++) {
        if (await guest.executeJavaScript(source)) return;
        await delay(50);
      }
      const state = await guest.executeJavaScript(
        'JSON.stringify({width:innerWidth,client:document.documentElement.clientWidth,table:document.querySelector("table")?.getBoundingClientRect().toJSON()})',
      );
      throw Error("Timed out: " + source + " " + state);
    };
    assert.equal(await guest.executeJavaScript("window.checked"), true);
    const shot = async (name) => {
      await delay(250);
      if (process.env.MILAGRE_SCREENSHOT_DIR)
        fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, name), (await window.webContents.capturePage()).toPNG());
    };
    assert.equal(await guest.executeJavaScript("document.body.firstElementChild.getBoundingClientRect().top"), 0, "no extra space before the content");
    await guest.executeJavaScript('document.body.style.padding="24px";document.body.style.margin="16px"');
    assert.equal(await guest.executeJavaScript("document.body.firstElementChild.getBoundingClientRect().top"), 0, "a page's own outer padding is dropped");
    const host = await evaluate('getComputedStyle(document.querySelector("[data-slot=html-reply]")).fontSize');
    assert.equal(await guest.executeJavaScript("getComputedStyle(document.body).fontSize"), host, "chat text size");
    assert.equal(await guest.executeJavaScript("getComputedStyle(document.body).backgroundColor"), "rgba(0, 0, 0, 0)", "the transcript shows through");
    assert.equal(
      await guest.executeJavaScript(
        '(()=>{const d=document.createElement("i");d.style.color="var(--accent)";document.body.append(d);const c=getComputedStyle(d).color;d.remove();return getComputedStyle(document.querySelector("#count")).backgroundColor===c})()',
      ),
      true,
      "the primary button uses the accent",
    );
    assert.equal(await guest.executeJavaScript('document.querySelectorAll("#bars rect").length'), 3);
    assert.equal(
      await guest.executeJavaScript(
        '(()=>{const c=document.querySelector("#trend");return c.getContext("2d").getImageData(0,0,c.width,c.height).data.some((v,i)=>i%4===3&&v>0)})()',
      ),
      true,
      "canvas draws pixels",
    );
    await evaluate('document.querySelector("[data-slot=html-reply]").scrollIntoView()');
    await shot("light-wide.png");
    await guest.executeJavaScript('const select=document.querySelector("#period");select.value="2";select.dispatchEvent(new Event("change"))');
    assert.equal(await guest.executeJavaScript('document.querySelector("#revenue").textContent'), "80");
    await guest.executeJavaScript('const slider=document.querySelector("#target");slider.value="90";slider.dispatchEvent(new Event("input"))');
    assert.equal(await guest.executeJavaScript('document.querySelector("#target-value").textContent'), "90%");
    const before = await evaluate('document.querySelector("[data-slot=html-reply] iframe").clientHeight');
    await guest.executeJavaScript('document.querySelector("#notes").open=true');
    await waitFor(`document.querySelector("[data-slot=html-reply] iframe").clientHeight>${before}`);

    await guest.executeJavaScript('document.querySelector("#count").click()');
    assert.equal(await guest.executeJavaScript('document.querySelector("#count-value").textContent'), "1");
    assert.equal(await guest.executeJavaScript('(()=>{try{return parent.document.body.textContent}catch{return "isolated"}})()'), "isolated");
    assert.equal(await guest.executeJavaScript("typeof window.milagre"), "undefined");
    await evaluate('window.postMessage({channel:"milagre:html-render",type:"link",url:"https://evil.example"},"*")');
    await delay(100);
    assert.deepEqual(await evaluate("window.external"), [], "unrelated window messages cannot open links");
    await evaluate('document.documentElement.classList.add("dark");window.dispatchEvent(new Event("milagre-theme"))');
    await delay(150);
    assert.equal(await guest.executeJavaScript("getComputedStyle(document.documentElement).colorScheme"), "dark", "dark theme follows live");
    assert.equal(
      await guest.executeJavaScript("getComputedStyle(document.body).color"),
      await evaluate("getComputedStyle(document.body).color"),
      "ink follows live",
    );
    await shot("dark-wide.png");
    await evaluate(
      'document.documentElement.classList.remove("dark");document.documentElement.style.setProperty("--ink","#123456");window.dispatchEvent(new Event("milagre-theme"))',
    );
    await delay(100);
    assert.equal(await guest.executeJavaScript('getComputedStyle(document.documentElement).getPropertyValue("--ink")'), "#123456");
    await evaluate('document.documentElement.style.removeProperty("--ink");window.dispatchEvent(new Event("milagre-theme"))');
    assert.equal(
      await evaluate('!!document.querySelector("[data-slot=html-reply] header, [data-slot=html-reply] button")'),
      false,
      "the reply has no app title bar or actions",
    );
    await window.webContents.setVisualZoomLevelLimits(1, 1);
    window.setContentSize(390, 844);
    await delay(100);
    assert.equal(await evaluate("document.documentElement.scrollWidth<=window.innerWidth"), true, "reply fits a narrow chat");
    assert.equal(await guest.executeJavaScript("document.documentElement.scrollWidth<=innerWidth"), true, "the page reflows instead of scrolling sideways");
    await evaluate('document.querySelector("[data-slot=html-reply]").scrollIntoView()');
    await shot("light-narrow.png");
    await guest.executeJavaScript(
      `document.body.innerHTML='<table id="wide-table" style="width:100%"><tr><td style="min-width:500px">Wide values</td></tr></table>'`,
    );
    await delay(250);
    assert.equal(
      await guest.executeJavaScript('getComputedStyle(document.querySelector("table")).overflowX'),
      "auto",
      "dynamic wide tables get their own scroll container",
    );
    assert.equal(
      await guest.executeJavaScript('(()=>{const t=document.querySelector("table");t.scrollLeft=100;return t.scrollLeft>0})()'),
      true,
      "clipped values are reachable",
    );
    assert.equal(await guest.executeJavaScript("document.body.scrollWidth<=innerWidth"), true, "table scrolling stays inside the reply");
    window.setContentSize(1000, 1000);
    await waitFor("innerWidth===1000");
    await waitForGuest('innerWidth>500 && getComputedStyle(document.querySelector("table")).display==="table"');
    assert.equal(
      await guest.executeJavaScript('getComputedStyle(document.querySelector("table")).display'),
      "table",
      "wide layout returns to the original table display",
    );
    assert.equal(
      await guest.executeJavaScript('Math.abs(document.querySelector("table").getBoundingClientRect().width-innerWidth)<1'),
      true,
      "100% tables retain the full wide layout",
    );
    window.setContentSize(390, 844);
    await waitFor("innerWidth===390");
    await waitForGuest('innerWidth<500 && getComputedStyle(document.querySelector("table")).overflowX==="auto"');
    assert.equal(await guest.executeJavaScript('getComputedStyle(document.querySelector("table")).overflowX'), "auto", "containment reapplies after narrowing");
    await window.reload();
    await waitFor('document.querySelector("[data-slot=html-reply]")?.textContent.includes("Could not load")');
    await evaluate('Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="Retry").click()');
    await waitFor('!!document.querySelector("[data-slot=html-reply] iframe")');
    console.log(
      "PASS: HTML replies render through the real transcript components, run scripts in isolation, follow theme, render without chrome, fit narrow chats and reload.",
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
}
async function main() {
  const { previewHtml } = require("../packages/core/src/html-render.cjs");
  const overflowPage = '<div id="too-wide" style="width:500px;height:40px">Overflow diagnostic</div>';
  const narrow = await previewHtml({ html: overflowPage, width: 340 });
  assert.equal(narrow.overflowX, 160, "preview reports excess width even when body clips it");
  assert.equal(narrow.overflowSelector, "#too-wide");
  const wide = await previewHtml({ html: overflowPage, width: 720 });
  assert.equal(wide.overflowX, 0);
  assert.equal(wide.overflowSelector, null);
  const { createServer } = await import("vite");
  const { spawn } = require("node:child_process");
  const server = await createServer({
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
    plugins: [
      {
        name: "html-reply-fixture",
        resolveId: (id) => (id === "/__html_fixture.tsx" ? id : null),
        load: (id) => (id === "/__html_fixture.tsx" ? fixture : null),
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url !== "/__html__") return next();
            response.setHeader("content-type", "text/html");
            response.end(
              await server.transformIndexHtml(
                request.url,
                '<html><body><div id="root"></div><script type="module" src="/__html_fixture.tsx"></script></body></html>',
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
    const child = spawn(require("electron"), [__filename, server.resolvedUrls.local[0] + "__html__"], { env, stdio: "inherit" });
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
