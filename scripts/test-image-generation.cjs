// Run with node scripts/test-image-generation.cjs. Checks that an image Codex generates shows in the
// reply as its own surface, outside the folded activity: generating while the step runs, the image
// once it is saved and loaded with copy and download buttons and a right-click menu, and a failed step
// row (no surface) when it fails. Set MILAGRE_SCREENSHOT_DIR to keep screenshots.
const assert = require("node:assert/strict");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");

const PHOTO = path.join(__dirname, "fixtures", "photo.png");
const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatComposer } from "/src/components/ChatComposer";
import { MODEL_CATALOG, capabilityFor } from "/src/model";
import "/src/styles.css";
const noop = () => {};
window.imageCalls = [];
window.milagre = { listEditors: async () => [], copyImage: async (file) => { window.imageCalls.push(["copy", file]); }, saveImage: async (file) => { window.imageCalls.push(["save", file]); return null; }, showImageMenu: async (file) => { window.imageCalls.push(["menu", file]); } };
const PROMPT = "A quiet mountain landscape at sunset, soft dusk light over layered ridges";
const thought = { id: "t1", kind: "thinking", title: "Thought for 3s", status: "done", detail: "Generating the image the user asked for.", durationMs: 3000, offset: 0 };
const image = (status, extra = {}) => ({ id: "ig_1", kind: "image", title: status === "running" ? "Generating an image" : "Generated an image", status, offset: 0, ...extra });
function Fixture() {
  const [state, setState] = useState("generating");
  window.setFixture = setState;
  const running = state === "generating";
  const finalStep = state === "failed" ? image("failed", { title: "Couldn't generate an image", note: "image limit reached" }) : image("done", { file: ${JSON.stringify(PHOTO)}, detail: PROMPT });
  const messages = [
    { id: 1, session_id: 1, context: null, role: "user", body: "make me an image of a mountain landscape at sunset" },
    ...(running ? [] : [{ id: 2, session_id: 1, context: null, role: "assistant", body: state === "failed" ? "I couldn't generate it: the image limit is used up." : "Here it is.", steps: [thought, { ...finalStep, offset: 0 }], images: state === "failed" ? [] : [{ id: "captured", name: "photo.png", path: ${JSON.stringify(PHOTO)}, sourcePath: ${JSON.stringify(PHOTO)} }] }]),
  ];
  return <div style={{ height: "100%", padding: 12 }}>
    <ChatComposer messages={messages}
      imageDraft={{ images: [], files: [], attachFiles: noop, attachPath: noop, removeFile: noop, loading: false, error: "", onPaste: noop, clear: noop, remove: noop }}
      projectPath="/fixture" draft="" onDraftChange={noop} onSend={noop} isSending={running} sendBlocked={false}
      streamingText="" streamingSteps={running ? [thought, image("running")] : undefined} asking={false}
      models={MODEL_CATALOG} cliStatus={null} onModelPickerOpen={noop} selectedModel={MODEL_CATALOG[0]} onModelChange={noop}
      capability={capabilityFor(MODEL_CATALOG[0], null)} onEffortChange={noop} ultracode={false} onUltracodeChange={noop}
      fastMode={false} onFastModeChange={noop} permissionMode="auto" onPermissionModeChange={noop}
      onRecommendationSelect={noop} worktrees={[]} onWorktreeChange={noop}
      isolation="local" onIsolationChange={noop} branches={[]} baseBranch="main" onBaseBranchChange={noop} newChatError={null} />
  </div>;
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
  }
}

(process.versions.electron ? browserChecks() : main()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
