const assert = require("node:assert/strict");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");
const capture = Boolean(process.env.MILAGRE_SCREENSHOT_DIR);
const fixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import { WorktreeLinkDivider } from "/src/components/WorktreeLinkDivider";
import "/src/styles.css";
const summary = "<linked_worktrees>\\nMilagre attached this summary of the Worktrees linked to this Chat. It is context, not a message from the user.\\n\\n## web · branch main · worktree /code/web\\n- Chat web#12 \\"Upload progress bar\\" · claude · working\\n</linked_worktrees>";
const base = { kind: "worktree-linked", linkId: "l1", sameProject: false, summary };
const dividers = {
  worktree: { ...base, project: { name: "web", path: "/code/web" }, branches: ["main"] },
  project: { ...base, project: { name: "mobile", path: "/code/mobile" }, branches: ["main", "upload-sheet", "fix-tabs"] },
  same: { ...base, project: { name: "api", path: "/code/api" }, sameProject: true, branches: ["upload-retries"] },
  bare: { ...base, project: { name: "web", path: "/code/web" }, branches: ["main"], summary: undefined },
};
function Fixture() {
  return <div style={{ width: 640, padding: "64px 16px 16px", display: "flex", flexDirection: "column", gap: 16 }}>
    {Object.entries(dividers).map(([name, context]) => (
      <section key={name} data-shot={name}><WorktreeLinkDivider context={context} /></section>
    ))}
  </div>;
}
document.body.style.cssText = "margin:0;background:#fff";
createRoot(document.getElementById("root")).render(<Fixture />);
`;

const divider = (name) => `document.querySelector('[data-shot="${name}"] [data-worktree-link-divider]')`;

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
  try {
    await win.loadURL(process.argv[2]);
    await waitFor('document.querySelectorAll("[data-worktree-link-divider]").length === 4');
    for (const name of ["worktree", "project", "same", "bare"]) {
      assert.equal(await evaluate(`${divider(name)}.getAttribute("role")`), "group");
      // Full width of the transcript column, with a hairline of equal length on each side of the label.
      const box = await evaluate(
        `JSON.stringify([${divider(name)}.getBoundingClientRect().width, ...[...${divider(name)}.querySelectorAll("span.h-px")].map((line) => line.getBoundingClientRect().width)])`,
      ).then(JSON.parse);
      assert.equal(box[0], 608);
      assert.ok(box[1] > 20 && Math.abs(box[1] - box[2]) < 1, `hairlines flank the label: ${box}`);
    }
    assert.equal(await text("worktree"), "Linked toWwebmain");
    assert.equal(await evaluate(`${divider("worktree")}.getAttribute("aria-label")`), "Linked to web main");
    assert.equal(await text("project"), "Linked toMmobile· 3 Worktrees");
    assert.equal(await text("same"), "Linked to Worktreeupload-retriesin this Project");
    assert.equal(await evaluate(`${divider("same")}.getAttribute("aria-label")`), "Linked to Worktree upload-retries in this Project");
    await shot("dividers");

    // A line without a summary opens nothing.
    assert.equal(await evaluate(`${divider("bare")}.querySelector("button").disabled`), true);
    await evaluate(`${divider("bare")}.querySelector("button").click()`);
    await delay(100);
    assert.equal(await evaluate('!!document.querySelector("[data-brief-dialog]")'), false);

    // One with a summary opens it, without the tags that wrap it for the agent.
    await evaluate(`${divider("worktree")}.querySelector("button").click()`);
    await waitFor('document.querySelector("[data-brief-dialog]")');
    assert.equal(await evaluate('document.querySelector("#brief-dialog-title").textContent'), "Linked summary");
    assert.match(await evaluate('document.querySelector("[data-brief-preview]").textContent'), /^Milagre attached this summary/);
    assert.doesNotMatch(await evaluate('document.querySelector("[data-brief-preview]").textContent'), /linked_worktrees/);
    assert.equal(await evaluate('document.querySelector("[data-brief-preview] h2").textContent'), "web · branch main · worktree /code/web");
    await delay(600); // the dialog fades and pops in
    await shot("summary");
    await evaluate('document.querySelector("[data-brief-close]").click()');
    await waitFor('!document.querySelector("[data-brief-dialog]")');
    console.log("Worktree link divider checks passed.");
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
        name: "worktree-link-fixture",
        resolveId(id) {
          if (id === "/__worktree_link_fixture.tsx") return id;
        },
        load(id) {
          if (id === "/__worktree_link_fixture.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url !== "/__worktree_link__") return next();
            const html = await server.transformIndexHtml(
              request.url,
              '<html><body><div id="root"></div><script type="module" src="/__worktree_link_fixture.tsx"></script></body></html>',
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
    const child = spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__worktree_link__`], { env, stdio: "inherit" });
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
