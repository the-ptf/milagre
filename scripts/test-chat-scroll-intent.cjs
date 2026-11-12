// Run with node scripts/test-chat-scroll-intent.cjs. Uses the app's existing Vite and Electron dependencies.
//
// Small upward gestures and Shift+Space must interrupt streaming follow before crossing the 56px threshold.
// Uses native CDP input against ChatComposer, plus the real nested ScrollArea primitive.
const assert = require("node:assert/strict");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");

const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { MessageScroller } from "/src/components/agents/message-scroller";
import { ScrollArea } from "/src/components/primitives/ScrollArea";
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
  const chat = { id: 1, count: 100 };
  const [streaming, setStreaming] = useState("");
  window.stream = (value) => flushSync(() => setStreaming(value));
  const [steps, setSteps] = useState([]);
  window.steps = (value) => flushSync(() => setSteps(value));
  const [nested, setNested] = useState(false);
  window.nested = () => flushSync(() => setNested(true));
  const [draft, setDraft] = useState("");
  const model = MODEL_CATALOG[0];
  if (nested) return <MessageScroller className="h-full" navigation="none" onFollowChange={(value) => window.following = value}>
    <div style={{height:2000}}>Earlier messages</div>
    <ScrollArea chainScroll data-nested style={{height:120}}><div style={{height:500}}>Nested output</div></ScrollArea>
    <button data-control onClick={() => window.activated = true}>Activate</button>
    <p>{streaming}</p>
  </MessageScroller>;
  return <div style={{ height: "100%", padding: 12 }}>
    <ChatComposer streamingText={streaming} streamingSteps={steps} agentChatId={"/fixture#" + chat.id} scrollKey={chat.id} messages={messagesOf(chat.id, chat.count)}
      imageDraft={{ images: [], files: [], removeFile: noop, attachFiles: noop, loading: false, error: "", onPaste: noop, clear: noop, remove: noop }}
      projectPath="/fixture" draft={draft} onDraftChange={setDraft} onSend={noop} isSending={!!streaming} sendBlocked={false}
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
  // Xvfb must map the Linux window for foreground compositor/input scheduling. An unmapped window batches
  // wheel/scroll events at roughly 1Hz even with backgroundThrottling disabled. macOS stays hidden.
  const window = new BrowserWindow({
    width: 800,
    height: 600,
    useContentSize: true,
    show: process.platform === "linux",
    webPreferences: { backgroundThrottling: false },
  });
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") console.error(event.message);
  });
  const evaluate = async (source) => {
    try {
      return await window.webContents.executeJavaScript(source);
    } catch (error) {
      throw new Error(`${source}: ${error.message}`, { cause: error });
    }
  };
  async function waitFor(source) {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    const state = await evaluate(`(() => {
      const v = document.querySelector('[aria-label="Conversation"]');
      return {top:v?.scrollTop, height:v?.scrollHeight, viewport:v?.clientHeight, deliveredWheelDelta:window.deliveredWheelDelta};
    })()`);
    throw new Error(`Timed out: ${source}; scroll state: ${JSON.stringify(state)}`);
  }
  const rendered = () => evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  const viewport = `document.querySelector('[aria-label="Conversation"]')`;
  const distance = `(() => { const v = ${viewport}; return Math.round(v.scrollHeight - v.clientHeight - v.scrollTop); })()`;
  const jumpButton = `!!document.querySelector('button[aria-label="Go to bottom"]')`;
  // Where the Chat rests once its messages have measured and every observer has run.
  const settled = async () => {
    await delay(1000);
    return { distance: await evaluate(distance), jump: await evaluate(jumpButton) };
  };
  try {
    await window.loadURL(process.argv[2]);
    await waitFor(`document.querySelectorAll('[data-slot="message"]').length === 40`);
    const tall = await evaluate(`Math.min(...[...document.querySelectorAll('[data-slot="message"]')].slice(-6).map(m => m.offsetHeight))`);
    assert.ok(tall > 200, `The fixture's messages must be taller than the 160px placeholder; shortest: ${tall}`);
    const opened = await settled();
    assert.ok(opened.distance <= 1 && !opened.jump, "A Chat opens at its end");

    window.webContents.debugger.attach("1.3");
    // Keep the hidden macOS page focused for native keyboard input without focusing the app.
    await window.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
    await waitFor("document.hasFocus()");
    const position = (selector = viewport) =>
      evaluate(`(() => { const r = ${selector}.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
    const wheel = (pos, deltaY, extra = {}) =>
      window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseWheel", ...pos, deltaY, deltaX: 0, ...extra });
    const key = async (shift) => {
      await window.webContents.debugger.sendCommand("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: " ",
        code: "Space",
        windowsVirtualKeyCode: 32,
        text: " ",
        modifiers: shift ? 8 : 0,
      });
      await window.webContents.debugger.sendCommand("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: " ",
        code: "Space",
        windowsVirtualKeyCode: 32,
        modifiers: shift ? 8 : 0,
      });
    };
    const page = async (shift, condition) => {
      // Wait for the native page animation to finish before reversing direction or requesting the end.
      // Canceling the prior automatic jump can emit its own scrollend before the key's default scroll starts.
      await evaluate(`(() => {
        window.pageScrollEnded = false;
        const onEnd = () => {
          if (!(${condition})) return;
          window.pageScrollEnded = true;
          ${viewport}.removeEventListener('scrollend', onEnd);
        };
        ${viewport}.addEventListener('scrollend', onEnd);
      })()`);
      await key(shift);
      await waitFor("window.pageScrollEnded");
    };
    const end = async () => {
      await evaluate(`${viewport}.dispatchEvent(new Event('milagre:transcript-end'))`);
      await waitFor(`${distance} <= 1`);
    };
    // CDP wheel input exercises Chromium's default scrolling; assigning scrollTop would bypass this regression.
    // Tool steps change autoScrollKey even while their summary stays the same height. Small inputs used to keep
    // following within 56px and restart the smooth jump on every step.
    for (const text of [false, true]) {
      await evaluate(`window.stream('Start.'); window.steps([])`);
      await settled();
      await end();
      const pos = await position();
      await evaluate(`(() => {
        window.deliveredWheelDelta = 0;
        const onWheel = (event) => {
          // Output may legitimately follow until the first queued gesture reaches the viewport.
          if (window.deliveredWheelDelta === 0) window.gestureStartTop = ${viewport}.scrollTop;
          window.deliveredWheelDelta += event.deltaY;
          if (window.deliveredWheelDelta <= -1000) ${viewport}.removeEventListener('wheel', onWheel);
        };
        ${viewport}.addEventListener('wheel', onWheel, {passive:true});
      })()`);
      await evaluate(`window.tick=0; window.growth=setInterval(() => {
        window.tick++;
        if (${text}) window.stream('Wrapping text changes the height of the reply. '.repeat(tick*2));
        if (tick%3===0) window.steps(Array.from({length:tick/3},(_,i)=>({id:'s'+i,kind:'shell',title:'Tool '+i,status:'done',offset:0})));
      },16)`);
      const start = Date.now();
      const pending = [];
      for (let i = 0; i < 125; i++) {
        await delay(Math.max(0, start + i * 16 - Date.now()));
        pending.push(wheel(pos, -8));
      }
      await Promise.all(pending);
      // CDP acknowledges queued input before Chromium delivers it. On Linux a late upward wheel otherwise
      // arrives after Go to bottom and correctly cancels that jump. Drain the full gesture, including coalesced
      // deltas, and let its default scroll render before measuring or beginning a different user action.
      await waitFor("window.deliveredWheelDelta === -1000");
      await rendered();
      await evaluate("clearInterval(window.growth)");
      const moved = await evaluate(`window.gestureStartTop - ${viewport}.scrollTop`);
      assert.ok(moved > 800, `125 small upward inputs must escape ${text ? "text and tools" : "tools"}: moved ${moved}px`);
      const reading = await evaluate(`${viewport}.scrollTop`);
      await evaluate(`window.stream('New lines.\\n\\n'.repeat(200))`);
      await delay(200);
      assert.ok(Math.abs((await evaluate(`${viewport}.scrollTop`)) - reading) <= 1, "Output growth preserves the reading position");
      console.log(`PASS: small wheel inputs escape ${text ? "wrapping text and tool updates" : "tool updates"} (${Math.round(moved)}px)`);
      await evaluate(`document.querySelector('button[aria-label="Go to bottom"]').click()`);
      await waitFor(`${distance} <= 1`);
    }
    await evaluate(`window.stream('Start.'); window.steps([])`);
    await settled();
    await end();
    await evaluate(
      `(() => { const v=${viewport}; v.tabIndex=-1; v.focus(); window.tick=0; window.growth=setInterval(()=>window.steps(Array.from({length:++tick},(_,i)=>({id:'k'+i,kind:'shell',title:'Command '+i,status:'done',offset:0}))),48); })()`,
    );
    await delay(120);
    const beforeKey = await evaluate(`${viewport}.scrollTop`);
    await page(true, `${beforeKey} - ${viewport}.scrollTop > 200`);
    assert.ok(beforeKey - (await evaluate(`${viewport}.scrollTop`)) > 200, "Shift+Space interrupts smooth following during tool updates");
    await evaluate("clearInterval(window.growth)");
    const beforeSpace = await evaluate(`${viewport}.scrollTop`);
    await page(false, `${viewport}.scrollTop > ${beforeSpace} + 200`);
    assert.ok((await evaluate(`${viewport}.scrollTop`)) > beforeSpace + 200, "Space still pages down");
    await end();
    const pos = await position();
    await wheel(pos, -8);
    await rendered();
    const nearEnd = await evaluate(`${viewport}.scrollTop`);
    await evaluate(`window.stream('Another line.\\n\\n'.repeat(20))`);
    await delay(200);
    assert.ok(Math.abs((await evaluate(`${viewport}.scrollTop`)) - nearEnd) <= 1, "Even an 8px upward gesture pauses growth");
    await wheel(pos, 10000);
    await waitFor(`${distance} <= 1`);
    // The compositor can reach the end before React receives its scroll event and resumes following.
    await rendered();
    await evaluate(`window.stream('Another line.\\n\\n'.repeat(30))`);
    await waitFor(`${distance} <= 1`);
    console.log("PASS: Shift+Space, Space, manual return to the end and explicit end events preserve follow semantics");

    await evaluate(`window.stream('Tail'); window.nested(); window.following=true`);
    await settled();
    const nested = `document.querySelector('[data-nested]')`;
    await evaluate(`${nested}.scrollTop=100`);
    await wheel(await position(nested), -8);
    await waitFor(`${nested}.scrollTop < 100`);
    assert.ok(await evaluate(`${nested}.scrollTop < 100`), "The nested output scrolls");
    assert.equal(await evaluate("window.following"), true, "A nested output gesture does not pause the transcript");
    await evaluate(`document.querySelector('[data-control]').focus()`);
    await key(true);
    await rendered();
    assert.equal(await evaluate("window.following"), true, "Space on a button does not pause the transcript");
    await evaluate(`${nested}.scrollTop=0`);
    await wheel(await position(nested), -8);
    await waitFor("window.following === false");
    assert.equal(await evaluate("window.following"), false, "A gesture at the nested output's top chains to the transcript");
    await end();
    assert.equal(await evaluate("window.following"), true, "Explicit end restores following after nested scroll-away");
    await evaluate(`${nested}.style.overscrollBehaviorY='contain'`);
    await wheel(await position(nested), -8);
    await rendered();
    assert.equal(await evaluate("window.following"), true, "A contained nested scroller never hands its gesture to the transcript");
    console.log("PASS: nested scrollers and button activation keep their own input");
    app.exit(0);
  } catch (error) {
    console.error(error);
    if (process.env.MILAGRE_SCREENSHOT_DIR)
      await Promise.race([
        window.webContents
          .capturePage()
          .then((image) => require("node:fs").writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, "chat-scroll-intent-failure.png"), image.toPNG())),
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
        name: "chat-scroll-intent-fixture",
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
