// Real Electron layout and selection checks for the new Chat branch/worktree picker.
// MILAGRE_SCREENSHOT_DIR saves images outside the repo.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");
const long = "fix/a-very-long-branch-name-with-a-common-prefix-but-a-different-ending";
const fixture = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '/src/styles.css';
import { NewChatHeader } from '/src/components/ChatComposer';
const branches = ['main', 'milagre/resolve-pr-246-conflicts-and-mj8k', '${long}-one', '${long}-two'];
const worktrees = [{ id: 1, name: 'main', path: '/fixture' }, { id: 2, name: branches[2], path: '/worktrees/ending-one' }];
function Fixture() {
  const [isolation, setIsolation] = useState('worktree');
  const [baseBranch, setBaseBranch] = useState('main');
  const [selectedWorktreeId, setWorktree] = useState(1);
  // At the bottom, as above the composer, so the pickers open upward.
  return <div style={{ position: 'fixed', left: 40, right: 40, bottom: 40 }}><NewChatHeader worktrees={worktrees} branches={branches} isolation={isolation} onIsolationChange={setIsolation} baseBranch={baseBranch} onBaseBranchChange={setBaseBranch} selectedWorktreeId={selectedWorktreeId} onWorktreeChange={setWorktree} /></div>;
}
createRoot(document.getElementById('root')).render(<Fixture />);
`;

async function checks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "milagre-branch-picker-")));
  await app.whenReady();
  const window = new BrowserWindow({ width: 900, height: 680, show: false, webPreferences: { backgroundThrottling: false } });
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  async function waitFor(source) {
    for (let n = 0; n < 200; n++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw new Error("Timed out: " + source);
  }
  const click = (name) => evaluate(`[...document.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(name)}).click()`);
  const type = (value) =>
    evaluate(
      `(() => { const input = document.querySelector('input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`,
    );
  async function screenshot(name) {
    if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
    await delay(250);
    fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, name + ".png"), (await window.webContents.capturePage()).toPNG());
  }
  try {
    await window.loadURL(process.argv[2]);
    await waitFor(`!!document.querySelector('[data-new-chat-pickers]')`);
    await click("main");
    await waitFor(`document.querySelectorAll('[data-picker-row]').length === 4`);
    assert.equal(
      await evaluate(`(() => {
      return [...document.querySelectorAll('[data-picker-row]')].every(row => {
        const label = row.querySelector('strong');
        return row.scrollWidth <= row.clientWidth && label.scrollWidth <= label.clientWidth && label.getBoundingClientRect().right < row.getBoundingClientRect().right;
      });
    })()`),
      true,
      "full names must fit their rows without horizontal overflow",
    );
    assert.equal(
      await evaluate(`(() => {
      const search = document.querySelector('input').getBoundingClientRect();
      return [...document.querySelectorAll('[data-picker-row]')].every(row => row.getBoundingClientRect().bottom <= search.top);
    })()`),
      true,
      "search stays below the branch list",
    );
    await screenshot("desktop-branches");
    await type("  ENDING-TWO  ");
    await waitFor(`document.querySelectorAll('[data-picker-row]').length === 1`);
    await screenshot("desktop-search");
    await evaluate(`document.querySelector('input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
    await waitFor(`!document.querySelector('input')`);
    assert.equal(await evaluate(`document.querySelector('[data-new-chat-pickers]').textContent.includes('ending-two')`), true);
    await click("New worktree");
    await waitFor(`document.querySelectorAll('[data-picker-row]').length === 2`);
    await evaluate(`[...document.querySelectorAll('[data-picker-row]')].find(row => row.textContent.includes('Local')).click()`);
    await click("main");
    await waitFor(`!!document.querySelector('input[placeholder="Search worktrees"]')`);
    await type("ending-one");
    await waitFor(`document.querySelectorAll('[data-picker-row]').length === 1`);
    await screenshot("desktop-worktrees");
    await evaluate(`document.querySelector('[data-picker-row]').click()`);
    await waitFor(`!document.querySelector('input')`);
    assert.equal(await evaluate(`document.querySelector('[data-new-chat-pickers]').textContent.includes('ending-one')`), true);
    console.log("PASS: full branch names fit; search and keyboard selection pick the right branch; worktree selection works");
    app.exit(0);
  } catch (error) {
    console.error(error);
    await screenshot("failure");
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
        name: "branch-picker-fixture",
        enforce: "pre",
        transform(source, id) {
          if (id.endsWith("/components/ChatComposer.tsx")) return source + "\nexport { NewChatHeader };\n";
        },
        resolveId(id) {
          if (id === "/__branch_picker_fixture.tsx") return id;
        },
        load(id) {
          if (id === "/__branch_picker_fixture.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url !== "/__branch_picker__") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await server.transformIndexHtml(
                request.url,
                '<html><body><div id="root"></div><script type="module" src="/__branch_picker_fixture.tsx"></script></body></html>',
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
    const child = spawn(require("electron"), [__filename, server.resolvedUrls.local[0] + "__branch_picker__"], { env, stdio: "inherit" });
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
