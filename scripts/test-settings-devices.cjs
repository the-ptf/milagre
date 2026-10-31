// Run with npm test -- --only test-settings-devices. Exercises Settings › Devices in the real App against a real daemon (its
// own temporary data directory and socket, port chosen by the OS): see the devices list fail soft on a host without it,
// turn device access on, see the QR code and the relay status, copy the link, see a phone and a computer pair and the
// Computers list appear, see a new phone marked New until seen, remove the phone, see a phone that paired while the owner
// was away announced once and marked New, reset access, turn it off, then on again behind a Cloudflare tunnel. The rest of the window's API is mocked, like the
// other checks. Set MILAGRE_SCREENSHOT_DIR to save screenshots.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");

/** The New mark on a phone's row in Settings › Devices, as an expression to evaluate in the window. */
const newMark = (key) => `document.querySelector('[data-device-row="phone"][data-device-key="${key}"] [data-device-new]')?.textContent`;

const fixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import "/src/styles.css";
// The window talks to the host through the main process, as the real preload does (see electron/preload.cjs).
const { ipcRenderer } = window.require("electron");
const state = { next_id: 3, projects: { 1: { id: 1, name: "shop" } }, worktrees: { 1: { id: 1, name: "main", path: "/fixture", project_id: 1 } }, sessions: { 2: { id: 2, worktree_id: 1, agent_name: "Claude", provider: "claude", status: "Idle" } }, connections: {}, events: [], messages: [], approvals: [], tasks: {}, artifacts: {}, outputs: [], conflicts: [] };
window.milagre = new Proxy({
  getRuntimeConnection: async () => ({ connected: true }),
  getAgentPorts: async () => ({}),
  getCurrentProject: async () => ({ path: "/fixture", name: "shop", state }),
  listBranches: async () => ["main"],
  listEditors: async () => [],
  getCachedUsage: async () => ({ providers: [] }),
  readUsage: async () => ({ providers: [] }),
  getUpdateState: async () => ({ status: "idle" }),
  getAppVersion: async () => "0.0.0",
  getLinkedWork: async () => ({ delegations: [], negotiations: [], receiveOnly: [] }),
  getPhoneStatus: () => ipcRenderer.invoke("phone:status"),
  setPhoneEnabled: (enabled) => ipcRenderer.invoke("phone:set-enabled", enabled),
  setPhoneLan: (enabled) => ipcRenderer.invoke("phone:set-lan", enabled),
  resetPhoneAccess: () => ipcRenderer.invoke("phone:reset"),
  openPhonePairing: () => ipcRenderer.invoke("phone:open-pairing"),
  listDevices: () => ipcRenderer.invoke("devices:list"),
  removeDevice: (key) => ipcRenderer.invoke("devices:remove", key),
  acknowledgeDevices: (keys) => ipcRenderer.invoke("devices:acknowledge", keys),
  onPhoneStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("phone:status", listener);
    return () => ipcRenderer.removeListener("phone:status", listener);
  },
}, { get(target, key) { return target[key] ?? (String(key).startsWith("on") ? () => () => {} : async () => null); } });
localStorage.setItem("milagre-settings", JSON.stringify({ defaultModelId: "claude-opus-5-5", defaultPermissionMode: "ask" }));
const { default: App } = await import("/src/App");
createRoot(document.getElementById("root")).render(<App />);
`;

async function browserChecks() {
  const { app, BrowserWindow, ipcMain, clipboard } = require("electron");
  const { startDaemon } = require("../apps/daemon/src/server.cjs");
  const { connect } = require("../apps/daemon/src/client.cjs");
  app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "milagre-devices-ui-")));
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "milagre-devices-host-")));
  await app.whenReady();
  // The check never dials the public relay: this stand-in reports that it connected. A reset's retired room has no onStatus.
  const relays = [];
  const startRelay = (options) => {
    relays.push(options);
    setTimeout(() => options.onStatus?.("online"), 20);
    return { close: async () => {}, status: () => "online" };
  };
  // Nor does it run cloudflared: the tunnel only answers with the address a real one would have.
  const tunnels = { startNamedTunnel: async ({ hostname }) => ({ url: `https://${hostname}`, close: async () => {} }) };
  const daemon = await startDaemon({
    dataDir,
    version: "test",
    phoneOptions: { localPort: 0, lanPort: 0, lanHostname: "127.0.0.1", addresses: () => ["192.168.1.20"], startRelay, tunnels },
    runtimeOptions: {
      cwd: dataDir,
      environmentReady: Promise.resolve(),
      titleModels: {},
      agentCli: Object.assign(async () => ({ command: null }), { invalidate() {} }),
    },
  });
  const host = await connect({ dataDir });
  const paired = [];
  host.on("event", ({ channel, payload }) => {
    if (channel === "phone:paired") paired.push(payload);
  });
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    useContentSize: true,
    show: false,
    webPreferences: { partition: "devices-test", backgroundThrottling: false, nodeIntegration: true, contextIsolation: false },
  });
  for (const method of ["phone:status", "phone:set-enabled", "phone:set-lan", "phone:reset", "phone:open-pairing", "devices:remove"])
    ipcMain.handle(method, (_event, ...args) => host.call(method, args));
  host.on("event", ({ channel, payload }) => {
    if (channel === "phone:status" && !window.isDestroyed()) window.webContents.send(channel, payload);
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
    for (let n = 0; n < 200; n++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    await screenshot("timeout");
    throw Error(`Timed out: ${source}. Screen: ${await evaluate("document.body.innerText.slice(0, 400)")}`);
  }
  async function click(text) {
    const expr = `[...document.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(text)})`;
    await waitFor(`!!(${expr})`);
    await evaluate(`(${expr}).click()`);
  }
  const screenshotDir = process.env.MILAGRE_SCREENSHOT_DIR;
  async function screenshot(name) {
    if (!screenshotDir) return;
    await delay(400);
    fs.mkdirSync(screenshotDir, { recursive: true });
    fs.writeFileSync(path.join(screenshotDir, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  }
  const toggle = `document.querySelector('[role="checkbox"][aria-label="Allow devices to connect"]')`;
  const token = async () => new URL((await host.call("phone:status")).pairingLink).searchParams.get("token");

  try {
    await window.loadURL(process.argv[2]);
    await waitFor(`!!document.querySelector('[aria-label="Settings"]')`);
    await evaluate(`document.querySelector('[aria-label="Settings"]').click()`);
    await click("Devices");

    // A host from before devices:list: the access controls still work, and the lists say they couldn't be read.
    await waitFor(`!!${toggle} && document.body.textContent.includes('Allow devices to connect')`);
    await waitFor(`document.querySelector('[data-devices-error]')?.textContent.startsWith("Couldn't read paired devices")`);
    for (const method of ["devices:list", "devices:acknowledge"]) ipcMain.handle(method, (_event, ...args) => host.call(method, args));
    console.log("PASS: without devices:list the section still shows its access controls");

    // Off: the toggle, its status, and nothing else to pair with.
    assert.equal(await evaluate(`${toggle}.getAttribute('aria-checked')`), "false");
    await waitFor(`document.body.textContent.includes('Off')`);
    assert.equal(await evaluate(`!!document.querySelector('[data-phone-qr]')`), false);
    assert.equal(await evaluate(`[...document.querySelectorAll('button')].some(el => el.textContent.includes('Reset access'))`), false);
    await screenshot("devices-off");
    console.log("PASS: Settings › Devices starts off, with nothing to pair");

    // On: a QR image that decodes, the relay status, the pairing window and the warning.
    await evaluate(`${toggle}.click()`);
    await waitFor(`!!document.querySelector('[data-phone-qr]')`);
    await waitFor(`!document.querySelector('[data-devices-error]')`);
    await waitFor(`(() => { const img = document.querySelector('[data-phone-qr]'); return img.complete && img.naturalWidth > 0; })()`);
    assert.equal(await evaluate(`${toggle}.getAttribute('aria-checked')`), "true");
    assert.equal(await evaluate(`document.querySelector('[data-phone-qr]').src.startsWith('data:image/svg+xml')`), true);
    await waitFor(`document.body.textContent.includes('On, reachable from any network')`);
    assert.equal(await evaluate(`!!document.querySelector('[data-phone-local-only]')`), false);
    await waitFor(`document.querySelector('[data-phone-pairing="open"]')?.textContent.includes('New devices can pair for 10 more minutes')`);
    assert.match(await evaluate(`document.querySelector('[data-phone-warning]').textContent`), /gives access to your agents/);
    const first = await token();
    assert.match(first, /^[a-f0-9]{64}$/);
    await screenshot("phone-on");
    console.log("PASS: turning it on shows the QR code, the relay status, the pairing window and the warning");

    // Local network: on by default with phone access, switchable on its own, and it says where a phone on the same network dials.
    const lanToggle = `document.querySelector('[role="checkbox"][aria-label="Allow on local network"]')`;
    await waitFor(`!!${lanToggle} && document.body.textContent.includes('Reachable at 192.168.1.20')`);
    assert.equal(await evaluate(`${lanToggle}.getAttribute('aria-checked')`), "true");
    await screenshot("lan-on");
    await evaluate(`${lanToggle}.click()`);
    await waitFor(`${lanToggle}.getAttribute('aria-checked') === 'false' && !document.body.textContent.includes('Reachable at 192.168.1.20')`);
    assert.equal((await host.call("phone:status")).lan.enabled, false);
    await screenshot("lan-off");
    await evaluate(`${lanToggle}.click()`);
    await waitFor(`${lanToggle}.getAttribute('aria-checked') === 'true' && document.body.textContent.includes('Reachable at 192.168.1.20')`);
    assert.equal((await host.call("phone:status")).lan.enabled, true);
    console.log("PASS: the local network switch shows the Mac's address, turns off and back on");

    // Copy: the pairing link lands on the clipboard.
    window.webContents.focus();
    await click("Copy link");
    await waitFor(`[...document.querySelectorAll('button')].some(el => el.textContent.trim() === 'Copied')`);
    const copied = await clipboard.readText();
    assert.equal(copied, (await host.call("phone:status")).pairingLink);
    assert.match(copied, /^milagre:\/\/pair\?relay=/);
    console.log("PASS: Copy link copies the link");
    await evaluate(`document.querySelector('button[aria-label="Pairing connection"]').click()`);
    await click("LAN or Tailscale only");
    await click("Copy link");
    await delay(50);
    const privateLink = await clipboard.readText();
    assert.ok(new URL(privateLink).searchParams.get("relay").startsWith("ws://192.168.1.20:"));
    assert.ok(!privateLink.includes("relay.milagre.cloud"));
    await screenshot("private-pairing");
    await evaluate(`document.querySelector('button[aria-label="Pairing connection"]').click()`);
    await click("Automatic");
    console.log("PASS: Settings offers a private QR and copied link with no public relay fallback");

    // Devices: no phones yet and no Computers list, then a phone and a computer as they pair.
    const phoneKey = "p".repeat(43);
    const computerKey = "c".repeat(43);
    const hostDevices = () => relays.findLast((options) => !options.retired).phones;
    // The Devices page has no section headings; the Computers list shows as its rows.
    const computersShown = `!!document.querySelector('[data-device-row="computer"]')`;
    await waitFor(`document.querySelector('[data-devices-empty]')?.textContent === 'No phones yet'`);
    assert.equal(await evaluate(computersShown), false);
    // The Cloudflare note is for a Cloudflare tunnel only (unit-tested in phone.test.ts); this host reaches phones through the relay.
    assert.equal(await evaluate(`!!document.querySelector('[data-devices-note]')`), false);
    await hostDevices().add(phoneKey, { kind: "phone", name: "Victor's iPhone" });
    await waitFor(`document.querySelector('[data-device-row="phone"]')?.textContent.includes("Victor's iPhone")`);
    assert.equal(await evaluate(`document.querySelector('[data-device-row="phone"] [data-device-line]').textContent`), "Last seen just now");
    assert.equal(await evaluate(computersShown), false, "Computers stays hidden with no computer");
    assert.deepEqual(paired, [{ pairedPhones: 1, kind: "phone" }]);
    // A phone that just paired is New; the host hears it was shown, and the mark stays while the section is open.
    await waitFor(`${newMark(phoneKey)} === 'New'`);
    for (let n = 0; n < 200 && (await host.call("devices:list"))[0].isNew; n++) await delay(25);
    assert.equal((await host.call("devices:list"))[0].isNew, false, "acknowledged once shown");
    await hostDevices().add(computerKey, { kind: "computer", name: "studio" });
    await waitFor(`${computersShown} && document.querySelector('[data-device-row="computer"]')?.textContent.includes('studio')`);
    assert.equal(await evaluate(`${newMark(phoneKey)} ?? null`), "New", "still New after the list is read again");
    assert.equal(await evaluate(`!!document.querySelector('[data-device-row="computer"] [data-device-new]')`), false, "a computer was allowed here: never New");
    await evaluate(`document.querySelector('[data-device-row="phone"]').scrollIntoView({ block: 'center' })`);
    await screenshot("devices-lists");
    console.log("PASS: phones and computers list by name as they pair; Computers shows only once there is one");

    // Remove asks first; Cancel keeps the phone; confirming removes it on the host.
    const phoneLine = `document.querySelector('[data-device-row="phone"] [data-device-line]')?.textContent`;
    await evaluate(`document.querySelector('[data-device-row="phone"] [data-device-remove]').click()`);
    await waitFor(`${phoneLine} === "Remove Victor's iPhone? It can pair again from Pair a device."`);
    await screenshot("device-remove-confirm");
    await click("Cancel");
    await waitFor(`${phoneLine} === "Last seen just now"`);
    await evaluate(`document.querySelector('[data-device-row="phone"] [data-device-remove]').click()`);
    await waitFor(`!!document.querySelector('[data-device-remove-confirm]')`);
    await evaluate(`document.querySelector('[data-device-remove-confirm]').click()`);
    await waitFor(`!document.querySelector('[data-device-row="phone"]') && document.querySelector('[data-devices-empty]')?.textContent === 'No phones yet'`);
    assert.deepEqual(
      (await host.call("devices:list")).map((device) => device.key),
      [computerKey],
    );
    console.log("PASS: Remove asks first and removes the phone on the host");

    // A phone pairs while the owner isn't looking (here: another section; in life, Milagre closed). The host keeps its
    // "New phone paired" notice for the first window to take, once, and the next visit marks it New.
    const awayKey = "q".repeat(43);
    await click("About");
    await waitFor(`!document.querySelector('[data-device-row]')`);
    await hostDevices().add(awayKey, { kind: "phone", name: "Pixel 9" });
    const notices = await Promise.all([host.call("devices:take-notices"), host.call("devices:take-notices")]);
    // The removed phone is gone with its notice; the computer was allowed here and has none.
    assert.deepEqual(
      notices.flatMap((reply) => reply.devices).map((device) => device.name),
      ["Pixel 9"],
      "announced once, whoever asks",
    );
    // The window that took it shows it, then confirms.
    assert.equal(await host.call("devices:confirm-notices", [notices.find((reply) => reply.claim).claim]), 1);
    assert.deepEqual(await host.call("devices:take-notices"), { claim: null, devices: [] });
    await click("Devices");
    await waitFor(`${newMark(awayKey)} === 'New'`);
    await evaluate(`document.querySelector('[data-device-row="phone"]').scrollIntoView({ block: 'center' })`);
    await screenshot("device-new");
    // Seen: leaving and coming back shows it without the mark.
    await click("About");
    await waitFor(`!document.querySelector('[data-device-row]')`);
    await click("Devices");
    await waitFor(`document.querySelector('[data-device-row="phone"]')?.textContent.includes('Pixel 9')`);
    assert.equal(await evaluate(`${newMark(awayKey)} ?? null`), null);
    await screenshot("device-seen");
    console.log("PASS: a phone that paired while the owner was away is announced once and marked New until seen");

    // Reset asks first, and cancelling changes nothing.
    await click("Reset access");
    await waitFor(`document.body.textContent.includes('must pair again')`);
    await screenshot("phone-reset-confirm");
    await click("Cancel");
    await waitFor(`!document.body.textContent.includes('must pair again')`);
    assert.equal(await token(), first);
    await click("Reset access");
    await click("Reset and disconnect");
    // The old code stays up until the host has restarted with the new token.
    let second = first;
    for (let n = 0; n < 200 && second === first; n++) {
      await delay(25);
      second = await token().catch(() => first);
    }
    await waitFor(
      `(() => { const img = document.querySelector('[data-phone-qr]'); return img && img.complete && img.naturalWidth > 0 && document.body.textContent.includes('Make a new code'); })()`,
    );
    assert.notEqual(second, first);
    await waitFor(`document.querySelector('[data-devices-empty]')?.textContent === 'No phones yet' && !${computersShown}`);
    // The old room is held only to tell the phone that paired there that this Mac was reset.
    const retired = relays.filter((options) => options.retired);
    assert.equal(retired.length, 1);
    assert.equal(retired[0].token, undefined);
    console.log("PASS: reset asks first, makes a new token, forgets every device and keeps the old room answering");

    // The pushed reset status can reach the renderer before the reset RPC releases its busy guard.
    await waitFor(`[...document.querySelectorAll('button')].some(el => el.textContent.trim() === 'Reset access' && !el.disabled)`);
    // Off: the code goes away and the host keeps the setting.
    await evaluate(`${toggle}.click()`);
    await waitFor(`!document.querySelector('[data-phone-qr]') && ${toggle}.getAttribute('aria-checked') === 'false'`);
    assert.equal(await evaluate(`[...document.querySelectorAll('button')].some(el => el.textContent.includes('Reset access'))`), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, "mobile.json"), "utf8")).enabled, false);
    await screenshot("phone-off-again");
    console.log("PASS: turning it off removes the code");

    // Behind a Cloudflare tunnel: phones scan the tunnel's code, and Copy link gives another Mac the relay's link.
    fs.writeFileSync(
      path.join(dataDir, "cloudflare.json"),
      JSON.stringify({ hostname: "mac.example.com", port: 0, connectorToken: "connector", access: { id: `${"a".repeat(32)}.access`, secret: "b".repeat(40) } }),
      { mode: 0o600 },
    );
    await evaluate(`${toggle}.click()`);
    await waitFor(`!!document.querySelector('[data-phone-qr]') && document.body.textContent.includes('Reachable at mac.example.com')`);
    await waitFor(`document.querySelector('[data-phone-pairing="open"]')?.textContent.includes('New devices can pair for 10 more minutes')`);
    const tunnelStatus = await host.call("phone:status");
    assert.match(tunnelStatus.pairingLink, /^milagre:\/\/pair\?address=https%3A%2F%2Fmac\.example\.com/);
    await click("Copy link");
    await waitFor(`[...document.querySelectorAll('button')].some(el => el.textContent.trim() === 'Copied')`);
    assert.equal(await clipboard.readText(), tunnelStatus.computerLink);
    assert.match(tunnelStatus.computerLink, /^milagre:\/\/pair\?relay=/);
    await screenshot("tunnel-on");
    console.log("PASS: behind a Cloudflare tunnel the relay runs too, and Copy link copies its link for another Mac");

    host.close();
    await daemon.close();
    app.exit(0);
  } catch (error) {
    console.error(error);
    await screenshot("failure").catch(() => {});
    host.close();
    await daemon.close().catch(() => {});
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
        name: "devices-fixture",
        resolveId(id) {
          if (id === "/__devices_fixture.tsx") return id;
        },
        load(id) {
          if (id === "/__devices_fixture.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url !== "/__devices__") return next();
            const html = await server.transformIndexHtml(
              request.url,
              '<html><body><div id="root"></div><script type="module" src="/__devices_fixture.tsx"></script></body></html>',
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
    const child = spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__devices__`], { env, stdio: "inherit" });
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
