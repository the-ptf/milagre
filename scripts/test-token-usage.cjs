const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { home, link, report, accountUsage } = require("./fixtures/token-usage.cjs");
const { useAsyncMiddleware } = require("./async-middleware.cjs");

const fixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import { TokenUsagePage } from "/src/components/token-usage/TokenUsagePage";
import { AccountUsageSection } from "/src/components/usage/AccountUsageSection";
import { applyThemeNow } from "/src/lib/settings";
import "/src/fonts.css";
import "/src/styles.css";
localStorage.setItem("milagre.tokenUsage", JSON.stringify({ metric: "tokens", range: "7d" }));
window.accountUsageReads = 0;
window.analyticsReads = 0;
window.accountData = ${JSON.stringify(accountUsage)};
window.defaultActions = [];
window.milagre = {
  readTokenUsage: async () => { window.analyticsReads++; return (${JSON.stringify(report)}); },
  getCachedAccountUsage: async () => window.accountData,
  readAccountUsage: async () => { window.accountUsageReads++; return window.accountData; },
  accountAction: async (...args) => {
    window.defaultActions.push(args);
    if (window.failSelection) throw new Error("Selection failed");
    const [, provider, id] = args;
    window.accountData = { ...window.accountData, providers: window.accountData.providers.map(entry => entry.provider === provider ? { ...entry, account: { ...entry.account, default: entry.account.id === id || undefined } } : entry) };
  },
  on: () => window.milagre
};
window.opened = [];
applyThemeNow();
const root = createRoot(document.getElementById("root"));
root.render(<TokenUsagePage onOpenChat={(...args) => window.opened.push(args)} />);
window.showRemote = () => root.render(<AccountUsageSection computerId="peer-fixture" computerName="Paired Mac" onManageAccounts={() => {}} />);
`;

async function check() {
  const { app, BrowserWindow } = require("electron");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-token-usage-"));
  app.setPath("userData", profile);
  if (process.platform === "darwin") app.setActivationPolicy("prohibited");
  await app.whenReady();
  const window = new BrowserWindow({ width: 1120, height: 1000, show: false, webPreferences: { backgroundThrottling: false } });
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  async function waitFor(source) {
    for (let i = 0; i < 200; i++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw new Error(`Timed out: ${source}`);
  }
  try {
    await window.loadURL(process.argv[2]);
    await waitFor(`document.querySelectorAll("[data-account-usage] [data-usage-account]").length === 3`);
    assert.equal(await evaluate("window.analyticsReads"), 0, "Plan usage does not read analytics");
    assert.equal(await evaluate(`document.querySelector('[aria-label="Usage view"] [aria-selected=true]').textContent`), "Plan usage");
    assert.deepEqual(
      await evaluate(
        `Array.from(document.querySelectorAll('[data-account-usage] h2')).map(el => [el.getAttribute('aria-label'), el.querySelector('span').textContent.trim()])`,
      ),
      [
        ["Codex, 1 account", "1 account"],
        ["Claude, 2 accounts", "2 accounts"],
      ],
      "provider headings are explicit, without repeating the selected tab title",
    );
    assert.equal(
      await evaluate(`document.querySelector('[data-usage-provider=claude]').classList.contains('bg-surface')`),
      true,
      "each provider has its own surface",
    );
    assert.equal(await evaluate(`document.querySelector('[data-usage-provider=codex]').classList.contains('shadow-card')`), true);
    assert.equal(await evaluate(`document.querySelectorAll("[data-usage-provider=claude] [data-usage-account]").length`), 2);
    for (const [id, percent] of [
      ["personal", 21],
      ["work", 76],
      ["default", 42],
    ]) {
      const text = await evaluate(`document.querySelector('[data-account-usage] [data-usage-account="${id}"]').textContent`);
      for (const label of ["Five-hour", "Daily", "Weekly"]) assert.match(text, new RegExp(label));
      assert.match(text, new RegExp(`${percent}%`));
    }
    const refreshSelector = JSON.stringify('[aria-label="Refresh plan usage"]');
    await waitFor(`!document.querySelector(${refreshSelector}).disabled`);
    const toolbarAligned = `(() => {
      const tabs = document.querySelector('[aria-label="Usage view"]').getBoundingClientRect();
      const refresh = document.querySelector('[aria-label="Refresh plan usage"]').getBoundingClientRect();
      return Math.abs(tabs.y + tabs.height / 2 - refresh.y - refresh.height / 2) < 1;
    })()`;
    assert.equal(await evaluate(toolbarAligned), true, "tabs and plan controls share one row");
    assert.equal(await evaluate(`document.querySelectorAll('[aria-label="Refresh plan usage"]').length`), 1, "the toolbar reuses the refresh control");
    await evaluate(`document.querySelector(${refreshSelector}).click()`);
    await waitFor("window.accountUsageReads === 2");
    await evaluate(`document.querySelector('[aria-label="Usage view"] [aria-selected=true]').focus()`);
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Right" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Right" });
    await waitFor(`document.querySelectorAll("[data-usage-project]").length === 2`);
    assert.equal(await evaluate(`document.querySelector('[aria-label="Usage view"] [aria-selected=true]').textContent`), "Analytics");
    assert.equal(await evaluate(`document.querySelector('[data-account-usage]')`), null, "analytics is separate from account limits");
    assert.equal(await evaluate(`document.querySelectorAll("[data-usage-model]").length`), 1, "Activity model details stay visible");
    assert.equal(await evaluate(`document.querySelectorAll("[data-usage-day]").length > 0`), true, "Activity calendar stays visible");
    for (const owner of [home, link]) {
      const selector = `[data-usage-project="${owner}"]`;
      await evaluate(
        `(() => { const button = document.querySelector(${JSON.stringify(selector + " > button")}); if (button.getAttribute("aria-expanded") !== "true") button.click(); })()`,
      );
      await waitFor(`document.querySelector(${JSON.stringify(selector + " [data-usage-chat]")})`);
      const text = await evaluate(`document.querySelector(${JSON.stringify(selector)}).textContent`);
      assert.match(text, owner === home ? /Plan the release/ : /Update both apps/);
      assert.doesNotMatch(text, /Outside Milagre|Archived/);
      await evaluate(`document.querySelector(${JSON.stringify(selector + " [data-usage-chat]")}).click()`);
    }
    assert.deepEqual(await evaluate("window.opened"), [
      ["local", home, 7],
      ["local", link, 7],
    ]);
    if (process.env.MILAGRE_SCREENSHOT_DIR) {
      await delay(150);
      fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, "chat-attribution.png"), (await window.webContents.capturePage()).toPNG());
    }
    await evaluate(`document.querySelector('[aria-label="Usage view"] [role=tab]').click()`);
    await waitFor(`document.querySelectorAll("[data-account-usage] [data-usage-account]").length === 3`);
    const readsBeforeDefault = await evaluate("window.accountUsageReads");
    const actionSelector = '[data-usage-account="work"] button';
    assert.equal(await evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(actionSelector)})).opacity`), "0", "action is hidden at rest");
    const actionRect = await evaluate(
      `(() => { const element = document.querySelector(${JSON.stringify(actionSelector)}); element.scrollIntoView(); const r = element.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    );
    window.webContents.debugger.attach("1.3");
    await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", ...actionRect });
    await waitFor(`getComputedStyle(document.querySelector(${JSON.stringify(actionSelector)})).opacity === "1"`);
    await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: 0, y: 0 });
    await evaluate(`document.querySelector(${JSON.stringify(actionSelector)}).focus()`);
    await waitFor(`getComputedStyle(document.querySelector(${JSON.stringify(actionSelector)})).opacity === "1"`);
    await waitFor(`document.querySelector("[role=tooltip]")?.textContent.includes("Project and Link choices stay")`);
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('[data-usage-account="work"]')).backgroundColor`), "rgba(0, 0, 0, 0)");
    await evaluate(`document.querySelector('[data-usage-account="work"]').click()`);
    assert.deepEqual(await evaluate("window.defaultActions"), [], "informational rows do not switch accounts");
    await evaluate(`document.querySelector(${JSON.stringify(actionSelector)}).click()`);
    await waitFor(`!document.querySelector('[data-usage-account="work"] button')`);
    assert.deepEqual(await evaluate("window.defaultActions"), [["select", "claude", "work"]]);
    assert.match(await evaluate(`document.querySelector('[data-usage-account="work"]').textContent`), /Default/);
    assert.equal(await evaluate("window.accountUsageReads"), readsBeforeDefault, "changing the default reuses cached windows");
    await evaluate(`window.failSelection = true; document.querySelector('[data-usage-account="personal"] button').click()`);
    await waitFor(`document.querySelector("[role=alert]")?.textContent.includes("Selection failed")`);
    assert.match(await evaluate(`document.querySelector('[data-usage-account="work"]').textContent`), /Default/);
    await evaluate(`document.querySelector('[aria-label="Plan usage display"]').click()`);
    await waitFor(`document.querySelector("[role=listbox]")`);
    await evaluate(`Array.from(document.querySelectorAll("[role=option]")).find(el => el.textContent.includes("Remaining")).click()`);
    await waitFor(`document.querySelector('[data-usage-account="work"]').textContent.includes("24% left")`);
    assert.equal(await evaluate(`document.querySelector('[data-usage-account="work"] .h-1 > span').style.width`), "24%");
    window.setContentSize(720, 1000);
    await waitFor("innerWidth === 720");
    assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true, "the compact view fits a narrower desktop panel");
    assert.equal(await evaluate(toolbarAligned), true, "the shared toolbar stays aligned at a narrower width");
    if (process.env.MILAGRE_SCREENSHOT_DIR) {
      await delay(150);
      fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, "compact-narrow.png"), (await window.webContents.capturePage()).toPNG());
    }
    assert.equal(
      await evaluate(`document.querySelector('[data-usage-account="work"]').scrollWidth <= document.querySelector('[data-usage-account="work"]').clientWidth`),
      true,
      "five windows wrap inside the account row",
    );
    await evaluate("window.showRemote()");
    await waitFor(`document.querySelectorAll("[data-usage-account]").length === 3`);
    assert.equal(await evaluate(`document.querySelectorAll("[data-usage-account] button").length`), 0, "paired computers never offer default mutations");
    assert.equal(await evaluate(`document.querySelector("[data-account-usage]").textContent.includes("Manage accounts")`), false);
    console.log("PASS: Plan usage windows, default actions, display preference, remote restrictions and canonical Chat links");
    window.destroy();
    fs.rmSync(profile, { recursive: true, force: true });
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
        name: "token-usage-fixture",
        resolveId(id) {
          if (id === "/__token_usage.tsx") return id;
        },
        load(id) {
          if (id === "/__token_usage.tsx") return fixture;
        },
        configureServer(vite) {
          useAsyncMiddleware(vite.middlewares, async (request, response, next) => {
            if (request.url !== "/__token_usage__") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await vite.transformIndexHtml(
                request.url,
                '<html><body><div id="root" style="height:100vh"></div><script type="module" src="/__token_usage.tsx"></script></body></html>',
              ),
            );
          });
        },
      },
    ],
  });
  try {
    await server.listen();
    const env = { ...process.env, MILAGRE_BACKGROUND: "1" };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__token_usage__`], {
      env,
      stdio: "inherit",
      timeout: 60_000,
      killSignal: "SIGKILL",
    });
    process.exitCode = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    await server.close();
  }
}
(process.versions.electron ? check() : main()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
