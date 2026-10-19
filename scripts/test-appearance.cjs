// Settings > Appearance on the real surfaces: transcript width and size, code size, diff colors, the sidebar row and
// motion. A Vite fixture renders ChatComposer (a user bubble and a reply with a code and a diff block), a sidebar
// ChatRow and a ChangesPanelSlot; the check changes `appearance` through the settings store and reads computed styles.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatComposer } from "/src/components/ChatComposer";
import { CodeBlock } from "/src/components/markdown/CodeBlock";
import { ChatRow } from "/src/components/sidebar/ChatRow";
import { ChangesPanelSlot } from "/src/components/changes/ChangesPanelSlot";
import { MODEL_CATALOG, capabilityFor } from "/src/model";
import { useApplyTheme, updateSettings, getSettings } from "/src/lib/settings";
import { attachTerminal } from "/src/lib/terminal-sessions";
import "/src/styles.css";
window.milagre = Object.freeze({ listEditors: async () => [], setWindowBackground: async () => {}, setTerminalFocused: () => {},
  terminals: { read: () => new Promise(() => {}), input: async () => {}, resize: async () => {} } });
window.__update = (patch) => updateSettings({ appearance: { ...getSettings().appearance, ...patch } });
window.__mountTerminal = () => {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:0;bottom:0;width:300px;height:160px';
  document.body.appendChild(host);
  window.__term = attachTerminal({ id: 't1', chatId: 'c1', title: 't', cwd: '/', label: 'l', busy: false, cols: 80, rows: 24, createdAt: 0 }, host).term;
};
const noop = () => {};
const messages = [
  { id: 1, session_id: 1, context: null, role: "user", body: "Please fix the greeting" },
  { id: 2, session_id: 1, context: null, role: "assistant",
    body: "Here is the change.\\n\\n\`\`\`ts\\nconst answer = 42;\\n\`\`\`" },
];
function Fixture() {
  useApplyTheme();
  const [panel, setPanel] = useState(false);
  window.__setPanel = setPanel;
  const model = MODEL_CATALOG[0];
  return <div style={{ display: "flex", height: "100vh", gap: 12, padding: 12 }}>
    <aside data-sidebar-collapsed="false" style={{ width: 224 }}>
      <ChatRow item={{ id: "1", label: "Review authentication flow", details: { diff: { added: 12, removed: 3 } } }} active collapsed={false} actions={{}} onPick={noop} show={{ computer: false, pullRequests: false, linearIssue: false, branch: false, diff: true, lastActivity: false }} />
      <CodeBlock code={"-const greeting = 'hi';\\n+const greeting = 'hello';"} fence="diff" diff />
    </aside>
    <main style={{ flex: 1, minWidth: 0 }}>
      <ChatComposer messages={messages}
        imageDraft={{ images: [], files: [], removeFile: noop, attachFiles: noop, loading: false, error: "", onPaste: noop, clear: noop, remove: noop }}
        projectPath="/fixture" draft="" onDraftChange={noop} onSend={noop} isSending={false} sendBlocked={false}
        models={MODEL_CATALOG} cliStatus={null} onModelPickerOpen={noop} selectedModel={model} onModelChange={noop}
        capability={capabilityFor(model, null)} onEffortChange={noop} ultracode={false} onUltracodeChange={noop}
        fastMode={false} onFastModeChange={noop} permissionMode="auto" onPermissionModeChange={noop}
        onRecommendationSelect={noop} worktrees={[{ id: 1, name: "main", path: "/fixture" }]} onWorktreeChange={noop}
        isolation="worktree" onIsolationChange={noop} branches={["main"]} baseBranch="main" onBaseBranchChange={noop} newChatError={null}
        linearActive onStartFromIssue={noop} />
    </main>
    <ChangesPanelSlot open={panel}>
      <aside data-changes-panel style={{ width: 320 }} className="shrink-0 rounded-window bg-inset" />
    </ChangesPanelSlot>
  </div>;
}
document.documentElement.classList.add("dark");
createRoot(document.getElementById("root")).render(<Fixture />);
`;

const hexToRgb = (hex) => `rgb(${[1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", fs.mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-appearance-")));
  await app.whenReady();
  const { DIFF_PAIRS } = await import("@milagre/shared/appearance");
  const window = new BrowserWindow({ width: 1600, height: 900, useContentSize: true, show: false, webPreferences: { backgroundThrottling: false } });
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  const errors = [];
  window.webContents.on("console-message", (details) => {
    if (details.level === "error") errors.push(details.message);
  });
  const waitFor = async (source) => {
    for (let i = 0; i < 200; i++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw Error("Timed out: " + source);
  };
  const set = (patch) => evaluate(`window.__update(${JSON.stringify(patch)})`);
  const style = (selector, property) =>
    evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw Error('no element: ' + ${JSON.stringify(selector)}); return getComputedStyle(el).${property}; })()`,
    );
  const columnWidth = () => evaluate(`document.querySelector('.chat-column').getBoundingClientRect().width`);
  const bubble = '[data-slot="message"][data-from="user"] > div';
  const marker = "span.text-diff-add";
  try {
    await window.loadURL(process.argv[2]);
    await waitFor(`!!document.querySelector('.chat-column') && !!document.querySelector('.chat-title-current') && !!document.querySelector('${marker}')`);

    // Defaults change nothing.
    assert.equal(await style(bubble, "fontSize"), "13px", "default chat size");
    assert.equal(await style(".chat-title-current", "fontSize"), "14px", "default sidebar size");
    assert.equal(await style("pre.font-mono", "fontSize"), "12px", "default code size");
    assert.ok((await columnWidth()) <= 768, "comfortable column is at most 768px");
    assert.equal(
      await style(marker, "color"),
      await evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--green').trim()`).then(hexToRgb),
      "red-green keeps today's green",
    );

    // Chat width.
    await set({ chatWidth: "wide" });
    await waitFor(`document.querySelector('.chat-column').getBoundingClientRect().width > 768`);
    assert.equal(await columnWidth(), 1024, "wide caps the column at 1024px");
    await set({ chatWidth: "full" });
    await waitFor(`document.querySelector('.chat-column').getBoundingClientRect().width > 1024`);
    assert.ok((await columnWidth()) > 1024, "full fills the pane at a 1600px window");
    await set({ chatWidth: "custom", chatWidthPx: 1100 });
    await waitFor(`document.querySelector('.chat-column').getBoundingClientRect().width === 1100`);
    assert.equal(await columnWidth(), 1100, "custom caps the column at its px");
    await set({ chatWidth: "comfortable" });

    // Sizes.
    await set({ chatSize: "large", codeSize: "large", sidebarSize: "larger" });
    await waitFor(`getComputedStyle(document.querySelector('${bubble}')).fontSize === '15px'`);
    assert.equal(await style(bubble, "fontSize"), "15px", "large chat text is 15px");
    assert.equal(await style("pre.font-mono", "fontSize"), "14px", "large code is 14px");
    assert.equal(await style(".chat-title-current", "fontSize"), "16px", "the larger sidebar grows a chat name by 2px");
    await evaluate(`window.__mountTerminal()`);
    assert.equal(await evaluate(`window.__term.options.fontSize`), 14.5, "a new terminal takes the code size plus half a pixel");
    await set({ codeSize: "small" });
    await waitFor(`window.__term.options.fontSize === 11.5`);
    await set({ chatSize: "default", codeSize: "default", sidebarSize: "default" });
    await waitFor(`window.__term.options.fontSize === 12.5`);
    assert.equal(await style(bubble, "fontSize"), "13px", "back to default");

    // Diff colors follow the pair, per scheme (the fixture is dark).
    const blue = DIFF_PAIRS.find((pair) => pair.id === "blue-orange");
    await set({ diffColors: "blue-orange" });
    await waitFor(`getComputedStyle(document.querySelector('${marker}')).color === ${JSON.stringify(hexToRgb(blue.dark.add))}`);
    assert.equal(await style("[data-chat-diff] .text-diff-remove", "color"), hexToRgb(blue.dark.remove), "the sidebar's removed count follows the pair");

    // Motion: with it off a panel opens in a frame; at normal speed it is still moving a frame in.
    const openWidth = (wait) =>
      evaluate(`new Promise((resolve) => {
      window.__setPanel(false);
      setTimeout(() => {
        window.__setPanel(true);
        setTimeout(() => resolve({ width: document.querySelector('[data-changes-slot]').getBoundingClientRect().width, animations: document.getAnimations().length }), ${wait});
      }, 600);
    })`);
    await set({ motion: "normal" });
    const normal = await openWidth(40);
    assert.ok(normal.width < 300, "at normal speed the panel is still opening 40ms in (got " + normal.width + ")");
    await set({ motion: "off" });
    const off = await openWidth(40);
    assert.ok(off.width >= 320, "with motion off the panel is fully open within a frame or two");
    assert.equal(off.animations, 0, "with motion off nothing is animating");
    assert.deepEqual(errors, []);
    console.log("PASS: Appearance sizes, chat width, diff colors and motion reach the chat, code, sidebar, terminal and panels");
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.error(errors);
    app.exit(1);
  }
}

async function main() {
  const { createServer } = await import("vite");
  const server = await createServer({
    configFile: path.resolve(__dirname, "../apps/desktop/vite.config.ts"),
    cacheDir: path.resolve(__dirname, "../node_modules/.vite-appearance"),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "appearance-fixture",
        resolveId(id) {
          if (id === "/__appearance.tsx") return id;
        },
        load(id) {
          if (id === "/__appearance.tsx") return fixture;
        },
        configureServer(server) {
          server.middlewares.use(async (request, response, next) => {
            if (request.url !== "/__appearance") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await server.transformIndexHtml(
                request.url,
                '<html><body><div id="root"></div><script type="module" src="/__appearance.tsx"></script></body></html>',
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
    const child = require("node:child_process").spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__appearance`], {
      env,
      stdio: "inherit",
    });
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
  if (process.versions.electron) require("electron").app.exit(1);
  else process.exitCode = 1;
});
