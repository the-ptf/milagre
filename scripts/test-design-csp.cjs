// Production CSP regression: the real minified renderer must run its trusted
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
    window.showInactive();
    await delay(100);
    const frame = window.webContents.mainFrame.frames.find((item) => item.url === "about:srcdoc");
    assert.ok(frame, "the preview is an opaque srcdoc iframe");
    assert.equal(await frame.executeJavaScript("!!document.getElementById('design-root')"), true, "the design preview renders under the built renderer CSP");
    assert.equal(await frame.executeJavaScript("typeof window.untrustedScriptRan"), "undefined", "unapproved inline scripts remain blocked");
    assert.equal(await frame.executeJavaScript("!!window.require || !!window.milagre"), false, "the frame has no host bridge");
    await window.webContents.executeJavaScript("window.designMessages=[];addEventListener('message',event=>window.designMessages.push(event.data))");
    window.webContents.debugger.attach("1.3");
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
    const { DESIGN_CODE_CSP } = require("@milagre/shared/artifact-document");
    const code = previews.register(
      window.webContents.id,
      '<!doctype html><html><head><script>window.blocked=[];addEventListener("securitypolicyviolation",e=>blocked.push(e.blockedURI))</script><script src="https://evil.example/x@1.0.0/a.js"></script></head><body><button id="go" onclick="this.textContent=eval(\'1+1\')">0</button><script>window.designScriptRan=true</script></body></html>',
      { code: true },
    );
    await window.webContents.executeJavaScript(
      `(() => { const frame=document.createElement('iframe');frame.sandbox='allow-scripts';frame.setAttribute('csp',${JSON.stringify(DESIGN_CODE_CSP)});frame.src=${JSON.stringify(code)};document.body.append(frame); })()`,
    );
    let codeFrame;
    for (let attempt = 0; attempt < 100; attempt++) {
      codeFrame = window.webContents.mainFrame.frames.find((item) => item.url === code);
      if (codeFrame && (await codeFrame.executeJavaScript("!!document.getElementById('go')"))) break;
      await delay(20);
    }
    assert.ok(codeFrame, "an interactive design loads under production frame-src");
    assert.equal(await codeFrame.executeJavaScript("window.designScriptRan"), true, "an interactive design's inline scripts run");
    await codeFrame.executeJavaScript("document.getElementById('go').click()");
    assert.equal(await codeFrame.executeJavaScript("document.getElementById('go').textContent"), "2", "evaluation runs, for Babel");
    assert.ok(
      (await codeFrame.executeJavaScript("window.blocked")).some((uri) => uri.includes("evil.example")),
      "scripts off the pinned CDNs are blocked",
    );
    assert.equal(await codeFrame.executeJavaScript("fetch('https://unpkg.com/').then(()=>false,()=>true)"), true, "the design's own requests are blocked");
    assert.equal(await codeFrame.executeJavaScript("!!window.require || !!window.milagre"), false, "interactive designs have no host bridge");
    previews.clear(window.webContents.id);
    window.webContents.debugger.detach();
    console.log("PASS: production CSP isolates interactive HTML artifacts and interactive designs, and keeps layer previews inert");
  } finally {
    window.destroy();
    app.quit();
  }
}

async function run() {
  const { spawn } = require("node:child_process");
  const { build } = require("esbuild");
  const { artifactDocument } = require("@milagre/shared/artifact-document");
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
    const preview = artifactDocument(designHtml(createExampleDesign())) + "<script>window.untrustedScriptRan=true</script>";
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
