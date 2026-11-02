// Settings > Appearance in Electron: the theme picker and mode control recolor the page, striped body and code.
// The terminal is exercised for real: a session from lib/terminal-sessions.ts follows a fake daemon that never answers,
// and its xterm options.theme must change with the theme. The window behind the page takes the theme's page color.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");

const fixture = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SettingsNav, SettingsPanel } from '/src/components/Settings';
import { useApplyTheme, updateSettings } from '/src/lib/settings';
import { attachTerminal } from '/src/lib/terminal-sessions';
import '/src/styles.css';
window.milagre = { listEditors: async () => [], listRecentProjects: async () => [], listProjects: async () => [], setWindowBackground: async (color) => { window.__windowBackground = color; }, setTerminalFocused: () => {},
  terminals: { read: () => new Promise(() => {}), input: async () => {}, resize: async () => {} } };
window.__updateSettings = updateSettings;
window.__mountTerminal = () => {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;right:0;bottom:0;width:300px;height:160px';
  document.body.appendChild(host);
  const session = attachTerminal({ id: 't1', chatId: 'c1', title: 't', cwd: '/', label: 'l', busy: false, cols: 80, rows: 24, createdAt: 0 }, host);
  window.__term = session.term;
};
function Fixture() {
  const [section, setSection] = useState('appearance');
  useApplyTheme();
  return (
    <div style={{ display: 'flex', gap: 12, height: '100vh', padding: 12 }}>
      <SettingsNav section={section} onSelect={setSection} onSelectProject={() => {}} onBack={() => {}} showProjectSettings={false} />
      <main style={{ flex: 1, minWidth: 0 }}><SettingsPanel section={section} models={[]} update={null} /></main>
      <pre className="code-token" style={{ '--shiki-light': 'var(--shiki-token-keyword)', '--shiki-dark': 'var(--shiki-token-keyword)' }}>const</pre>
    </div>
  );
}
createRoot(document.getElementById('root')).render(<Fixture />);
`;

const tile = (label) => `document.querySelector('[role="radio"][aria-label="${label}"]')`;
const mode = (label) => `document.querySelector('[role="radiogroup"][aria-label="Mode"] [aria-label="${label}"]')`;
const pageIs = (hex) => `getComputedStyle(document.documentElement).getPropertyValue('--page').trim() === '${hex}'`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", fs.mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-theming-")));
  await app.whenReady();
  const window = new BrowserWindow({ width: 1100, height: 700, show: false, webPreferences: { backgroundThrottling: false } });
  window.webContents.session.setPermissionRequestHandler((_, __, callback) => callback(true));
  window.webContents.session.setPermissionCheckHandler(() => true);
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
    fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, name + ".png"), (await window.webContents.capturePage()).toPNG());
  };
  const page = () => evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--page').trim()`);
  try {
    await window.loadURL(process.argv[2]);
    await waitFor(`!!${tile("Milagre Blue")}`);
    assert.equal(await evaluate(`${tile("Milagre Blue")}.getAttribute('aria-checked')`), "true", "Milagre Blue is the default");
    await evaluate(`${mode("Dark")}.click()`);
    await waitFor(`document.documentElement.classList.contains('dark')`);
    const blueDark = await page();
    await screenshot("milagre-blue-dark");
    await evaluate(`${mode("Light")}.click()`);
    await waitFor(`!document.documentElement.classList.contains('dark')`);
    await screenshot("milagre-blue-light");
    await evaluate(`${mode("Dark")}.click()`);
    await evaluate(`${tile("Catppuccin Mocha")}.click()`);
    await waitFor(pageIs("#1e1e2e"));
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.code-token')).color`), "rgb(203, 166, 247)", "code follows the theme");
    assert.equal(await evaluate(`getComputedStyle(document.body).backgroundColor`), "rgb(30, 30, 46)", "the striped body follows the theme");
    await screenshot("catppuccin-mocha-dark");
    await evaluate(`${mode("Light")}.click()`);
    await waitFor(pageIs("#eff1f5"));
    assert.equal(
      await evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--ansi-1').trim()`),
      "#d20f39",
      "terminal colors follow the theme",
    );
    const termTheme = () => evaluate(`JSON.stringify(window.__term.options.theme)`).then(JSON.parse);
    await evaluate(`window.__mountTerminal()`);
    const latte = await termTheme();
    assert.equal(latte.red, "#d20f39", "a live xterm session paints with the Latte red");
    assert.equal(latte.foreground, "#4c4f69", "a live xterm session paints with the Latte ink");
    await evaluate(`${mode("Dark")}.click()`);
    await waitFor(pageIs("#1e1e2e"));
    await waitFor(`window.__term.options.theme.foreground !== '#4c4f69'`);
    const mocha = await termTheme();
    assert.equal(mocha.red, "#f38ba8", "switching theme repaints the live xterm (red)");
    assert.equal(mocha.foreground, "#cdd6f4", "switching theme repaints the live xterm (foreground)");
    await evaluate(`${mode("Light")}.click()`);
    await waitFor(pageIs("#eff1f5"));
    await waitFor(`window.__term.options.theme.red === '#d20f39'`);
    await waitFor(`window.__windowBackground === '#eff1f5'`);
    await screenshot("catppuccin-latte");
    await evaluate(`${tile("Gray")}.click()`);
    await waitFor(pageIs("#fafafb"));
    assert.equal(await evaluate(`JSON.parse(localStorage.getItem('milagre-settings')).colorTheme`), "gray", "the choice is saved");
    assert.notEqual(blueDark, "#17181a", "Milagre Blue dark is not Gray dark");
    assert.equal(await evaluate(`document.querySelectorAll('#milagre-theme').length`), 1, "one theme stylesheet is reused");
    await screenshot("gray-light");
    // Custom theme editor in Appearance
    const custom = `document.querySelector('[role="checkbox"][aria-label="Custom theme"]')`;
    await waitFor(`!!${custom}`);
    await evaluate(`${custom}.click()`);
    await waitFor(`!!document.querySelector('input[aria-label="Accent hex"]')`);
    assert.ok(await evaluate(`!!document.querySelector('[role="radiogroup"][aria-label="Editing"]')`), "Editing control");
    assert.ok(await evaluate(`!!document.querySelector('[data-contrast]')`), "contrast line");
    await evaluate(`(() => { const input = document.querySelector('input[aria-label="Accent hex"]');
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(input, '#e85d9a');
      input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); input.dispatchEvent(new Event('blur', { bubbles: true })); })()`);
    await waitFor(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === '#e85d9a'`);
    await screenshot("custom-editor");
    window.webContents.focus();
    require("electron").clipboard.writeText('{"light":1}');
    await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Paste JSON').click()`);
    await waitFor(`document.body.innerText.includes("That isn't a Milagre theme")`);
    assert.equal(await evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`), "#e85d9a");
    await screenshot("custom-editor-bad-paste");
    await evaluate(`navigator.clipboard.readText = () => Promise.reject(new Error('denied')), 0`);
    await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Paste JSON').click()`);
    await waitFor(`document.body.innerText.includes("Could not read the clipboard.")`);
    assert.ok(!(await evaluate(`document.body.innerText.includes("That isn't a Milagre theme")`)), "a failed clipboard read is not a bad theme");
    await evaluate(`delete navigator.clipboard.readText`);
    // Dragging the color picker: many ticks in one frame make one settings write, and the swatch follows the last tick.
    await evaluate(`(() => {
      window.__writes = 0;
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) { if (key === 'milagre-settings') window.__writes++; return set.call(this, key, value); };
      const input = document.querySelector('input[type="color"][aria-label="Accent"]');
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      for (const hex of ['#112233', '#223344', '#334455', '#445566', '#556677', '#778899']) {
        setValue.call(input, hex);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      window.__swatch = input.value;
    })()`);
    assert.equal(await evaluate(`window.__swatch`), "#778899", "the swatch follows every tick");
    await waitFor(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === '#778899'`);
    assert.equal(await evaluate(`window.__writes`), 1, "six picker ticks in one frame are one settings write");
    await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Copy as JSON').click()`);
    const clipboard = require("electron").clipboard;
    for (let i = 0; i < 100 && !/#778899/.test(await clipboard.readText()); i++) await delay(25);
    assert.match(await clipboard.readText(), /#778899/, "Copy as JSON writes the seeds");
    await evaluate(`${custom}.click()`);
    await waitFor(`JSON.parse(localStorage.getItem('milagre-settings')).colorTheme === 'milagre-blue'`);
    assert.equal(await evaluate(`JSON.parse(localStorage.getItem('milagre-settings')).customTheme.light.accent`), "#778899");
    assert.deepEqual(errors, []);
    console.log(
      "PASS: Appearance defaults to Milagre Blue; picking a theme and a mode recolors the page, body, code and window background, one stylesheet is reused, and the choice is saved",
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
    cacheDir: path.resolve(__dirname, "../node_modules/.vite-theming"),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "theming-fixture",
        resolveId(id) {
          if (id === "/__theming.tsx") return id;
        },
        load(id) {
          if (id === "/__theming.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url !== "/__theming") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await server.transformIndexHtml(
                request.url,
                '<html><body><div id="root"></div><script type="module" src="/__theming.tsx"></script></body></html>',
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
    const child = require("node:child_process").spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__theming`], {
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
