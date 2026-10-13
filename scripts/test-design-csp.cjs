// Production CSP regression: the real minified renderer must run its trusted
// controller inside an opaque srcdoc iframe without allowing arbitrary scripts.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const attribute = (value) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function check() {
  const { app, BrowserWindow, protocol } = require("electron");
  protocol.registerSchemesAsPrivileged([{ scheme: "milagre-artifact", privileges: { standard: true, secure: true } }]);
  app.setPath("userData", path.join(process.argv[2], "profile"));
  await app.whenReady();
  const previews = require("../apps/desktop/electron/artifact-preview.cjs").createArtifactPreviews();
  protocol.handle("milagre-artifact", (request) => previews.handle(request));
  const window = new BrowserWindow({
    width: 600,
    height: 900,
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false },
  });
  try {
    await window.loadFile(path.join(process.argv[2], "index.html"));
    // Opaque frame pointer routing needs a composited surface, even in this isolated check.
    window.showInactive();
    await delay(100);
    const frame = window.webContents.mainFrame.frames.find((item) => item.url === "about:srcdoc");
    assert.ok(frame, "the preview is an opaque srcdoc iframe");
    assert.equal(await frame.executeJavaScript("!!document.getElementById('design-guides')"), true, "the controller runs under the built renderer CSP");
    assert.equal(await frame.executeJavaScript("typeof window.untrustedScriptRan"), "undefined", "unapproved inline scripts remain blocked");
    assert.equal(await frame.executeJavaScript("!!window.require || !!window.milagre"), false, "the frame has no host bridge");
    await window.webContents.executeJavaScript("window.designMessages=[];addEventListener('message',event=>window.designMessages.push(event.data))");
    window.webContents.debugger.attach("1.3");
    await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x: 60, y: 125, button: "left", clickCount: 1 });
    await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: 60, y: 125, button: "left", clickCount: 1 });
    for (let tries = 0; tries < 50; tries++) {
      if (await window.webContents.executeJavaScript("window.designMessages.some(message=>message.type==='milagre:design-select'&&message.id==='heading')"))
        break;
      await delay(20);
    }
    assert.equal(
      await window.webContents.executeJavaScript("window.designMessages.some(message=>message.type==='milagre:design-select'&&message.id==='heading')"),
      true,
      "a real pointer click selects the text layer",
    );
    assert.notEqual(await frame.executeJavaScript("document.getElementById('design-selection').style.display"), "none");
    await frame.executeJavaScript("dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    for (let tries = 0; tries < 50; tries++) {
      if (await window.webContents.executeJavaScript("window.designMessages.includes('milagre:artifact-escape')")) break;
      await delay(20);
    }
    assert.equal(
      await window.webContents.executeJavaScript("window.designMessages.includes('milagre:artifact-escape')"),
      true,
      "Escape reaches the parent under CSP",
    );
    const url = previews.register(
      window.webContents.id,
      '<button id="counter" onclick="this.textContent=Number(this.textContent)+1">0</button><script>window.artifactScriptRan=true</script>',
    );
    await window.webContents.executeJavaScript(
      `(() => { const frame=document.createElement('iframe');frame.sandbox='allow-scripts';frame.src=${JSON.stringify(url)};document.body.append(frame); })()`,
    );
    let htmlFrame;
    for (let attempt = 0; attempt < 100; attempt++) {
      htmlFrame = window.webContents.mainFrame.frames.find((item) => item.url === url);
      if (htmlFrame && (await htmlFrame.executeJavaScript("!!document.getElementById('counter')"))) break;
      await delay(20);
    }
    assert.ok(htmlFrame, "the HTML artifact loads under production frame-src");
    assert.equal(await htmlFrame.executeJavaScript("window.artifactScriptRan"), true, "artifact inline scripts run under their isolated response CSP");
    await htmlFrame.executeJavaScript("document.getElementById('counter').click()");
    assert.equal(await htmlFrame.executeJavaScript("document.getElementById('counter').textContent"), "1", "artifact buttons work");
    assert.equal(await htmlFrame.executeJavaScript("!!window.require || !!window.milagre"), false, "HTML artifacts have no host bridge");
    assert.equal(
      await htmlFrame.executeJavaScript("(()=>{try{return !!parent.document.body}catch{return false}})()"),
      false,
      "HTML artifact cannot read the parent app",
    );
    assert.equal(await htmlFrame.executeJavaScript("fetch('https://example.com').then(()=>false,()=>true)"), true, "artifact script requests remain blocked");
    previews.clear(window.webContents.id);
    window.webContents.debugger.detach();
    console.log("PASS: production CSP isolates interactive HTML artifacts and permits trusted design controllers");
  } finally {
    window.destroy();
    app.quit();
  }
}

async function run() {
  const { spawn } = require("node:child_process");
  const { build } = require("esbuild");
  const { artifactDocument } = require("@milagre/shared/artifact");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-design-csp-"));
  try {
    const built = await fs.readFile(path.join(__dirname, "../apps/desktop/dist/index.html"), "utf8");
    const policy = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"[^>]*>/i.exec(built)?.[1];
    assert.ok(policy, "build the desktop renderer before this check");
    assert.ok(!/script-src[^;]*'unsafe-inline'/.test(policy), "the parent keeps its strict inline-script policy");
    const bundled = await build({
      entryPoints: [path.join(__dirname, "../packages/shared/src/design.mjs")],
      bundle: true,
      minify: true,
      format: "esm",
      platform: "browser",
      write: false,
    });
    const { designHtml, createExampleDesign } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
    const preview = artifactDocument(designHtml(createExampleDesign(), { interactive: true })) + "<script>window.untrustedScriptRan=true</script>";
    await fs.writeFile(
      path.join(temp, "index.html"),
      `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}"><style>html,body{margin:0}iframe{display:block;width:390px;height:844px;border:0}</style><iframe sandbox="allow-scripts" srcdoc="${attribute(preview)}"></iframe>`,
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require("electron"), [__filename, temp], { env, stdio: "inherit" });
    process.exitCode = await new Promise((resolve) => child.once("exit", (code) => resolve(code ?? 1)));
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

if (process.versions.electron || require.main === module)
  (process.versions.electron ? check() : run()).catch((error) => {
    console.error(error);
    process.exit(1);
  });
