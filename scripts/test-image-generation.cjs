// Run with node scripts/test-image-generation.cjs. Checks that an image Codex generates shows in the
// reply as its own surface, outside the folded activity: generating while the step runs, the image
// once it is saved and loaded with copy and download buttons and a right-click menu, and a failed step
// row (no surface) when it fails. Set MILAGRE_SCREENSHOT_DIR to keep screenshots.
const assert = require("node:assert/strict");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");

const PHOTO = path.join(__dirname, "fixtures", "photo.png");
const fs = require("node:fs");
const VIEWED_ROOT = path.join(require("node:os").tmpdir(), `milagre-viewed-images-${require("node:crypto").randomUUID()}`);
const VIEWED = Object.fromEntries(
  ["original", "snapshot1", "snapshot2", "stored1", "stored2", "broken"].map((name) => [name, path.join(VIEWED_ROOT, name + ".png")]),
);
const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatComposer } from "/src/components/ChatComposer";
import { ScopeContext } from "/src/lib/computer-bridge";
import { MODEL_CATALOG, capabilityFor } from "/src/model";
import "/src/styles.css";
const noop = () => {};
window.imageCalls = [];
window.milagre = { listEditors: async () => [], copyImage: async (file) => { window.imageCalls.push(["copy", file]); }, saveImage: async (file) => { window.imageCalls.push(["save", file]); return null; }, showImageMenu: async (file) => { window.imageCalls.push(["menu", file]); } };
const viewedPaths = ${JSON.stringify(VIEWED)};
window.viewedFixturePaths = viewedPaths;
window.remoteReads = [];
window.milagre.on = () => ({ readMedia: async ({path}) => {
  window.remoteReads.push(path);
  if (![viewedPaths.stored1, viewedPaths.stored2].includes(path)) throw new Error("Image unavailable");
  return { type: "image/png", base64: ${JSON.stringify(require("node:fs").readFileSync(PHOTO).toString("base64"))} };
} });
const PROMPT = "A quiet mountain landscape at sunset, soft dusk light over layered ridges";
const thought = { id: "t1", kind: "thinking", title: "Thought for 3s", status: "done", detail: "Generating the image the user asked for.", durationMs: 3000, offset: 0 };
const image = (status, extra = {}) => ({ id: "ig_1", kind: "image", title: status === "running" ? "Generating an image" : "Generated an image", status, offset: 0, ...extra });
function Fixture() {
  const [state, setState] = useState(sessionStorage.imageFixture || "generating");
  window.setFixture = (next) => { sessionStorage.imageFixture = next; setState(next); };
  const viewed = state.startsWith("viewed");
  const viewedSteps = Array.from({length: 16}, (_, index) => [
    { id: "read-" + index, kind: "read", title: "Read source-" + index + ".png", status: "done", offset: 0 },
    { id: "read-" + index + ":image:0", kind: "image", imageOrigin: "viewed", sourceFile: viewedPaths.original, file: index === 2 ? viewedPaths.broken : index === 1 ? viewedPaths.snapshot2 : viewedPaths.snapshot1, title: "Viewed an image", status: "done", offset: 0 }
  ]).flat();
  const viewedAttachments = state === "viewed-pending" ? [] : [
    { id: "a", name: "stored1.png", sourcePath: viewedPaths.snapshot1, path: viewedPaths.stored1 },
    { id: "b", name: "stored2.png", sourcePath: viewedPaths.snapshot2, path: viewedPaths.stored2 }
  ];
  const running = state === "generating";
  const finalStep = state === "failed" ? image("failed", { title: "Couldn't generate an image", note: "image limit reached" }) : image("done", { file: ${JSON.stringify(PHOTO)}, detail: PROMPT });
  const messages = [
    { id: 1, session_id: 1, context: null, role: "user", body: "make me an image of a mountain landscape at sunset" },
    ...(running ? [] : [{ id: 2, session_id: 1, context: null, role: "assistant", body: state === "failed" ? "I couldn't generate it: the image limit is used up." : "Here it is.", steps: viewed ? viewedSteps : [thought, { ...finalStep, offset: 0 }], images: viewed ? viewedAttachments : state === "failed" ? [] : [{ id: "captured", name: "photo.png", path: ${JSON.stringify(PHOTO)}, sourcePath: ${JSON.stringify(PHOTO)} }] }]),
  ];
  return <ScopeContext.Provider value={state === "viewed-remote" ? "fixture-remote|/fixture" : null}><div style={{ height: "100%", padding: 12 }}>
    <ChatComposer messages={messages}
      imageDraft={{ images: [], files: [], attachFiles: noop, attachPath: noop, removeFile: noop, loading: false, error: "", onPaste: noop, clear: noop, remove: noop }}
      projectPath="/fixture" draft="" onDraftChange={noop} onSend={noop} isSending={running} sendBlocked={false}
      streamingText="" streamingSteps={running ? [thought, image("running")] : undefined} asking={false}
      models={MODEL_CATALOG} cliStatus={null} onModelPickerOpen={noop} selectedModel={MODEL_CATALOG[0]} onModelChange={noop}
      capability={capabilityFor(MODEL_CATALOG[0], null)} onEffortChange={noop} ultracode={false} onUltracodeChange={noop}
      fastMode={false} onFastModeChange={noop} permissionMode="auto" onPermissionModeChange={noop}
      onRecommendationSelect={noop} worktrees={[]} onWorktreeChange={noop}
      isolation="local" onIsolationChange={noop} branches={[]} baseBranch="main" onBaseBranchChange={noop} newChatError={null} />
  </div></ScopeContext.Provider>;
}
document.documentElement.classList.add("dark");
createRoot(document.getElementById("root")).render(<Fixture />);
`;

if (process.versions.electron)
  require("electron").protocol.registerSchemesAsPrivileged([
    { scheme: "milagre-media", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ]);

async function browserChecks() {
  const { app, BrowserWindow, protocol, net } = require("electron");
  const { createMediaHandler } = require("../apps/desktop/electron/media.cjs");
  app.setPath("userData", require("node:fs").mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-image-generation-")));
  await app.whenReady();
  protocol.handle(
    "milagre-media",
    createMediaHandler((url, options) => net.fetch(url, options)),
  );
  const window = new BrowserWindow({ width: 800, height: 700, useContentSize: true, show: false, webPreferences: { backgroundThrottling: false } });
  window.webContents.on("console-message", (details) => {
    if (details.level === "error") console.error(details.message);
  });
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  async function screenshot(name) {
    if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
    await delay(900);
    const fs = require("node:fs");
    fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  }
  async function waitFor(source) {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw new Error(`Timed out: ${source}`);
  }
  const surface = 'document.querySelector("[data-slot=image-generation]")';
  try {
    await window.loadURL(process.argv[2]);
    await waitFor(`${surface}?.dataset.state === "generating"`);
    assert.equal(await evaluate(`!!${surface}.closest("[data-slot=activity]")`), false, "the image is not folded into the activity");
    assert.equal(await evaluate(`${surface}.getAttribute("aria-busy")`), "true");
    await screenshot("generating");
    await evaluate('window.setFixture("done")');
    await waitFor(`${surface}?.dataset.state === "complete"`);
    const done = await evaluate(`({ text: ${surface}.textContent, loaded: ${surface}.querySelector("img").naturalWidth > 0 })`);
    assert.ok(done.loaded, "the saved image loads through milagre-media");
    assert.doesNotMatch(done.text, /Image ready|Generating image/, "no status line under the image");
    assert.doesNotMatch(done.text, /\d+ × \d+/, "no resolution badge over the image");
    assert.doesNotMatch(done.text, /mountain landscape/, "the prompt isn't repeated under the image");
    assert.match(await evaluate(`${surface}.querySelector("[role=img]").getAttribute("aria-label")`), /mountain landscape/, "the prompt is the image's label");
    await screenshot("complete");
    assert.equal(
      await evaluate('document.querySelectorAll("[data-from=assistant] [aria-label=Attachments]").length'),
      0,
      "durable assistant image copies do not duplicate the reply image as attachments",
    );
    // Hovering shows the buttons; each acts on the saved file, and so does the right-click menu.
    const box = await evaluate(
      `(() => { const r = ${surface}.querySelector("[role=img]").getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`,
    );
    window.webContents.sendInputEvent({ type: "mouseMove", x: box.x, y: box.y });
    await waitFor('getComputedStyle(document.querySelector("[aria-label=\'Copy image\']").parentElement.parentElement).opacity === "1"');
    await screenshot("hover-actions");
    await evaluate("document.querySelector(\"[aria-label='Copy image']\").click()");
    await waitFor('!!document.querySelector("[aria-label=Copied]")');
    await evaluate("document.querySelector(\"[aria-label='Download image']\").click()");
    await evaluate(`${surface}.parentElement.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))`);
    await waitFor("window.imageCalls.length === 3");
    assert.deepEqual(await evaluate("window.imageCalls"), [
      ["copy", PHOTO],
      ["save", PHOTO],
      ["menu", PHOTO],
    ]);
    // Clicking the image opens it full size, morphing out of its place in the chat, and Escape returns it.
    await evaluate("document.querySelector(\"[aria-label='Preview generated image']\").click()");
    await waitFor('document.querySelector("dialog[open] img")?.naturalWidth > 0');
    assert.equal(await evaluate(`${surface}.querySelector("img").classList.contains("opacity-0")`), true, "the chat image hides behind the viewer");
    await screenshot("preview");
    // The full-size image has the same right-click menu, shown once though the event bubbles back through the portal.
    await evaluate('document.querySelector("dialog img").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))');
    assert.deepEqual(await evaluate("window.imageCalls.slice(3)"), [["menu", PHOTO]]);
    await evaluate('document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))');
    await waitFor('!document.querySelector("dialog")');
    assert.equal(await evaluate('document.activeElement?.getAttribute("aria-label")'), "Preview generated image", "focus returns to the image");
    assert.equal(await evaluate(`${surface}.querySelector("img").classList.contains("opacity-0")`), false);
    await evaluate('window.setFixture("failed")');
    await waitFor(`!${surface} && !!document.querySelector("[data-slot=step][data-status=failed]")`);
    assert.match(
      await evaluate('document.querySelector("[data-slot=step][data-status=failed]").textContent'),
      /Couldn't generate an image.*image limit reached/,
    );
    await screenshot("failed");
    // Saved snapshot paths differ from their durable copies. Originals and snapshots were removed
    // before this renderer existed; a reload repeats the check without renderer media caches.
    const viewedStrip = 'document.querySelector("[data-slot=viewed-images]")';
    const viewedButtons = viewedStrip + '.querySelectorAll("button")';
    await evaluate('window.setFixture("viewed-pending")');
    await waitFor(`${viewedStrip}?.textContent.includes("Image unavailable")`);
    await evaluate('window.setFixture("viewed")');
    await waitFor(`${viewedButtons}.length === 16 && [...${viewedButtons}].filter(b => !b.disabled).length === 15`);
    const viewedPaths = await evaluate("window.viewedFixturePaths");
    for (const file of [viewedPaths.original, viewedPaths.snapshot1, viewedPaths.snapshot2]) assert.equal(fs.existsSync(file), false);
    const geometry = await evaluate(
      `(() => { const strip = ${viewedStrip}; const tile = strip.querySelector("button").getBoundingClientRect(); return { w: tile.width, h: tile.height, scroll: strip.scrollWidth > strip.clientWidth, width: strip.clientWidth }; })()`,
    );
    assert.equal(geometry.w, 80);
    assert.equal(geometry.h, 80);
    assert.ok(geometry.scroll, "sixteen tiles scroll horizontally in a compact strip");
    assert.equal(await evaluate('document.querySelectorAll("[data-slot=generated-image]").length'), 0);
    assert.equal(await evaluate(`${viewedStrip}.querySelectorAll("button:disabled").length`), 1, "undecodable image has readable unavailable tile");
    assert.match(await evaluate(`${viewedStrip}.querySelector("button").getAttribute("aria-label")`), /original.png/);
    await screenshot("viewed-local");
    await new Promise((resolve) => {
      window.webContents.once("did-finish-load", resolve);
      window.reload();
    });
    await waitFor(`${viewedStrip} && [...${viewedButtons}].filter(b => !b.disabled).length === 15`);
    await evaluate(`${viewedStrip}.querySelector("button").click()`);
    await waitFor('document.querySelector("dialog[open] img")?.naturalWidth > 0');
    await evaluate('document.querySelector("dialog img").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))');
    assert.equal((await evaluate("window.imageCalls.at(-1)"))[1], viewedPaths.stored1, "viewer actions use durable bytes");
    await evaluate('document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))');
    await waitFor('document.querySelector("dialog img")?.src.includes("stored2")');
    await evaluate('document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))');
    await waitFor('!document.querySelector("dialog")');
    await evaluate('window.setFixture("viewed-remote")');
    await waitFor(`${viewedStrip} && [...${viewedButtons}].filter(b => !b.disabled).length === 15`);
    const reads = await evaluate("window.remoteReads");
    assert.ok(reads.includes(viewedPaths.stored1) && reads.includes(viewedPaths.stored2));
    assert.ok(
      reads.every((file) => [viewedPaths.stored1, viewedPaths.stored2, viewedPaths.broken].includes(file)),
      "never request provenance or deleted snapshot paths",
    );
    await screenshot("viewed-remote");
    await evaluate(`${viewedStrip}.querySelector("button").click()`);
    await waitFor('document.querySelector("dialog[open] img")?.src.startsWith("data:image/png")');
    await evaluate('document.querySelector("dialog img").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))');
    assert.match((await evaluate("window.imageCalls.at(-1)"))[1], /^data:image\/png;base64,/, "remote viewer menu uses returned image bytes");
    await evaluate('document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))');
    await waitFor('!document.querySelector("dialog")');
    console.log(
      "PASS: sixteen compact viewed-image tiles, grouped local/remote viewers and actions, durable copies after source deletion and renderer restart, transient-to-durable recovery and unavailable decode/fetch states",
    );
    console.log(
      "PASS: a generated image shows outside the activity, generating, then complete with copy and download buttons and a right-click menu, a full-size preview on click (the prompt only as its label), or a failed step row with the reason and no image surface",
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
}

async function main() {
  fs.mkdirSync(VIEWED_ROOT, { recursive: true });
  for (const name of ["original", "snapshot1", "snapshot2"]) fs.copyFileSync(PHOTO, VIEWED[name]);
  fs.copyFileSync(VIEWED.snapshot1, VIEWED.stored1);
  fs.copyFileSync(VIEWED.snapshot2, VIEWED.stored2);
  fs.writeFileSync(VIEWED.broken, "not a decodable image");
  for (const name of ["original", "snapshot1", "snapshot2"]) fs.unlinkSync(VIEWED[name]);
  const { createServer } = await import("vite");
  const { spawn } = require("node:child_process");
  const server = await createServer({
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "image-generation-fixture",
        resolveId(id) {
          if (id === "/__image_generation_fixture.tsx") return id;
        },
        load(id) {
          if (id === "/__image_generation_fixture.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url !== "/__image_generation__") return next();
            const html = await server.transformIndexHtml(
              request.url,
              '<html><body><div id="root"></div><script type="module" src="/__image_generation_fixture.tsx"></script></body></html>',
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
    const child = spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__image_generation__`], { env, stdio: "inherit" });
    process.exitCode = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    await server.close();
    fs.rmSync(VIEWED_ROOT, { recursive: true, force: true });
  }
}

(process.versions.electron ? browserChecks() : main()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
