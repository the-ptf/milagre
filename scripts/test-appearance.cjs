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
import { LayoutGroup } from "motion/react";
import { Select } from "/src/components/primitives/Select";
import { PillSlot } from "/src/components/primitives/StatusPill";
import { AppMotionConfig } from "/src/components/motion/AppMotionConfig";
import { useApplyTheme, updateSettings, getSettings } from "/src/lib/settings";
import { attachTerminal } from "/src/lib/terminal-sessions";
import "/src/styles.css";
window.milagre = Object.freeze({ listEditors: async () => [], setWindowBackground: async () => {}, setTerminalFocused: () => {},
  terminals: { read: () => new Promise(() => {}), input: async () => {}, resize: async () => {} } });
window.__update = (patch) => updateSettings({ appearance: { ...getSettings().appearance, ...patch } });
window.__settings = (patch) => updateSettings(patch);
window.__mountTerminal = () => {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:0;bottom:0;width:300px;height:160px';
  document.body.appendChild(host);
  window.__term = attachTerminal({ id: 't1', chatId: 'c1', title: 't', cwd: '/', label: 'l', busy: false, cols: 80, rows: 24, createdAt: 0 }, host).term;
};
const noop = () => {};
const selectOptions = Array.from({ length: 12 }, (_, index) => ({ value: "option-" + index, label: "Option " + index }));
const messages = [
  { id: 1, session_id: 1, context: null, role: "user", body: "Please fix the greeting" },
  { id: 2, session_id: 1, context: null, role: "assistant",
    body: "Here is the change.\\n\\n\`\`\`ts\\nconst answer = 42;\\n\`\`\`" },
];
const longMessages = Array.from({ length: 24 }, (_, index) => ({
  id: 100 + index, session_id: 1, context: null, role: index % 2 ? "assistant" : "user",
  body: index % 2 ? "Reply number " + index + " is long enough to wrap around a line and show text moving under the edge fade of the chat." : "Question number " + index + " about the change",
}));
function Fixture() {
  useApplyTheme();
  const [panel, setPanel] = useState(false);
  const [shift, setShift] = useState(false);
  // The edge fades: a long transcript to scroll text under them, a running turn (data-busy), and a tile (focused ChatGrid tile) behind the chat.
  const [long, setLong] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tile, setTile] = useState(false);
  window.__setPanel = setPanel;
  window.__setShift = setShift;
  window.__setLong = setLong;
  window.__setBusy = setBusy;
  window.__setTile = setTile;
  const model = MODEL_CATALOG[0];
  return <div style={{ display: "flex", height: "100vh", gap: 12, padding: 12 }}>
    <aside data-sidebar-collapsed="false" style={{ width: 224 }}>
      <ChatRow item={{ id: "1", label: "Review authentication flow", details: { diff: { added: 12, removed: 3 } } }} active collapsed={false} actions={{}} onPick={noop} show={{ computer: false, pullRequests: false, linearIssue: false, branch: false, diff: true, lastActivity: false }} />
      <CodeBlock code={"-const greeting = 'hi';\\n+const greeting = 'hello';"} fence="diff" diff />
    </aside>
    <div style={{ position: "fixed", right: 12, bottom: 190 }} data-select-probe="bottom"><Select label="Bottom probe" value="option-0" options={selectOptions} onChange={noop} width={200} /></div>
    <div style={{ position: "fixed", right: 12, top: 4 }} data-select-probe="top"><Select label="Top probe" value="option-0" options={selectOptions} onChange={noop} width={200} /></div>
    <LayoutGroup>
      <PillSlot slot="layout-probe" style={{ position: "fixed", top: 0, left: shift ? 400 : 100 }}><span style={{ display: "block", width: 20, height: 20 }} /></PillSlot>
    </LayoutGroup>
    <main style={{ flex: 1, minWidth: 0 }}>
      <div data-chat-tile={tile ? "fixture" : undefined} className={tile ? "bg-surface" : undefined} style={{ height: "100%" }}>
      <ChatComposer messages={long ? longMessages : messages}
        imageDraft={{ images: [], files: [], removeFile: noop, attachFiles: noop, loading: false, error: "", onPaste: noop, clear: noop, remove: noop }}
        projectPath="/fixture" draft="" onDraftChange={noop} onSend={noop} isSending={busy} sendBlocked={false}
        models={MODEL_CATALOG} cliStatus={null} onModelPickerOpen={noop} selectedModel={model} onModelChange={noop}
        capability={capabilityFor(model, null)} onEffortChange={noop} ultracode={false} onUltracodeChange={noop}
        fastMode={false} onFastModeChange={noop} permissionMode="auto" onPermissionModeChange={noop}
        onRecommendationSelect={noop} worktrees={[{ id: 1, name: "main", path: "/fixture" }]} onWorktreeChange={noop}
        isolation="worktree" onIsolationChange={noop} branches={["main"]} baseBranch="main" onBaseBranchChange={noop} newChatError={null}
        linearActive onStartFromIssue={noop} />
      </div>
    </main>
    <ChangesPanelSlot open={panel}>
      <aside data-changes-panel style={{ width: 320 }} className="shrink-0 rounded-window bg-inset" />
    </ChangesPanelSlot>
  </div>;
}
document.documentElement.classList.add("dark");
createRoot(document.getElementById("root")).render(<AppMotionConfig><Fixture /></AppMotionConfig>);
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

    // The fixture is dark whatever the system scheme is (a Linux runner reports light, which would pick the light pair).
    await evaluate(`window.__settings({ theme: 'dark' })`);
    await waitFor(`document.documentElement.classList.contains('dark')`);

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

    // The composer (and the chip row above it) take the transcript column's side insets, whatever the width setting,
    // so the composer card's edges line up with the transcript's text edges.
    const edges = (selector) =>
      evaluate(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); const r = el.getBoundingClientRect(); const c = getComputedStyle(el); return { left: r.left + parseFloat(c.paddingLeft), right: r.right - parseFloat(c.paddingRight) }; })()`,
      );
    const assertAligned = async (label) => {
      const transcriptEdges = await edges(".chat-column");
      const composerEdges = await edges("[data-composer-wrap]");
      assert.ok(
        Math.abs(transcriptEdges.left - composerEdges.left) <= 2,
        label + ": composer left edge lines up with the transcript " + JSON.stringify([transcriptEdges, composerEdges]),
      );
      assert.ok(
        Math.abs(transcriptEdges.right - composerEdges.right) <= 2,
        label + ": composer right edge lines up with the transcript " + JSON.stringify([transcriptEdges, composerEdges]),
      );
    };
    await assertAligned("comfortable");

    // Chat width.
    await set({ chatWidth: "wide" });
    await waitFor(`document.querySelector('.chat-column').getBoundingClientRect().width > 768`);
    assert.equal(await columnWidth(), 1024, "wide caps the column at 1024px");
    await assertAligned("wide");
    await set({ chatWidth: "full" });
    await waitFor(`document.querySelector('.chat-column').getBoundingClientRect().width > 1024`);
    assert.ok((await columnWidth()) > 1024, "full fills the pane at a 1600px window");
    await assertAligned("full");
    await set({ chatWidth: "custom", chatWidthPx: 1100 });
    await waitFor(`document.querySelector('.chat-column').getBoundingClientRect().width === 1100`);
    assert.equal(await columnWidth(), 1100, "custom caps the column at its px");
    await assertAligned("custom");
    await set({ chatWidth: "comfortable" });
    // A pane narrower than the column: the transcript's rail lane widens its left inset and the composer follows.
    window.setContentSize(900, 900);
    await waitFor(`document.querySelector('.chat-column').getBoundingClientRect().width < 700`);
    await assertAligned("narrow comfortable");
    window.setContentSize(1600, 900);
    await waitFor(`document.querySelector('.chat-column').getBoundingClientRect().width > 700`);

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
    // Counted from the frame the slot mounts in, not from the click: a slow runner can take longer than 40ms to render it.
    const off = await evaluate(`new Promise((resolve) => {
      window.__setPanel(false);
      setTimeout(() => {
        window.__setPanel(true);
        const frames = (count, done) => (count ? requestAnimationFrame(() => frames(count - 1, done)) : done());
        const mounted = () => {
          const slot = document.querySelector('[data-changes-slot]');
          if (!slot) return requestAnimationFrame(mounted);
          frames(2, () => resolve({ width: slot.getBoundingClientRect().width, animations: document.getAnimations().length }));
        };
        mounted();
      }, 600);
    })`);
    assert.ok(off.width >= 320, "with motion off the panel is fully open within a frame or two of mounting (got " + off.width + ")");
    assert.equal(off.animations, 0, "with motion off nothing is animating");
    // Layout animations (a PillSlot sliding over in a LayoutGroup) follow Off too: the probe lands in its final spot at once.
    const probeLeft = (shift, wait) =>
      evaluate(`new Promise((resolve) => {
      window.__setShift(${shift});
      setTimeout(() => resolve(document.querySelector('[data-slot="layout-probe"]').getBoundingClientRect().left), ${wait});
    })`);
    await set({ motion: "normal" });
    await probeLeft(false, 700);
    const sliding = await probeLeft(true, 40);
    assert.ok(sliding < 399, "at normal speed the layout probe is still sliding 40ms in (got " + sliding + ")");
    await set({ motion: "off" });
    await probeLeft(false, 300);
    assert.equal(await probeLeft(true, 40), 400, "with motion off a layout slide is instant");
    // Edge fades: the tint is the background the transcript sits on (the page, or a focused tile's surface) and stays
    // soft, so an empty area under a fade shows no band, while a turn runs and when idle, in light, dark and a custom theme.
    const rectOf = (selector) =>
      evaluate(
        `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }; })()`,
      );
    const capture = async (rect) => {
      window.webContents.invalidate();
      await delay(250);
      // The first capture wakes a hidden window's compositor; read the next frame.
      await window.webContents.capturePage();
      await delay(100);
      return window.webContents.capturePage(rect);
    };
    // The mean of a region's channels (whatever the bitmap's channel order, the same order for both samples being compared).
    const meanOf = (image) => {
      const { width, height } = image.getSize();
      const bitmap = image.toBitmap();
      const sum = [0, 0, 0];
      for (let pixel = 0; pixel < width * height; pixel++) for (let channel = 0; channel < 3; channel++) sum[channel] += bitmap[pixel * 4 + channel];
      return sum.map((total) => total / (width * height));
    };
    // The fade's tint as { rgb, alpha }: the browser reports the color-mix as an oklab() color, which a canvas turns into rgb.
    const tintOf = (selector) =>
      evaluate(`(() => {
        const image = getComputedStyle(document.querySelector(${JSON.stringify(selector + " > :last-child")})).backgroundImage;
        const css = /oklab\\([^)]*\\)/.exec(image)?.[0];
        if (!css) throw Error('No oklab tint in ' + image);
        const [base, alpha] = css.slice(0, -1).split('/');
        const context = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
        context.fillStyle = base.trim() + ')';
        context.fillRect(0, 0, 1, 1);
        return { rgb: [...context.getImageData(0, 0, 1, 1).data].slice(0, 3), alpha: Number(alpha) };
      })()`);
    const rgbOf = (color) => /rgb\((\d+), (\d+), (\d+)\)/.exec(color).slice(1).map(Number);
    const shootFade = async (name) => {
      if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
      fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
      // The last lines pass under the bottom fade.
      await evaluate(`(() => { const v = document.querySelector('[aria-label="Conversation"]'); v.scrollTop = v.scrollHeight - v.clientHeight - 70; })()`);
      await delay(200);
      const composer = await rectOf("[data-composer-wrap]");
      const column = await rectOf(".chat-column");
      const x = Math.max(0, column.x - 60);
      const y = Math.max(0, composer.y - 200);
      const image = await capture({ x, y, width: Math.min(column.width + 120, 1600 - x), height: 330 });
      fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, name + ".png"), image.toPNG());
    };
    const fades = async (label, background) => {
      for (const busy of [false, true]) {
        await evaluate(`window.__setBusy(${busy})`);
        await waitFor(`!!document.querySelector('.chat-bottom-blur')?.hasAttribute('data-busy') === ${busy}`);
        await delay(100);
        const where = label + (busy ? ", turn running" : ", idle");
        const bottom = await tintOf(".chat-bottom-blur");
        const wanted = rgbOf(background);
        for (const channel of [0, 1, 2])
          assert.ok(
            Math.abs(bottom.rgb[channel] - wanted[channel]) <= 2,
            where + ": the bottom fade tints toward the transcript background " + background + " (got " + JSON.stringify(bottom) + ")",
          );
        assert.ok(bottom.alpha <= (busy ? 0.5 : 0.35) + 0.001, where + ": the bottom fade tint stays soft (got " + JSON.stringify(bottom) + ")");
        assert.deepEqual(await tintOf(".chat-top-blur"), bottom, where + ": the top fade mirrors the bottom's tint");
        assert.equal((await rectOf(".chat-bottom-blur")).height, 56, where + ": the bottom fade is 56px tall");
        // Over empty space the middle of the fade is the background itself: same pixels as just above the fade.
        const overlay = await rectOf(".chat-bottom-blur");
        // Clear of the terminal the size checks left at the window's bottom-left corner.
        const x = overlay.x + 330;
        const middle = meanOf(await capture({ x, y: overlay.y + Math.round(overlay.height / 2) - 4, width: 24, height: 8 }));
        const above = meanOf(await capture({ x, y: overlay.y - 60, width: 24, height: 8 }));
        for (const channel of [0, 1, 2])
          assert.ok(Math.abs(middle[channel] - above[channel]) <= 3, where + ": no band over an empty transcript " + JSON.stringify([middle, above]));
      }
    };
    const backgroundOf = (selector) => style(selector, "backgroundColor");
    await set({ chatWidth: "comfortable" });
    await evaluate(`window.__settings({ theme: 'dark', colorTheme: 'default' })`);
    await waitFor(`document.documentElement.classList.contains('dark')`);
    await fades("dark page", await backgroundOf("body"));
    await evaluate(`window.__setTile(true)`);
    await waitFor(`!!document.querySelector('[data-chat-tile]')`);
    await fades("dark tile", await backgroundOf("[data-chat-tile]"));
    await evaluate(`window.__settings({ theme: 'light' })`);
    await waitFor(`!document.documentElement.classList.contains('dark')`);
    await fades("light tile", await backgroundOf("[data-chat-tile]"));
    await evaluate(`window.__setTile(false)`);
    await fades("light page", await backgroundOf("body"));
    await evaluate(
      `window.__settings({ theme: 'dark', colorTheme: 'custom', customThemeEnabled: true, customTheme: { light: { background: '#fdf6e3', text: '#073642', accent: '#268bd2' }, dark: { background: '#1f1630', text: '#e6ddf5', accent: '#b48ead' } } })`,
    );
    await waitFor(`document.documentElement.classList.contains('dark')`);
    await evaluate(`window.__setTile(true)`);
    await fades("custom tile", await backgroundOf("[data-chat-tile]"));
    // With text scrolled under the bottom edge, as it reads while a turn runs (screenshots when MILAGRE_SCREENSHOT_DIR is set).
    await evaluate(`window.__setLong(true)`);
    await waitFor(`document.querySelectorAll('[data-slot="message"]').length > 20`);
    await evaluate(`window.__settings({ colorTheme: 'default' })`);
    await waitFor(`document.documentElement.classList.contains('dark')`);
    await evaluate(`window.__setBusy(true)`);
    await delay(300);
    await shootFade("fade-tile-dark-busy");
    await evaluate(`window.__setTile(false)`);
    await delay(200);
    await shootFade("fade-page-dark-busy");
    await evaluate(`window.__setLong(false); window.__setBusy(false)`);
    await evaluate(`window.__settings({ theme: 'dark' })`);

    // Select: near the bottom it opens above its trigger and shows more rows than a downward panel would; near the top it opens below.
    const openProbe = async (label) => {
      await evaluate(`document.querySelector('[aria-label=${JSON.stringify(label)}][aria-haspopup]').click()`);
      await waitFor(`!!document.querySelector('[role="listbox"][aria-label=${JSON.stringify(label)}]')`);
      const result = await evaluate(`(() => {
        const trigger = document.querySelector('[aria-label=${JSON.stringify(label)}][aria-haspopup]').getBoundingClientRect();
        const panel = document.querySelector('[role="listbox"][aria-label=${JSON.stringify(label)}] [data-picker-panel]').getBoundingClientRect();
        return { triggerTop: trigger.top, triggerBottom: trigger.bottom, top: panel.top, bottom: panel.bottom, height: panel.height };
      })()`);
      await evaluate(`document.querySelector('[aria-label=${JSON.stringify(label)}][aria-haspopup]').click()`);
      await waitFor(`!document.querySelector('[role="listbox"][aria-label=${JSON.stringify(label)}]')`);
      return result;
    };
    const lower = await openProbe("Bottom probe");
    assert.ok(lower.bottom <= lower.triggerTop, "a Select near the bottom opens above its trigger " + JSON.stringify(lower));
    assert.ok(lower.height > 250, "and shows its rows instead of a stub (height " + lower.height + ")");
    const upper = await openProbe("Top probe");
    assert.ok(upper.top >= upper.triggerBottom, "a Select near the top opens below its trigger " + JSON.stringify(upper));
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
