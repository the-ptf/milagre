// Canvas previews: exercise the real canvas's zoom, visibility, selection, version and load transitions in Electron.
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { setTimeout: delay } = require("node:timers/promises");
const fixture = `
import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ArtifactCanvas } from "/src/components/agents/ArtifactCanvas";
import { designHtml } from "@milagre/shared/design";
import "/src/styles.css";
const document = (version) => ({ schemaVersion: 1, width: 1440, height: 900, background: version === 1 ? "#e4efe4" : "#efe4e4", nodes: [
  { id: "text", type: "text", width: 400, height: 100, x: 40, y: 40, text: "Preview " + version, fontFamily: "Plus Jakarta Sans", fontSize: 30 },
  { id: "logo", type: "image", width: 32, height: 32, src: "https://example.invalid/logo.png", fill: "#ff0000" },
  { id: "inline", type: "image", width: 32, height: 32, x: 100, y: 150, src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6SmAAAAAASUVORK5CYII=" },
  { id: "icon", type: "icon", width: 32, height: 32, x: 150, y: 150, icon: "check" }
] });
window.milagre = {
  readDesignsEnabled: async () => ({ enabled: true }), onDesignsEnabledChanged: () => () => {},
  artifacts: { get: async ({id, version = 1, chatId}) => ({ id, version, latest: 2, title: id, format: id === "page" ? "html" : "design", width: 1440, height: 900,
    html: id === "page" ? "<h1>HTML artifact</h1>" : designHtml(document(version)), document: chatId === "other#1" ? { ...document(version), background: "#334455", nodes: [{ ...document(version).nodes[0], text: "Other Chat" }] } : document(version) }) }
};
const noop = () => {};
function Fixture() {
  const canvas = useRef(null);
  const [versions, setVersions] = useState({});
  const [show, setShow] = useState(true);
  const [html, setHtml] = useState(false);
  const [allowLive, setAllowLive] = useState(true);
  window.setAllowLive = setAllowLive;
  const [chat, setChat] = useState("fixture#1");
  window.setChat = setChat;
  window.canvas = canvas;
  window.setVersion = (version) => setVersions({ a: version });
  window.setShow = setShow;
  window.setHtml = setHtml;
  const ids = html ? ["a", "b", "c", "page"] : ["a", "b", "c"];
  return <main className="absolute inset-0 flex flex-col">{show && <ArtifactCanvas ref={canvas} allowLive={allowLive} chatId={chat} designs={ids.map(id => ({ id, version: 2, title: id, format: id === "page" ? "html" : "design" }))}
    versions={versions} onVersion={(id, version) => setVersions(v => ({ ...v, [id]: version }))} focus={null} commenting={false}
    comments={{ pins: [], sent: [], open: null, onPin: noop, onOpen: noop, onText: noop, onRemove: noop, onSend: noop }}
    choice={{ sent: null, pending: null, onChoose: noop }} onView={v => { window.view = v; }} />}</main>;
}
createRoot(window.document.getElementById("root")).render(<Fixture />);
`;
const frame = (id) => `document.querySelector('[data-slot=artifact-frame][data-artifact=${id}]')`;
async function check() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", fs.mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-design-previews-")));
  await app.whenReady();
  const window = new BrowserWindow({ width: 620, height: 800, show: false, webPreferences: { backgroundThrottling: false } });
  window.webContents.on("console-message", (details) => {
    if (details.level === "error") console.error(details.message);
  });
  const evaluate = (source) => window.webContents.executeJavaScript(source);

  const waitFor = async (source) => {
    const deadline = Date.now() + 8000;
    do {
      if (await evaluate(source)) return;
      await delay(20);
    } while (Date.now() < deadline);
    throw Error("Timed out: " + source);
  };
  const shot = async (name) => {
    if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
    fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, name + ".png"), (await window.webContents.capturePage()).toPNG());
  };
  try {
    await window.loadURL(process.argv[2]);
    await waitFor(`document.querySelectorAll('[data-design-body][data-painted]').length === 3`);
    assert.ok(await evaluate("window.view.scale < .22"));
    assert.equal(await evaluate("document.querySelectorAll('[data-design-body] iframe').length"), 0);
    assert.equal(await evaluate("document.querySelectorAll('[data-design-body] img').length"), 3);
    await evaluate(`window.previewColor = async (id, corner = true) => {
      const img = document.querySelector('[data-artifact=' + id + '] [data-design-body] img');
      const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
      return [...ctx.getImageData(corner ? canvas.width-1 : 1, corner ? canvas.height-1 : 1, 1, 1).data].join(',');
    }; true`);
    assert.equal(await evaluate("window.previewColor('a', false)"), "216,222,216,255", "remote image keeps the grey placeholder in the raster preview");
    assert.ok(await evaluate(`${frame("a")}.querySelector('img').src.startsWith('data:image/png;')`));
    await shot("fit-previews");
    assert.ok(
      await evaluate(`${frame("a")}.querySelector('img').naturalWidth * ${frame("a")}.querySelector('img').naturalHeight > 65536`),
      "the initial preview exercises asynchronous encoding",
    );
    await evaluate(
      "window.syncEncodes = 0; window.encodePNG = HTMLCanvasElement.prototype.toDataURL; HTMLCanvasElement.prototype.toDataURL = function(...args) { window.syncEncodes++; return window.encodePNG.apply(this,args); }; window.canvas.current.zoomTo(.05)",
    );
    await waitFor(`${frame("a")}.querySelector('img').naturalWidth === Math.ceil(1440 * .0625 * devicePixelRatio)`);
    assert.equal(await evaluate(`${frame("a")}.querySelector('img').naturalHeight`), await evaluate("Math.ceil(900 * .0625 * devicePixelRatio)"));
    assert.ok(await evaluate("window.syncEncodes > 0"), "the small uncached bucket exercises synchronous encoding");
    await evaluate("void (HTMLCanvasElement.prototype.toDataURL = window.encodePNG)");
    assert.equal(await evaluate("window.previewColor('a')"), "239,228,228,255", "small synchronous previews preserve their pixels");

    await evaluate("window.setAllowLive(false); window.canvas.current.zoomTo(.3)");
    await delay(200);
    assert.equal(await evaluate("document.querySelectorAll('[data-design-body] iframe').length"), 0, "full frames wait for panel entry");
    await evaluate("window.setAllowLive(true)");
    await waitFor("document.querySelectorAll('[data-design-body] iframe').length > 0");
    await waitFor("[...document.querySelectorAll('[data-design-body] iframe')].every(f => getComputedStyle(f.parentElement).opacity === '1')");
    await evaluate("window.canvas.current.zoomTo(.235)");
    await delay(200);
    assert.ok(await evaluate("document.querySelectorAll('[data-design-body] iframe').length > 0"), "live mode persists in the hysteresis band");
    await evaluate("window.canvas.current.zoomTo(.21)");
    await waitFor("document.querySelectorAll('[data-design-body] iframe').length === 0");
    await evaluate("window.canvas.current.zoomTo(.235)");
    await delay(200);
    assert.equal(await evaluate("document.querySelectorAll('[data-design-body] iframe').length"), 0, "image mode persists in the hysteresis band");

    await evaluate("window.canvas.current.zoomTo(2)");
    await waitFor(`${frame("b")}.querySelector('iframe') && !${frame("a")}.querySelector('iframe') && !${frame("c")}.querySelector('iframe')`);
    await evaluate(
      `document.querySelector('[data-slot=artifact-canvas]').dispatchEvent(new WheelEvent('wheel', { deltaX: -3000, bubbles: true, cancelable: true }))`,
    );
    await waitFor(`${frame("a")}.querySelector('iframe') && !${frame("c")}.querySelector('iframe')`);
    await shot("in-view-live");
    await evaluate("window.canvas.current.fitAll()");
    await waitFor("document.querySelectorAll('[data-design-body] iframe').length === 0");
    const point = await evaluate(
      `(() => { const r = ${frame("a")}.querySelector('[data-slot=artifact-shield]').getBoundingClientRect(); return { x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2) }; })()`,
    );
    for (const type of ["mouseDown", "mouseUp"]) window.webContents.sendInputEvent({ type, ...point, button: "left", clickCount: 1 });
    await waitFor(`${frame("a")}.querySelector('[data-design-body]').dataset.active === 'true' && ${frame("a")}.querySelector('iframe')`);
    await shot("selected-live-at-fit");
    await evaluate(`window.retainedFrame = ${frame("a")}.querySelector('iframe'); window.oldPreviewWidth = ${frame("b")}.querySelector('img').naturalWidth`);
    const initialDensity = await evaluate("devicePixelRatio");
    const nextDensity = initialDensity * 2;
    window.webContents.debugger.attach("1.3");
    await window.webContents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
      width: 620,
      height: 800,
      deviceScaleFactor: nextDensity,
      mobile: false,
    });
    await waitFor(`devicePixelRatio === ${nextDensity} && ${frame("b")}.querySelector('img').naturalWidth > window.oldPreviewWidth`);
    assert.equal(
      await evaluate(`${frame("a")}.querySelector('iframe') === window.retainedFrame`),
      true,
      "DPR changes preserve the live frame's scroll/focus/state",
    );
    await window.webContents.debugger.sendCommand("Emulation.clearDeviceMetricsOverride");
    await waitFor(`devicePixelRatio === ${initialDensity}`);
    window.webContents.debugger.detach();
    await evaluate("dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))");
    await waitFor("document.querySelectorAll('[data-design-body] iframe').length === 0");
    await evaluate("window.setVersion(1)");
    await waitFor(`${frame("a")}.dataset.version === '1' && ${frame("a")}.querySelector('[data-design-body][data-painted]')`);
    assert.equal(await evaluate("window.previewColor('a')"), "228,239,228,255");
    await evaluate("window.setVersion(2)");
    await waitFor(`${frame("a")}.dataset.version === '2' && ${frame("a")}.querySelector('[data-design-body][data-painted]')`);
    assert.equal(await evaluate("window.previewColor('a')"), "239,228,228,255");
    await evaluate("window.setHtml(true)");
    await waitFor(`${frame("page")}?.querySelector('iframe') && ${frame("page")}.querySelector('[data-painted]')`);
    await evaluate("window.setShow(false)");
    await waitFor("!document.querySelector('[data-slot=artifact-canvas]')");
    await evaluate("window.setShow(true)");
    await waitFor("document.querySelectorAll('[data-design-body][data-painted]').length === 4");
    assert.equal(await evaluate("document.querySelectorAll('[data-design-body] iframe').length"), 1, "only HTML keeps an iframe after warm remount at Fit");
    // Start live while image decode is delayed, then zoom out. The painted iframe stays until its replacement decodes.
    await evaluate("window.setShow(false)");
    await waitFor("!document.querySelector('[data-slot=artifact-canvas]')");
    await evaluate(
      "window.originalDecode = HTMLImageElement.prototype.decode; window.decodeWaiters = []; HTMLImageElement.prototype.decode = function() { return new Promise(resolve => window.decodeWaiters.push(resolve)); }; window.setHtml(false); window.setShow(true)",
    );
    await waitFor("window.decodeWaiters.length === 3");
    await evaluate("window.canvas.current.zoomTo(.3)");
    await waitFor("[...document.querySelectorAll('[data-design-body] iframe')].some(f => getComputedStyle(f.parentElement).opacity === '1')");
    await evaluate("window.canvas.current.fitAll()");
    await delay(200);
    assert.ok(await evaluate("document.querySelectorAll('[data-design-body] iframe').length > 0"), "a painted live frame survives until the preview decodes");
    await evaluate("HTMLImageElement.prototype.decode = window.originalDecode; window.decodeWaiters.forEach(resolve => resolve())");
    await waitFor(
      "document.querySelectorAll('[data-design-body] iframe').length === 0 && document.querySelectorAll('[data-design-body][data-painted]').length === 3",
    );
    await evaluate("window.setChat('other#1')");
    await waitFor(`${frame("a")}?.querySelector('[data-design-body][data-painted]') && window.previewColor('a').then(color => color === '51,68,85,255')`);
    await evaluate(
      "window.encodePNG = HTMLCanvasElement.prototype.toDataURL; HTMLCanvasElement.prototype.toDataURL = () => { throw Error('PNG encoding failed'); }; window.setChat('encode-failure#1'); window.canvas.current.zoomTo(.05)",
    );
    await waitFor(
      "document.querySelectorAll('[data-design-body] iframe').length === 3 && document.querySelectorAll('[data-design-body][data-painted]').length === 3",
    );
    await evaluate("HTMLCanvasElement.prototype.toDataURL = () => 'data:,'; window.setChat('empty-png#1')");
    await waitFor(
      "document.querySelectorAll('[data-design-body] iframe').length === 3 && document.querySelectorAll('[data-design-body][data-painted]').length === 3",
    );
    await evaluate("void (HTMLCanvasElement.prototype.toDataURL = window.encodePNG)");
    await evaluate("window.setChat('recovered-png#1')");
    await waitFor(
      "document.querySelectorAll('[data-design-body] iframe').length === 0 && document.querySelectorAll('[data-design-body][data-painted]').length === 3",
    );
    // An HTML preview registration failure remains visible rather than waiting forever behind the design fade.
    await evaluate("window.milagre.createArtifactPreview = async () => { throw Error('Preview registration failed'); }; window.setHtml(true)");
    await waitFor(`${frame("page")}?.querySelector('[role=alert]')?.textContent.includes('Preview registration failed')`);
    assert.equal(await evaluate(`getComputedStyle(${frame("page")}.querySelector('[role=alert]')).opacity`), "1");
    console.log("PASS: Fit previews, settled hysteresis, viewport culling, selection, version readiness, HTML and warm remount");
    app.exit(0);
  } catch (error) {
    console.error(
      await evaluate(
        "[...document.querySelectorAll('[data-design-body]')].map(f => ({painted:f.dataset.painted,images:[...f.querySelectorAll('img')].map(i=>({complete:i.complete,width:i.naturalWidth,opacity:i.style.opacity,connected:i.isConnected})),frames:f.querySelectorAll('iframe').length}))",
      ),
    );
    await shot("preview-failure");
    console.error(error);
    app.exit(1);
  }
}
async function main() {
  const { createServer } = await import("vite");
  const { spawn } = require("node:child_process");
  const server = await createServer({
    configFile: path.resolve(__dirname, "../apps/desktop/vite.config.ts"),
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
    plugins: [
      {
        name: "design-previews-fixture",
        resolveId: (id) => (id === "/__previews.tsx" ? id : undefined),
        load: (id) => (id === "/__previews.tsx" ? fixture : undefined),
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== "/__previews__") return next();
            void server
              .transformIndexHtml(request.url, '<html><body><div id="root"></div><script type="module" src="/__previews.tsx"></script></body></html>')
              .then((html) => {
                response.setHeader("Content-Type", "text/html");
                response.end(html);
                return null;
              })
              .catch((error) => {
                response.statusCode = 500;
                response.end(String(error));
              });
          });
        },
      },
    ],
  });
  try {
    await server.listen();
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require("electron"), [__filename, `${server.resolvedUrls.local[0]}__previews__`], { env, stdio: "inherit" });
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    await server.close();
  }
}
(process.versions.electron ? check() : main()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
