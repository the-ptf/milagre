const assert = require("node:assert/strict");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");
const capture = Boolean(process.env.MILAGRE_SCREENSHOT_DIR);
const fixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import { HandoffDivider } from "/src/components/Handover";
import "/src/styles.css";
const models = [
  { id: "opus-5.5", name: "Opus 5.5", provider: "claude" },
  { id: "gpt-6", name: "GPT-6", provider: "codex" },
];
const from = { provider: "claude", model: "opus-5.5" };
const to = { provider: "codex", model: "gpt-6" };
const brief = "# Goal\\n\\nFix the **login redirect**.";
const dividers = {
  preparing: { kind: "handoff", status: "preparing", from, to },
  done: { kind: "handoff", status: "done", from, to, brief },
  failed: { kind: "handoff", status: "failed", from, to },
  restored: { kind: "handoff", status: "done", from: to, to, brief },
};
function Fixture() {
  return <div style={{ width: 640, padding: "64px 16px 16px", display: "flex", flexDirection: "column", gap: 16 }}>
    {Object.entries(dividers).map(([name, context]) => (
      <section key={name} data-shot={name}><HandoffDivider context={context} models={models} /></section>
    ))}
  </div>;
}
document.documentElement.classList.add("dark");
document.body.style.cssText = "margin:0;background:#202123";
createRoot(document.getElementById("root")).render(<Fixture />);
`;

const divider = (name) => `document.querySelector('[data-shot="${name}"] [data-handoff-divider]')`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  await app.whenReady();
  const win = new BrowserWindow({ width: 680, height: 420, show: false, webPreferences: { backgroundThrottling: false } });
  const evaluate = (source) => win.webContents.executeJavaScript(source);
  async function waitFor(source) {
    for (let i = 0; i < 200; i++) {
      if (await evaluate(source)) return;
      await delay(20);
    }
    throw Error(`Timed out: ${source}`);
  }
  async function shot(name) {
    if (!capture) return;
    // A hidden window repaints lazily: wait for the frame that shows the last change.
    await evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    await delay(250);
    const fs = require("node:fs/promises");
    await fs.mkdir(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
    await fs.writeFile(path.join(process.env.MILAGRE_SCREENSHOT_DIR, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  }
  const text = (name) => evaluate(`${divider(name)}.textContent`);
  const press = (keyCode) => {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode });
  };
  try {
    await win.loadURL(process.argv[2]);
    await waitFor('document.querySelectorAll("[data-handoff-divider]").length === 4');
    for (const name of ["preparing", "done", "failed", "restored"]) {
      assert.equal(await evaluate(`${divider(name)}.dataset.status`), name === "restored" ? "done" : name);
      assert.equal(await evaluate(`${divider(name)}.getAttribute("role")`), "group");
      assert.ok(await evaluate(`${divider(name)}.getAttribute("aria-label")`));
      // Full width of the transcript column, with a hairline of equal length on each side of the label.
      const box = await evaluate(
        `JSON.stringify([${divider(name)}.getBoundingClientRect().width, ...[...${divider(name)}.querySelectorAll("span.h-px")].map((line) => line.getBoundingClientRect().width)])`,
      ).then(JSON.parse);
      assert.equal(box[0], 608);
      assert.ok(box[1] > 20 && Math.abs(box[1] - box[2]) < 1, `hairlines flank the label: ${box}`);
    }
    assert.match(await text("preparing"), /^Context handoff.*Opus 5\.5.*→.*GPT-6$/);
    assert.match(await text("done"), /^Context handoff.*Opus 5\.5.*→.*GPT-6$/);
    assert.match(await text("failed"), /^Context handoff.*Opus 5\.5.*→.*GPT-6.*Handoff failed$/);
    assert.match(await text("restored"), /^Context restored.*GPT-6$/);
    assert.doesNotMatch(await text("restored"), /Opus/);
    for (const name of ["preparing", "done", "failed", "restored"]) await shot(name);

    // Only a finished handoff with a brief opens it.
    for (const name of ["preparing", "failed"]) {
      assert.equal(await evaluate(`${divider(name)}.querySelector("button").disabled`), true);
      await evaluate(`${divider(name)}.querySelector("button").click()`);
      await delay(100);
      assert.equal(await evaluate('!!document.querySelector("[data-brief-dialog]")'), false);
    }
    await evaluate(`${divider("done")}.querySelector("button").click()`);
    await waitFor('document.querySelector("[data-brief-dialog]")');
    assert.equal(await evaluate('document.querySelector("[data-brief-preview] h1").textContent'), "Goal");
    assert.equal(await evaluate('document.querySelector("[data-brief-preview] strong").textContent'), "login redirect");
    assert.equal(await evaluate('!!document.querySelector("[data-brief-tab]") || !!document.querySelector("[data-brief-editor]")'), false);
    await delay(600); // the dialog fades and pops in
    await shot("brief");
    press("Escape");
    await waitFor('!document.querySelector("[data-brief-dialog]")');

    // A restored divider opens its brief the same way, and Close shuts it.
    await evaluate(`${divider("restored")}.querySelector("button").click()`);
    await waitFor('document.querySelector("[data-brief-dialog]")');
    await evaluate('document.querySelector("[data-brief-close]").click()');
    await waitFor('!document.querySelector("[data-brief-dialog]")');
    console.log("Handoff divider checks passed.");
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
        name: "handoff-fixture",
        resolveId(id) {
          if (id === "/__handoff_fixture.tsx") return id;
        },
        load(id) {
          if (id === "/__handoff_fixture.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url !== "/__handoff__") return next();
            const html = await server.transformIndexHtml(
              request.url,
              '<html><body><div id="root"></div><script type="module" src="/__handoff_fixture.tsx"></script></body></html>',
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
    const child = spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__handoff__`], { env, stdio: "inherit" });
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
