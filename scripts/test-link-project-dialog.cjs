// The real Link dialog with a controlled registry response. --preview leaves the mock open.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");
const preview = process.argv.includes("--preview");
const names = ["rd-mobile-backend", "rd-mobile", "food-api", "food-web", "rd-food-merchant", "rd-food-apps", "shared-components", "notifications-service"];
const projects = names.map((name) => ({
  id: `/preview/${name}/.git`,
  name,
  path: `/Users/victor/Code/projects/${name}`,
  lastOpenedAt: "2026-10-05T12:00:00.000Z",
}));
const fixture = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LinkProjectDialog } from '/src/components/LinkProjectDialog';
import '/src/styles.css';
const projects = ${JSON.stringify(projects)};
window.milagre = {
  listProjects: () => window.projectsLoaded ? Promise.resolve(projects) : new Promise(resolve => { window.finishProjectLoading = () => { window.projectsLoaded = true; resolve(projects); }; ${preview ? "setTimeout(window.finishProjectLoading, 1600);" : ""} }),
  getProjectImage: async () => null,
  createNamedLink: async request => ({ ...request, id: 'preview-link', createdAt: new Date().toISOString() }),
  updateNamedLink: async request => { window.updated = request; return { ...request, createdAt: new Date().toISOString() }; },
};
function Fixture() {
  const [open, setOpen] = useState(true);
  const [created, setCreated] = useState('');
  const [editing, setEditing] = useState(null);
  window.openLinkDialog = () => setOpen(true);
  window.editLinkDialog = link => { setEditing(link); setOpen(true); };
  return <main className="flex min-h-screen items-center justify-center bg-surface-2 p-8 text-ink">
    <div className="rounded-[16px] bg-surface p-8 shadow-raised">
      <p className="text-[12px] text-ink-3">Preview</p>
      <h1 className="mt-1 text-[20px] font-semibold">Link projects</h1>
      <p className="mt-2 text-[13px] text-ink-2">Eight Projects. Four visible rows.</p>
      <button className="mt-5 rounded-control bg-ink px-4 py-2 text-[13px] text-surface" onClick={() => setOpen(true)}>Open Link projects</button>
      {created && <p className="mt-3 text-[13px]">{created}</p>}
    </div>
    {open && <LinkProjectDialog key={editing?.id ?? 'new'} link={editing ?? undefined} onClose={() => setOpen(false)} onCreated={link => { setCreated(link.name + ' links ' + link.projectIds.length + ' Projects'); setOpen(false); }} />}
  </main>;
}
createRoot(document.getElementById('root')).render(<Fixture />);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-link-dialog-"));
  app.setPath("userData", profile);
  await app.whenReady();
  const window = new BrowserWindow({
    title: "Milagre: Link projects preview",
    width: 1000,
    height: 800,
    show: preview,
    webPreferences: { backgroundThrottling: false },
  });
  const evaluate = (source) => window.webContents.executeJavaScript(source);
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
    await delay(200);
    await window.webContents.capturePage();
    await delay(100);
    fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, name + ".png"), (await window.webContents.capturePage()).toPNG());
  };
  app.on("window-all-closed", () => app.quit());
  await window.loadURL(process.argv[2]);
  if (preview) {
    window.show();
    app.focus({ steal: true });
    window.focus();
    console.log("READY: Link dialog preview with eight mock Projects and a delayed registry response. Close and reopen to replay loading.");
    return;
  }
  try {
    await waitFor(`!!document.querySelector('#link-name')`);
    assert.equal(await evaluate(`document.querySelectorAll('dialog [role="status"] [aria-hidden="true"]').length`), 4, "Loading shows four skeleton rows");
    assert.equal(await evaluate(`document.querySelector('dialog').textContent.includes('No projects found.')`), false, "Loading is not an empty search result");
    assert.equal(await evaluate(`document.querySelector('dialog button[type=submit]').disabled`), true);
    await screenshot("link-loading");
    await evaluate("window.finishProjectLoading()");
    await waitFor(`document.querySelectorAll('dialog input[type=checkbox]').length === 8`);
    assert.equal(await evaluate(`!!document.querySelector('dialog [role="status"]')`), false);
    const list = await evaluate(
      `(() => { const rows = [...document.querySelectorAll('dialog label')].filter(row => row.querySelector('input[type=checkbox]')); const area = rows[0].parentElement; const first = rows[0].getBoundingClientRect(); const fourth = rows[3].getBoundingClientRect(); const fifth = rows[4].getBoundingClientRect(); const rect = area.getBoundingClientRect(); return { scrollable: area.scrollHeight > area.clientHeight, firstVisible: first.top >= rect.top, fourthVisible: fourth.bottom <= rect.bottom, fifthOutside: fifth.top >= rect.bottom - 5 }; })()`,
    );
    assert.deepEqual(
      list,
      { scrollable: true, firstVisible: true, fourthVisible: true, fifthOutside: true },
      "Four complete rows fit; additional Projects scroll",
    );
    await screenshot("link-project-list");
    await evaluate(
      `(() => { const area = document.querySelector('dialog input[type=checkbox]').closest('label').parentElement; area.scrollTop = area.scrollHeight; })()`,
    );
    assert.ok(
      await evaluate(
        `(() => { const row = [...document.querySelectorAll('dialog label')].find(row => row.textContent.includes('notifications-service')); const area = row.parentElement.getBoundingClientRect(); const rect = row.getBoundingClientRect(); return rect.top >= area.top && rect.bottom <= area.bottom; })()`,
      ),
      "The last Project is reachable by scrolling",
    );
    await screenshot("link-project-list-scrolled");

    // Editing: a member whose folder is gone is listed so it can be removed, and another Project can be added.
    await evaluate(`document.querySelector('dialog form button[type=button]').click()`);
    await waitFor(`!document.querySelector('dialog')`);
    await evaluate(
      `window.editLinkDialog({ id: 'food', name: 'RDFood', projectIds: ['/preview/food-api/.git', '/preview/food-web/.git', '/preview/gone-service/.git'], createdAt: '2026-10-01T00:00:00.000Z' })`,
    );
    await waitFor(`document.querySelectorAll('dialog input[type=checkbox]').length === 9`);
    assert.equal(await evaluate(`document.querySelector('#link-dialog-title').textContent`), "Edit Link");
    assert.equal(await evaluate(`document.querySelector('#link-name').value`), "RDFood");
    assert.equal(await evaluate(`document.querySelectorAll('dialog input[type=checkbox]:checked').length`), 3, "Current members start checked");
    const toggle = (name) =>
      evaluate(`[...document.querySelectorAll('dialog label')].find(row => row.textContent.includes(${JSON.stringify(name)})).querySelector('input').click()`);
    assert.ok(await evaluate(`[...document.querySelectorAll('dialog label')].some(row => row.textContent.includes('gone-serviceUnavailable'))`));
    await toggle("gone-service");
    await toggle("rd-food-merchant");
    await screenshot("link-edit");
    await evaluate(`document.querySelector('dialog button[type=submit]').click()`);
    await waitFor(`!!window.updated`);
    assert.deepEqual(await evaluate("window.updated"), {
      id: "food",
      name: "RDFood",
      projectIds: ["/preview/food-api/.git", "/preview/food-web/.git", "/preview/rd-food-merchant/.git"],
    });
    await waitFor(`document.body.textContent.includes('RDFood links 3 Projects')`);
    console.log("PASS: loading skeleton, no false empty state, four-row limit, scroll access to all eight Projects, and editing a Link's members.");
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
}

async function main() {
  const { createServer } = await import("vite");
  const server = await createServer({
    configFile: path.resolve(__dirname, "../apps/desktop/vite.config.ts"),
    cacheDir: path.resolve(__dirname, "../node_modules/.vite-link-dialog"),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "link-dialog-fixture",
        resolveId(id) {
          if (id === "/__link-dialog.tsx") return id;
        },
        load(id) {
          if (id === "/__link-dialog.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url !== "/__link-dialog") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await server.transformIndexHtml(
                request.url,
                '<html><body><div id="root"></div><script type="module" src="/__link-dialog.tsx"></script></body></html>',
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
    const child = spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__link-dialog`, ...(preview ? ["--preview"] : [])], {
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
