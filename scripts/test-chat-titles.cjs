const assert = require("node:assert/strict");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");
const capture = Boolean(process.env.MILAGRE_SCREENSHOT_DIR);
const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatRow } from "/src/components/sidebar/ChatRow";
import { chatTitle } from "/src/lib/chat-list";
import "/src/styles.css";
const initial = { sessions: { 1: { id: 1, worktree_id: 1, agent_name: "main", status: "Created", titlePending: true, summary: { count: 1, titleLine: "when i navigate between chats the scroll jumps" } } }, messages: [] };
function Fixture() {
  const [state, setState] = useState(initial);
  const [mounted, setMounted] = useState(true);
  window.setMounted = setMounted;
  window.rename = title => setState(s => ({ ...s, sessions: { 1: { ...s.sessions[1], title } } }));
  // The main-process naming lifecycle is covered in electron/chat-title.test.cjs.
  // This controlled broadcast exercises the real row's title transition.
  window.resolveTitle = title => setState(s => ({ ...s, sessions: { 1: { ...s.sessions[1], generatedTitle: title } } }));
  return <aside data-sidebar-collapsed="false" style={{width: ${capture ? 300 : 224}}}>
    {${capture} && <div style={{padding: "14px 16px 8px", color: "#888", fontSize: 12}}>Chats</div>}
    {mounted && <ChatRow item={{id: "1", label: chatTitle(state.sessions[1], state.messages), mark: ${capture ? '"running"' : '"idle"'}}} active collapsed={false} actions={{}} onPick={() => {}} />}
    {${capture} && <>
      <ChatRow item={{id: "2", label: "Review authentication flow"}} active={false} collapsed={false} actions={{}} onPick={() => {}} />
      <ChatRow item={{id: "3", label: "Update keyboard shortcuts"}} active={false} collapsed={false} actions={{}} onPick={() => {}} />
    </>}
  </aside>;
}
if (${capture}) {
  document.documentElement.classList.add("dark");
  document.body.style.cssText = "margin:0;background:#202123";
}
createRoot(document.getElementById("root")).render(<Fixture />);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  await app.whenReady();
  const win = new BrowserWindow({ width: capture ? 300 : 500, height: capture ? 200 : 240, show: false, webPreferences: { backgroundThrottling: false } });
  const evaluate = (source) => win.webContents.executeJavaScript(source);
  async function waitFor(source) {
    for (let i = 0; i < 200; i++) {
      if (await evaluate(source)) return;
      await delay(20);
    }
    throw Error(`Timed out: ${source}`);
  }
  try {
    await win.loadURL(process.argv[2]);
    await waitFor("!!window.resolveTitle");
    assert.equal(
      await evaluate('document.querySelector(".chat-title-current").textContent'),
      "when i navigate between chats the scroll jumps",
      "The saved summary names a Chat before its transcript loads",
    );
    if (capture) {
      await captureTransition(win, evaluate);
      app.exit(0);
      return;
    }
    assert.equal(await evaluate('document.getAnimations().some(a => a.animationName?.startsWith("chat-title"))'), false, "No animation on mount");
    const before = await evaluate('document.querySelector("[data-row]").getBoundingClientRect().toJSON()');
    await evaluate('window.resolveTitle("Preserve chat scroll position")');
    await waitFor('document.querySelector("[data-changing]")');
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".chat-title-current")).animationName'), "chat-title-in");
    const after = await evaluate('document.querySelector("[data-row]").getBoundingClientRect().toJSON()');
    assert.deepEqual(after, before, "Title replacement must not move or resize the row");
    await waitFor('!document.querySelector("[data-changing]")');
    await evaluate("window.setMounted(false)");
    await waitFor('!document.querySelector("[data-chat-title]")');
    await evaluate("window.setMounted(true)");
    await waitFor('document.querySelector("[data-chat-title]")');
    assert.equal(await evaluate('!!document.querySelector("[data-changing]")'), false, "Saved title does not replay on remount");

    await win.webContents.debugger.attach("1.3");
    await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await evaluate('window.rename("Reduced motion title")');
    await waitFor('document.querySelector(".chat-title-current").textContent === "Reduced motion title"');
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".chat-title-current")).animationName'), "none");
    console.log("PASS: title transition, stable row, remount, reduced motion");
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
}

// Record actual Chromium paints with their elapsed timing, without slowing the animation.
// MILAGRE_SCREENSHOT_DIR=/tmp/chat-titles npm test -- --only chat-titles (requires ffmpeg).
async function captureTransition(win, evaluate) {
  const fs = require("node:fs/promises");
  const { execFileSync } = require("node:child_process");
  const output = path.resolve(process.env.MILAGRE_SCREENSHOT_DIR);
  const temporary = await fs.mkdtemp(path.join(require("node:os").tmpdir(), "milagre-title-capture-"));
  await fs.mkdir(output, { recursive: true });
  await delay(250);
  const frames = [];
  const start = performance.now();
  let resolved = false;
  while (performance.now() - start < 3000) {
    const time = performance.now() - start;
    if (!resolved && time >= 1000) {
      await evaluate('window.resolveTitle("Preserve chat scroll position")');
      resolved = true;
    }
    const name = path.join(temporary, `frame-${frames.length}.png`);
    const paint = await win.webContents.capturePage();
    frames.push({ name, time: performance.now() - start });
    await fs.writeFile(name, paint.toPNG());
    await delay(16);
  }
  await fs.copyFile(frames[0].name, path.join(output, "before.png"));
  await fs.copyFile(frames.at(-1).name, path.join(output, "after.png"));
  const concat = frames
    .map((frame, index) => `file '${frame.name}'\nduration ${((frames[index + 1]?.time ?? frame.time + 40) - frame.time) / 1000}`)
    .join("\n");
  const manifest = path.join(temporary, "frames.txt");
  await fs.writeFile(manifest, concat + `\nfile '${frames.at(-1).name}'\n`);
  // The GIF is for people reading the screenshots; without ffmpeg (the CI runner image lacks it, and installing it
  // took that shard 35 s) the before and after frames are kept and the GIF is skipped.
  try {
    execFileSync("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      manifest,
      "-filter_complex",
      "fps=30,split[a][b];[a]palettegen[p];[b][p]paletteuse",
      "-loop",
      "0",
      path.join(output, "title-transition.gif"),
    ]);
    console.log(`Captured before/after and title-transition.gif in ${output}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    console.log(`Captured before/after in ${output}; no ffmpeg, so no title-transition.gif`);
  }
  await fs.rm(temporary, { recursive: true });
}

async function main() {
  const { createServer } = await import("vite");
  const { spawn } = require("node:child_process");
  const server = await createServer({
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "chat-title-fixture",
        resolveId(id) {
          if (id === "/__chat_title_fixture.tsx") return id;
        },
        load(id) {
          if (id === "/__chat_title_fixture.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url !== "/__chat_title__") return next();
            const html = await server.transformIndexHtml(
              request.url,
              '<html><body><div id="root"></div><script type="module" src="/__chat_title_fixture.tsx"></script></body></html>',
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
    const child = spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__chat_title__`], { env, stdio: "inherit" });
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
