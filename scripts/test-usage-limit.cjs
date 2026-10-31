// Run with node scripts/test-usage-limit.cjs. Checks the usage-limit card under a reply the plan's limit stopped:
// its headline shows on its own while a turn runs or the reply isn't the Chat's last message; with the Chat idle it
// lists the Project's other accounts (signed-out ones greyed), a failed switch says why and re-enables, a good one calls
// the bridge and replaces the buttons with the result; no other account offers Add account, and only limited ones also
// offer Manage accounts. The message that continued the Chat on the new account shows as a line, not a bubble. Also checks the Experimental switch reads and saves through the bridge.
// Set MILAGRE_SCREENSHOT_DIR to keep screenshots.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");

const fixture = `
// A switch continues the Chat.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatComposer } from "/src/components/ChatComposer";
import { SettingsPanel } from "/src/components/Settings";
import { BridgeContext, ScopeContext } from "/src/lib/computer-bridge";
import { MODEL_CATALOG, capabilityFor } from "/src/model";
import "/src/styles.css";
const noop = () => {};
const params = new URLSearchParams(location.search);
const scenario = params.get("scenario") || "running";
const future = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
const account = (id, extra = {}) => ({ id, provider: "claude", label: id, state: "ready", ...extra });
const accountSets = {
  running: [account("default"), account("work", { email: "work@example.com", plan: "team" })],
  choices: [
    account("default"),
    account("work", { email: "work@example.com", plan: "team" }),
    account("flaky", { email: "flaky@example.com", plan: "max" }),
    account("old", { email: "old@example.com", state: "signed-out" }),
  ],
  none: [account("default")],
  limited: [account("default"), account("work", { email: "work@example.com", limitedUntil: future })],
};
window.switchCalls = [];
window.accountsOpened = 0;
window.autoSaves = [];
window.milagre = Object.freeze({
  listEditors: async () => [],
  listAccounts: async () => ({ providers: [{ provider: "claude", selectedId: "default", accounts: [account("default")] }] }),
  accountAction: async () => ({ providers: [] }),
  readLimitAutoSwitch: async () => ({ autoSwitch: false }),
  saveLimitAutoSwitch: async (value) => (window.autoSaves.push(value), { autoSwitch: value }),
  listRecentProjects: async () => [],
  listProjects: async () => [],
});
const bridge = {
  ...window.milagre,
  getProjectAccounts: async (scopeKey) => ({
    scopeKey,
    providers: [{ provider: "claude", accountId: null, effectiveId: "default", defaultId: "default", accounts: accountSets[scenario] ?? accountSets.running }],
  }),
  switchAccountAfterLimit: async (projectPath, sessionId, provider, accountId) => {
    window.switchCalls.push([projectPath, sessionId, provider, accountId]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (accountId === "flaky") throw new Error("Could not reach flaky@example.com");
    return { continued: true, label: "work@example.com" };
  },
};
const limited = { id: 2, session_id: 7, role: "assistant", body: "You've hit your session limit · resets 12:10pm", outcome: "failed", context: { kind: "limit", provider: "claude", accountId: "default", resetsAt: future } };
function Fixture() {
  const messages = [
    { id: 1, session_id: 7, context: null, role: "user", body: "Wire up the invoices export" },
    limited,
    ...(scenario === "older" ? [{ id: 3, session_id: 7, context: null, role: "user", body: "Try again" }] : []),
    ...(scenario === "continued"
      ? [
          { id: 3, session_id: 7, role: "user", body: "Switched to work@example.com after the usage limit", context: { kind: "account-switch", provider: "claude", label: "work@example.com" } },
          { id: 4, session_id: 7, role: "assistant", body: "Picking up the invoices export where it stopped.", outcome: "completed", context: null },
        ]
      : []),
  ];
  return <div style={{ height: "100%", padding: 12 }}>
    <BridgeContext.Provider value={bridge}><ScopeContext.Provider value="/fixture">
      <ChatComposer messages={messages}
        imageDraft={{ images: [], files: [], attachFiles: noop, attachPath: noop, removeFile: noop, loading: false, error: "", onPaste: noop, clear: noop, remove: noop }}
        projectPath="/fixture" draft="" onDraftChange={noop} onSend={noop} isSending={scenario === "running"} sendBlocked={false}
        onOpenAccounts={() => { window.accountsOpened++; }}
        models={MODEL_CATALOG} cliStatus={null} onModelPickerOpen={noop} selectedModel={MODEL_CATALOG[0]} onModelChange={noop}
        capability={capabilityFor(MODEL_CATALOG[0], null)} onEffortChange={noop} ultracode={false} onUltracodeChange={noop}
        fastMode={false} onFastModeChange={noop} permissionMode="auto" onPermissionModeChange={noop}
        onRecommendationSelect={noop} worktrees={[]} onWorktreeChange={noop}
        isolation="local" onIsolationChange={noop} branches={[]} baseBranch="main" onBaseBranchChange={noop} newChatError={null} />
    </ScopeContext.Provider></BridgeContext.Provider>
  </div>;
}
function Settings() {
  return <div style={{ padding: 12, height: "100%" }}><SettingsPanel section="accounts" models={[]} update={null} /></div>;
}
document.documentElement.classList.add("dark");
createRoot(document.getElementById("root")).render(scenario === "settings" ? <Settings /> : <Fixture />);
`;

async function browserChecks(base) {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "milagre-usage-limit-")));
  await app.whenReady();
  const window = new BrowserWindow({ width: 800, height: 600, useContentSize: true, show: false, webPreferences: { backgroundThrottling: false } });
  const errors = [];
  window.webContents.on("console-message", (details) => {
    if (details.level === "error") errors.push(details.message);
  });
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  async function waitFor(source) {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw new Error(`Timed out: ${source}`);
  }
  async function screenshot(name) {
    if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
    await delay(500);
    fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  }
  const card = 'document.querySelector("[data-slot=usage-limit]")';
  const open = async (scenario) => {
    await window.loadURL(`${base}?scenario=${scenario}`);
    await waitFor(`!!${card}`);
  };
  const buttons = `[...${card}.querySelectorAll("button")]`;
  try {
    // A running turn, or a reply that isn't the last message: the headline only.
    await open("running");
    const text = await evaluate(`${card}.textContent`);
    assert.match(text, /Claude hit its usage limit/, "the headline names the provider");
    assert.match(text, /It resets at/, "and says when it resets");
    await delay(200);
    assert.equal(await evaluate(`${buttons}.length`), 0, "no buttons while a turn runs");
    await screenshot("static");
    await open("older");
    await delay(200);
    assert.equal(await evaluate(`${buttons}.length`), 0, "no buttons once the Chat moved on");

    // Idle: the other accounts, the signed-out one greyed.
    await open("choices");
    await waitFor(`${buttons}.length === 3`);
    assert.deepEqual(await evaluate(`${buttons}.map((button) => button.dataset.account)`), ["work", "flaky", "old"]);
    assert.deepEqual(await evaluate(`${buttons}.map((button) => button.disabled)`), [false, false, true], "a signed-out account can't be picked");
    assert.match(await evaluate(`${buttons}[0].textContent`), /Switch to work@example\.com/);
    assert.match(await evaluate(`${buttons}[0].textContent`), /Team/);
    assert.match(await evaluate(`${buttons}[2].textContent`), /Not signed in/);
    assert.equal(await evaluate(`!!${card}.querySelector("[data-usage-limit-add], [data-usage-limit-manage]")`), false, "no way out while some account works");
    await screenshot("choices");

    // A failed switch says why and leaves every account pickable.
    await evaluate(`${buttons}[1].click()`);
    await waitFor(`!!${card}.querySelector("[data-usage-limit-error]")`);
    assert.match(await evaluate(`${card}.querySelector("[data-usage-limit-error]").textContent`), /Could not reach flaky@example\.com/);
    assert.deepEqual(await evaluate(`${buttons}.map((button) => button.disabled)`), [false, false, true]);
    await screenshot("error");

    // A good one calls the bridge for this Chat and shows the result instead of the buttons.
    await evaluate(`${buttons}[0].click()`);
    await waitFor(`!!${card}.querySelector("[data-usage-limit-result]")`);
    assert.equal(await evaluate(`${card}.querySelector("[data-usage-limit-result]").textContent`), "Switched to work@example.com. Continuing…");
    assert.equal(await evaluate(`${buttons}.length`), 0, "the buttons are gone");
    assert.equal(await evaluate(`!!${card}.querySelector("[data-usage-limit-error]")`), false, "and the earlier error with them");
    assert.deepEqual(await evaluate("window.switchCalls"), [
      ["/fixture", 7, "claude", "flaky"],
      ["/fixture", 7, "claude", "work"],
    ]);
    await screenshot("switched");

    // The message that continued the Chat is a line between the card and the reply, not a bubble the user typed.
    await open("continued");
    const divider = 'document.querySelector("[data-account-switch-divider]")';
    await waitFor(`!!${divider}`);
    assert.equal(await evaluate(`${divider}.textContent`), "Switched towork@example.com");
    assert.equal(await evaluate(`${divider}.getAttribute("aria-label")`), "Switched to work@example.com after the usage limit");
    assert.equal(
      await evaluate('[...document.querySelectorAll("[data-slot=message]")].some((item) => item.textContent.includes("after the usage limit"))'),
      false,
    );
    await screenshot("continued");

    // No other account: Add account opens Settings > Accounts.
    await open("none");
    await waitFor(`!!${card}.querySelector("[data-usage-limit-add]")`);
    assert.equal(await evaluate(`${buttons}.length`), 1);
    await evaluate(`${card}.querySelector("[data-usage-limit-add]").click()`);
    assert.equal(await evaluate("window.accountsOpened"), 1);
    await screenshot("add-account");

    // Every other account limited too: greyed with when they're back, and Manage accounts.
    await open("limited");
    await waitFor(`!!${card}.querySelector("[data-usage-limit-manage]")`);
    assert.equal(await evaluate(`${buttons}[0].disabled`), true);
    assert.match(await evaluate(`${buttons}[0].textContent`), /Limited until/);
    await evaluate(`${card}.querySelector("[data-usage-limit-manage]").click()`);
    assert.equal(await evaluate("window.accountsOpened"), 1, "a new page, a new count");
    await screenshot("all-limited");

    // Accounts > Usage limits: the Mac-owned switch reads off, saves through the bridge.
    await window.loadURL(`${base}?scenario=settings`);
    const toggle =
      'document.querySelector(\'[role="checkbox"][aria-label="Switch accounts at usage limits"], button[aria-label="Switch accounts at usage limits"]\')';
    await waitFor(`!!${toggle}`);
    assert.match(await evaluate("document.body.textContent"), /move its Project to the next signed-in account and continue/);
    await evaluate(`${toggle}.click()`);
    await waitFor("JSON.stringify(window.autoSaves) === '[true]'");
    await waitFor(`${toggle}.getAttribute("aria-checked") === "true"`);
    await screenshot("setting-on");

    assert.deepEqual(errors, []);
    console.log(
      "PASS: the limit card shows its headline alone while a turn runs or after the Chat moved on; idle, it lists the other accounts with signed-out ones greyed, reports a failed switch and re-enables, and shows the result of a good one; the continue message is a line; Add account and Manage accounts open Settings; the Accounts switch saves through the bridge",
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.error(errors);
    app.exit(1);
  }
}

async function main() {
  const { createServer } = await import("vite");
  const { spawn } = require("node:child_process");
  const server = await createServer({
    configFile: path.resolve(__dirname, "../apps/desktop/vite.config.ts"),
    cacheDir: path.resolve(__dirname, "../node_modules/.vite-usage-limit"),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "usage-limit-fixture",
        resolveId(id) {
          if (id === "/__usage_limit_fixture.tsx") return id;
        },
        load(id) {
          if (id === "/__usage_limit_fixture.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url?.split("?")[0] !== "/__usage_limit__") return next();
            const html = await server.transformIndexHtml(
              request.url,
              '<html><body><div id="root"></div><script type="module" src="/__usage_limit_fixture.tsx"></script></body></html>',
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
    const child = spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__usage_limit__`], { env, stdio: "inherit" });
    process.exitCode = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    await server.close();
  }
}
(process.versions.electron ? browserChecks(process.argv[2]) : main()).catch((error) => {
  console.error(error);
  if (process.versions.electron) require("electron").app.exit(1);
  else process.exitCode = 1;
});
