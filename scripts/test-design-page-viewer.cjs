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
    const before = await evaluate("document.getElementById('canvas').style.transform");
    await evaluate("document.getElementById('in').click()");
    assert.notEqual(await evaluate("document.getElementById('canvas').style.transform"), before, "zoom changes the canvas");
    const afterZoom = await evaluate("document.getElementById('canvas').style.transform");
    await evaluate("document.getElementById('viewport').dispatchEvent(new WheelEvent('wheel',{deltaX:35,deltaY:20,bubbles:true,cancelable:true}))");
    assert.notEqual(await evaluate("document.getElementById('canvas').style.transform"), afterZoom, "wheel pans the canvas");
    await evaluate("document.getElementById('fit').click()");
    assert.equal(await evaluate("document.getElementById('canvas').style.transform"), before, "Fit restores the whole page");

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
    console.log("PASS: public page renders both designs and embedded raster under CSP; desktop/phone zoom, pan, pinch, escaping and 20-design Fit work");
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
  const server = http.createServer((request, response) => {
    const page = pages.get(request.url);
    response.writeHead(page ? 200 : 404, { ...SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8" });
    response.end(page ?? "Not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require("electron"), [__filename, `http://127.0.0.1:${server.address().port}`, profile], { env, stdio: "inherit" });
    process.exitCode = await new Promise((resolve) => child.once("exit", (code) => resolve(code ?? 1)));
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
