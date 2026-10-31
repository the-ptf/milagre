// Run with npm test -- --only add-project-remote. Add project with another computer, in Electron against a stand-in for
// the bridges: the computer is chosen first (an offline one is disabled), This Mac keeps its folder dialog, and another
// computer's home folder is browsed there with a breadcrumb, each folder tagged "Added" or "git · branch", and the chosen
// checkout opens on that computer. Set MILAGRE_SCREENSHOT_DIR to save screenshots.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");
const { ThisComputer } = require("@milagre/shared/host-computer");

const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { AddProjectDialog } from "/src/components/AddProjectDialog";
import { updateSettings } from "/src/lib/settings";
import "/src/styles.css";
const HOME = "/Users/a";
const listings = {
  [HOME]: { path: HOME, home: HOME, parent: null, entries: [{ name: "Code", path: HOME + "/Code", git: false, branch: null, project: false }, { name: "notes", path: HOME + "/notes", git: false, branch: null, project: false }] },
  [HOME + "/Code"]: { path: HOME + "/Code", home: HOME, parent: HOME, entries: [
    { name: "arketa-web", path: HOME + "/Code/arketa-web", git: true, branch: "main", project: true },
    { name: "billing-service", path: HOME + "/Code/billing-service", git: true, branch: "main", project: false },
    { name: "scratch", path: HOME + "/Code/scratch", git: false, branch: null, project: false },
  ] },
};
window.listed = [];
window.opened = [];
window.localDialogs = 0;
const arketa = { listDirs: async ({ path } = {}) => (window.listed.push(path ?? null), listings[path ?? HOME]), openProjectAt: async (folder) => (window.opened.push(folder), { path: "c-arketa|" + folder, name: folder.split("/").pop(), state: {} }) };
window.milagre = {
  openProject: async () => (window.localDialogs++, null),
  on: (id) => (id === "c-arketa" ? arketa : {}),
  onComputersChanged: (callback) => ((window.pushComputers = (computers) => callback({ thisMac: "victor-mbp", computers })), () => {}),
  computers: { list: async () => ({ thisMac: "victor-mbp", computers: [
    { id: "c-arketa", name: "arketa", hostId: "a".repeat(22), relayHost: "relay.milagre.cloud", state: "online", route: "lan", lastSeen: Date.now(), addedAt: 1, message: null, lan: true, lanRoutes: [] },
    { id: "c-studio", name: "studio", hostId: "s".repeat(22), relayHost: "relay.milagre.cloud", state: "offline", route: null, lastSeen: Date.now() - 7200000, addedAt: 1, message: null, lan: false, lanRoutes: [] },
  ] }) },
};
updateSettings({ otherComputers: true });
function Fixture() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button data-reopen onClick={() => setOpen(true)}>Reopen</button>
      {open ? <AddProjectDialog onClose={() => setOpen(false)} onOpened={(project) => { window.added = project.path; setOpen(false); }} /> : <output data-closed />}
    </>
  );
}
createRoot(document.getElementById("root")).render(<Fixture />);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "milagre-add-project-remote-")));
  await app.whenReady();
  const window = new BrowserWindow({ width: 960, height: 760, show: false, webPreferences: { backgroundThrottling: false } });
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
    throw new Error(`Timed out: ${source}`);
  };
  const screenshot = async (name) => {
    if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
    fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
    window.webContents.invalidate();
    await delay(250);
    fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, name + ".png"), (await window.webContents.capturePage()).toPNG());
  };
  try {
    await window.loadURL(process.argv[2]);
    const text = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent.trim() ?? null`);
    const on = (id) => `document.querySelector('[data-add-project-on="${id}"]')`;
    await waitFor(`document.querySelector('dialog[data-add-project]')?.open && !!${on("c-studio")}`);
    assert.equal(await evaluate(`${on("c-studio")}.disabled`), true, "an offline computer can't be chosen");
    assert.match(await text('[data-add-project-on="c-arketa"]'), /arketa\s*Same network/);
    assert.match(await text('[data-add-project-on="this-mac"]'), new RegExp(`victor-mbp\\s*${ThisComputer}`));
    await evaluate(`${on("this-mac")}.click()`);
    await evaluate(`[...document.querySelectorAll('dialog button')].find((b) => b.textContent.trim() === 'Choose folder…').click()`);
    await waitFor(`window.localDialogs === 1`);
    console.log("PASS: This Mac's choice runs the folder dialog, and an offline computer is disabled");

    await evaluate(`${on("c-arketa")}.click()`);
    await waitFor(`!!document.querySelector('[data-folder="Code"]')`);
    assert.equal(await text("[data-folder-path]"), "~ /");
    await evaluate(`document.querySelector('[data-folder="Code"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await waitFor(`!!document.querySelector('[data-folder="billing-service"]')`);
    assert.equal(await text("[data-folder-path]"), "~ / Code /");
    assert.deepEqual(
      await evaluate(
        `[...document.querySelectorAll('[data-folder]')].map((row) => [row.dataset.folder, row.querySelector('[data-folder-tag]')?.textContent.trim() ?? ""])`,
      ),
      [
        ["arketa-web", "Added"],
        ["billing-service", "git · main"],
        ["scratch", ""],
      ],
    );
    assert.match(await text("dialog[data-add-project]"), /Opens on arketa\. Its daemon owns the Project; this window drives it\./);
    await evaluate(`document.querySelector('[data-folder="billing-service"]').click()`);
    await waitFor(`[...document.querySelectorAll('dialog button')].some((b) => b.textContent.trim() === 'Add billing-service' && !b.disabled)`);
    await screenshot("add-project-remote");
    await evaluate(`[...document.querySelectorAll('dialog button')].find((b) => b.textContent.trim() === 'Add billing-service').click()`);
    await waitFor(`window.added === 'c-arketa|/Users/a/Code/billing-service' && !!document.querySelector('[data-closed]')`);
    assert.deepEqual(await evaluate(`window.opened`), ["/Users/a/Code/billing-service"]);
    console.log("PASS: another computer's folders are browsed there, tagged, and the chosen checkout opens on it");

    // An Added folder is opened (switched to), not added a second time.
    const button = (label) => `[...document.querySelectorAll('dialog button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})`;
    await evaluate(`document.querySelector('[data-reopen]').click()`);
    await waitFor(`document.querySelector('dialog[data-add-project]')?.open`);
    await evaluate(`${on("c-arketa")}.click()`);
    await waitFor(`!!document.querySelector('[data-folder="Code"]')`);
    await evaluate(`document.querySelector('[data-folder="Code"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await waitFor(`!!document.querySelector('[data-folder="arketa-web"]')`);
    await evaluate(`document.querySelector('[data-folder="arketa-web"]').click()`);
    await waitFor(`!!${button("Open arketa-web")} && !${button("Open arketa-web")}.disabled`);
    await evaluate(`${button("Open arketa-web")}.click()`);
    await waitFor(`window.added === 'c-arketa|/Users/a/Code/arketa-web' && !!document.querySelector('[data-closed]')`);

    // The chosen computer going offline stops the browser and disables Add; removing it falls back to This Mac.
    const computerList = (state) =>
      `[{ id: "c-arketa", name: "arketa", hostId: "a".repeat(22), relayHost: "relay.milagre.cloud", state: ${JSON.stringify(state)}, route: null, lastSeen: Date.now(), addedAt: 1, message: null, lan: false, lanRoutes: [] }]`;
    await evaluate(`document.querySelector('[data-reopen]').click()`);
    await waitFor(`document.querySelector('dialog[data-add-project]')?.open`);
    await evaluate(`${on("c-arketa")}.click()`);
    await waitFor(`!!document.querySelector('[data-folder="Code"]')`);
    await evaluate(`document.querySelector('[data-folder="Code"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await waitFor(`!!document.querySelector('[data-folder="billing-service"]')`);
    await evaluate(`document.querySelector('[data-folder="billing-service"]').click()`);
    await waitFor(`!${button("Add billing-service")}.disabled`);
    await evaluate(`window.pushComputers(${computerList("offline")})`);
    await waitFor(`!!document.querySelector('[data-add-project-away]')`);
    const reads = await evaluate(`window.listed.length`);
    assert.equal(await evaluate(`${button("Add billing-service")}.disabled`), true, "Add waits for the computer to be online");
    await evaluate(`window.pushComputers([])`);
    await waitFor(`!!${button("Choose folder…")} && !document.querySelector('[data-add-project-away]')`);
    assert.equal(await evaluate(`window.listed.length`), reads, "nothing is read from an offline computer");
    console.log("PASS: an Added folder opens, and an offline or removed computer stops the browser");

    // A press on the scrim closes the dialog.
    await evaluate(`document.querySelector('dialog[data-add-project]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    await waitFor(`!!document.querySelector('[data-closed]')`);
    assert.deepEqual(errors, []);
    console.log("PASS: a press on the scrim closes the dialog");
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.error(errors);
    await screenshot("failure").catch(() => {});
    app.exit(1);
  }
}

async function main() {
  const { createServer } = await import("vite");
  const server = await createServer({
    configFile: path.resolve(__dirname, "../apps/desktop/vite.config.ts"),
    cacheDir: path.resolve(__dirname, "../node_modules/.vite-add-project-remote"),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "add-project-remote-fixture",
        resolveId(id) {
          if (id === "/__add-project-remote.tsx") return id;
        },
        load(id) {
          if (id === "/__add-project-remote.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url !== "/__add-project-remote") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await server.transformIndexHtml(
                request.url,
                '<html><body><div id="root"></div><script type="module" src="/__add-project-remote.tsx"></script></body></html>',
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
    const child = require("node:child_process").spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__add-project-remote`], {
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
