// Run with node scripts/test-chat-scroll-return.cjs. Uses the app's existing Vite and Electron dependencies.
//
// A Chat opened or revisited lands at its latest message and keeps following it (#972). test-chat-layout's fixture has
// one-line messages, shorter than the 160px each skipped message stands at (styles.css), so a transcript placed at its
// end before its messages measure only shrinks and still ends at the bottom. Real replies are taller: these grow.
const assert = require("node:assert/strict");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");

const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { ChatComposer } from "/src/components/ChatComposer";
import { MODEL_CATALOG, capabilityFor } from "/src/model";
import "/src/styles.css";
window.milagre = Object.freeze({ listEditors: async () => [] });
const noop = () => {};
// About 450px a message at the fixture's width: a paragraph, a list and a code block, like a normal agent reply.
const body = (chat, index) => "Reply " + (index + 1) + " in Chat " + chat + ". " + "The change moves the scroll position into the scroller, so every place that shows a transcript at its end goes through one path. ".repeat(4)
  + "\\n\\n- First step of the plan\\n- Second step, with a longer line that wraps on a narrow window\\n- Third step\\n\\n\\x60\\x60\\x60ts\\nconst viewport = document.querySelector('[aria-label=\\"Conversation\\"]');\\nviewport.scrollTop = viewport.scrollHeight;\\nconsole.log(viewport.scrollTop);\\n\\x60\\x60\\x60\\n\\nDone.";
const cache = new Map();
const messagesOf = (chat, count) => {
  const key = chat + ":" + count;
  if (!cache.has(key)) cache.set(key, Array.from({ length: count }, (_, index) => ({
    id: chat * 1000 + index + 1, session_id: chat, context: null, role: index % 2 ? "assistant" : "user", body: body(chat, index),
  })));
  return cache.get(key);
};
function Fixture() {
  const [chat, setChat] = useState({ id: 1, count: 100 });
  window.switchChat = (id, count) => flushSync(() => setChat({ id, count }));
  window.addMessages = (more) => setChat((current) => ({ ...current, count: current.count + more }));
  const [draft, setDraft] = useState("");
  const model = MODEL_CATALOG[0];
  return <div style={{ height: "100%", padding: 12 }}>
    <ChatComposer agentChatId={"/fixture#" + chat.id} scrollKey={chat.id} messages={messagesOf(chat.id, chat.count)}
      imageDraft={{ images: [], files: [], removeFile: noop, attachFiles: noop, loading: false, error: "", onPaste: noop, clear: noop, remove: noop }}
      projectPath="/fixture" draft={draft} onDraftChange={setDraft} onSend={noop} isSending={false} sendBlocked={false}
      models={MODEL_CATALOG} cliStatus={null} onModelPickerOpen={noop} selectedModel={model} onModelChange={noop}
      capability={capabilityFor(model, null)} onEffortChange={noop} ultracode={false} onUltracodeChange={noop}
      fastMode={false} onFastModeChange={noop} permissionMode="auto" onPermissionModeChange={noop}
      onRecommendationSelect={noop} worktrees={[{ id: 1, name: "main", path: "/fixture" }]} onWorktreeChange={noop}
      isolation="worktree" onIsolationChange={noop} branches={["main"]} baseBranch="main" onBaseBranchChange={noop} newChatError={null} />
  </div>;
}
document.documentElement.classList.add("dark");
createRoot(document.getElementById("root")).render(<Fixture />);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", require("node:fs").mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-chat-scroll-")));
  await app.whenReady();
  const window = new BrowserWindow({ width: 800, height: 600, useContentSize: true, show: false, webPreferences: { backgroundThrottling: false } });
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") console.error(event.message);
  });
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  async function waitFor(source) {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw new Error(`Timed out: ${source}`);
  }
  const viewport = `document.querySelector('[aria-label="Conversation"]')`;
  const distance = `(() => { const v = ${viewport}; return Math.round(v.scrollHeight - v.clientHeight - v.scrollTop); })()`;
  const jumpButton = `!!document.querySelector('button[aria-label="Go to bottom"]')`;
  // Where the Chat rests once its messages have measured and every observer has run.
  const settled = async () => {
    await delay(1000);
    return { distance: await evaluate(distance), jump: await evaluate(jumpButton) };
  };
  // CHAT_SCROLL_REPORT=1 prints every result instead of stopping at the first failure (for before/after numbers).
  const check = (ok, message, pass) => {
    if (process.env.CHAT_SCROLL_REPORT) return console.log(`${ok ? "ok" : "FAIL"}: ${message}`);
    assert.ok(ok, message);
    if (pass) console.log(`PASS: ${pass}`);
  };
  const label = (state) => `${state.distance}px from the end${state.jump ? ", Go to bottom shown" : ""}`;
  const scrollToEnd = `(() => {
    const v = ${viewport};
    v.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 100 }));
    v.scrollTo({ top: v.scrollHeight, behavior: 'instant' });
  })()`;
  try {
    await window.loadURL(process.argv[2]);
    await waitFor(`document.querySelectorAll('[data-slot="message"]').length === 40`);
    const tall = await evaluate(`Math.min(...[...document.querySelectorAll('[data-slot="message"]')].slice(-6).map(m => m.offsetHeight))`);
    assert.ok(tall > 200, `The fixture's messages must be taller than the 160px placeholder; shortest: ${tall}`);
    const opened = await settled();
    check(opened.distance <= 1 && !opened.jump, `A Chat opens at its end; ${label(opened)}`);

    // A: Show earlier messages, back to the end, another Chat, back again.
    const results = [];
    for (let run = 0; run < 3; run++) {
      const id = 10 + run * 2;
      await evaluate(`window.switchChat(${id}, 100)`);
      await waitFor(`document.querySelectorAll('[data-slot="message"]').length === 40`);
      await settled();
      await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.startsWith('Show earlier messages')).click()`);
      await waitFor(`document.querySelectorAll('[data-slot="message"]').length === 80`);
      await delay(300);
      await evaluate(scrollToEnd);
      await waitFor(`${distance} <= 1 && !${jumpButton}`);
      await delay(300);
      await evaluate(`window.switchChat(${id + 1}, 100)`);
      await settled();
      await evaluate(`window.switchChat(${id}, 100)`);
      results.push(await settled());
    }
    check(
      results.every((state) => state.distance <= 1 && !state.jump),
      `A Chat that showed earlier messages comes back at its end; runs: ${results.map(label).join("; ")}`,
      "back to a parked Chat after Show earlier messages lands at its end, 3 of 3",
    );

    // B: first opens of Chats that were never parked.
    const firstOpens = [];
    for (let run = 0; run < 20; run++) {
      await evaluate(`window.switchChat(${100 + run}, 100)`);
      firstOpens.push(await settled());
    }
    const stuck = firstOpens.filter((state) => state.distance > 1 || state.jump);
    check(
      stuck.length === 0,
      `20 first opens land at the end; ${stuck.length} did not: ${stuck.map(label).join("; ")}`,
      "20 first opens of a 100-message Chat with tall messages land at the end",
    );

    // Reading earlier messages keeps its place when new ones arrive, and Go to bottom takes the Chat back to following.
    await evaluate(
      `(() => { const v = ${viewport}; v.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 })); v.scrollTo({ top: v.scrollHeight / 2, behavior: 'instant' }); })()`,
    );
    await waitFor(jumpButton);
    const reading = await evaluate(`${viewport}.scrollTop`);
    await evaluate("window.addMessages(2)");
    await waitFor(`document.querySelectorAll('[data-slot="message"]').length === 42`);
    await delay(300);
    assert.ok(Math.abs((await evaluate(`${viewport}.scrollTop`)) - reading) <= 1, "New messages keep the reading position");
    await evaluate(`document.querySelector('button[aria-label="Go to bottom"]').click()`);
    await waitFor(`${distance} <= 1 && !${jumpButton}`);
    await evaluate("window.addMessages(2)");
    await waitFor(`document.querySelectorAll('[data-slot="message"]').length === 44`);
    const following = await settled();
    check(
      following.distance <= 1 && !following.jump,
      `Back at the end, new messages are followed; ${label(following)}`,
      "reading earlier messages keeps its place as new ones arrive; Go to bottom follows them again",
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    if (process.env.MILAGRE_SCREENSHOT_DIR)
      await Promise.race([
        window.webContents
          .capturePage()
          .then((image) => require("node:fs").writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, "chat-scroll-return-failure.png"), image.toPNG())),
        delay(2000),
      ]).catch(() => {});
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
        name: "chat-scroll-return-fixture",
        resolveId(id) {
          if (id === "/__chat_scroll_fixture.tsx") return id;
        },
        load(id) {
          if (id === "/__chat_scroll_fixture.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url !== "/__chat_scroll__") return next();
            const html = await server.transformIndexHtml(
              request.url,
              '<html><body><div id="root"></div><script type="module" src="/__chat_scroll_fixture.tsx"></script></body></html>',
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
    const child = spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__chat_scroll__`], { env, stdio: "inherit" });
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
