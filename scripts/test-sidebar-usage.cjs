// Browser integration check using the app's existing Electron/Vite dependencies.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { SidebarUsage } from "/src/components/usage/SidebarUsage";
import { applyThemeNow, getSettings, updateSettings } from "/src/lib/settings";
import "/src/fonts.css";
import "/src/styles.css";
// Exercise a supported bundled font: system font metrics differ across Linux images and macOS.
updateSettings({ theme: "dark", usageDisplay: "used", appearance: { ...getSettings().appearance, uiFont: "inter" } });
applyThemeNow();
window.setTheme = theme => { updateSettings({ theme }); applyThemeNow(); };
const weekly = { id: "weekly", label: "Weekly", shortLabel: "wk", usedPercent: 96, resetsAt: null };
const session = { id: "session", label: "Session", shortLabel: "5h", usedPercent: 32, resetsAt: null };
window.setDisplay = usageDisplay => updateSettings({ usageDisplay });
// The Project's saved accounts: two for Claude, so its card offers a picker; one for Codex, which stays plain text.
const accountListeners = new Set();
let claudeChoice = null;
window.assigned = [];
const ready = (id, email) => ({ id, label: id, email, state: "ready" });
window.milagre = {
  getProjectAccounts: async (scopeKey) => ({ scopeKey, providers: [
    { provider: "claude", accountId: claudeChoice, effectiveId: claudeChoice ?? "work", defaultId: "work", accounts: [ready("work", "work@example.test"), ready("personal", "me@example.test")] },
    { provider: "codex", accountId: null, effectiveId: "personal", defaultId: "personal", accounts: [ready("personal", "victor@example.test")] },
  ] }),
  assignProjectAccount: async (scopeKey, provider, id) => {
    window.assigned.push([scopeKey, provider, id]);
    claudeChoice = id;
    accountListeners.forEach((listener) => listener());
    return window.milagre.getProjectAccounts(scopeKey);
  },
  onAccountsChanged: (listener) => (accountListeners.add(listener), () => accountListeners.delete(listener)),
};
function Fixture() {
  const [hasSession, setSession] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [scope, setScope] = useState(undefined);
  window.setScope = setScope;
  window.setSession = setSession;
  window.setCollapsed = setCollapsed;
  const snapshot = { providers: [
    { provider: "claude", account: { id: "work", label: "Work" }, status: "ok", windows: [{ ...session, usedPercent: 0 }, { ...weekly, usedPercent: 82 }] },
    { provider: "codex", account: { id: "personal", label: "Personal", email: "victor@example.test" }, status: "ok", windows: hasSession ? [session, weekly] : [weekly], bankedResets: 3 },
    { provider: "antigravity", account: { id: "default", label: "Default account" }, status: "ok", windows: [
      { id: "gemini:5h", label: "Gemini 5-hour", shortLabel: "5h", usedPercent: 3, resetsAt: null },
      { id: "gemini:weekly", label: "Gemini weekly", shortLabel: "wk", usedPercent: 25, resetsAt: null },
    ] },
  ] };
  return <aside className="bg-surface rounded-[8px]" data-sidebar-collapsed={collapsed} style={{ width: collapsed ? 44 : 224, padding: 8, margin: 24 }}>
    <SidebarUsage scope={scope} usage={{ snapshot, loading: false, refresh: async () => {}, refreshIfStale: () => {} }} />
  </aside>;
}
createRoot(document.getElementById("root")).render(<Fixture />);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "milagre-sidebar-usage-")));
  await app.whenReady();
  const window = new BrowserWindow({ width: 320, height: 180, show: false, webPreferences: { backgroundThrottling: false } });
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  async function waitFor(source) {
    for (let i = 0; i < 200; i++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw new Error(`Timed out: ${source}`);
  }
  async function resize(width, height) {
    // setContentSize returns before the renderer's resize event, which closes an open usage card.
    await evaluate('window.usageResized = false; window.addEventListener("resize", () => { window.usageResized = true; }, { once: true }); true');
    window.setContentSize(width, height);
    await waitFor(`window.usageResized && innerWidth === ${width} && innerHeight === ${height}`);
  }
  const geometry = () =>
    evaluate(`(() => [...document.querySelectorAll('.sidebar-usage-row')].map(row =>
    [...row.querySelectorAll('.sidebar-copy .overflow-hidden')].map(bar => {
      const rect = bar.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: rect.width, fill: bar.firstElementChild.style.width };
    })
  ))()`);
  const screenshot = async (name) => {
    await delay(350);
    const image = await window.webContents.capturePage();
    if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
    require("node:fs").mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
    require("node:fs").writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, `${name}.png`), image.toPNG());
  };
  try {
    await window.loadURL(process.argv[2]);
    await waitFor('document.querySelectorAll(".sidebar-usage-row").length === 3');
    assert.equal(
      await evaluate('document.fonts.load(\'12px "Inter Variable"\').then(faces => faces.length > 0 && faces.every(face => face.status === "loaded"))'),
      true,
      "The bundled Inter font loaded before measuring the rows",
    );
    await evaluate("document.fonts.ready.then(() => true)");
    assert.match(await evaluate('getComputedStyle(document.querySelector(".sidebar-copy.truncate")).fontFamily'), /^"Inter Variable"/);
    const [claude, codex, antigravity] = await geometry();
    assert.equal(antigravity.length, 2, "Antigravity shows its Gemini 5-hour and weekly windows");
    assert.deepEqual(
      antigravity.map((bar) => bar.fill),
      ["3%", "25%"],
    );
    assert.equal(await evaluate('document.querySelectorAll(".sidebar-usage-row")[2].textContent'), "Antigravity3%5h25%wk");
    assert.equal(
      await evaluate(
        '(() => { const name = document.querySelectorAll(".sidebar-usage-row")[2].querySelector(".truncate"); const range = document.createRange(); range.selectNodeContents(name); return range.getBoundingClientRect().width <= name.getBoundingClientRect().width; })()',
      ),
      true,
      "The longest provider name fits beside two windows",
    );
    assert.equal(codex.length, 1);
    assert.equal(codex[0].width, 104, "Weekly-only meter spans both window columns");
    assert.equal(codex[0].left, claude[0].left);
    assert.equal(codex[0].right, claude[1].right);
    assert.equal(codex[0].fill, "96%", "Full-width track preserves actual usage");
    await screenshot("weekly-only-dark");
    await evaluate("window.setSession(true)");
    await waitFor('document.querySelectorAll(".sidebar-usage-row")[1].textContent.includes("5h")');
    const [twoClaude, twoCodex] = await geometry();
    assert.deepEqual(
      twoCodex.map(({ left, right, width }) => ({ left, right, width })),
      twoClaude.map(({ left, right, width }) => ({ left, right, width })),
    );
    assert.deepEqual(
      twoCodex.map((bar) => bar.width),
      [48, 48],
    );
    assert.deepEqual(
      twoCodex.map((bar) => bar.fill),
      ["32%", "96%"],
    );
    await screenshot("5h-dark");
    await evaluate('window.setTheme("light")');
    await screenshot("5h-light");
    await evaluate('window.setSession(false); window.setDisplay("remaining")');
    await waitFor('document.querySelectorAll(".sidebar-usage-row")[1].textContent.includes("4%")');
    assert.equal((await geometry())[1][0].width, 104);
    assert.equal((await geometry())[1][0].fill, "4%");
    await evaluate('window.setDisplay("used")');
    await waitFor('document.querySelectorAll(".sidebar-usage-row")[1].textContent.includes("96%")');
    await screenshot("weekly-only-light");
    await resize(560, 420);
    await evaluate('document.querySelector("aside").style.marginTop = "300px"');
    const cardText = '(document.querySelector("[data-usage-card]")?.textContent ?? "")';
    await evaluate('document.querySelectorAll(".sidebar-usage-row")[1].click()');
    await waitFor(`${cardText}.includes("victor@example.test")`);
    const codexCard = await evaluate(cardText);
    assert.match(codexCard, /victor@example\.test/);
    assert.doesNotMatch(codexCard, /Codex/);
    assert.match(codexCard, /Banked resets3 left/);
    assert.equal(await evaluate('document.querySelector("[data-usage-account]").textContent'), "victor@example.test");
    assert.match(await evaluate('document.querySelectorAll(".sidebar-usage-row")[1].getAttribute("aria-label")'), /victor@example.test/);
    await screenshot("codex-card-banked");
    // Resizing really dismisses a card; the next click must happen after delivery of that event.
    await resize(580, 440);
    await waitFor('!document.querySelector("[data-usage-card]")');
    await evaluate('document.querySelectorAll(".sidebar-usage-row")[1].click()');
    await waitFor(`${cardText}.includes("victor@example.test")`);
    assert.match(await evaluate(cardText), /Banked resets3 left/);
    await evaluate('window.setTheme("dark")');
    await screenshot("codex-account-dark");
    await evaluate('document.querySelectorAll(".sidebar-usage-row")[0].click()');
    await waitFor(`${cardText}.includes("Work")`);
    const claudeCard = await evaluate(cardText);
    assert.match(claudeCard, /Work/);
    assert.doesNotMatch(claudeCard, /Claude/);
    assert.equal(await evaluate('document.querySelector("[data-usage-account]").textContent'), "Work");
    await screenshot("claude-account-name");
    assert.doesNotMatch(claudeCard, /Banked/, "No banked row when the account has none");
    await evaluate('document.querySelectorAll(".sidebar-usage-row")[2].click()');
    await waitFor(`${cardText}.includes("Default account")`);
    assert.match(await evaluate(cardText), /Gemini 5-hour/);
    assert.match(await evaluate(cardText), /Gemini weekly/);
    await screenshot("antigravity-card");

    // With a Project, Claude's two accounts turn the name into a picker; Codex's one stays text.
    await evaluate('window.setScope("/projects/work")');
    await evaluate('document.querySelectorAll(".sidebar-usage-row")[0].click()');
    const picker = 'document.querySelector("[data-usage-card] [aria-haspopup=listbox]")';
    await waitFor(`Boolean(${picker})`);
    assert.match(await evaluate(`${picker}.textContent`), /^work@example\.test$/);
    await evaluate(`${picker}.click()`);
    await waitFor('Boolean(document.querySelector("[role=listbox]"))');
    // The panel sits outside the card: leaving the card for it keeps the card open.
    await evaluate('document.querySelector("[data-usage-card]").dispatchEvent(new PointerEvent("pointerleave"))');
    await delay(300);
    assert.equal(await evaluate('Boolean(document.querySelector("[data-usage-card]"))'), true, "Card stays while its picker is open");
    await screenshot("claude-account-picker");
    await evaluate('[...document.querySelectorAll("[role=listbox] [data-picker-row]")].find((row) => row.textContent.includes("me@example.test")).click()');
    await waitFor("window.assigned.length === 1");
    assert.deepEqual(await evaluate("window.assigned[0]"), ["/projects/work", "claude", "personal"]);
    await waitFor(`${picker}?.textContent.includes("me@example.test")`);
    await delay(400);
    assert.equal(await evaluate('Boolean(document.querySelector("[data-usage-card]"))'), true, "Card stays after a switch");
    await screenshot("claude-account-switched");
    await evaluate('document.querySelectorAll(".sidebar-usage-row")[1].click()');
    await waitFor(`${cardText}.includes("victor@example.test")`);
    await delay(100);
    assert.equal(await evaluate(`Boolean(${picker})`), false, "One saved account shows plain text");
    await evaluate("window.setScope(undefined)");
    await evaluate('document.querySelector("aside").style.marginTop = ""');
    await evaluate("window.setCollapsed(true)");
    await waitFor('document.querySelector("aside").dataset.sidebarCollapsed === "true"');
    assert.equal(await evaluate('getComputedStyle(document.querySelectorAll(".sidebar-usage-row")[1].querySelector(".sidebar-copy")).display'), "none");
    assert.equal(await evaluate('document.querySelectorAll(".sidebar-usage-rail")[1].firstElementChild.getBoundingClientRect().width'), 16);
    console.log(
      "PASS: weekly-only width, 5h column alignment, actual percentages, remaining mode, banked resets row, Antigravity Gemini windows, collapsed rail, account email and name fallback, account picker",
    );
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
        name: "sidebar-usage-fixture",
        resolveId(id) {
          if (id === "/__sidebar_usage_fixture.tsx") return id;
        },
        load(id) {
          if (id === "/__sidebar_usage_fixture.tsx") return fixture;
        },
        configureServer(server) {
          server.middlewares.use(async (request, response, next) => {
            if (request.url !== "/__sidebar_usage__") return next();
            const html = await server.transformIndexHtml(
              request.url,
              '<html><body><div id="root"></div><script type="module" src="/__sidebar_usage_fixture.tsx"></script></body></html>',
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
    const child = spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__sidebar_usage__`], {
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
(process.versions.electron ? browserChecks() : main()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
