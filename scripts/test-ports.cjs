// Run with node scripts/test-ports.cjs. First finds a real server started by a fake agent's
// command shell with ps and lsof, then checks the Ports pill and the sidebar hover card in Electron.
const assert = require("node:assert/strict");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");

const fixture = `
window.milagre = Object.freeze({ listEditors: async () => [], on: () => window.milagre });
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatComposer } from "/src/components/ChatComposer";
import { ChatRow } from "/src/components/sidebar/ChatRow";
import { MODEL_CATALOG, capabilityFor } from "/src/model";
import { associatedPullRequest } from "@milagre/shared/chats";
import { updateSettings } from "/src/lib/settings";
import "/src/styles.css";
const noop = () => {};
window.stopped = [];
window.prLinks = [];
window.updateSettings = updateSettings;
function Fixture() {
  const [remote, setRemote] = useState(false);
  window.setRemote = setRemote;
  const [ports, setPorts] = useState([
    { port: 5173, pid: 4211, command: "node", address: "127.0.0.1" },
    { port: 8081, pid: 4380, command: "node", address: "*" },
    { port: 54321, pid: 4402, command: "postgres", address: "::1" },
  ]);
  window.setPorts = setPorts;
  // window.lagging: Stop returns before the host's new list arrives.
  const stopPort = (pid) => new Promise((resolve) => setTimeout(() => {
    window.stopped.push(pid);
    if (!window.lagging) setPorts((current) => current.filter((port) => port.pid !== pid));
    resolve(true);
  }, 400));
  window.setDark = (dark) => document.documentElement.classList.toggle("dark", dark);
  const [model] = useState(MODEL_CATALOG[0]);
  const messages = [
    { id: 1, session_id: 1, context: null, role: "user", body: "Start the web app and Metro so I can try the new screen." },
    { id: 2, session_id: 1, context: null, role: "assistant", body: "Vite is on 5173, Metro on 8081 and the local database on 54321. [Site](https://example.org/app) [PR](https://github.com/team/second/pull/12/files#diff-123) [Other PR](https://github.com/team/third/pull/12)" },
  ];
  const plan = { source: "milagre", tasks: [{ id: "0", title: "Start the dev servers", status: "completed" }, { id: "1", title: "Open the new screen", status: "in_progress" }], phases: [], updatedAt: 0 };
  return <div style={{ display: "flex", height: "100%" }}>
    <aside style={{ width: 240, paddingTop: 10, borderRight: "1px solid var(--color-line)" }}>
      <ChatRow item={{ id: "1", label: "Start the dev servers", details: { branch: "milagre/dev-servers", path: "/fixture/dev-servers", diff: { added: 42, removed: 7 }, ports } }} active collapsed={false} actions={{}} onPick={noop} />
      <ChatRow item={{ id: "2", label: "Chat without ports", details: { branch: "main", path: "/fixture/main" } }} active={false} collapsed={false} actions={{}} onPick={noop} />
    </aside>
    <div style={{ flex: 1, minWidth: 0, padding: 12 }}>
      <ChatComposer messages={messages}
        agentChatId={remote ? "milagre-link:studio|11111111-1111-1111-1111-111111111111#1" : "/fixture#1"}
        onOpenPullRequestLink={(url) => {
          const pr = associatedPullRequest(url, [{ url: "https://github.com/team/first/pull/12", cwd: "/first" }, { url: "https://github.com/team/second/pull/12", cwd: "/second" }]);
          if (pr) window.prLinks.push(pr.cwd);
          return !!pr;
        }}
        imageDraft={{ images: [], files: [], attachFiles: noop, attachPath: noop, removeFile: noop, loading: false, error: "", onPaste: noop, clear: noop, remove: noop }}
        projectPath="/fixture" draft="" onDraftChange={noop} onSend={noop} isSending={false} sendBlocked={false} plan={plan} ports={ports} onStopPort={stopPort} subagents={[]}
        models={MODEL_CATALOG} cliStatus={null} onModelPickerOpen={noop} selectedModel={model} onModelChange={noop}
        capability={capabilityFor(model, null)} onEffortChange={noop} ultracode={false} onUltracodeChange={noop}
        fastMode={false} onFastModeChange={noop} permissionMode="auto" onPermissionModeChange={noop}
        onRecommendationSelect={noop} worktrees={[]} onWorktreeChange={noop}
        isolation="local" onIsolationChange={noop} branches={[]} baseBranch="main" onBaseBranchChange={noop} newChatError={null} />
    </div>
  </div>;
}
document.documentElement.classList.add("dark");
createRoot(document.getElementById("root")).render(<Fixture />);
`;

// A fake agent with an MCP-like child in its own group and a command shell that starts a server in the background.
async function realProcessCheck() {
  const { spawn } = require("node:child_process");
  const { PortWatcher } = require("../packages/core/src/agents/ports.cjs");
  const agentSource = `
    const { spawn } = require("node:child_process");
    const net = require("node:net");
    // Like an MCP server: a direct child in the agent's own group, listening.
    spawn(process.execPath, ["-e", "require('net').createServer().listen(0, '127.0.0.1'); setInterval(() => {}, 1000)"], { stdio: "ignore" });
    // Like a Bash tool call: a shell in its own group that starts and waits for a server.
    spawn("/bin/zsh", ["-c", "nohup " + JSON.stringify(process.execPath) + " -e \\"require('net').createServer().listen(0, '127.0.0.1'); setInterval(() => {}, 1000)\\" >/dev/null 2>&1 & wait"], { detached: true, stdio: "ignore" });
    setInterval(() => {}, 1000);
  `;
  const fs = require("node:fs");
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-ports-worktree-")));
  const agent = spawn(process.execPath, ["-e", agentSource], { cwd, detached: true, stdio: "ignore" });
  let roots = new Map([
    ["/fixture#1", { pid: agent.pid, cwd }],
    ["/other#2", { pid: 999999, cwd }],
  ]);
  const published = [];
  const watcher = new PortWatcher({ roots: () => roots, publish: (ports) => published.push(ports), pollMs: 60_000 });
  try {
    let ports;
    for (let attempt = 0; attempt < 40 && !ports; attempt++) {
      await delay(250);
      await watcher.poll();
      ports = watcher.snapshot()["/fixture#1"];
    }
    assert.ok(ports, "The backgrounded server's port shows for the chat");
    assert.equal(watcher.snapshot()["/other#2"], undefined, "Another Chat in the same Worktree does not get it");
    assert.equal(ports.length, 1, `Only the command's server counts, not the agent's own child: ${JSON.stringify(ports)}`);
    assert.equal(ports[0].address, "127.0.0.1");
    // The agent stops (its session closed); the orphaned server still belongs to the chat until it stops.
    const server = ports[0].pid;
    process.kill(watcher.processes.get(server).pgid, "SIGKILL");
    process.kill(-agent.pid, "SIGKILL");
    roots = new Map();
    await delay(300);
    await watcher.poll();
    assert.deepEqual(
      watcher.snapshot()["/fixture#1"]?.map((port) => port.pid),
      [server],
      "An orphaned server stays with its chat",
    );
    assert.equal(await watcher.stopPort("/fixture#1", server), true, "Stop ends the orphaned server");
    assert.throws(() => process.kill(server, 0), /ESRCH/, "The server process is gone");
    assert.deepEqual(watcher.snapshot(), {}, "A stopped server leaves the list");
    assert.equal(watcher.timer, null, "Nothing left to watch stops polling");
    console.log(`PASS: real ps/lsof run found port ${ports[0].port}, ignored the agent's own listener, kept the orphan, dropped it once stopped`);
  } finally {
    watcher.close();
    try {
      process.kill(-agent.pid, "SIGKILL");
    } catch {}
    for (const pids of Object.values(watcher.snapshot()))
      for (const { pid } of pids)
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
  }
}

// A server started in a Chat's Terminal shows with the Chat's ports, and stopping it leaves the Terminal open.
async function terminalPortCheck() {
  const fs = require("node:fs");
  const { PortWatcher } = require("../packages/core/src/agents/ports.cjs");
  const { createTerminals, terminalEnvironment } = require("../packages/core/src/terminals.cjs");
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-ports-terminal-")));
  const terminals = createTerminals({
    resolveChat: async () => [{ path: cwd, label: "terminal" }],
    shell: () => ({ file: "/bin/zsh", args: ["-f"] }),
    environment: () => terminalEnvironment({ PATH: process.env.PATH, HOME: cwd }),
  });
  const roots = () => new Map([...terminals.shells()].map(([chatId, shells]) => [chatId, { shells }]));
  const watcher = new PortWatcher({ roots, publish: () => {}, pollMs: 60_000 });
  try {
    const { id } = await terminals.open({ chatId: "/fixture#3" });
    await terminals.input({ terminalId: id, data: `${JSON.stringify(process.execPath)} -e "require('net').createServer().listen(0, '127.0.0.1')"\r` });
    let ports;
    for (let attempt = 0; attempt < 40 && !ports; attempt++) {
      await delay(250);
      await watcher.poll();
      ports = watcher.snapshot()["/fixture#3"];
    }
    assert.ok(ports?.length === 1, `The Terminal's server shows with its Chat's ports: ${JSON.stringify(watcher.snapshot())}`);
    assert.equal(await watcher.stopPort("/fixture#3", ports[0].pid), true);
    assert.throws(() => process.kill(ports[0].pid, 0), /ESRCH/, "The server stopped");
    assert.equal((await terminals.list({ chatId: "/fixture#3" })).terminals.length, 1, "Stopping the port keeps the Terminal");
    console.log(`PASS: a server started in a Terminal shows as the Chat's port ${ports[0].port}, and stopping it keeps the Terminal`);
  } finally {
    watcher.close();
    await terminals.dispose();
  }
}

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  const { guardNavigation } = require("../apps/desktop/electron/links.cjs");
  app.setPath("userData", require("node:fs").mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-ports-ui-")));
  await app.whenReady();
  const window = new BrowserWindow({ width: 1000, height: 560, useContentSize: true, show: false, webPreferences: { backgroundThrottling: false } });
  const opened = [];
  guardNavigation(window.webContents, { appUrl: process.argv[2], openExternal: (url) => opened.push(url) });
  window.webContents.on("console-message", (details) => {
    if (details.level === "error") console.error(details.message);
  });
  const evaluate = async (source) => {
    try {
      return await window.webContents.executeJavaScript(source);
    } catch (error) {
      throw new Error(`${source}: ${error.message}`, { cause: error });
    }
  };
  const screenshotDir = process.env.MILAGRE_SCREENSHOT_DIR;
  async function screenshot(name) {
    if (!screenshotDir) return;
    await delay(300);
    const fs = require("node:fs");
    fs.mkdirSync(screenshotDir, { recursive: true });
    fs.writeFileSync(path.join(screenshotDir, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  }
  async function waitFor(source) {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw new Error(`Timed out: ${source}`);
  }
  const pill = "[data-slot=port-track] [data-face=pill] button";
  const firstRow = 'document.querySelector("[data-row]")';
  try {
    await window.loadURL(process.argv[2]);
    await waitFor('!!document.querySelector("[data-slot=port-track]")');
    assert.equal(await evaluate(`document.querySelector("${pill}").textContent`), "Ports 3");
    const row = await evaluate(
      `(() => {const a=document.querySelector("${pill}").getBoundingClientRect(), b=document.querySelector("[data-slot=task-track] [data-face=pill] button").getBoundingClientRect();return {gap:b.left-a.right,dy:Math.abs(a.top-b.top)}})()`,
    );
    assert.ok(row.gap >= 0 && row.gap <= 12 && row.dy < 1, `Ports pill is not beside the to-do pill: ${JSON.stringify(row)}`);
    for (const theme of ["dark", "light"]) {
      await evaluate(`window.setDark(${theme === "dark"})`);
      await evaluate(`document.querySelector("${pill}").click()`);
      await waitFor('document.querySelector("[data-slot=port-popover]")?.dataset.state === "open"');
      assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-port-row] a")].map(a => a.getAttribute("href"))'), [
        "http://localhost:5173",
        "http://localhost:8081",
        "http://[::1]:54321",
      ]);
      assert.ok(await evaluate('document.querySelector("[data-port-row]").textContent.includes(":5173")'));
      await screenshot(`ports-popover-${theme}`);
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
      await waitFor('document.querySelector("[data-slot=port-popover]")?.dataset.state !== "open"');
    }
    await evaluate(`document.querySelector("${pill}").click()`);
    await waitFor('document.querySelector("[data-slot=port-popover]")?.dataset.state === "open"');
    // A port row opens in the Chat's Browser panel; ⌘-click opens it in the user's browser instead.
    await evaluate('document.querySelector("[data-port-row] a").click()');
    await waitFor('document.querySelector("[data-slot=browser-address]")?.value === "http://localhost:5173"');
    assert.deepEqual(opened, [], "A port row opens in the Browser panel, not outside");
    await waitFor('document.querySelector("[data-slot=port-popover]")?.dataset.state !== "open"');
    await evaluate("document.querySelector(\"[aria-label='Hide Browser panel']\").click()");
    await waitFor('!document.querySelector("[data-slot=browser-dock]")');
    await evaluate(`document.querySelector("${pill}").click()`);
    await waitFor('document.querySelector("[data-slot=port-popover]")?.dataset.state === "open"');
    await evaluate(
      'document.querySelector("[data-port-row] a").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true, ctrlKey: true }))',
    );
    await delay(100);
    assert.deepEqual(opened, ["http://localhost:5173/"], "A ⌘-clicked port row opens in the browser");
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    await waitFor('document.querySelector("[data-slot=port-popover]")?.dataset.state !== "open"');

    // Stop: the row shows a spinner until the port is gone, then leaves the list.
    await evaluate(`document.querySelector("${pill}").click()`);
    await waitFor('document.querySelector("[data-slot=port-popover]")?.dataset.state === "open"');
    assert.equal(
      await evaluate('getComputedStyle(document.querySelector("[data-port-stop]").parentElement.parentElement).opacity'),
      "0",
      "Stop is hidden until the row is hovered",
    );
    // A hidden window has no hover or focus, so show the second row as hovered for the screenshot.
    await evaluate("window.setDark(true)");
    await evaluate(
      '(() => { const row = document.querySelector("[data-port-row]:nth-child(2)"); row.style.background = "var(--color-hover)"; for (const el of row.querySelectorAll(".opacity-0")) el.style.opacity = "1"; })()',
    );
    await screenshot("ports-stop-hover-dark");
    await evaluate(
      '(() => { const row = document.querySelector("[data-port-row]:nth-child(2)"); row.style.background = ""; for (const el of row.querySelectorAll(".opacity-0")) el.style.opacity = ""; })()',
    );
    await evaluate('document.querySelector("[data-port-row]:nth-child(2) [data-port-stop]").click()');
    await waitFor('!!document.querySelector("[data-port-row][data-stopping] [role=status]")');
    await screenshot("ports-stopping-dark");
    await waitFor('document.querySelectorAll("[data-port-row]").length === 2');
    assert.deepEqual(await evaluate("window.stopped"), [4380]);
    assert.equal(await evaluate(`document.querySelector("${pill}").textContent`), "Ports 2");
    await evaluate('document.querySelector("[data-port-stop-all]").click()');
    await waitFor('!document.querySelector("[data-slot=port-track]") && !document.querySelector("[data-slot=port-popover]")');
    assert.deepEqual(await evaluate("window.stopped.sort()"), [4211, 4380, 4402]);
    await evaluate(
      `window.setPorts([{ port: 5173, pid: 4211, command: "node", address: "127.0.0.1" }, { port: 8081, pid: 4380, command: "node", address: "*" }, { port: 54321, pid: 4402, command: "postgres", address: "::1" }])`,
    );
    await waitFor('!!document.querySelector("[data-slot=port-track]")');

    // A server Stop ended leaves the list when Stop returns, even before the host's new list arrives; that list has
    // the last word.
    await evaluate("window.lagging = true");
    await evaluate(`document.querySelector("${pill}").click()`);
    await waitFor('document.querySelector("[data-slot=port-popover]")?.dataset.state === "open"');
    await evaluate('document.querySelector("[data-port-row]:nth-child(2) [data-port-stop]").click()');
    await waitFor('document.querySelectorAll("[data-port-row]").length === 2');
    assert.equal(await evaluate(`document.querySelector("${pill}").textContent`), "Ports 2");
    assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-port-row] a")].map(a => a.getAttribute("href"))'), [
      "http://localhost:5173",
      "http://[::1]:54321",
    ]);
    await evaluate(
      `window.setPorts([{ port: 5173, pid: 4211, command: "node", address: "127.0.0.1" }, { port: 8081, pid: 4380, command: "node", address: "*" }, { port: 54321, pid: 4402, command: "postgres", address: "::1" }])`,
    );
    await waitFor('document.querySelectorAll("[data-port-row]").length === 3');
    await evaluate("window.lagging = false");
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await waitFor('document.querySelector("[data-slot=port-popover]")?.dataset.state !== "open"');

    // The sidebar hover card lists the chat's ports.
    await evaluate("window.setDark(true)");
    await evaluate(`${firstRow}.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }))`);
    await waitFor('!!document.querySelector("[data-chat-card-ports]")');
    assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-chat-card-port]")].map(a => a.textContent)'), [":5173", ":8081", ":54321"]);
    await screenshot("ports-hover-card-dark");
    await evaluate("window.setDark(false)");
    await screenshot("ports-hover-card-light");
    await evaluate('document.querySelector("[data-chat-card-port]").click()');
    await delay(100);
    assert.equal(opened.at(-1), "http://localhost:5173/", "A port in the card opens in the browser");
    await waitFor('!document.querySelector("[data-chat-hover-card]")');
    await evaluate(`${firstRow}.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, pointerType: "mouse", relatedTarget: document.body }))`);

    // No ports: no pill, no card line.
    await evaluate("window.setPorts([])");
    await waitFor('!document.querySelector("[data-slot=port-track]")');
    await evaluate(`${firstRow}.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }))`);
    await waitFor('!!document.querySelector("[data-chat-hover-card]")');
    assert.equal(await evaluate('!!document.querySelector("[data-chat-card-ports]")'), false);
    await evaluate(`${firstRow}.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, pointerType: "mouse", relatedTarget: document.body }))`);

    // A remote Link Chat still has a Browser panel on the viewing Mac.
    await evaluate("window.setRemote(true)");
    await delay(100);
    const clickReplyLink = (href, modifiers = {}) =>
      evaluate(
        `document.querySelector('[data-slot=message-content] a[href="${href}"]').dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...${JSON.stringify(modifiers)} }))`,
      );
    const site = "https://example.org/app";
    await clickReplyLink(site);
    await waitFor(`document.querySelector("[data-slot=browser-address]")?.value === "${site}"`);
    const beforePr = opened.length;
    const pr = "https://github.com/team/second/pull/12/files#diff-123";
    await clickReplyLink(pr);
    assert.deepEqual(await evaluate("window.prLinks"), ["/second"], "An associated PR keeps the right Project even when its number is shared");
    assert.equal(opened.length, beforePr, "The associated PR does not leave the app");
    assert.equal(await evaluate('document.querySelector("[data-slot=browser-address]").value'), site, "The PR does not open a browser page");
    await evaluate('window.updateSettings({ openLinksIn: "external" })');
    await clickReplyLink(pr);
    assert.deepEqual(await evaluate("window.prLinks"), ["/second", "/second"], "Associated PRs still use Git with the external browser preference");
    await clickReplyLink(site);
    await delay(100);
    assert.equal(opened.at(-1), site, "The external browser preference applies to remote Chats");
    await evaluate('window.updateSettings({ openLinksIn: "milagre" })');
    await clickReplyLink(pr, { metaKey: true });
    await delay(100);
    assert.equal(opened.at(-1), pr, "Command-click keeps the normal alternate link behavior");
    await evaluate('window.updateSettings({ openLinksIn: "external" })');
    const unrelated = "https://github.com/team/third/pull/12";
    await clickReplyLink(unrelated);
    await delay(100);
    assert.equal(opened.at(-1), unrelated, "An unrelated PR stays external");
    await evaluate('window.updateSettings({ openLinksIn: "milagre" })');
    console.log("PASS: Ports pill, Stop, themes, hover cards, remote Link Chat browser links, browser preference and associated PR routing");
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
}

async function main() {
  await realProcessCheck();
  await terminalPortCheck();
  const { createServer } = await import("vite");
  const { spawn } = require("node:child_process");
  const server = await createServer({
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "ports-fixture",
        resolveId(id) {
          if (id === "/__ports_fixture.tsx") return id;
        },
        load(id) {
          if (id === "/__ports_fixture.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url !== "/__ports__") return next();
            const html = await server.transformIndexHtml(
              request.url,
              '<html><body><div id="root"></div><script type="module" src="/__ports_fixture.tsx"></script></body></html>',
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
    const child = spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__ports__`], { env, stdio: "inherit" });
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
