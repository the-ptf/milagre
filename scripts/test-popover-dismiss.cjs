// Real mouse presses dismiss the composer pickers and Select from anywhere outside them. No agent calls.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");

const fixture = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PromptComposer } from '/src/components/PromptComposer';
import { Select } from '/src/components/primitives/Select';
import { MODEL_CATALOG, capabilityFor } from '/src/model';
import '/src/styles.css';
const noop = () => {};
window.milagre = { listSkills: async () => ({ skills: [], warnings: [] }) };
function Fixture() {
  const [draft, setDraft] = useState('');
  const [theme, setTheme] = useState('light');
  const [cliStatus, setCliStatus] = useState({ codex: { state: 'outdated', message: 'Milagre needs Codex 0.99. Run codex update.' } });
  window.setCliStatus = setCliStatus;
  const model = MODEL_CATALOG[0];
  return <div style={{ width: '100%', maxWidth: 720, margin: '0 auto', paddingTop: 20 }}>
    <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
      <div data-testid="stopper" onPointerDown={event => event.stopPropagation()} style={{ width: 160, height: 40, background: '#eee' }}>stops propagation</div>
      <div style={{ marginLeft: 'auto' }}><Select label="Theme" value={theme} options={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} onChange={setTheme} /></div>
    </div>
    <div data-testid="transcript" style={{ height: 380 }} />
    <PromptComposer projectPath="/fixture" draft={draft} onDraftChange={setDraft}
      imageDraft={{ images: [], files: [], loading: false, error: '', onPaste: noop, remove: noop, removeFile: noop }}
      onSend={noop} sendBlocked={false} running
      models={MODEL_CATALOG} cliStatus={cliStatus} onModelPickerOpen={noop} selectedModel={model} onModelChange={noop}
      capability={capabilityFor(model, null)} onEffortChange={noop} ultracode={false} onUltracodeChange={noop}
      fastMode={false} onFastModeChange={noop} permissionMode="auto" onPermissionModeChange={noop} />
  </div>;
}
createRoot(document.getElementById('root')).render(<Fixture />);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", fs.mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-popover-dismiss-")));
  await app.whenReady();
  const window = new BrowserWindow({ width: 1000, height: 640, show: false, webPreferences: { backgroundThrottling: false } });
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  const errors = [];
  window.webContents.on("console-message", (details) => {
    if (details.level === "error") errors.push(details.message);
  });
  const waitFor = async (source) => {
    for (let i = 0; i < 200; i++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw Error("Timed out: " + source);
  };
  const screenshot = async (name) => {
    if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
    fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
    window.webContents.invalidate();
    await delay(250);
    await window.webContents.capturePage();
    await delay(100);
    fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, name + ".png"), (await window.webContents.capturePage()).toPNG());
  };
  // A real mouse press and release at the centre of the first element matching the selector, or `inset` px from
  // an edge when the centre may sit under an open picker. Confirm the edge is not obscured.
  const click = async (selector, { inset, fromRight = false } = {}) => {
    const point = await evaluate(
      `(() => { const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(${inset === undefined ? "rect.x + rect.width / 2" : fromRight ? `rect.right - ${Number(inset)}` : `rect.x + ${Number(inset)}`}), y: Math.round(rect.y + rect.height / 2) }; })()`,
    );
    if (inset !== undefined)
      assert.equal(
        await evaluate(`document.querySelector(${JSON.stringify(selector)}).contains(document.elementFromPoint(${point.x}, ${point.y}))`),
        true,
        "The click lands on the intended outside surface",
      );
    window.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
    window.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
    await delay(150);
  };
  const panels = () => evaluate(`document.querySelectorAll('[data-picker-panel]').length`);
  const model = "[data-promptbar] button[aria-expanded]:not([aria-label])";
  const permissions = '[data-promptbar] button[aria-label="Agent permissions"]';
  try {
    await window.loadURL(process.argv[2]);
    await waitFor(`!!document.querySelector('[data-prompt-editor]')`);

    await click(model);
    await waitFor(`!!document.querySelector('[data-picker-panel] input')`);
    await screenshot("model-picker-open");
    assert.equal(
      await evaluate(`[...document.querySelectorAll('[data-picker-panel] [data-provider-tabs] > button')].map((tab) => tab.disabled).join()`),
      "false,false,false,false",
      "A provider tab stays clickable while its CLI needs an update",
    );
    // Each provider's models, with its logo in color and each model's context window (Kiro: its credit multiplier) beside its name.
    // Antigravity last: its tab stays open for the missing-CLI check below.
    for (const index of [0, 1, 3, 2]) {
      await click(`[data-picker-panel] [data-provider-tabs] > button:nth-child(${index + 1})`);
      assert.match(
        await evaluate(`document.querySelector('[data-picker-panel] [data-picker-row] [data-picker-meta]')?.textContent ?? ""`),
        /^(\d+(k|M)|[\d.]+×)$/,
        "A model row shows its context window or credit multiplier beside the name",
      );
      await screenshot(`model-picker-tab-${index + 1}`);
    }
    const tabs = `[...document.querySelectorAll('[data-picker-panel] [data-provider-tabs] > button')].map((tab) => tab.getAttribute('aria-label')).join()`;
    await evaluate(`window.setCliStatus((current) => ({ ...current, antigravity: { state: 'missing', message: 'Antigravity is not installed.' } }))`);
    // The open tab stays until the picker reopens; then a missing CLI has no tab.
    await waitFor(`${tabs} === "Codex,Claude,Antigravity,Kiro"`);
    await click(model);
    await click(model);
    await waitFor(`${tabs} === "Codex,Claude,Kiro"`);
    await screenshot("model-picker-missing-hidden");
    await evaluate(`window.setCliStatus((current) => ({ ...current, antigravity: { state: 'ready' } }))`);
    await waitFor(`${tabs} === "Codex,Claude,Antigravity,Kiro"`);
    await click("[data-picker-panel] input");
    assert.equal(await panels(), 1, "Pressing inside the picker keeps it open");
    await click("[data-prompt-editor]");
    assert.equal(await panels(), 0, "Pressing the prompt field closes the model picker");
    assert.equal(await evaluate(`document.activeElement?.hasAttribute("data-prompt-editor")`), true, "The press still lands in the prompt field");
    await screenshot("model-picker-closed");

    await click(model);
    assert.equal(await panels(), 1);
    await click(model);
    assert.equal(await panels(), 0, "The trigger still toggles the picker closed");

    await click(permissions);
    assert.equal(await panels(), 1);
    await click('[data-testid="stopper"]');
    assert.equal(await panels(), 0, "A surface that stops propagation still closes the picker");

    await click(model);
    // The open picker covers the transcript's centre; press the transcript beside it, not a model row.
    await click('[data-testid="transcript"]', { inset: 24, fromRight: true });
    assert.equal(await panels(), 0, "Pressing the transcript closes the picker");

    await click('button[aria-label="Theme"]');
    assert.equal(await panels(), 1);
    await click("[data-prompt-editor]");
    assert.equal(await panels(), 0, "Pressing elsewhere closes Select");
    await click('button[aria-label="Theme"]');
    await click('[data-testid="stopper"]');
    assert.equal(await panels(), 0, "Select closes over a surface that stops propagation");
    await click('button[aria-label="Theme"]');
    await click('[role="option"]:last-child');
    assert.equal(await panels(), 0);
    assert.equal(await evaluate(`document.querySelector('button[aria-label="Theme"]').textContent`), "Dark", "Choosing an option still works");

    // Anchored surfaces follow their trigger through a scroll or resize; a press is what closes them.
    await click(model);
    await waitFor(`!!document.querySelector('[data-picker-panel] input')`);
    assert.equal(
      await evaluate(`document.documentElement.hasAttribute('data-popover-open')`),
      true,
      "The title bar releases its drag region while a picker is open",
    );
    await evaluate(`document.querySelector('[data-testid="transcript"]').dispatchEvent(new Event('scroll', { bubbles: false }))`);
    await delay(50);
    assert.equal(await panels(), 1, "Scrolling outside keeps the picker open");
    await window.setSize(980, 640);
    await delay(200);
    assert.equal(await panels(), 1, "Resizing keeps the picker open");
    await click("[data-prompt-editor]");
    assert.equal(await panels(), 0);
    assert.equal(await evaluate(`document.documentElement.hasAttribute('data-popover-open')`), false, "The drag region returns when nothing is open");

    await click('button[aria-label="Theme"]');
    const before = await evaluate(`document.querySelector('[role="listbox"]').getBoundingClientRect().left`);
    await window.setSize(900, 640);
    await delay(200);
    assert.equal(await panels(), 1, "Select survives a resize");
    assert.notEqual(
      await evaluate(`document.querySelector('[role="listbox"]').getBoundingClientRect().left`),
      before,
      "Select follows its trigger after a resize",
    );
    await click("[data-prompt-editor]");
    assert.equal(await panels(), 0);

    assert.deepEqual(errors, []);
    console.log(
      "PASS: composer pickers and Select close on any outside press, follow their trigger through scroll and resize, release the title-bar drag region, and still toggle and choose",
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.error(errors);
    app.exit(1);
  }
}

async function main() {
  const { createServer } = await import("vite");
  const server = await createServer({
    configFile: path.resolve(__dirname, "../apps/desktop/vite.config.ts"),
    cacheDir: path.resolve(__dirname, "../node_modules/.vite-popover-dismiss"),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "popover-dismiss-fixture",
        resolveId(id) {
          if (id === "/__popover-dismiss.tsx") return id;
        },
        load(id) {
          if (id === "/__popover-dismiss.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url !== "/__popover-dismiss") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await server.transformIndexHtml(
                request.url,
                '<html><body><div id="root"></div><script type="module" src="/__popover-dismiss.tsx"></script></body></html>',
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
    const child = require("node:child_process").spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__popover-dismiss`], {
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
  if (process.versions.electron) require("electron").app.exit(1);
  else process.exitCode = 1;
});
