// Real desktop design components, real disk-backed artifact versions, an isolated Electron profile and IPC.
// node scripts/test-design-editor.cjs --preview keeps a fresh editor open for hands-on testing.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");

const chatId = "/design-fixture#1";
const designId = "fieldnotes";
const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ArtifactCards, ArtifactsProvider, DesignFeedbackCard } from "/src/components/agents/ArtifactCard";
import { PanelToggles } from "/src/components/agents/PanelToggles";
import { useDesignsEnabled } from "/src/lib/designs-enabled";
import { designFeedbackMessage, parseDesignFeedback } from "@milagre/shared/artifact";
import "/src/styles.css";
const step = { id: "design-1", kind: "artifact", title: "Created Fieldnotes", status: "done", offset: 0, artifact: { id: "fieldnotes", title: "Fieldnotes", version: 1 } };
const feedback = { id: 7, body: designFeedbackMessage({ comments: [{ id: "a1b2c3d4", design: step.artifact, x: 0.1, y: 0.2, nodeId: "heading", text: "Keep this heading easy to scan" }] }) };
function RemoteFlag() {
  const flag = useDesignsEnabled("fixture-remote|/design-fixture#1");
  return <output data-slot="remote-designs-flag" data-ready={flag.ready} data-enabled={flag.enabled}>Remote Designs: {flag.ready ? String(flag.enabled) : "loading"}</output>;
}
function Fixture() {
  const [remote, setRemote] = useState(false);
  window.mountRemote = () => setRemote(true);
  return <main data-workspace-main style={{ height: "100vh", padding: "72px 32px 32px" }}>
  <div data-chat-pane className="mx-auto max-w-3xl">
    <div className="mb-6"><p className="text-[12px] text-ink-3">Milagre Design Lab</p><h1 className="mt-2 text-2xl font-medium text-ink">An editable screen, in your Chat.</h1><p className="mt-2 max-w-lg text-[13px] leading-6 text-ink-2">Open Fieldnotes, then choose Edit. Select a layer, change its text or appearance, or drag it on the canvas. Save keeps a new version.</p></div>
    {remote && <div className="flex gap-4 text-xs text-ink-3"><RemoteFlag /><RemoteFlag /></div>}
    <ArtifactsProvider chatId="/design-fixture#1" steps={[step]} userMessages={[feedback]} onSend={async () => true}><ArtifactCards steps={[step]} /><DesignFeedbackCard feedback={parseDesignFeedback(feedback.body)} messageId={feedback.id} /></ArtifactsProvider>
  </div><PanelToggles right={24} />
</main>;
}
document.documentElement.classList.add("dark");
createRoot(document.getElementById("root")).render(<Fixture />);
`;

const deadline = async (promise, label, timeout = 10000) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out in ${label}`)), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

async function browserChecks() {
  const { app, BrowserWindow, ipcMain } = require("electron");
  const { createChatArtifacts } = require("../packages/core/src/chat-artifacts.cjs");
  const { createExampleDesign } = require("@milagre/shared/design");
  const temp = process.env.MILAGRE_DESIGN_FIXTURE_DIRECTORY;
  if (!temp) throw new Error("Start this fixture with node scripts/test-design-editor.cjs.");
  const preview = process.argv.includes("--preview");
  app.setPath("userData", path.join(temp, "profile"));
  const api = createChatArtifacts({
    directory: path.join(temp, "artifacts"),
    validateChat: async (id) => {
      assert.equal(id, chatId);
    },
  });
  await api.showDesign({ chatId, id: designId, title: "Fieldnotes", document: createExampleDesign() });
  const methods = ["get", "list", "apply", "comments", "addComments"];
  let nextApplyGate = null;
  ipcMain.handle("design-fixture:call", (_event, method, request) => {
    if (!methods.includes(method)) throw new Error("Unknown fixture method");
    if (method === "apply" && nextApplyGate) {
      const gate = nextApplyGate;
      nextApplyGate = null;
      return gate.then(() => api.apply(request));
    }
    return api[method](request);
  });
  let localReads = 0;
  // Designs are always on; a paired Mac on an older Milagre can still report them off, which this flag plays.
  let localEnabled = true;
  let remoteReads = 0;
  let remoteEnabled = true;
  ipcMain.handle("design-fixture:read-enabled", async (_event, host) => {
    if (host === "fixture-remote") {
      remoteReads++;
      const value = { enabled: remoteEnabled };
      await delay(250);
      return value;
    }
    localReads++;
    return { enabled: localEnabled };
  });
  const preload = path.join(temp, "preload.cjs");
  fs.writeFileSync(
    preload,
    `const { contextBridge, ipcRenderer } = require("electron");
    const bridge = (host) => ({
      readDesignsEnabled: () => ipcRenderer.invoke("design-fixture:read-enabled", host),
      onDesignsEnabledChanged: (callback) => {
        const listener = (_event, value) => callback(value);
        ipcRenderer.on("design-fixture:enabled:" + host, listener);
        return () => ipcRenderer.removeListener("design-fixture:enabled:" + host, listener);
      },
      artifacts: Object.fromEntries(${JSON.stringify(methods)}.map((method) => [method, (request) => ipcRenderer.invoke("design-fixture:call", method, request)])),
    });
    contextBridge.exposeInMainWorld("milagre", { ...bridge("local"), on: bridge });`,
  );
  await app.whenReady();
  const window = new BrowserWindow({
    title: "Milagre Design Lab",
    width: 1440,
    height: 960,
    useContentSize: true,
    show: preview,
    webPreferences: { preload, backgroundThrottling: false },
  });
  require("../apps/desktop/electron/links.cjs").guardNavigation(window.webContents, { appUrl: new URL(process.argv[2]).origin + "/", openExternal: () => {} });
  window.webContents.on("console-message", (details) => {
    if (details.level === "error" && !/Content Security Policy/.test(details.message)) console.error(details.message);
  });
  const evaluate = (source) =>
    deadline(window.webContents.executeJavaScript(source), source.slice(0, 200)).catch((error) => {
      throw new Error(`${error.message}\n  in: ${source.slice(0, 400)}`);
    });
  const { evaluatePanel } = require("./panel-menu-test.cjs").panelMenuHelpers(evaluate);
  async function waitFor(source) {
    for (let i = 0; i < 300; i++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw new Error(`Timed out: ${source}`);
  }
  const ensureLayers = async () => {
    await waitFor('!!document.querySelector("[data-slot=design-layers-toggle]")');
    if (!(await evaluate('!!document.querySelector("[data-slot=design-layers-panel]")')))
      await evaluate('document.querySelector("[data-slot=design-layers-toggle]").click()');
  };
  const click = async (selector) => {
    if (selector.startsWith("[data-panel-toggle=")) return evaluatePanel(`document.querySelector(${JSON.stringify(selector)}).click()`);
    if (selector.startsWith("[data-node-id=")) await ensureLayers();
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    if (selector === "[data-slot=artifact-edit]") await ensureLayers();
  };
  const draftInput = async (label, text) => {
    await evaluate(
      `(() => { const element = document.querySelector('[aria-label=${JSON.stringify(label)}]'); element.focus(); Object.getOwnPropertyDescriptor(element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value").set.call(element, ${JSON.stringify(text)}); element.dispatchEvent(new Event("input", { bubbles: true })); })()`,
    );
    await delay(25);
  };
  const blurInput = async (label) => {
    await evaluate(
      `(() => { const element = document.querySelector('[aria-label=${JSON.stringify(label)}]'); element.blur(); element.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); })()`,
    );
  };
  const input = async (label, text) => {
    await draftInput(label, text);
    await blurInput(label);
  };
  const read = () => api.get({ chatId, id: designId });
  const button = (text) =>
    evaluate(
      `[...document.querySelectorAll("[data-slot=design-editor] button")].find((button) => button.textContent.trim() === ${JSON.stringify(text)}).click()`,
    );
  const select = async (label, value) => {
    await click(`button[aria-label="${label}"]`);
    await waitFor(`!!document.querySelector('[role=listbox][aria-label="${label}"]')`);
    await evaluate(
      `[...document.querySelectorAll('[role=listbox][aria-label="${label}"] [role=option]')].find((option) => option.textContent.trim() === ${JSON.stringify(value)}).click()`,
    );
  };
  const downloads = [];
  const exportDialog = 'document.querySelector("[data-slot=design-export-dialog]")';
  if (!preview)
    window.webContents.session.on("will-download", (_event, item) => {
      const destination = path.join(temp, item.getFilename());
      item.setSavePath(destination);
      item.once("done", (_event, state) => downloads.push({ destination, state }));
    });
  const openExport = async (format = "PNG") => {
    if (!(await evaluate(`!!${exportDialog}`))) await click('[aria-label="Export design"]');
    await waitFor(`${exportDialog}?.open`);
    await click(`[data-slot="design-export-dialog"] input[aria-label="${format}"]`);
  };
  const download = async (format) => {
    await openExport(format);
    const before = downloads.length;
    await click('[data-slot="design-export-download"]');
    for (let i = 0; i < 400 && downloads.length === before; i++) await delay(25);
    assert.equal(downloads.length, before + 1, `${format} was downloaded`);
    assert.equal(downloads.at(-1).state, "completed");
    await waitFor(`!${exportDialog}`);
    return fs.readFileSync(downloads.at(-1).destination);
  };
  async function screenshot(name) {
    if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
    fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
    await delay(500);
    fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, `design-editor-${name}.png`), (await window.webContents.capturePage()).toPNG());
  }
  const editor = 'document.querySelector("[data-slot=design-editor]")';
  const status = 'document.querySelector("[data-slot=design-save-status]")';
  const setLocal = (enabled) => {
    localEnabled = enabled;
    window.webContents.send("design-fixture:enabled:local", { enabled });
  };
  let interactive;
  const previewPoint = async (id) => {
    // A sandboxed srcDoc navigation may replace WebFrameMain, including after undo.
    const expectedScript = await evaluate(
      `new DOMParser().parseFromString(${editor}.querySelector("iframe").srcdoc, "text/html").querySelector("script").textContent`,
    );
    interactive = null;
    for (let attempt = 0; attempt < 40 && !interactive; attempt++) {
      for (const child of window.webContents.mainFrame.framesInSubtree) {
        if (child === window.webContents.mainFrame) continue;
        const script = await deadline(
          child.executeJavaScript('document.getElementById("design-guides") && document.querySelector("script")?.textContent'),
          "find preview",
          500,
        ).catch(() => null);
        if (script === expectedScript) interactive = child;
      }
      if (!interactive) await delay(25);
    }
    assert.ok(interactive, "the current editable preview is ready");
    const rectangle = await deadline(
      interactive.executeJavaScript(
        `(() => { const box = document.querySelector('[data-design-node="${id}"]').getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; })()`,
      ),
      `preview point ${id}`,
    );
    const frameBounds = await evaluate(
      `(() => { const iframe = ${editor}.querySelector("iframe"); const box = iframe.getBoundingClientRect(); return { x: box.x, y: box.y, scale: box.width / iframe.clientWidth }; })()`,
    );
    return { x: frameBounds.x + rectangle.x * frameBounds.scale, y: frameBounds.y + rectangle.y * frameBounds.scale, scale: frameBounds.scale };
  };
  async function openEditor(layers = true) {
    await waitFor('!!document.querySelector("[data-slot=artifact-card] iframe")');
    await click("[data-slot=artifact-card] button");
    await waitFor('!!document.querySelector("[data-slot=artifact-edit]")');
    await evaluate('document.querySelector("[data-slot=artifact-edit]").click()');
    await waitFor(`!!${editor} && !!${editor}.querySelector("iframe")`);
    if (layers) await ensureLayers();
  }
  try {
    await window.loadURL(process.argv[2]);
    await openEditor(false);
    assert.equal(await evaluate('!!document.querySelector("[data-slot=designs-experimental]")'), false, "Designs left Experimental: no badge");
    assert.equal(await evaluate('!!document.querySelector("[data-slot=design-layers-panel]")'), false, "Layers starts closed for a clear canvas");
    assert.equal(
      await evaluate(`!!document.querySelector('[aria-label="Share Designs page"], [aria-label="Share page"]')`),
      false,
      "older hosts without a sharing service expose no Share button in the page or review canvas",
    );
    assert.equal(await evaluate('document.querySelector("[data-slot=design-tool-rail]").querySelectorAll("button").length'), 7);
    await screenshot("floating-tools");
    if (preview) {
      console.log(`READY: Milagre Design Lab at ${process.argv[2]} (Electron window). Disposable versions: ${path.join(temp, "artifacts")}`);
      window.show();
      window.focus();
      window.on("closed", () => app.quit());
      return;
    }

    await evaluate(
      `(() => { const button = document.querySelector('[data-slot="design-layers-toggle"]'); button.focus(); button.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); })()`,
    );
    assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), "Add frame", "arrow keys navigate the vertical tool rail");
    assert.ok(await evaluate(`${status}.textContent.includes("Saved · version 1")`), "toolbar navigation never nudges a selected layer");
    await click('[data-slot="design-layers-toggle"]');
    await waitFor('!!document.querySelector("[data-slot=design-layers-panel]")');
    await click('[data-node-id="card-title"]');
    const selectedLayerText = await evaluate('document.querySelector("textarea[aria-label=Text]").value');
    await click('[aria-label="Collapse Today card"]');
    assert.equal(await evaluate('!!document.querySelector("[data-node-id=card-title]")'), false, "collapsing a frame hides its descendants");
    assert.equal(await evaluate('document.querySelector("textarea[aria-label=Text]").value'), selectedLayerText, "collapsing does not change selection");
    await click('[aria-label="Expand Today card"]');
    await waitFor('!!document.querySelector("[data-node-id=card-title]")');
    await screenshot("floating-layers");
    await evaluate('window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
    await waitFor('!document.querySelector("[data-slot=design-layers-panel]")');
    assert.ok(await evaluate(`!!${editor}`), "Escape closes Layers without closing the editor");
    assert.equal(await evaluate('document.querySelector("textarea[aria-label=Text]").value'), selectedLayerText);
    await click('[data-slot="design-layers-toggle"]');
    await click('[data-slot="design-layers-toggle"]');
    assert.equal(await evaluate('!!document.querySelector("[data-slot=design-layers-panel]")'), false, "the toolbar toggles Layers closed");

    // Icon layers: add, rename to another Lucide icon, and see the new geometry in the preview.
    await click('[aria-label="Add icon"]');
    const iconField = 'document.querySelector("input[aria-label=Icon]")';
    assert.equal(await evaluate(`${iconField}.value`), "star", "a new icon layer starts as a star");
    await input("Icon", "chevron-left");
    await waitFor(
      `new DOMParser().parseFromString(${editor}.querySelector("iframe").srcdoc, "text/html").querySelector('[data-design-node^="icon-"] svg path')?.getAttribute("d") === "m15 18-6-6 6-6"`,
    );
    assert.equal(await evaluate('!!document.querySelector("input[aria-label=Stroke]")'), false, "icons have no border stroke field");
    assert.equal(await evaluate('!!document.querySelector("input[aria-label=\\"Line weight\\"]")'), true);
    await screenshot("icon-layer");

    // Remote Chats use their own shared subscription; an event wins over an older read response.
    assert.equal(localReads, 1, "cards, feedback and editor share one local flag subscription");
    await evaluate("window.mountRemote()");
    await waitFor('document.querySelectorAll("[data-slot=remote-designs-flag]").length === 2');
    for (let attempt = 0; attempt < 100; attempt++) {
      if (remoteReads) break;
      await delay(10);
    }
    assert.equal(remoteReads, 1, "both remote readers share one routed host read");
    remoteEnabled = false;
    window.webContents.send("design-fixture:enabled:fixture-remote", { enabled: false });
    await waitFor('document.querySelector("[data-slot=remote-designs-flag]").dataset.ready === "true"');
    await delay(300);
    assert.equal(
      await evaluate('document.querySelector("[data-slot=remote-designs-flag]").dataset.enabled'),
      "false",
      "late initial read cannot override the remote change",
    );
    remoteEnabled = true;
    window.webContents.send("design-fixture:enabled:fixture-remote", { enabled: true });
    await waitFor('document.querySelector("[data-slot=remote-designs-flag]").dataset.enabled === "true"');

    // A host reporting Designs off closes an open editor and removes every design surface. Disk data stays untouched.
    const savedDocument = (await read()).document;
    setLocal(false);
    await waitFor('!document.querySelector("[data-slot=artifact-card]")');
    assert.equal(
      await evaluate(
        '!!document.querySelector("[data-slot=design-editor], [data-slot=artifact-dock], [data-slot=artifact-card], [data-slot=artifact-group], [data-slot=design-feedback], [data-panel-toggle=designs]")',
      ),
      false,
      "off hides cards, feedback, panel toggle, dock and editor",
    );
    const plainFeedback = await evaluate('document.querySelector("[data-slot=design-feedback-text]").textContent');
    assert.match(plainFeedback, /Keep this heading easy to scan/);
    assert.doesNotMatch(plainFeedback, /design_read|design_apply|artifact_show|nodeId|a1b2c3d4/);
    assert.equal(
      await evaluate('document.querySelector("[data-slot=remote-designs-flag]").dataset.enabled'),
      "true",
      "one host reporting off never disables another",
    );
    await screenshot("designs-off");
    await window.loadURL(process.argv[2]);
    await waitFor('!!document.querySelector("[data-slot=design-feedback-text]")');
    assert.equal(await evaluatePanel('!!document.querySelector("[data-slot=artifact-card], [data-panel-toggle=designs]")'), false, "reopening stays off");
    setLocal(true);
    await waitFor('!!document.querySelector("[data-slot=artifact-card] iframe") && !!document.querySelector("[data-slot=design-feedback]")');
    assert.equal(
      await evaluate('!!document.querySelector("[data-slot=artifact-dock], [data-slot=design-editor]")'),
      false,
      "reenabling does not reopen a discarded editor",
    );
    assert.deepEqual((await read()).document, savedDocument, "turning Designs off preserves every saved layer");
    await click("[data-slot=artifact-card] button");
    await waitFor('!!document.querySelector("[data-slot=artifact-dock], [data-slot=design-editor]")');
    await screenshot("designs-enabled");

    await waitFor('!!document.querySelector("[data-slot=artifact-edit]")');
    await click("[data-slot=artifact-edit]");
    await waitFor(`!!${editor} && !!${editor}.querySelector("iframe")`);

    assert.equal(await evaluate(`${editor}.querySelectorAll("[data-node-id]").length`), 13);
    assert.equal(await evaluate(`${editor}.querySelector("iframe").getAttribute("sandbox")`), "allow-scripts");
    await screenshot("initial");
    await click('[data-node-id="heading"]');
    await input("Text", "Make time\nfor yourself.");
    await waitFor(`${status}.textContent.includes("Unsaved changes")`);
    await click('[data-panel-toggle="designs"]');
    assert.ok(await evaluate(`!!${editor}`), "the global panel toggle cannot discard an open editor");
    assert.equal(
      (await read()).document.nodes.find((node) => node.id === "heading").text,
      "Make room\nfor a good day.",
      "staged edits are not persisted before Save",
    );
    await click('[aria-label="Undo design edit"]');
    await waitFor('document.querySelector("textarea[aria-label=Text]").value === "Make room\\nfor a good day."');
    await click('[aria-label="Redo design edit"]');
    await waitFor('document.querySelector("textarea[aria-label=Text]").value === "Make time\\nfor yourself."');
    await input("Text color", "#315644");
    await click("[data-slot=design-save]");
    await waitFor(`${status}.textContent.includes("Saved · version 2")`);
    assert.equal((await read()).document.nodes.find((node) => node.id === "heading").fill, "#315644");
    await screenshot("edited");

    // Saved metadata updates the review canvas, and Edit from a historical version opens the newest document.
    await click('[aria-label="Close design editor"]');
    await waitFor('document.querySelector("[data-slot=artifact-frame]").dataset.version === "2"');
    await click('[aria-label="Previous version of Fieldnotes"]');
    await waitFor('document.querySelector("[data-slot=artifact-frame]").dataset.version === "1"');
    await click("[data-slot=artifact-edit]");
    await waitFor(`!!${editor}`);
    await click('[data-node-id="heading"]');
    assert.equal(await evaluate('document.querySelector("textarea[aria-label=Text]").value'), "Make time\nfor yourself.");
    assert.match(await evaluate(`${status}.textContent`), /version 2/);

    // The first click after typing can be Save: it commits the focused draft before persisting.
    window.show();
    window.focus();
    app.focus({ steal: true });
    await delay(200);
    window.webContents.debugger.attach("1.3");
    const clickWithPointer = async (selector) => {
      const point = await evaluate(
        `(() => { const element = document.querySelector(${JSON.stringify(selector)}); element.scrollIntoView({block:"nearest"}); const box = element.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; })()`,
      );
      await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", button: "none", buttons: 0, ...point });
      await delay(30);
      await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", buttons: 1, clickCount: 1, ...point });
      await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", buttons: 0, clickCount: 1, ...point });
    };
    await clickWithPointer('input[aria-label="Text color"]');
    await evaluate("document.querySelector('input[aria-label=\"Text color\"]').select()");
    await window.webContents.debugger.sendCommand("Input.insertText", { text: "#37634d" });
    await waitFor('document.querySelector(\'input[aria-label="Text color"]\').value === "#37634d"');
    await waitFor('!document.querySelector("[data-slot=design-save]").disabled');
    assert.equal(await evaluate("document.querySelector('input[aria-label=\"Text color\"]').value"), "#37634d");
    await clickWithPointer("[data-slot=design-save]");
    await waitFor(`${status}.textContent.includes("Saved · version 3")`);
    assert.equal((await read()).document.nodes.find((node) => node.id === "heading").fill, "#37634d");

    // A real pointer gesture inside the sandbox moves a free-positioned layer.
    window.show();
    window.focus();
    await delay(200);
    for (const child of window.webContents.mainFrame.framesInSubtree) {
      if (child === window.webContents.mainFrame) continue;
      if (await child.executeJavaScript('!!document.getElementById("design-resize")').catch(() => false)) interactive = child;
    }
    assert.ok(interactive, "editable preview loaded its interaction controller");
    await previewPoint("heading");
    const box = await interactive.executeJavaScript(
      '(() => { const box = document.querySelector("[data-design-node=heading]").getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height }; })()',
    );
    const bounds = await evaluate(
      `(() => { const frame = ${editor}.querySelector("iframe"); const rect = frame.getBoundingClientRect(); return { x: rect.x, y: rect.y, scale: rect.width / frame.clientWidth }; })()`,
    );
    const point = { x: Math.round(bounds.x + (box.x + box.width / 2) * bounds.scale), y: Math.round(bounds.y + (box.y + box.height / 2) * bounds.scale) };
    await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", buttons: 1, clickCount: 1, ...point });
    await delay(80);
    await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x + Math.round(20 * bounds.scale),
      y: point.y + Math.round(12 * bounds.scale),
      button: "left",
      buttons: 1,
    });
    await delay(80);
    await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      button: "left",
      buttons: 0,
      clickCount: 1,
      x: point.x + Math.round(20 * bounds.scale),
      y: point.y + Math.round(12 * bounds.scale),
    });
    await delay(200);
    await waitFor('Number(document.querySelector("input[aria-label=X]").value) > 40');
    assert.ok(Number(await evaluate('document.querySelector("input[aria-label=Y]").value')) > 110, "drag updates document position");
    await previewPoint("heading");
    const handle = await interactive.executeJavaScript(
      '(() => { const box = document.getElementById("design-resize").getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; })()',
    );
    const resizePoint = { x: bounds.x + handle.x * bounds.scale, y: bounds.y + handle.y * bounds.scale };
    await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mousePressed",
      button: "left",
      buttons: 1,
      clickCount: 1,
      ...resizePoint,
    });
    await delay(50);
    await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      button: "left",
      buttons: 1,
      x: resizePoint.x - 24 * bounds.scale,
      y: resizePoint.y - 16 * bounds.scale,
    });
    await delay(50);
    await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      button: "left",
      buttons: 0,
      clickCount: 1,
      x: resizePoint.x - 24 * bounds.scale,
      y: resizePoint.y - 16 * bounds.scale,
    });
    await waitFor('Number(document.querySelector("input[aria-label=Width]").value) < 315');
    assert.ok(Number(await evaluate('document.querySelector("input[aria-label=Height]").value')) < 85, "resize handle updates document dimensions");
    window.webContents.debugger.detach();
    await input("Width", "312");
    await input("Height", "96");
    await click("[data-slot=design-save]");
    await waitFor(`${status}.textContent.includes("Saved · version 4")`);
    assert.equal((await read()).document.nodes.find((node) => node.id === "heading").width, 312);

    await click('[data-node-id="card"]');
    await input("Gap", "20");
    await click('[aria-label="Undo design edit"]');
    await waitFor('document.querySelector("input[aria-label=Gap]").value === "16"');
    await click('[aria-label="Redo design edit"]');
    await waitFor('document.querySelector("input[aria-label=Gap]").value === "20"');
    await evaluate(`[...${editor}.querySelectorAll("button")].find((button) => button.textContent === "Duplicate").click()`);
    await waitFor(`${editor}.querySelectorAll("[data-node-id]").length === 19`);
    await evaluate(`[...${editor}.querySelectorAll("button")].find((button) => button.textContent === "Delete").click()`);
    await waitFor(`${editor}.querySelectorAll("[data-node-id]").length === 13`);
    await click('[aria-label="Add text"]');
    await waitFor(`${editor}.querySelectorAll("[data-node-id]").length === 14`);
    await input("Text", "Keep this new layer");
    await click("[data-slot=design-save]");
    await waitFor(`${status}.textContent.includes("Saved · version 5")`);
    assert.ok((await read()).document.nodes.some((node) => node.text === "Keep this new layer"));
    await screenshot("layers");

    // Disjoint concurrent fields merge locally; saving still requires a separate click, and draft history is recoverable.
    await input("Text", "A draft before the final");
    await input("Text", "A draft that must not overwrite");
    await api.apply({ chatId, id: designId, expectedVersion: 5, operations: [{ op: "update", id: "footer", patch: { text: "Another editor was here" } }] });
    await click("[data-slot=design-save]");
    await waitFor(`${editor}.textContent.includes("Your edits are merged with version 6")`);
    assert.equal((await read()).version, 6);
    assert.equal(await evaluate('document.querySelector("textarea[aria-label=Text]").value'), "A draft that must not overwrite");
    await click('[data-node-id="footer"]');
    assert.equal(await evaluate('document.querySelector("textarea[aria-label=Text]").value'), "Another editor was here");
    await screenshot("merged-draft");
    await button("Restore my draft");
    await click('[aria-label="Undo design edit"]');
    const newTextId = (await read()).document.nodes.find((node) => node.text === "Keep this new layer").id;
    await click(`[data-node-id="${newTextId}"]`);
    await waitFor('document.querySelector("textarea[aria-label=Text]").value === "A draft before the final"');
    await click('[aria-label="Redo design edit"]');
    await waitFor('document.querySelector("textarea[aria-label=Text]").value === "A draft that must not overwrite"');
    await button("Load latest");
    await waitFor(`${status}.textContent.includes("Saved · version 6")`);
    await click('[data-node-id="footer"]');
    assert.equal(await evaluate('document.querySelector("textarea[aria-label=Text]").value'), "Another editor was here");
    assert.equal(
      (await api.get({ chatId, id: designId, version: 1 })).document.nodes.find((node) => node.id === "heading").text,
      "Make room\nfor a good day.",
      "historical versions remain unchanged",
    );

    await click('[aria-label="Close design editor"]');
    for (let version = 2; version <= 6; version++) {
      await click('[aria-label="Next version of Fieldnotes"]');
      await waitFor(`document.querySelector("[data-slot=artifact-frame]").dataset.version === "${version}"`);
    }
    await waitFor('!!document.querySelector("[data-slot=artifact-sent-pin]")');
    const pin = await evaluate(
      '(() => { const pin = document.querySelector("[data-slot=artifact-sent-pin]").parentElement; return { x: parseFloat(pin.style.left), y: parseFloat(pin.style.top) }; })()',
    );
    const heading = (await read()).document.nodes.find((node) => node.id === "heading");
    assert.ok(Math.abs(pin.x - ((heading.x + heading.width / 2) / 390) * 100) < 0.01, "layer comment follows its new horizontal position");
    assert.ok(Math.abs(pin.y - ((heading.y + heading.height / 2) / 844) * 100) < 0.01, "layer comment follows its new vertical position");
    await screenshot("comment-follows-layer");
    await evaluate(
      `window.milagre.artifacts.apply({ chatId: ${JSON.stringify(chatId)}, id: ${JSON.stringify(designId)}, expectedVersion: 6, operations: [{ op: "update", id: "heading", patch: { hidden: true } }] }).then((artifact) => window.dispatchEvent(new CustomEvent("milagre:design-saved", { detail: { chatId: ${JSON.stringify(chatId)}, artifact } })))`,
    );
    await waitFor('document.querySelector("[data-slot=artifact-frame]").dataset.version === "7" && !document.querySelector("[data-slot=artifact-sent-pin]")');

    // Sizing controls use the shared layout engine and persist through the same operations API.
    await click("[data-slot=artifact-edit]");
    await waitFor(`!!${editor}`);
    const saveChanges = async () => {
      const version = (await read()).version + 1;
      await click("[data-slot=design-save]");
      await waitFor(`${status}.textContent.includes("Saved · version ${version}")`);
      return read();
    };
    await click('[data-node-id="brand"]');
    await select("Width sizing", "Hug");
    await select("Height sizing", "Hug");
    await input("Line height", "1.8");
    await input("Min width", "80");
    let advanced = await saveChanges();
    const brand = advanced.document.nodes.find((node) => node.id === "brand");
    assert.equal(brand.widthMode, "hug");
    assert.equal(brand.heightMode, "hug");
    assert.equal(brand.lineHeight, 1.8);
    assert.equal(brand.minWidth, 80);
    const { designLayout } = require("@milagre/shared/design");
    assert.ok(designLayout(advanced.document).get("brand").width < brand.width, "hug can shrink below the fallback width");
    await click('[data-node-id="card-body"]');
    await select("Width sizing", "Fill");
    await select("Height sizing", "Hug");
    await input("Line height", "1.4");
    advanced = await saveChanges();
    assert.equal(advanced.document.nodes.find((node) => node.id === "card-body").widthMode, "fill");
    await screenshot("sizing");

    // Shift/Cmd selection supports one atomic move, duplicate and delete across selected roots.
    await click('[data-node-id="brand"]');
    await evaluate(`document.querySelector('[data-node-id="footer"]').dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }))`);
    await waitFor(`${editor}.textContent.includes("2 layers selected")`);
    await input("Selection X", "38");
    advanced = await saveChanges();
    assert.equal(advanced.document.nodes.find((node) => node.id === "brand").x, 38);
    assert.equal(advanced.document.nodes.find((node) => node.id === "footer").x, 38);
    const originalCount = advanced.document.nodes.length;
    await button("Duplicate");
    await waitFor(`${editor}.querySelectorAll("[data-node-id]").length === ${originalCount + 2}`);
    assert.equal(await evaluate(`${editor}.querySelectorAll('[data-node-id][aria-pressed=true]').length`), 2);
    await button("Delete");
    await waitFor(`${editor}.querySelectorAll("[data-node-id]").length === ${originalCount}`);
    await click('[data-node-id="card"]');
    await evaluate(`document.querySelector('[data-node-id="card-title"]').dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }))`);
    await button("Duplicate");
    await waitFor(`${editor}.querySelectorAll("[data-node-id]").length === ${originalCount + 6}`);
    await button("Delete");
    await waitFor(`${editor}.querySelectorAll("[data-node-id]").length === ${originalCount}`);
    await click('[data-node-id="brand"]');
    await evaluate(`document.querySelector('[data-node-id="footer"]').dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }))`);
    await screenshot("multi-selection");

    // Real canvas modifier selection, group drag, guides and Alt bypass use the sandbox controller.
    window.webContents.debugger.attach("1.3");
    for (const child of window.webContents.mainFrame.framesInSubtree) {
      if (child === window.webContents.mainFrame) continue;
      if (await child.executeJavaScript('!!document.getElementById("design-guides")').catch(() => false)) interactive = child;
    }
    const pointer = (type, point, modifiers = 0, pressed = type !== "mouseReleased") =>
      deadline(
        window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
          type,
          button: "left",
          buttons: pressed ? 1 : 0,
          clickCount: 1,
          x: point.x,
          y: point.y,
          modifiers,
        }),
        `pointer ${type}`,
      );
    const dragLayer = async (id, x, y, modifiers, inspect) => {
      const from = await previewPoint(id);
      const to = { x: from.x + x * from.scale, y: from.y + y * from.scale };
      await pointer("mouseMoved", from, modifiers, false);
      await delay(80);
      await pointer("mousePressed", from, modifiers);
      await delay(40);
      await pointer("mouseMoved", to, modifiers);
      await delay(40);
      if (inspect) await inspect();
      await pointer("mouseReleased", to, modifiers);
      await delay(100);
    };
    await click('[data-node-id="date"]');
    const footerPoint = await previewPoint("footer");
    // Route the pointer into the sandbox before pressing, as dragLayer does.
    await pointer("mouseMoved", footerPoint, 8, false);
    await delay(80);
    await pointer("mousePressed", footerPoint, 8);
    await pointer("mouseReleased", footerPoint, 8);
    await waitFor(
      `${editor}.querySelector('[data-node-id="footer"]').getAttribute("aria-pressed") === "true" && ${editor}.querySelector('[data-node-id="date"]').getAttribute("aria-pressed") === "true"`,
    );
    await dragLayer("date", 20, 8, 1);
    advanced = await saveChanges();
    assert.equal(advanced.document.nodes.find((node) => node.id === "date").x, 48);
    assert.equal(advanced.document.nodes.find((node) => node.id === "footer").x, 58);
    assert.equal(advanced.document.nodes.find((node) => node.id === "date").y, 226);
    assert.equal(advanced.document.nodes.find((node) => node.id === "footer").y, 780);
    await click('[data-node-id="date"]');
    await dragLayer("date", -19, 0, 0, async () => {
      assert.ok(await interactive.executeJavaScript('document.getElementById("design-guides").childElementCount > 0'), "nearby edges display alignment guides");
      await screenshot("snapping-guides");
    });
    await waitFor('Number(document.querySelector("input[aria-label=X]").value) === 30');
    await click('[aria-label="Undo design edit"]');
    await waitFor('Number(document.querySelector("input[aria-label=X]").value) === 48');
    await dragLayer("date", -19, 0, 1, async () => {
      assert.equal(await interactive.executeJavaScript('document.getElementById("design-guides").childElementCount'), 0, "Alt bypasses snapping guides");
    });
    await waitFor('Number(document.querySelector("input[aria-label=X]").value) === 29');
    const canvasKey = async (key, code, modifiers = 0) => {
      await previewPoint("date");
      await deadline(window.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key, code, modifiers }), `key down ${key}`);
      await deadline(window.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers }), `key up ${key}`);
    };
    await canvasKey("ArrowRight", "ArrowRight");
    await waitFor('Number(document.querySelector("input[aria-label=X]").value) === 30');
    await canvasKey("z", "KeyZ", 4);
    await waitFor('Number(document.querySelector("input[aria-label=X]").value) === 29');
    await canvasKey("z", "KeyZ", 4);
    await waitFor('Number(document.querySelector("input[aria-label=X]").value) === 48');
    // Repeated keydowns in one preview turn accumulate before React can reload the iframe.
    await previewPoint("date");
    await interactive.executeJavaScript(
      'for (let i = 0; i < 5; i++) document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));',
    );
    await waitFor('Number(document.querySelector("input[aria-label=X]").value) === 53');
    await previewPoint("date");
    await interactive.executeJavaScript(
      'for (let i = 0; i < 5; i++) document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true }));',
    );
    await waitFor('Number(document.querySelector("input[aria-label=X]").value) === 103');
    for (let i = 0; i < 10; i++) await click('[aria-label="Undo design edit"]');
    await waitFor('Number(document.querySelector("input[aria-label=X]").value) === 48');
    window.webContents.debugger.detach();

    // Main component updates flow to instances; detach makes an independent subtree.
    await click('[data-node-id="note"]');
    await button("Make component");
    await waitFor(`!!document.querySelector('[aria-label="Insert Reflection field instance"]')`);
    await button("Create instance");
    await waitFor(`${editor}.textContent.includes("Linked instance")`);
    const instanceId = await evaluate(`${editor}.querySelector('[data-node-id][aria-pressed=true]').dataset.nodeId`);
    await input("X", "28");
    await input("Y", "725");
    await button("Edit main");
    await input("Fill", "#dfead9");
    await input("Width", "300");
    advanced = await saveChanges();
    let instance = advanced.document.nodes.find((node) => node.id === instanceId);
    assert.equal(instance.componentId, "note");
    assert.equal(instance.fill, "#dfead9");
    assert.equal(instance.width, 300);
    assert.equal(instance.y, 725, "main component edits preserve instance placement");
    const instanceChildId = advanced.document.nodes.find((node) => node.parentId === instanceId).id;
    await click(`[data-node-id="${instanceId}"]`);
    const countBeforeInstanceCopy = advanced.document.nodes.length;
    await button("Duplicate");
    await waitFor(`${editor}.querySelectorAll("[data-node-id]").length === ${countBeforeInstanceCopy + 2}`);
    const copiedInstanceId = await evaluate(`${editor}.querySelector('[data-node-id][aria-pressed=true]').dataset.nodeId`);
    assert.notEqual(copiedInstanceId, instanceId);
    await click('[data-node-id="note-placeholder"]');
    await input("Text", "A reusable reflection");
    advanced = await saveChanges();
    assert.equal(advanced.document.nodes.find((node) => node.id === instanceChildId).text, "A reusable reflection");
    assert.equal(
      advanced.document.nodes.find((node) => node.parentId === copiedInstanceId).text,
      "A reusable reflection",
      "duplicated instances remain linked to their main component",
    );
    await click(`[data-node-id="${instanceChildId}"]`);
    assert.equal(await evaluate(`${editor}.querySelector('[data-node-id][aria-pressed=true]').dataset.nodeId`), instanceId);
    assert.equal(
      await evaluate(`!!document.querySelector('textarea[aria-label="Text"]')`),
      false,
      "linked descendants cannot silently diverge from the main component",
    );
    await screenshot("component-instance");
    await button("Detach");
    await click(`[data-node-id="${instanceChildId}"]`);
    await input("Text", "Detached reflection");
    advanced = await saveChanges();
    instance = advanced.document.nodes.find((node) => node.id === instanceId);
    assert.equal(instance.componentId, undefined);
    assert.equal(advanced.document.nodes.find((node) => node.id === instanceChildId).componentSourceId, undefined);
    assert.equal(advanced.document.nodes.find((node) => node.id === "note-placeholder").text, "A reusable reflection");

    // CSS-invalid unquoted custom names remain valid in previews and both export formats.
    await click('[data-node-id="note-placeholder"]');
    await input("Font family", "Font 3, SF.Pro, sans-serif");
    await previewPoint("note-placeholder");
    assert.equal(
      await interactive.executeJavaScript(`document.querySelector('[data-design-node="note-placeholder"]').style.fontFamily`),
      '"Font 3", "SF.Pro", sans-serif',
      "the browser accepts custom font names instead of dropping the font-family declaration",
    );

    // Export through the real download control. The PNG includes embedded image pixels.
    await click('[aria-label="Add image"]');
    const imageId = await evaluate(`${editor}.querySelector('[data-node-id][aria-pressed=true]').dataset.nodeId`);
    const { nativeImage } = require("electron");
    const magenta = nativeImage.createFromBitmap(Buffer.from([255, 0, 255, 255]), { width: 1, height: 1 });
    await input("Image URL", `data:image/png;base64,${magenta.toPNG().toString("base64")}`);
    await input("X", "330");
    await input("Y", "32");
    await input("Width", "30");
    await input("Height", "30");
    advanced = await saveChanges();
    // The native export dialog owns focus and shortcuts without editing the page behind it.
    assert.equal(await evaluate(`document.querySelector('[aria-label="Undo design edit"]').textContent.trim()`), "");
    assert.equal(await evaluate(`document.querySelector('[aria-label="Redo design edit"]').textContent.trim()`), "");
    const beforeModal = await evaluate(`${editor}.querySelector("iframe").srcdoc`);
    await openExport();
    await evaluate(`${exportDialog}.querySelector('input:checked').focus()`);
    window.webContents.debugger.attach("1.3");
    const modalKey = async (key, code, windowsVirtualKeyCode, modifiers = 0) => {
      await window.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode, modifiers });
      await window.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode, modifiers });
    };
    await modalKey("ArrowDown", "ArrowDown", 40);
    await waitFor(`${exportDialog}.querySelector('input[aria-label="SVG"]').checked`);
    await modalKey("z", "KeyZ", 90, 4);
    assert.equal(await evaluate(`${editor}.querySelector("iframe").srcdoc`), beforeModal, "format navigation and undo shortcuts cannot change the canvas");
    await screenshot("export-dialog");
    await modalKey("Escape", "Escape", 27);
    window.webContents.debugger.detach();
    await waitFor(`!${exportDialog}`);
    assert.ok(await evaluate(`!!${editor}`), "Escape dismisses export without closing the page");
    const exportedPage = JSON.parse((await download("JSON")).toString());
    assert.equal(exportedPage.format, "milagre-design-page");
    assert.deepEqual(
      exportedPage.designs.map((item) => item.document),
      [advanced.document],
    );
    const svg = (await download("SVG")).toString();
    assert.match(svg, /<text\b/);
    assert.match(svg, /<image\b/);
    assert.match(svg, /font-family="&quot;Font 3&quot;, &quot;SF.Pro&quot;, sans-serif"/);
    assert.doesNotMatch(svg, /foreignObject|<!DOCTYPE html>/);
    const png = nativeImage.createFromBuffer(await download("PNG"));
    assert.deepEqual(png.getSize(), { width: 390, height: 844 });
    const pixels = png.toBitmap();
    const offset = (45 * 390 + 345) * 4;
    assert.ok(pixels[offset] > 240 && pixels[offset + 1] < 20 && pixels[offset + 2] > 240, "PNG contains the embedded magenta image");
    await evaluate(
      `window.__fontLoad = document.fonts.load.bind(document.fonts); document.fonts.load = () => Promise.reject(new DOMException("Unavailable font", "NetworkError")); null`,
    );
    try {
      const fallbackPng = nativeImage.createFromBuffer(await download("PNG"));
      assert.deepEqual(fallbackPng.getSize(), { width: 390, height: 844 }, "unavailable fonts fall back without failing PNG export");
    } finally {
      await evaluate(`document.fonts.load = window.__fontLoad; delete window.__fontLoad`);
    }
    const downloadedCount = downloads.length;
    window.webContents.session.webRequest.onBeforeRequest({ urls: ["https://design-export.invalid/*"] }, (_details, callback) => callback({ cancel: true }));
    await input("Image URL", "https://design-export.invalid/blocked.png");
    await openExport();
    await click('[data-slot="design-export-download"]');
    await waitFor(`${exportDialog}.textContent.includes("PNG export failed")`);
    assert.equal(downloads.length, downloadedCount, "a blocked image cannot produce a misleading successful PNG");
    assert.ok(await evaluate(`${exportDialog}.textContent.includes("Use an embedded image")`));
    await screenshot("export-error");
    await click('[aria-label="Cancel export"]');
    await input("Image URL", "https://[invalid]/image.png");
    await openExport();
    await click('[data-slot="design-export-download"]');
    await waitFor(`${exportDialog}.textContent.includes("PNG export failed") && ${exportDialog}.textContent.includes("invalid URL")`);
    assert.equal(downloads.length, downloadedCount, "malformed image URLs fail without a download or stuck promise");
    await waitFor("!document.querySelector('[data-slot=\"design-export-download\"]').disabled");
    await click('[aria-label="Cancel export"]');
    await click('[aria-label="Undo design edit"]');
    await click('[aria-label="Undo design edit"]');
    await waitFor(`${status}.textContent.includes("Saved · version")`);
    assert.equal((await read()).document.nodes.find((node) => node.id === imageId).src.startsWith("data:"), true);
    await download("PNG");
    assert.equal(await evaluate(`${editor}.textContent.includes("PNG export failed")`), false, "a successful retry clears the export error");

    // Host revisions refresh a clean editor and announce changes early without losing a dirty draft.
    const announce = (artifact) =>
      evaluate(
        `window.dispatchEvent(new CustomEvent("milagre:design-saved", { detail: { chatId: ${JSON.stringify(chatId)}, artifact: ${JSON.stringify(artifact)} } }))`,
      );
    const remoteEdit = async (operations, announceChange = true) => {
      const latest = await read();
      const updated = await api.apply({ chatId, id: designId, expectedVersion: latest.version, operations });
      if (announceChange) await announce(updated);
      return updated;
    };

    // A valid edit can exceed the preview output budget. Keep the draft and controls alive for recovery.
    const heavyIds = Array.from({ length: 40 }, (_, index) => `heavy-text-${index}`);
    advanced = await remoteEdit(
      heavyIds.map((id) => ({
        op: "insert",
        node: { id, name: "Long article", type: "text", width: 1, height: 1, fontSize: 2, lineHeight: 1, text: "a".repeat(20000) },
      })),
    );
    await waitFor(`${status}.textContent.includes("Saved · version ${advanced.version}")`);
    await click(`[data-node-id="${heavyIds[0]}"]`);
    await evaluate(`window.dispatchEvent(new MessageEvent("message", {
      source: ${editor}.querySelector("iframe").contentWindow,
      data: { type: "milagre:design-update", operations: ${JSON.stringify(heavyIds.map((id) => ({ op: "update", id, patch: { height: 16000 } })))} },
    }))`);
    await waitFor(`!!${editor}.querySelector('[data-slot=design-preview-error]')`);
    assert.match(await evaluate(`${editor}.querySelector('[data-slot=design-preview-error]').textContent`), /8 MiB.*Long article/);
    assert.equal(await evaluate('document.querySelector("[aria-label=Height]").value'), "16000", "the oversized draft remains available in the inspector");
    assert.equal(await evaluate('document.querySelector("[data-slot=design-save]").disabled'), true);
    await screenshot("preview-size-limit");
    await click('[aria-label="Undo design edit"]');
    await waitFor(`!!${editor}.querySelector("iframe") && !${editor}.querySelector('[data-slot=design-preview-error]')`);
    assert.equal(await evaluate('document.querySelector("[aria-label=Height]").value'), "1", "undo restores the bounded preview");
    advanced = await remoteEdit(heavyIds.map((id) => ({ op: "delete", id })));
    await waitFor(`${status}.textContent.includes("Saved · version ${advanced.version}")`);

    // Unset appearance fields show the rendered defaults, so removing a default is a real edit.
    advanced = await remoteEdit([
      { op: "insert", node: { id: "default-frame", type: "frame", x: 20, y: 400, width: 120, height: 120, locked: true } },
      { op: "insert", node: { id: "default-rectangle", parentId: "default-frame", type: "rectangle", width: 40, height: 40, stroke: "#000000" } },
      { op: "insert", node: { id: "default-ellipse", type: "ellipse", width: 40, height: 40 } },
      { op: "insert", node: { id: "default-text", type: "text", width: 120, height: 40, text: "Default text" } },
    ]);
    await waitFor(`${status}.textContent.includes("Saved · version ${advanced.version}")`);
    for (const [id, label, fill] of [
      ["default-frame", "Fill", "transparent"],
      ["default-rectangle", "Fill", "#d8ded8"],
      ["default-ellipse", "Fill", "#d8ded8"],
      ["default-text", "Text color", "#202720"],
    ]) {
      await click(`[data-node-id="${id}"]`);
      assert.equal(await evaluate(`document.querySelector('[aria-label="${label}"]').value`), fill, `${id} shows its effective fill`);
    }
    await click('[data-node-id="default-rectangle"]');
    assert.equal(await evaluate(`document.querySelector('[aria-label="Stroke width"]').value`), "1");
    await screenshot("effective-defaults");
    await previewPoint("default-rectangle");
    await delay(50);
    assert.equal(
      await interactive.executeJavaScript('document.getElementById("design-resize").style.display'),
      "none",
      "a locked parent hides child resize handles",
    );
    advanced = await remoteEdit([{ op: "update", id: "default-frame", patch: { locked: false, layout: "vertical" } }]);
    await waitFor(`${status}.textContent.includes("Saved · version ${advanced.version}")`);
    await previewPoint("default-rectangle");
    await delay(50);
    assert.equal(
      await interactive.executeJavaScript('document.getElementById("design-resize").style.display'),
      "block",
      "an unlocked layout child remains resizable",
    );
    await input("Fill", "transparent");
    await input("Stroke width", "0");
    advanced = await saveChanges();
    const clearedRectangle = advanced.document.nodes.find((node) => node.id === "default-rectangle");
    assert.equal(clearedRectangle.fill, "transparent", "typing transparent removes the implicit gray fill");
    assert.equal(clearedRectangle.strokeWidth, 0, "typing zero removes the implicit one-pixel stroke");
    await click('[data-node-id="default-text"]');
    await input("Text color", "transparent");
    advanced = await saveChanges();
    assert.equal(advanced.document.nodes.find((node) => node.id === "default-text").fill, "transparent");
    advanced = await remoteEdit(["default-frame", "default-ellipse", "default-text"].map((id) => ({ op: "delete", id })));
    await waitFor(`${status}.textContent.includes("Saved · version ${advanced.version}")`);

    // Messages can arrive in one task before React renders. Undo/redo must update the edit base immediately.
    await click('[data-node-id="footer"]');
    const originalFooter = advanced.document.nodes.find((node) => node.id === "footer");
    const commandThenPatch = (command, patch) =>
      evaluate(`(() => {
      const source = ${editor}.querySelector("iframe").contentWindow;
      window.dispatchEvent(new MessageEvent("message", { source, data: { type: "milagre:design-command", command: ${JSON.stringify(command)} } }));
      window.dispatchEvent(new MessageEvent("message", { source, data: { type: "milagre:design-update", id: "footer", patch: ${JSON.stringify(patch)} } }));
    })()`);
    await input("Text", "Draft before immediate undo");
    await commandThenPatch("undo", { fill: "#123456" });
    await waitFor(`document.querySelector('[aria-label="Text color"]').value === "#123456"`);
    assert.equal(
      await evaluate('document.querySelector("textarea[aria-label=Text]").value'),
      originalFooter.text,
      "an immediate iframe edit uses the undone document",
    );
    await click('[aria-label="Undo design edit"]');
    await waitFor(`${status}.textContent.includes("Saved · version")`);
    await input("Text", "Draft before immediate redo");
    await click('[aria-label="Undo design edit"]');
    await waitFor(`${status}.textContent.includes("Saved · version")`);
    await commandThenPatch("redo", { fill: "#654321" });
    await waitFor(`document.querySelector('[aria-label="Text color"]').value === "#654321"`);
    assert.equal(
      await evaluate('document.querySelector("textarea[aria-label=Text]").value'),
      "Draft before immediate redo",
      "an immediate iframe edit uses the redone document",
    );
    await click('[aria-label="Undo design edit"]');
    await click('[aria-label="Undo design edit"]');
    await waitFor(`${status}.textContent.includes("Saved · version")`);

    advanced = await remoteEdit([{ op: "update", id: "footer", patch: { text: "Clean refresh from another editor" } }]);
    await waitFor(`${status}.textContent.includes("Saved · version ${advanced.version}")`);
    await click('[data-node-id="footer"]');
    assert.equal(await evaluate('document.querySelector("textarea[aria-label=Text]").value'), "Clean refresh from another editor");

    // Typing and returning to the original value leaves only an uncommitted field flag. It cannot enable a rollback.
    await draftInput("Text", "A transient field value");
    await draftInput("Text", "Clean refresh from another editor");
    advanced = await remoteEdit([{ op: "insert", node: { id: "pending-rectangle", type: "rectangle", width: 12, height: 12 } }]);
    await waitFor(`${editor}.textContent.includes("Version ${advanced.version} is available")`);
    await button("Review latest changes");
    await waitFor(`!!${editor}.querySelector("[data-slot=design-conflict-review]")`);
    assert.equal(
      await evaluate(`${editor}.textContent.includes("Replace latest with my draft")`),
      false,
      "a clean draft cannot replace an incoming structural revision",
    );
    await blurInput("Text");
    await waitFor(`${status}.textContent.includes("Saved · version ${advanced.version}")`);
    assert.ok(await evaluate("!!document.querySelector('[data-node-id=\"pending-rectangle\"]')"));
    assert.equal((await read()).version, advanced.version, "blur adopts latest without writing an old document back");
    advanced = await remoteEdit([{ op: "delete", id: "pending-rectangle" }]);
    await waitFor(`${status}.textContent.includes("Saved · version ${advanced.version}")`);

    await input("Text", "One edit to undo");
    advanced = await remoteEdit([{ op: "insert", node: { id: "undo-rectangle", type: "rectangle", width: 12, height: 12 } }]);
    await waitFor(`${editor}.textContent.includes("Version ${advanced.version} is available")`);
    await click('[aria-label="Undo design edit"]');
    await waitFor(`${status}.textContent.includes("Saved · version ${advanced.version}")`);
    assert.ok(await evaluate("!!document.querySelector('[data-node-id=\"undo-rectangle\"]')"), "undoing to clean automatically adopts an incoming structure");
    advanced = await remoteEdit([{ op: "delete", id: "undo-rectangle" }]);
    await waitFor(`${status}.textContent.includes("Saved · version ${advanced.version}")`);

    await input("Text", "My local footer");
    advanced = await remoteEdit([{ op: "update", id: "footer", patch: { text: "Their latest footer", fill: "#b42318" } }]);
    await waitFor(
      `${editor}.textContent.includes("Version ${advanced.version} is available") && !!${editor}.querySelector("[data-slot=design-version-notice]")`,
    );
    assert.equal(await evaluate('document.querySelector("textarea[aria-label=Text]").value'), "My local footer");
    assert.equal(await evaluate(`${editor}.querySelector("[data-slot=design-save]").disabled`), true);
    assert.equal(await evaluate(`${editor}.querySelector('[aria-label="Undo design edit"]').disabled`), false);
    await button("Review latest changes");
    await waitFor(`!!${editor}.querySelector("[data-slot=design-conflict-review]")`);
    assert.equal(
      await evaluate(`[...${editor}.querySelectorAll("button")].find((button) => button.textContent.trim() === "Apply reviewed merge").disabled`),
      true,
    );
    assert.equal(await evaluate(`${editor}.querySelectorAll('[aria-label^="Use mine for"]').length`), 1, "only the overlapping text requires a choice");
    await screenshot("field-conflict-review");
    await click('[aria-label="Use mine for Footer · text"]');
    await button("Apply reviewed merge");
    await waitFor(`${editor}.textContent.includes("Your edits are merged with version ${advanced.version}")`);
    assert.equal((await read()).version, advanced.version, "reviewing and staging never saves on their own");
    assert.equal(await evaluate('document.querySelector("textarea[aria-label=Text]").value'), "My local footer");
    assert.equal(await evaluate("document.querySelector('input[aria-label=\"Text color\"]').value"), "#b42318", "a local text choice keeps the remote color");
    advanced = await saveChanges();
    assert.equal(advanced.document.nodes.find((node) => node.id === "footer").text, "My local footer");
    assert.equal(advanced.document.nodes.find((node) => node.id === "footer").fill, "#b42318");

    await input("Text", "A recoverable first draft");
    await input("Text", "A recoverable second draft");
    advanced = await remoteEdit([{ op: "update", id: "footer", patch: { text: "Another newest footer" } }]);
    await waitFor(`${editor}.textContent.includes("Version ${advanced.version} is available")`);
    await button("Load latest");
    await waitFor(`${status}.textContent.includes("Saved · version ${advanced.version}")`);
    // Loading another latest from a clean document must preserve the existing recoverable draft.
    for (const exit of ["close", "disable"]) {
      if (exit === "close") {
        await click('[aria-label="Close design editor"]');
        await waitFor(`!${editor}`);
      } else {
        setLocal(false);
        await waitFor(`!${editor}`);
        setLocal(true);
      }
      await openEditor();
      await waitFor(`!!${editor}.querySelector('[data-slot=design-suspended-draft]')`);
      await button("Restore unsaved draft");
      await waitFor('document.querySelector("textarea[aria-label=Text]").value === "A recoverable second draft"');
      await click('[aria-label="Undo design edit"]');
      await waitFor('document.querySelector("textarea[aria-label=Text]").value === "A recoverable first draft"');
      await click('[aria-label="Redo design edit"]');
      await waitFor('document.querySelector("textarea[aria-label=Text]").value === "A recoverable second draft"');
      await button("Load latest");
      await waitFor(`${status}.textContent.includes("Saved · version ${advanced.version}")`);
    }
    await draftInput("Text", "Transient clean reload");
    await draftInput("Text", "Another newest footer");
    advanced = await remoteEdit([{ op: "update", id: "brand", patch: { fill: "#064e3b" } }]);
    await waitFor(`${editor}.textContent.includes("Version ${advanced.version} is available")`);
    await button("Load latest");
    await waitFor(`${status}.textContent.includes("Saved · version ${advanced.version}")`);
    await button("Restore my draft");
    await waitFor('document.querySelector("textarea[aria-label=Text]").value === "A recoverable second draft"');
    await click('[aria-label="Undo design edit"]');
    await waitFor('document.querySelector("textarea[aria-label=Text]").value === "A recoverable first draft"');
    await click('[aria-label="Redo design edit"]');
    await waitFor('document.querySelector("textarea[aria-label=Text]").value === "A recoverable second draft"');
    await button("Load latest");
    await waitFor(`${status}.textContent.includes("Saved · version ${advanced.version}")`);

    // A merge that starts clean also preserves the earlier draft instead of replacing recovery with a clean snapshot.
    await draftInput("Text", "Transient clean merge");
    await draftInput("Text", "Another newest footer");
    advanced = await remoteEdit([{ op: "update", id: "brand", patch: { fill: "#065f46" } }]);
    await waitFor(`${editor}.textContent.includes("Version ${advanced.version} is available")`);
    await button("Review latest changes");
    await button("Apply reviewed merge");
    await waitFor(`${status}.textContent.includes("Saved · version ${advanced.version}")`);
    await button("Restore my draft");
    await waitFor('document.querySelector("textarea[aria-label=Text]").value === "A recoverable second draft"');
    await button("Load latest");
    await waitFor(`${status}.textContent.includes("Saved · version ${advanced.version}")`);

    // Structural replacement is explicit, reviewed, and checked again against an intervening save.
    await input("Text", "My reviewed structural draft");
    advanced = await remoteEdit([
      { op: "insert", node: { id: "remote-rectangle", name: "Remote rectangle", type: "rectangle", x: 0, y: 0, width: 12, height: 12, fill: "#000000" } },
    ]);
    await waitFor(`${editor}.textContent.includes("Version ${advanced.version} is available")`);
    await button("Review latest changes");
    await waitFor(`${editor}.textContent.includes("Added layer: Remote rectangle")`);
    assert.ok(await evaluate(`${editor}.textContent.includes("Earlier saved versions remain available")`));
    await screenshot("structural-conflict-review");
    advanced = await remoteEdit([{ op: "update", id: "footer", patch: { fill: "#115e59" } }], false);
    await button("Replace latest with my draft");
    await waitFor(`${editor}.textContent.includes("Version ${advanced.version} changed while you were editing")`);
    assert.equal((await read()).version, advanced.version, "another intervening save prevents the reviewed replacement");
    assert.ok((await read()).document.nodes.some((node) => node.id === "remote-rectangle"));
    assert.equal(await evaluate('document.querySelector("textarea[aria-label=Text]").value'), "My reviewed structural draft");
    await button("Review latest changes");
    await waitFor(`${editor}.textContent.includes("#115e59")`);
    await button("Replace latest with my draft");
    await waitFor(`${status}.textContent.includes("Saved · version ${advanced.version + 1}")`);
    assert.equal(
      (await read()).document.nodes.some((node) => node.id === "remote-rectangle"),
      false,
    );
    assert.equal(
      (await api.get({ chatId, id: designId, version: advanced.version })).document.nodes.some((node) => node.id === "remote-rectangle"),
      true,
    );

    // Validation failures explain the incompatible fields instead of claiming that the layer structure changed.
    advanced = await read();
    advanced = await remoteEdit([{ op: "replace", document: { ...advanced.document, tokens: { ...advanced.document.tokens, review: "#112233" } } }]);
    await waitFor(`${status}.textContent.includes("Saved · version ${advanced.version}")`);
    await input("Text color", "$review");
    const withoutReviewToken = { ...advanced.document.tokens };
    delete withoutReviewToken.review;
    advanced = await remoteEdit([{ op: "replace", document: { ...advanced.document, tokens: withoutReviewToken } }]);
    await waitFor(`${editor}.textContent.includes("Version ${advanced.version} is available")`);
    await button("Review latest changes");
    await waitFor(`${editor}.textContent.includes('Color token "$review" does not exist')`);
    assert.equal(await evaluate(`${editor}.querySelector("[data-slot=design-conflict-review]").textContent.includes("layer structure changed")`), false);
    assert.equal(await evaluate(`${editor}.textContent.includes("Replace latest with my draft")`), false);
    assert.equal(
      await evaluate(`[...${editor}.querySelectorAll("button")].find((button) => button.textContent.trim() === "Apply reviewed merge").disabled`),
      true,
    );
    await screenshot("merge-validation-error");
    await input("Text color", "#1d4ed8");
    await button("Apply reviewed merge");
    await waitFor(`${editor}.textContent.includes("Your edits are merged with version ${advanced.version}")`);
    advanced = await saveChanges();

    // During a delayed save, the sandbox has no editing controller; ignored nudges cannot accumulate for the next move.
    const savedX = advanced.document.nodes.find((node) => node.id === "footer").x;
    await input("X", String(savedX + 7));
    let releaseSave;
    nextApplyGate = new Promise((resolve) => {
      releaseSave = resolve;
    });
    await click("[data-slot=design-save]");
    await waitFor(`${status}.textContent.includes("Saving...")`);
    let pendingPreview;
    for (let attempt = 0; attempt < 100 && !pendingPreview; attempt++) {
      for (const child of window.webContents.mainFrame.framesInSubtree) {
        if (child === window.webContents.mainFrame) continue;
        const matches = await child
          .executeJavaScript(
            `!document.getElementById("design-guides") && document.querySelector("[data-design-node=footer]")?.style.left === "${savedX + 7}px"`,
          )
          .catch(() => false);
        if (matches) pendingPreview = child;
      }
      if (!pendingPreview) await delay(25);
    }
    assert.ok(pendingPreview, "the pending save preview disables its controller");
    await pendingPreview.executeJavaScript(
      'for (let i = 0; i < 5; i++) document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));',
    );
    assert.equal(await evaluate('Number(document.querySelector("input[aria-label=X]").value)'), savedX + 7);
    releaseSave();
    await waitFor(`${status}.textContent.includes("Saved · version ${advanced.version + 1}")`);
    await previewPoint("footer");
    await interactive.executeJavaScript('document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));');
    await waitFor(`Number(document.querySelector("input[aria-label=X]").value) === ${savedX + 8}`);
    await click('[aria-label="Undo design edit"]');
    await waitFor(`${status}.textContent.includes("Saved · version")`);

    // Escape from the sandbox uses the normal dirty-close confirmation and also closes a clean editor.
    await input("Text", "Unsaved escape draft");
    await previewPoint("footer");
    await interactive.executeJavaScript('document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));');
    await waitFor('!document.querySelector("[data-slot=design-layers-panel]")');
    assert.ok(await evaluate(`!!${editor}`), "iframe Escape closes Layers first");
    await interactive.executeJavaScript('document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));');
    await waitFor(`${editor}.textContent.includes("Your changes have not been saved")`);
    assert.equal(await evaluate('document.querySelector("textarea[aria-label=Text]").value'), "Unsaved escape draft");
    await button("Keep editing");
    await click('[aria-label="Undo design edit"]');
    await waitFor(`${status}.textContent.includes("Saved · version")`);
    await previewPoint("footer");
    await interactive.executeJavaScript('document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));');
    await waitFor(`!${editor}`);

    // A host flag change unmounts the whole dock without blurring a field. Keep committed and still-typed edits.
    await click("[data-slot=artifact-edit]");
    await waitFor(`!!${editor}`);
    await click('[data-node-id="footer"]');
    await input("Text color", "#abcdef");
    await draftInput("Text", "Uncommitted text kept while Designs is off");
    setLocal(false);
    await waitFor(`!${editor} && !document.querySelector('[data-slot=artifact-dock]')`);
    setLocal(true);
    advanced = await remoteEdit([{ op: "update", id: "brand", patch: { text: "A newer host revision" } }]);
    await openEditor();
    await waitFor(`!!${editor}.querySelector('[data-slot=design-suspended-draft]')`);
    await screenshot("draft-kept-after-off");
    await button("Restore unsaved draft");
    await waitFor('document.querySelector("textarea[aria-label=Text]").value === "Uncommitted text kept while Designs is off"');
    assert.equal(
      await evaluate(`${editor}.querySelector("iframe").srcdoc.includes("Uncommitted text kept while Designs is off")`),
      false,
      "restoration keeps typed text uncommitted until blur",
    );
    assert.equal(await evaluate(`document.querySelector('[aria-label="Text color"]').value`), "#abcdef");
    assert.equal(await evaluate(`document.querySelector('[aria-label="Undo design edit"]').disabled`), false, "restoration keeps Undo history");
    await blurInput("Text");
    await button("Review latest changes");
    await button("Apply reviewed merge");
    advanced = await saveChanges();
    assert.equal(advanced.document.nodes.find((node) => node.id === "footer").text, "Uncommitted text kept while Designs is off");
    assert.equal(advanced.document.nodes.find((node) => node.id === "footer").fill, "#abcdef");
    assert.equal(advanced.document.nodes.find((node) => node.id === "brand").text, "A newer host revision");
    await click('[aria-label="Close design editor"]');
    await waitFor(`!${editor}`);
    await click("[data-slot=artifact-edit]");
    await waitFor(`!!${editor}`);
    assert.equal(await evaluate(`!!${editor}.querySelector('[data-slot=design-suspended-draft]')`), false, "successful Save clears kept recovery");
    await click('[data-node-id="footer"]');
    await input("Text", "Explicitly discarded draft");
    await click('[aria-label="Close design editor"]');
    await button("Discard changes");
    await waitFor(`!${editor}`);
    await click("[data-slot=artifact-edit]");
    await waitFor(`!!${editor}`);
    assert.equal(await evaluate(`!!${editor}.querySelector('[data-slot=design-suspended-draft]')`), false, "explicit discard does not create a recovery entry");
    await click('[aria-label="Close design editor"]');
    await waitFor(`!${editor}`);

    // Edit opens one page with every design, retaining separate drafts while switching artboards.
    const secondId = "fieldnotes-evening";
    await api.showDesign({ chatId, id: secondId, title: "Evening walk", document: createExampleDesign() });
    await openEditor();
    await waitFor(`${editor}.querySelectorAll('[data-slot="design-page-frame"]').length === 2`);
    assert.equal(
      await evaluate(`${editor}.getAttribute("role") === "dialog" || ${editor}.getAttribute("aria-modal") === "true"`),
      false,
      "the editor is a page, not a modal",
    );
    assert.ok(await evaluate(`${editor}.getBoundingClientRect().width >= window.innerWidth - 1`), "the editor fills the app");
    await click('[aria-label="Show layers for Evening walk"]');
    await click('[data-node-id="brand"]');
    await draftInput("Text", "Evening draft");
    await click('[aria-label="Show layers for Fieldnotes"]');
    assert.ok(
      await evaluate('!!document.querySelector("[data-slot=design-layers-panel]")'),
      "switching page roots keeps Layers open and commits pending input",
    );
    await click('[data-node-id="brand"]');
    await input("Text", "Morning draft");
    await click('[aria-label="Select design Evening walk"]');
    await click('[data-node-id="brand"]');
    assert.equal(await evaluate('document.querySelector("textarea[aria-label=Text]").value'), "Evening draft", "switching artboards retains unsaved edits");
    const firstVersion = (await read()).version;
    await click('[data-slot="design-save"]');
    await waitFor(`document.querySelector('[data-slot="design-save"]').disabled && ${status}.textContent.includes("Saved · version")`);
    assert.equal((await read()).version, firstVersion + 1);
    assert.equal((await read()).document.nodes.find((node) => node.id === "brand").text, "Morning draft");
    assert.equal((await api.get({ chatId, id: secondId })).document.nodes.find((node) => node.id === "brand").text, "Evening draft");
    await draftInput("Text", "Draft included in page export");
    const pageDownload = JSON.parse((await download("JSON")).toString());
    assert.deepEqual(
      pageDownload.designs.map((item) => item.id),
      [designId, secondId],
    );
    assert.equal(pageDownload.designs[1].document.nodes.find((node) => node.id === "brand").text, "Draft included in page export");
    assert.equal(
      (await api.get({ chatId, id: secondId })).document.nodes.find((node) => node.id === "brand").text,
      "Evening draft",
      "export does not save drafts",
    );
    const pageSvg = (await download("SVG")).toString();
    const pageIds = [...pageSvg.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(new Set(pageIds).size, pageIds.length, "artboards cannot collide through SVG clip ids");
    assert.match(pageSvg, /Morning draft/);
    assert.match(pageSvg, /Draft included in page export/);
    const pagePng = nativeImage.createFromBuffer(await download("PNG"));
    assert.deepEqual(pagePng.getSize(), { width: 860, height: 844 });
    await screenshot("whole-page");
    await click('[aria-label="Select design Fieldnotes"]');
    await click('[aria-label="Close design editor"]');
    await waitFor(`${editor}.textContent.includes("Discard changes")`);
    await button("Discard changes");
    await waitFor(`!${editor}`);
    await openEditor();
    await waitFor(`${editor}.querySelectorAll('[data-slot="design-page-frame"]').length === 2`);
    await click('[aria-label="Select design Evening walk"]');
    await click('[data-node-id="brand"]');
    assert.equal(
      await evaluate('document.querySelector("textarea[aria-label=Text]").value'),
      "Evening draft",
      "closing checks and discards inactive drafts too",
    );
    await click('[aria-label="Close design editor"]');
    await waitFor(`!${editor}`);

    // A page wider than 4096 scales each artboard without losing its right or bottom edge.
    const wideDocument = {
      schemaVersion: 1,
      width: 2500,
      height: 1000,
      nodes: [
        { id: "right-edge", type: "rectangle", x: 2400, y: 0, width: 100, height: 1000, fill: "#ff00ff" },
        { id: "bottom-edge", type: "rectangle", x: 0, y: 900, width: 2500, height: 100, fill: "#ff00ff" },
      ],
    };
    for (const id of [designId, secondId]) {
      const latest = await api.get({ chatId, id });
      await api.apply({ chatId, id, expectedVersion: latest.version, operations: [{ op: "replace", document: wideDocument }] });
    }
    await openEditor();
    const scaledPng = nativeImage.createFromBuffer(await download("PNG"));
    const scaledSize = scaledPng.getSize();
    assert.equal(scaledSize.width, 4096);
    const scaledPixels = scaledPng.toBitmap();
    const scale = 4096 / 5080;
    for (const left of [0, 2580]) {
      for (const [x, y] of [
        [2450, 500],
        [1250, 950],
      ]) {
        const offset = (Math.floor(y * scale) * scaledSize.width + Math.floor((left + x) * scale)) * 4;
        assert.ok(
          scaledPixels[offset] > 240 && scaledPixels[offset + 1] < 20 && scaledPixels[offset + 2] > 240,
          `scaled PNG preserves edge at ${left + x},${y}`,
        );
      }
    }
    await click('[aria-label="Close design editor"]');
    await waitFor(`!${editor}`);

    // A second persistence instance reads the same saved document from disk.
    const reopened = createChatArtifacts({ directory: path.join(temp, "artifacts"), validateChat: async () => {} });
    assert.deepEqual((await reopened.get({ chatId, id: designId })).document, (await read()).document);
    console.log(
      "PASS: editable layers, pointer drag/resize, repeated arrow movement, iframe Escape, undo/redo, multi-select, Hug/Fill sizing, linked components, JSON/SVG/PNG export, image export errors, layer comments, clean refresh, reviewed field/structural conflicts with recoverable drafts, default-on Designs toggle, plain feedback while off, remote host routing and disabled-state persistence through real Electron IPC",
    );
    app.exit(0);
  } catch (error) {
    await screenshot("failure");
    console.error(error);
    app.exit(1);
  }
}

async function main() {
  const { createServer } = await import("vite");
  const { spawn } = require("node:child_process");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-design-editor-"));
  const server = await createServer({
    server: { host: "127.0.0.1", port: 0, hmr: false },
    plugins: [
      {
        name: "design-editor-fixture",
        resolveId(id) {
          if (id === "/__design_editor_fixture.tsx") return id;
        },
        load(id) {
          if (id === "/__design_editor_fixture.tsx") return fixture;
        },
        configureServer(vite) {
          useAsyncMiddleware(vite.middlewares, async (request, response, next) => {
            if (request.url !== "/__design_editor__") return next();
            const html = await vite.transformIndexHtml(
              request.url,
              '<html><body><div id="root"></div><script type="module" src="/__design_editor_fixture.tsx"></script></body></html>',
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
    const url = `${server.resolvedUrls.local[0]}__design_editor__`;
    console.log(`Design editor fixture: ${url}`);
    const env = { ...process.env, MILAGRE_DESIGN_FIXTURE_DIRECTORY: temp };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require("electron"), [path.resolve(__filename), url, ...(process.argv.includes("--preview") ? ["--preview"] : [])], {
      env,
      stdio: "inherit",
    });
    process.exitCode = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    await server.close();
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

(process.versions.electron ? browserChecks() : main()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
