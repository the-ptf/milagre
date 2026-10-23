// Checks lazy folded activity, fixed caps and reveal behavior through the real renderer components.
const assert = require("node:assert/strict");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ActivityBlock } from "/src/components/agents/ActivityBlock";
import { MessageScroller } from "/src/components/agents/message-scroller";
import { updateSettings } from "/src/lib/settings";
import "/src/styles.css";
const make = (count) => Array.from({ length: count }, (_, i) => ({ type: "step", step: { id: String(i), kind: "shell", title: "Command " + i, status: i < 2 ? "failed" : "done", detail: i === 100 ? "$ check\\nretained output" : undefined } }));
function Fixture() {
  const [entries, setEntries] = useState(make(250));
  const [waiting, setWaiting] = useState([]);
  const [streaming, setStreaming] = useState(false);
  const [version, setVersion] = useState(0);
  window.append = () => setEntries((current) => [...current, ...make(5).map((e, i) => ({ ...e, step: { ...e.step, id: String(current.length + i), title: "Appended " + i, status: "running" } }))]);
  window.reset = (count) => { setEntries(make(count)); setWaiting([]); setStreaming(false); setVersion((n) => n + 1); };
  window.waitEarlier = () => { setWaiting(["20"]); setStreaming(true); setEntries((current) => current.map((e) => e.step.id === "20" ? { ...e, step: { ...e.step, status: "running" } } : e)); };
  window.finishEarlier = () => { setWaiting([]); setEntries((current) => current.map((e) => e.step.id === "20" ? { ...e, step: { ...e.step, status: "done" } } : e)); };
  window.full = (full) => updateSettings({ toolCallDisplay: full ? "full" : "compact" });
  return <MessageScroller className="h-full" smooth={false} followOutput={false}>
    <div data-slot="message" data-from="user" style={{ minHeight: 700 }}>Please check the commands.</div>
    <div data-slot="message" data-from="assistant" id="activity-message"><ActivityBlock key={version} entries={entries} streaming={streaming} waitingStepIds={waiting} /></div>
  </MessageScroller>;
}
createRoot(document.getElementById("root")).render(<Fixture />);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", require("node:fs").mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-activity-cap-")));
  await app.whenReady();
  const window = new BrowserWindow({ width: 800, height: 700, useContentSize: true, show: false, webPreferences: { backgroundThrottling: false } });
  window.webContents.on("console-message", (details) => {
    if (details.level === "error") console.error(details.message);
  });
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  async function screenshot(name) {
    if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
    await delay(900);
    const fs = require("node:fs");
    fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  }
  async function waitFor(source) {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw new Error(`Timed out: ${source}`);
  }
  const rowCount = 'document.querySelectorAll("#activity-message [data-slot=step]").length';
  const fold = 'document.querySelector("[data-slot=activity] > button")';
  const earlier = 'document.querySelector("[data-earlier-steps]")';
  const body = 'document.querySelector("[data-slot=activity-body]")';
  const firstTitle = 'document.querySelector("[data-slot=activity-body] [data-slot=step]")?.textContent';
  try {
    await window.loadURL(process.argv[2]);
    await waitFor(`!!${fold}`);
    assert.equal(await evaluate(rowCount), 0, "folded rows are not mounted");
    assert.equal(await evaluate(`${body}.getAttribute("aria-live")`), "off", "revealing history does not flood the transcript live region");
    await evaluate(`${fold}.click()`);
    await waitFor(`${rowCount} === 150`);
    assert.equal(await evaluate(`${earlier}.textContent`), "Show earlier steps (100, 2 failed)");
    assert.ok((await evaluate(firstTitle)).includes("Command 100"));
    // Preserve an opened output across appends, revealing earlier entries and collapsing the block.
    await evaluate('document.querySelector("[data-slot=step] button[aria-expanded]").click()');
    await waitFor('document.querySelector("[data-slot=step]").textContent.includes("retained output")');
    await evaluate("window.append()");
    await waitFor(`${rowCount} === 155`);
    assert.ok((await evaluate(firstTitle)).includes("Command 100"));
    await evaluate(`${body}.scrollIntoView({ block: "start" })`);
    const beforeTop = await evaluate(`${body}.getBoundingClientRect().top`);
    await screenshot("capped");
    await evaluate(`${earlier}.click()`);
    await waitFor(`${rowCount} === 255 && !${earlier}`);
    assert.equal(await evaluate(`document.activeElement === ${body}`), true, "reveal transfers keyboard focus to the retained body");
    assert.ok(Math.abs((await evaluate(`${body}.getBoundingClientRect().top`)) - beforeTop) < 2, "revealing rows keeps the top of the list in place");
    assert.equal(
      await evaluate(
        '[...document.querySelectorAll("[data-slot=step]")].find(e => e.textContent.includes("Command 100"))?.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded")',
      ),
      "true",
    );
    await evaluate(`${fold}.click()`);
    await waitFor(`${fold}.getAttribute("aria-expanded") === "false"`);
    assert.equal(await evaluate(rowCount), 255, "collapse keeps mounted rows");
    await evaluate(`${fold}.click()`);
    await waitFor(`${fold}.getAttribute("aria-expanded") === "true"`);
    assert.equal(
      await evaluate(
        '[...document.querySelectorAll("[data-slot=step]")].find(e => e.textContent.includes("Command 100"))?.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded")',
      ),
      "true",
    );

    await evaluate("window.reset(250)");
    await waitFor(`${rowCount} === 0`);
    await evaluate(`${fold}.click()`);
    await waitFor(`${rowCount} === 150`);
    await evaluate("window.waitEarlier()");
    await waitFor(`${rowCount} === 230`);
    assert.ok((await evaluate(firstTitle)).includes("Command 20"));
    assert.ok((await evaluate(`${fold}.textContent`)).includes("Waiting for approval"));
    await evaluate("window.finishEarlier()");
    await waitFor(`!${fold}.textContent.includes("Waiting for approval")`);
    assert.equal(await evaluate(rowCount), 230, "finished pinned steps stay revealed");
    await screenshot("earlier-waiting-completed");

    await evaluate("window.reset(200)");
    await waitFor(`${rowCount} === 0`);
    await evaluate(`${fold}.click()`);
    await waitFor(`${rowCount} === 200`);
    assert.equal(await evaluate(`!!${earlier}`), false);
    await evaluate("window.append()");
    await waitFor(`${rowCount} === 205`);
    assert.equal(await evaluate(`!!${earlier}`), false, "a block opened before the threshold never starts hiding rows");

    await evaluate("window.reset(250); window.full(true)");
    await waitFor(`${rowCount} === 250 && !!document.querySelector("[data-slot=activity-inline]")`);
    assert.equal(await evaluate(`!!${earlier}`), false, "full mode stays uncapped");
    await evaluate("window.reset(1); window.full(false)");
    await waitFor(`${rowCount} === 1 && !${fold}`);
    await evaluate("window.reset(250)");
    await waitFor(`${rowCount} === 0`);
    await evaluate(`${fold}.click()`);
    await waitFor(`${rowCount} === 150`);
    // The answerless message's preview stays its summary after rows mount or change.
    const rail = 'document.querySelector("[aria-label=\\"Go to assistant message 2 of 2\\"]")';
    await waitFor(`!!${rail}`);
    await evaluate(`${rail}.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }))`);
    await waitFor('!!document.querySelector("[data-slot=preview-rail-title]")');
    // A changed summary proves the scroller's delayed refresh ran; stale previews cannot satisfy this.
    const previewTitle = 'document.querySelector("[data-slot=preview-rail-title]")?.textContent';
    const summary = `${fold}.textContent.replace(/\\s+/g, " ").trim()`;
    await evaluate("window.append()");
    await waitFor(`${rowCount} === 155`);
    await waitFor(`${previewTitle} === ${summary} && ${previewTitle}.includes("255")`);
    assert.equal(
      await evaluate('!!document.querySelector("[data-slot=preview-rail-description]")'),
      false,
      "capped activity text never leaks into the preview description",
    );
    await evaluate(`${earlier}.click()`);
    await waitFor(`${rowCount} === 255`);
    await evaluate(`${rail}.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }))`);
    await evaluate("window.append()");
    await waitFor(`${rowCount} === 260`);
    await waitFor(`${previewTitle} === ${summary} && ${previewTitle}.includes("260")`);
    assert.equal(
      await evaluate('!!document.querySelector("[data-slot=preview-rail-description]")'),
      false,
      "revealed activity text never leaks into the preview description",
    );
    window.webContents.debugger.attach("1.3");
    await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await evaluate("window.reset(250)");
    await waitFor(`${rowCount} === 0`);
    await evaluate(`${fold}.click()`);
    await waitFor(`${rowCount} === 150`);
    assert.ok(
      parseFloat(await evaluate(`getComputedStyle(${fold}.nextElementSibling).transitionDuration`)) < 0.001,
      "reduced motion removes the fold transition",
    );
    window.webContents.debugger.detach();
    console.log("PASS: lazy activity rows, cap/reveal, focus/position, appends, waiting boundary, retained output, full/single modes, stable answerless rail");
    app.exit(0);
  } catch (error) {
    console.error(error);
    await screenshot("failure").catch(() => {});
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
        name: "activity-cap-fixture",
        resolveId(id) {
          if (id === "/__activity_cap_fixture.tsx") return id;
        },
        load(id) {
          if (id === "/__activity_cap_fixture.tsx") return fixture;
        },
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== "/__activity_cap__") return next();
            server
              .transformIndexHtml(
                request.url,
                '<html><body><div id="root"></div><script type="module" src="/__activity_cap_fixture.tsx"></script></body></html>',
              )
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
    const child = spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__activity_cap__`], { env, stdio: "inherit" });
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
