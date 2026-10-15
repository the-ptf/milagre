// Real Chromium check for generated public pages. The server and Electron profile are disposable;
// no publication reaches the public sharing service. MILAGRE_SCREENSHOT_DIR retains screenshots.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { deflateSync } = require("node:zlib");
const { renderDesignPage } = require("@milagre/shared/design-page");

function raster() {
  const chunk = (name, value) => {
    const content = Buffer.concat([Buffer.from(name), value]);
    let crc = 0xffffffff;
    for (const byte of content) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const head = Buffer.alloc(4),
      tail = Buffer.alloc(4);
    head.writeUInt32BE(value.length);
    tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([head, content, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return (
    "data:image/png;base64," +
    Buffer.concat([
      Buffer.from("89504e470d0a1a0a", "hex"),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(Buffer.from([0, 82, 94, 234, 255]))),
      chunk("IEND", Buffer.alloc(0)),
    ]).toString("base64")
  );
}
const samplePage = () => ({
  schemaVersion: 1,
  title: "Studio notes",
  designs: [
    {
      title: "Desktop workspace",
      document: {
        schemaVersion: 1,
        width: 1024,
        height: 768,
        background: "#f5f3ee",
        nodes: [
          { id: "eyebrow", type: "text", x: 48, y: 44, width: 400, height: 24, text: "FIELDNOTES / WORKSPACE", fontSize: 13, fontWeight: 700, fill: "#61756d" },
          {
            id: "heading",
            type: "text",
            x: 48,
            y: 100,
            width: 800,
            height: 90,
            text: "Make room for good work.",
            fontSize: 48,
            fontWeight: 700,
            fill: "#243a32",
          },
          {
            id: "subtitle",
            type: "text",
            x: 48,
            y: 200,
            width: 840,
            height: 60,
            text: "A quiet place for plans, conversations and the next idea.",
            fontSize: 20,
            fill: "#61756d",
          },
          { id: "card", type: "rectangle", x: 48, y: 310, width: 580, height: 340, fill: "#ffffff", radius: 20 },
          { id: "card-title", type: "text", x: 76, y: 340, width: 500, height: 40, text: "This week", fontSize: 24, fontWeight: 600, fill: "#243a32" },
          {
            id: "list",
            type: "text",
            x: 76,
            y: 410,
            width: 490,
            height: 160,
            text: "Finish the first draft\nCollect a little inspiration\nLeave space to think",
            fontSize: 20,
            lineHeight: 2,
            fill: "#61756d",
          },
          { id: "raster", type: "image", x: 660, y: 310, width: 316, height: 340, src: raster(), radius: 20 },
          {
            id: "raster-label",
            type: "text",
            x: 690,
            y: 350,
            width: 254,
            height: 160,
            text: "A small idea.\nA fresh start.",
            fontSize: 34,
            fontWeight: 700,
            lineHeight: 1.4,
            fill: "#ffffff",
          },
        ],
      },
    },
    {
      title: "Phone workspace",
      document: {
        schemaVersion: 1,
        width: 390,
        height: 844,
        background: "#243a32",
        nodes: [
          { id: "eyebrow", type: "text", x: 28, y: 50, width: 320, height: 24, text: "FIELDNOTES", fontSize: 13, fontWeight: 700, fill: "#bed0c4" },
          {
            id: "heading",
            type: "text",
            x: 28,
            y: 108,
            width: 334,
            height: 115,
            text: "Good things\ntake shape.",
            fontSize: 42,
            fontWeight: 700,
            fill: "#f5f3ee",
          },
          {
            id: "subtitle",
            type: "text",
            x: 28,
            y: 245,
            width: 330,
            height: 75,
            text: "Your ideas, gathered in one place.",
            fontSize: 18,
            lineHeight: 1.4,
            fill: "#bed0c4",
          },
          { id: "card", type: "rectangle", x: 28, y: 364, width: 334, height: 240, fill: "#f5f3ee", radius: 20 },
          {
            id: "card-label",
            type: "text",
            x: 52,
            y: 392,
            width: 280,
            height: 100,
            text: "Today\nOne thoughtful step.",
            fontSize: 24,
            fontWeight: 600,
            lineHeight: 1.6,
            fill: "#243a32",
          },
          { id: "button", type: "rectangle", x: 52, y: 518, width: 286, height: 54, fill: "#5260df", radius: 12 },
          {
            id: "button-label",
            type: "text",
            x: 66,
            y: 534,
            width: 258,
            height: 24,
            text: "Open notebook",
            textAlign: "center",
            fontSize: 16,
            fontWeight: 600,
            fill: "#ffffff",
          },
        ],
      },
    },
  ],
});

function artifactPage(origin) {
  const blocked = `${origin}/blocked`;
  return {
    schemaVersion: 1,
    kind: "artifacts",
    title: "An explanation </h1><script>window.outerInjected=true</script>",
    artifacts: [
      {
        title: 'Interactive explanation " onload="window.outerInjected=true',
        width: 1280,
        height: 800,
        html: `<!doctype html><html><head><style>body{font-family:system-ui;padding:28px;color:#243a32}button{padding:12px}#remote-background{background-image:url('${blocked}/background')}</style></head><body>
        <h1>Why the result changes</h1><p>Adjust the count to explore the explanation.</p>
        <button id="increment">Add one</button><output id="count">0</output>
        <p id="remote-background">Embedded interactive content remains usable.</p>
        "></iframe><script>window.escapeMarker=true</script>
        <script>
          window.artifactProbe = { inline: true, violations: [] };
          const probe = window.artifactProbe;
          document.addEventListener('securitypolicyviolation', event => probe.violations.push(event.effectiveDirective));
          const denied = action => { try { action(); return false; } catch (error) { return error.name === 'SecurityError'; } };
          probe.parentDOM = denied(() => parent.document.body);
          probe.parentCookies = denied(() => parent.document.cookie);
          probe.cookies = denied(() => document.cookie);
          probe.localStorage = denied(() => localStorage.getItem('public-session'));
          probe.sessionStorage = denied(() => sessionStorage.getItem('public-session'));
          probe.node = typeof require === 'undefined' && typeof process === 'undefined';
          document.getElementById('increment').onclick = () => document.getElementById('count').textContent = String(Number(document.getElementById('count').textContent) + 1);
          fetch('${blocked}/fetch').then(() => probe.fetch = false, () => probe.fetch = true);
          const image = new Image(); image.onload = () => probe.image = false; image.onerror = () => probe.image = true; image.src = '${blocked}/image'; document.body.append(image);
          const script = document.createElement('script'); script.onerror = () => probe.script = true; script.src = '${blocked}/script'; document.body.append(script);
          const frame = document.createElement('iframe'); frame.src = '${blocked}/nested-frame'; document.body.append(frame);
          window.attemptArtifactNavigation = () => {
            probe.popup = window.open('${blocked}/popup') === null;
            probe.top = denied(() => top.location.href = '${blocked}/top');
            const form = document.createElement('form'); form.action = '${blocked}/form'; form.method = 'POST'; document.body.append(form); form.submit();
            const link = document.createElement('a'); link.href = '${blocked}/self-link'; document.body.append(link); link.click();
            window.location.href = '${blocked}/self-script';
            const refresh = document.createElement('meta'); refresh.httpEquiv = 'refresh'; refresh.content = '0;url=${blocked}/self-refresh'; document.head.append(refresh);
            probe.navigationAttempted = true;
          };
        </script></body></html>`,
      },
    ],
  };
}

async function check() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", process.argv[3]);
  await app.whenReady();
  const window = new BrowserWindow({
    width: 1280,
    height: 900,
    useContentSize: true,
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  const failedLoads = [];
  window.webContents.on("did-fail-load", (_event, code, description, url) => failedLoads.push({ code, description, url }));
  const evaluate = (code) => window.webContents.executeJavaScript(code);
  const ready = () => evaluate("Promise.all([...document.images].map(image => image.decode()))");
  const screenshot = async (name) => {
    if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
    await fs.mkdir(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
    await fs.writeFile(path.join(process.env.MILAGRE_SCREENSHOT_DIR, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  };
  try {
    await window.loadURL(process.argv[2] + "/page");
    await ready();
    assert.equal(await evaluate("document.images.length"), 2);
    assert.deepEqual(await evaluate("[...document.images].map(image => [image.naturalWidth, image.naturalHeight])"), [
      [1024, 768],
      [390, 844],
    ]);
    const pixel = await evaluate(
      `(async () => {const image = document.images[0]; const canvas = document.createElement('canvas'); canvas.width=image.naturalWidth; canvas.height=image.naturalHeight; const context=canvas.getContext('2d');context.drawImage(image,0,0);return [...context.getImageData(670,630,1,1).data]})()`,
    );
    assert.deepEqual(pixel, [82, 94, 234, 255], "the embedded raster survives SVG image rendering");
    assert.equal(await evaluate("fetch('https://example.com/blocked').then(() => false, () => true)"), true, "CSP blocks external network requests");
    assert.equal(await evaluate("!!window.milagre || !!window.require"), false, "public pages cannot reach the host bridge or Node");
    await screenshot("viewer-desktop");
    // No header or footer: the canvas fills the window; the zoom bar floats bottom-left and the Milagre logo bottom-right.
    assert.equal(await evaluate("document.querySelectorAll('header, footer').length"), 0, "the public page has no header or footer");
    assert.deepEqual(
      await evaluate("(r => [innerHeight - r.bottom, r.top])(document.getElementById('viewport').getBoundingClientRect())"),
      [0, 0],
      "the canvas fills the window",
    );
    const logo = await evaluate(
      "(() => {const a=document.querySelector('a.logo');return {href:a.href,target:a.target,rel:a.rel,label:a.getAttribute('aria-label')}})()",
    );
    assert.deepEqual(logo, { href: "https://milagre.cloud/", target: "_blank", rel: "noopener noreferrer", label: "Made with Milagre" });
    const dock = () =>
      evaluate(
        "(() => {const box=e=>e.getBoundingClientRect(),bar=box(document.querySelector('.bar')),logo=box(document.querySelector('a.logo'));return {barLeft:bar.left,barRight:bar.right,barBottom:bar.bottom,barHeight:bar.height,logoLeft:logo.left,logoRight:logo.right,logoBottom:logo.bottom,logoSize:[logo.width,logo.height],width:innerWidth,height:innerHeight}})()",
      );
    const placed = await dock();
    assert.equal(placed.width - placed.logoRight, 16, "the logo sits 16px from the right edge");
    assert.equal(placed.height - placed.logoBottom, 16, "the logo sits 16px from the bottom edge");
    assert.deepEqual(placed.logoSize, [32, 32]);
    assert.equal(placed.barLeft, 16, "the zoom bar sits 16px from the left edge");
    assert.equal(placed.barBottom, placed.logoBottom, "zoom bar and logo share a baseline");
    assert.equal(placed.barHeight, 32);
    const before = await evaluate("document.getElementById('canvas').style.transform");
    await evaluate("document.getElementById('in').click()");
    assert.notEqual(await evaluate("document.getElementById('canvas').style.transform"), before, "zoom changes the canvas");
    const afterZoom = await evaluate("document.getElementById('canvas').style.transform");
    await evaluate("document.getElementById('viewport').dispatchEvent(new WheelEvent('wheel',{deltaX:35,deltaY:20,bubbles:true,cancelable:true}))");
    assert.notEqual(await evaluate("document.getElementById('canvas').style.transform"), afterZoom, "wheel pans the canvas");
    await evaluate("document.getElementById('fit').click()");
    assert.equal(await evaluate("document.getElementById('canvas').style.transform"), before, "Fit restores the whole page");
    await evaluate("document.getElementById('zoom').click()");
    assert.equal(await evaluate("document.getElementById('zoom').textContent"), "100%", "the zoom reading resets to 100%");
    assert.equal(await evaluate("new DOMMatrix(getComputedStyle(document.getElementById('canvas')).transform).a"), 1);
    await evaluate("document.getElementById('fit').click()");

    window.setContentSize(390, 844);
    await delay(150);
    await screenshot("viewer-phone");
    assert.ok(await evaluate("document.getElementById('fit').getBoundingClientRect().right <= innerWidth"));
    // Native touch events exercise pointer capture and both pinch scale and midpoint translation.
    const send = (type, touchPoints) => window.webContents.debugger.sendCommand("Input.dispatchTouchEvent", { type, touchPoints });
    window.webContents.debugger.attach("1.3");
    const beforeTouch = await evaluate("new DOMMatrix(getComputedStyle(document.getElementById('canvas')).transform).toFloat64Array().slice(12,14)");
    await send("touchStart", [
      { x: 110, y: 350, id: 1 },
      { x: 230, y: 350, id: 2 },
    ]);
    await send("touchMove", [
      { x: 130, y: 370, id: 1 },
      { x: 250, y: 370, id: 2 },
    ]);
    await send("touchEnd", []);
    const afterTouch = await evaluate("[...new DOMMatrix(getComputedStyle(document.getElementById('canvas')).transform).toFloat64Array().slice(12,14)]");
    assert.ok(
      Math.abs(afterTouch[0] - beforeTouch[0] - 20) < 1 && Math.abs(afterTouch[1] - beforeTouch[1] - 20) < 1,
      "two fingers pan by their midpoint movement",
    );
    const startScale = await evaluate("new DOMMatrix(getComputedStyle(document.getElementById('canvas')).transform).a");
    await send("touchStart", [
      { x: 110, y: 350, id: 1 },
      { x: 230, y: 350, id: 2 },
    ]);
    await send("touchMove", [
      { x: 80, y: 350, id: 1 },
      { x: 260, y: 350, id: 2 },
    ]);
    await send("touchEnd", []);
    assert.ok((await evaluate("new DOMMatrix(getComputedStyle(document.getElementById('canvas')).transform).a")) > startScale, "pinch zooms in");
    window.webContents.debugger.detach();

    window.setContentSize(320, 640);
    await window.loadURL(process.argv[2] + "/large");
    await ready();
    await delay(100);
    const bounds = await evaluate(
      "(() => {const r=document.getElementById('canvas').getBoundingClientRect();return {left:r.left,right:r.right,viewport:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,fit:document.getElementById('fit').getBoundingClientRect().right}})()",
    );
    assert.ok(bounds.left >= 0 && bounds.right <= bounds.viewport, "Fit includes all 20 maximum-width designs on a narrow phone");
    assert.equal(bounds.overflow, false, "a long public title does not overflow the phone");
    assert.ok(bounds.fit <= bounds.viewport, "the phone keeps zoom controls reachable");
    assert.notEqual(await evaluate("document.getElementById('zoom').textContent"), "0%", "sub-percent zoom remains meaningful");
    await screenshot("viewer-phone-wide-page");
    await window.loadURL(process.argv[2] + "/escaped");
    await ready();
    assert.equal(await evaluate("window.injected"), undefined);
    assert.equal(await evaluate("document.querySelectorAll('script').length"), 1);
    assert.equal(await evaluate("document.querySelector('h1').textContent"), "</h1><script>window.injected=true</script>");
    assert.equal(await evaluate("document.querySelector('figcaption').textContent"), '<img src=x onerror="window.injected=true">');
    // Execute the actual public HTML under the same HTTP CSP as the Worker. The opaque
    // srcdoc frame must remain interactive without inheriting the public origin's authority.
    window.setContentSize(1280, 900);
    await window.loadURL(process.argv[2] + "/artifact");
    await evaluate("localStorage.setItem('public-session','parent-secret');sessionStorage.setItem('public-session','parent-secret')");
    assert.match(await evaluate("document.cookie"), /public-session=parent-secret/, "the parent origin has a cookie for the isolation probe");
    const frame = window.webContents.mainFrame.frames.find((child) => child.url === "about:srcdoc");
    assert.ok(frame, "the public Artifact loads its srcdoc under frame-src none");
    const evaluateArtifact = (code) => frame.executeJavaScript(code);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluateArtifact("!!(window.artifactProbe?.fetch && window.artifactProbe?.image && window.artifactProbe?.script)")) break;
      await delay(20);
    }
    const probe = await evaluateArtifact("window.artifactProbe");
    for (const field of ["inline", "parentDOM", "parentCookies", "cookies", "localStorage", "sessionStorage", "node", "fetch", "image", "script"])
      assert.equal(probe[field], true, `Artifact sandbox/CSP check: ${field}`);
    assert.equal(
      await evaluate("window.escapeMarker || window.outerInjected"),
      undefined,
      "malicious HTML and titles cannot escape srcdoc into the public wrapper",
    );
    assert.equal(await evaluateArtifact("window.escapeMarker"), true, "the escape probe remains inside the opaque frame");
    assert.deepEqual(await evaluate("[...document.querySelectorAll('iframe')].map(frame => frame.getAttribute('sandbox'))"), ["allow-scripts"]);
    assert.equal(
      await evaluate("document.querySelectorAll('script, #canvas, #viewport, #fit, nav, select').length"),
      0,
      "Artifact snapshots have no design canvas, chooser or history controls",
    );
    assert.equal(await evaluate("document.querySelectorAll('header, footer').length"), 0, "the public Artifact has no header or footer");
    assert.deepEqual(
      await evaluate("(r => [innerWidth - r.right, innerHeight - r.bottom, r.width, r.height])(document.querySelector('a.logo').getBoundingClientRect())"),
      [16, 16, 32, 32],
      "the Milagre logo floats bottom-right over the Artifact",
    );
    assert.equal(await evaluate("document.querySelector('a.logo').href"), "https://milagre.cloud/");
    await delay(150);
    await screenshot("viewer-artifact-before-click");
    const click = await evaluateArtifact(
      "(() => {const r=document.getElementById('increment').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()",
    );
    const outer = await evaluate("(() => {const r=document.querySelector('iframe').getBoundingClientRect();return {x:r.x,y:r.y}})()");
    window.webContents.debugger.attach("1.3");
    for (const type of ["mousePressed", "mouseReleased"])
      await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
        type,
        button: "left",
        clickCount: 1,
        x: outer.x + click.x,
        y: outer.y + click.y,
      });
    window.webContents.debugger.detach();
    await delay(50);
    assert.equal(await evaluateArtifact("document.getElementById('count').textContent"), "1", "a native click runs the Artifact's inline interaction");
    await screenshot("viewer-artifact-desktop");
    await evaluateArtifact("window.attemptArtifactNavigation()");
    await delay(150);
    assert.equal(window.webContents.getURL(), process.argv[2] + "/artifact", "the Artifact cannot navigate the public wrapper");
    assert.ok(
      failedLoads.some((failure) => failure.url.includes("/blocked/self-") && failure.description === "ERR_BLOCKED_BY_CSP"),
      "CSP refuses remote self navigation (Chromium may display its blocked-page document)",
    );
    // Reload the immutable page after the deliberate navigation attack for the phone rendering check.
    await window.loadURL(process.argv[2] + "/artifact");
    window.setContentSize(390, 844);
    await delay(50);
    assert.ok(await evaluate("document.querySelector('iframe').getBoundingClientRect().right <= innerWidth"), "the live page fits the phone viewport");
    await screenshot("viewer-artifact-phone");
    console.log(
      "PASS: public Designs and Artifact pages render under Worker CSP; canvas gestures and opaque Artifact interaction, escaping and blocked network/navigation verified",
    );
  } finally {
    window.destroy();
    app.quit();
  }
}

async function run() {
  const http = require("node:http");
  const { spawn } = require("node:child_process");
  const { SECURITY_HEADERS } = await import("../apps/design-share/src/service.mjs");
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-page-viewer-"));
  const sample = samplePage();
  const large = {
    schemaVersion: 1,
    title: "A".repeat(120),
    designs: Array.from({ length: 20 }, (_, index) => ({
      title: `Design ${index + 1}`,
      document: { schemaVersion: 1, width: 3840, height: 844, background: "#d6ddd9", nodes: [] },
    })),
  };
  const escaped = structuredClone(sample);
  escaped.title = "</h1><script>window.injected=true</script>";
  escaped.designs[0].title = '<img src=x onerror="window.injected=true">';
  const pages = new Map([
    ["/page", renderDesignPage(sample)],
    ["/large", renderDesignPage(large)],
    ["/escaped", renderDesignPage(escaped)],
  ]);
  const blockedRequests = [];
  const server = http.createServer((request, response) => {
    if (request.url.startsWith("/blocked/")) blockedRequests.push(request.url);
    const page = request.url === "/artifact" ? renderDesignPage(artifactPage(`http://127.0.0.1:${server.address().port}`)) : pages.get(request.url);
    response.writeHead(page ? 200 : 404, {
      ...SECURITY_HEADERS,
      "Content-Type": "text/html; charset=utf-8",
      ...(request.url === "/artifact" ? { "Set-Cookie": "public-session=parent-secret; SameSite=Lax" } : {}),
    });
    response.end(page ?? "Not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require("electron"), [__filename, `http://127.0.0.1:${server.address().port}`, profile], { env, stdio: "inherit" });
    process.exitCode = await new Promise((resolve) => child.once("exit", (code) => resolve(code ?? 1)));
    assert.deepEqual(blockedRequests, [], "no Artifact fetch, image, script, form, popup or frame navigation reaches the server");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(profile, { recursive: true, force: true });
  }
}
if (process.versions.electron || require.main === module)
  (process.versions.electron ? check() : run()).catch((error) => {
    console.error(error);
    process.exit(1);
  });
module.exports = { samplePage };
