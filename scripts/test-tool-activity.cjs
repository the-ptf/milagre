// Real renderer regression: source marks, exact arguments, bounded output, failure reasons and linked approvals.
const assert = require("node:assert/strict");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ActivityBlock, ActivityApprovalContext } from "/src/components/agents/ActivityBlock";
import "/src/styles.css";
document.documentElement.classList.add("dark");
document.body.style.background = "var(--page)";
const now = Date.now();
const calls = [
 { type: "step", step: { id: "linear", kind: "other", title: "Used \\u0060list_issues\\u0060 from linear", source: { server: "linear", name: "list_issues" }, input: JSON.stringify({ query: "Tool call UI" }, null, 2), summary: "2 results", detail: '[{"id":"ENG-12"},{"id":"ENG-13"}]', status: "done", startedAt: now - 8400, endedAt: now - 7200, durationMs: 1200 } },
 { type: "step", step: { id: "failed", kind: "shell", title: "Ran \\u0060npm test\\u0060", input: "npm test", summary: "Failed", error: "Error: missing Authorization header", detail: "$ npm test\\n" + Array.from({ length: 65 }, (_, i) => "line " + i).join("\\n") + "\\nError: missing Authorization header", status: "failed", startedAt: now - 7000, endedAt: now - 2800, durationMs: 4200 } },
 { type: "step", step: { id: "push", kind: "shell", title: "Ran \\u0060git push\\u0060", detail: "$ git push\\n", status: "running", startedAt: now - 1000 } }
];
function Fixture() {
 const [waiting, setWaiting] = useState(true);
 return <main style={{ width: 680, margin: "64px auto" }}>
  <p style={{ color: "var(--ink)", marginBottom: 20 }}>I'll review the tool calls and run their checks.</p>
  <ActivityApprovalContext.Provider value={waiting ? { stepId: "push", content: <button id="allow" onClick={() => setWaiting(false)}>Allow once</button> } : null}>
   <ActivityBlock entries={calls} streaming waitingStepIds={waiting ? ["push"] : []} />
  </ActivityApprovalContext.Provider>
 </main>;
}
createRoot(document.getElementById("root")).render(<Fixture />);
`;

async function check() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", require("node:fs").mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-tool-activity-")));
  await app.whenReady();
  const window = new BrowserWindow({ width: 1000, height: 800, show: false, webPreferences: { backgroundThrottling: false } });
  const run = (code) => window.webContents.executeJavaScript(code);
  const wait = async (code) => {
    for (let i = 0; i < 160; i++) {
      if (await run(code)) return;
      await delay(25);
    }
    throw new Error(`Timed out: ${code}`);
  };
  try {
    await window.loadURL(process.argv[2]);
    await wait('!!document.querySelector("[data-slot=activity]")');
    assert.equal(await run('document.querySelectorAll("#allow").length'), 1, "a collapsed group does not hide or duplicate its approval");
    assert.ok(
      await run(
        '(() => { const node = document.querySelector("[data-slot=activity-sources] > span"); return parseFloat(getComputedStyle(node).borderRadius) >= node.getBoundingClientRect().width / 2; })()',
      ),
      "source marks are fully circular",
    );
    assert.ok(await run('!!document.querySelector("[data-slot=activity-sources] [data-linear-logo]")'));
    await run('document.querySelector("[data-slot=activity] > button").click()');
    await wait('document.querySelectorAll("[data-slot=step]").length === 3');
    assert.equal(await run('document.querySelectorAll("#allow").length'), 1);
    await run('document.querySelector("[data-slot=activity] > button").click()');
    assert.equal(await run('document.querySelectorAll("#allow").length'), 1, "closing mounted rows keeps one usable approval");
    await run('document.querySelector("[data-slot=activity] > button").click()');
    assert.ok(
      await run('document.querySelector("[data-status=failed]").textContent.includes("Error: missing Authorization header")'),
      "the reason is available before disclosure",
    );
    await run('document.querySelector("[data-slot=step] button[aria-expanded]").click()');
    await wait('document.querySelector("[data-slot=step]").textContent.includes("Tool call UI")');
    assert.ok(await run('document.querySelector("[data-slot=step]").textContent.includes("Input")'));
    assert.ok(await run('document.querySelector("[data-slot=step]").textContent.includes("2 results")'));
    await run('document.querySelector("[data-status=failed] button[aria-expanded]").click()');
    await wait('document.querySelector("[data-status=failed]").textContent.includes("Show 26 earlier lines")');
    assert.equal(await run('document.querySelector("[data-status=failed]").textContent.includes("line 0")'), false);
    await run('[...document.querySelectorAll("[data-status=failed] button")].find(b => b.textContent.includes("earlier lines")).click()');
    await wait('document.querySelector("[data-status=failed]").textContent.includes("line 0")');
    await run('document.getElementById("allow").click()');
    await wait('!document.getElementById("allow")');
    assert.equal(
      await run('document.querySelector("[data-slot=step] button[aria-expanded]").getAttribute("aria-expanded")'),
      "true",
      "resolving approval preserves open output",
    );
    if (process.env.MILAGRE_SCREENSHOT_DIR) {
      await delay(400);
      const fs = require("node:fs");
      fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, "tool-activity.png"), (await window.webContents.capturePage()).toPNG());
    }
    console.log("PASS: source stack, Linear logo, exact input, bounded output, visible failure cause, linked approval and retained disclosure");
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
    cacheDir: "node_modules/.vite-tool-activity",
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "tool-activity-fixture",
        resolveId(id) {
          if (id === "/__tool_activity.tsx") return id;
        },
        load(id) {
          if (id === "/__tool_activity.tsx") return fixture;
        },
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== "/__tool_activity") return next();
            server
              .transformIndexHtml(request.url, '<html><body><div id="root"></div><script type="module" src="/__tool_activity.tsx"></script></body></html>')
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
    const child = spawn(require("electron"), [__filename, `${server.resolvedUrls.local[0]}__tool_activity`], { env, stdio: "inherit" });
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
