// Real renderer component; scripted frame transport is regression evidence only.
const assert = require("node:assert/strict");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ComputerUseCard } from "/src/components/agents/ComputerUseCard";
import "/src/styles.css";
window.reads = [];
window.answer = { seq: 0, live: false };
window.offline = false;
window.milagre = { computerUse: { frame: async request => {
 window.reads.push(request.after);
 if (window.offline) throw new Error("Connection lost");
 return window.answer;
} } };
const first = { id: "first", kind: "other", title: "Read TextEdit", status: "running", startedAt: Date.now() };
function Fixture() {
 const [steps, setSteps] = useState([first]);
 window.complete = () => setSteps([{ ...first, status: "done", endedAt: Date.now() }]);
 return <main style={{padding: 20}}><ComputerUseCard steps={steps} /></main>;
}
createRoot(document.getElementById("root")).render(<Fixture />);
`;
async function check() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", require("node:fs").mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-screen-card-")));
  await app.whenReady();
  const window = new BrowserWindow({ width: 1000, height: 700, show: false, webPreferences: { backgroundThrottling: false } });
  window.webContents.on("console-message", (details) => {
    if (details.level === "error") console.error(details.message);
  });
  const run = (code) => window.webContents.executeJavaScript(code);
  const wait = async (code) => {
    for (let i = 0; i < 120; i++) {
      if (await run(code)) return;
      await delay(50);
    }
    throw new Error(`Timed out: ${code}`);
  };
  try {
    await window.loadURL(process.argv[2]);
    await wait('!!document.querySelector("[data-computer-use-card]") && window.reads.length === 1');
    assert.equal(await run('!!document.querySelector("[data-computer-use-card] img")'), false);
    await run(
      'window.complete(); window.answer = { seq: 1, live: true, at: Date.now(), app: "TextEdit", image: "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", mime: "image/gif" }',
    );
    await wait('!!document.querySelector("[data-computer-use-card] img") && !!document.querySelector("[data-computer-use-live]")');
    assert.equal(await run('document.querySelectorAll("[data-computer-use-step]").length'), 1);
    await run(`document.querySelector('button[aria-label="Make the screen larger"]').click()`);
    await wait(`!!document.querySelector('button[aria-label="Show the steps beside the screen"]')`);
    await run("window.answer = { ...window.answer, live: false }");
    await wait('!document.querySelector("[data-computer-use-live]")');
    assert.equal(await run('!!document.querySelector("[data-computer-use-card] img")'), true);
    await run("window.offline = true");
    await delay(1300);
    await run('window.offline = false; window.answer = { ...window.answer, seq: 1, app: "Notes" }');
    await wait('document.querySelector("[data-computer-use-card] img")?.alt === "Notes"');
    assert.equal(await run("window.reads.at(-1)"), 0, "reconnect resets its cursor");
    console.log("PASS: delayed single first step, live/final image, expand and reconnect in the desktop card");
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
    cacheDir: "node_modules/.vite-computer-use-card",
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "computer-use-card-fixture",
        enforce: "pre",
        resolveId(id) {
          if (id === "/__computer_use_card.tsx") return id;
          if (id === "./ArtifactCard") return "\0screen-chat";
        },
        load(id) {
          if (id === "/__computer_use_card.tsx") return fixture;
          if (id === "\0screen-chat") return 'export const useReplyChatId = () => "/fixture#1";';
        },
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== "/__computer_use_card") return next();
            server
              .transformIndexHtml(request.url, '<html><body><div id="root"></div><script type="module" src="/__computer_use_card.tsx"></script></body></html>')
              .then((html) => {
                response.setHeader("Content-Type", "text/html");
                return response.end(html);
              })
              .catch((error) => {
                response.statusCode = 500;
                return response.end(String(error));
              });
          });
        },
      },
    ],
  });
  try {
    await server.listen();
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require("electron"), [__filename, `${server.resolvedUrls.local[0]}__computer_use_card`], { env, stdio: "inherit" });
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    await server.close();
  }
}
(process.versions.electron ? check() : main()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
