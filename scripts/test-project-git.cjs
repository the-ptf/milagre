// Project Git settings in real Electron. Screenshots are test evidence only.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");

const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import '/src/styles.css';
import { ProjectGitSettings } from '/src/components/ProjectGitSettings';
import { BRANCH_POLICY_DEFAULTS } from '@milagre/shared/branch-policy';
window.saved = { local: {}, repository: {}, effective: { ...BRANCH_POLICY_DEFAULTS } };
window.milagre = {
  readProjectGit: async () => window.saved,
  saveProjectGit: async (_path, local) => {
    window.saved = { local, repository: {}, effective: { ...BRANCH_POLICY_DEFAULTS, ...local } };
    return window.saved;
  }
};
createRoot(document.getElementById('root')).render(<div className="h-screen bg-page p-4"><ProjectGitSettings projectPath="/fixture" /></div>);
`;

async function checks() {
  const { app, BrowserWindow } = require("electron");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-project-git-"));
  app.setPath("userData", profile);
  await app.whenReady();
  const window = new BrowserWindow({ width: 900, height: 1050, show: false, webPreferences: { backgroundThrottling: false } });
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  async function waitFor(source) {
    for (let n = 0; n < 200; n++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw new Error("Timed out: " + source);
  }
  const fill = (selector, value) =>
    evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  async function screenshot(name) {
    if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
    await delay(250);
    fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, name + ".png"), (await window.webContents.capturePage()).toPNG());
  }
  try {
    await window.loadURL(process.argv[2]);
    await waitFor(`!!document.querySelector('#branch-template')`);
    // Token chips build the template at the caret, with a dash between parts.
    await evaluate(`document.querySelector('[data-branch-token="username"]').click()`);
    await evaluate(`document.querySelector('[data-branch-token="slug"]').click()`);
    await waitFor(`document.querySelector('#branch-template').value === '{username}-{slug}'`);
    await fill("#branch-template", "{username}-{ticket?}-{slug}");
    await fill('input[aria-label="Username"]', "victorlucss");
    await fill('input[aria-label="Base branch"]', "release/business-app/v2");
    await evaluate(`document.querySelector('[aria-label="Dashes only"]').click()`);
    await waitFor(`document.querySelector('[data-branch-preview]').textContent === 'victorlucss-eng-123-fix-login'`);
    // Saves as you type, without a Save button.
    await waitFor(`window.saved.local.baseBranch === 'release/business-app/v2' && window.saved.local.username === 'victorlucss'`);
    assert.equal(await evaluate(`window.saved.local.dashesOnly`), true);
    assert.equal(await evaluate(`window.saved.local.trackBase ?? false`), false);
    await screenshot("project-git-desktop");
    await fill("#branch-template", "milagre/{slug}");
    await waitFor(`!!document.querySelector('[role="alert"]')`);
    await delay(800);
    assert.equal(await evaluate(`window.saved.local.template`), "{username}-{ticket?}-{slug}", "an invalid template is never saved");
    await screenshot("project-git-invalid");
    await evaluate(`document.querySelector('[data-branch-reset]').click()`);
    await waitFor(`Object.keys(window.saved.local).length === 0`);
    await waitFor(`document.querySelector('[data-branch-preview]')?.textContent === 'milagre/fix-login-ab12'`);
    assert.equal(await evaluate(`!!document.querySelector('[data-branch-reset]')`), false);
    console.log("PASS Project Git settings: tokens, preview, autosave, validation and reset");
  } finally {
    window.destroy();
    app.quit();
  }
}

async function main() {
  const { createServer } = await import("vite");
  const { spawn } = require("node:child_process");
  const server = await createServer({
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "project-git-fixture",
        resolveId(id) {
          if (id === "/__project_git_fixture.tsx") return id;
        },
        load(id) {
          if (id === "/__project_git_fixture.tsx") return fixture;
        },
        configureServer(vite) {
          useAsyncMiddleware(vite.middlewares, async (request, response, next) => {
            if (request.url !== "/__project_git__") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await vite.transformIndexHtml(
                request.url,
                '<html><body><div id="root"></div><script type="module" src="/__project_git_fixture.tsx"></script></body></html>',
              ),
            );
          });
        },
      },
    ],
  });
  try {
    await server.listen();
    const env = { ...process.env, MILAGRE_BACKGROUND: "1" };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require("electron"), [__filename, server.resolvedUrls.local[0] + "__project_git__"], { env, stdio: "inherit" });
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    await server.close();
  }
}
(process.versions.electron ? checks() : main()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
