// Browser check: Settings > About lets the user pick the Beta release channel and hands the choice to the main process.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");

const fixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import { AboutSettings } from "/src/components/Settings";
import "/src/styles.css";
window.__channelCalls = [];
window.milagre = {
  getAppVersion: async () => "1.2.3",
  getReleaseChannel: async () => "stable",
  setReleaseChannel: async (channel) => { window.__channelCalls.push(channel); return channel; },
  getUpdateState: async () => ({ status: "idle", version: null, progress: 0 }),
  checkForUpdates: async () => ({ status: "up-to-date", version: null, progress: 0 }),
  readAutoUpdate: async () => ({ autoUpdate: false }),
  saveAutoUpdate: async (value) => ({ autoUpdate: value }),
  onAutoUpdate: () => () => {},
  installUpdate: async () => {},
  onUpdateState: () => () => {},
};
document.documentElement.classList.add("dark");
createRoot(document.getElementById("root")).render(
  <div style={{ maxWidth: 640, margin: "60px auto" }}><AboutSettings update={{ status: "up-to-date", version: null, progress: 0 }} /></div>,
);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  await app.whenReady();
  const window = new BrowserWindow({
    width: 900,
    height: 520,
    show: false,
    webPreferences: { backgroundThrottling: false, partition: "release-channel-check" },
  });
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  async function waitFor(source) {
    for (let i = 0; i < 200; i++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw new Error(`Timed out: ${source}`);
  }
  const screenshot = async (name) => {
    const dir = process.env.MILAGRE_SCREENSHOT_DIR;
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    await delay(200);
    fs.writeFileSync(path.join(dir, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  };
  const trigger = 'document.querySelector("button[aria-label=\\"Release channel\\"]")';
  try {
    await window.loadURL(process.argv[2]);
    await waitFor(`!!${trigger}`);
    await delay(300);
    assert.match(await evaluate(`${trigger}.textContent`), /Stable/);
    assert.match(await evaluate("document.body.innerText"), /Stable gets releases after they have run on Beta/);
    await evaluate(`${trigger}.click()`);
    await waitFor('!!document.querySelector("[role=listbox][aria-label=\\"Release channel\\"]")');
    await delay(300);
    await evaluate('[...document.querySelectorAll("[role=option]")].find(n => n.textContent.includes("Beta")).click()');
    await delay(400);
    assert.deepEqual(await evaluate("window.__channelCalls"), ["beta"]);
    assert.match(await evaluate("document.body.innerText"), /Beta gets a build most days main changes/);
    assert.match(await evaluate(`${trigger}.textContent`), /Beta/);
    await screenshot("settings-release-channel");
    console.log("PASS: Settings picks the Beta release channel and hands it to the main process");
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
        name: "release-channel-fixture",
        resolveId(id) {
          if (id === "/__release_channel_fixture.tsx") return id;
        },
        load(id) {
          if (id === "/__release_channel_fixture.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url !== "/__release_channel__") return next();
            const html = await server.transformIndexHtml(
              request.url,
              '<html><body><div id="root"></div><script type="module" src="/__release_channel_fixture.tsx"></script></body></html>',
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
    const child = spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__release_channel__`], { env, stdio: "inherit" });
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
