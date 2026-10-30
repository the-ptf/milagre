// Run with npm test -- --only test-add-computer. Add computer in Electron against a stand-in for main: a pasted link that
// isn't one, or is this Mac's own, is refused under the field; a good link shows the computer and how it is reached, with
// "Show it as" filled in; Add waits for the other Mac's Allow and can be cancelled; every refusal shows its words; a
// computer that is added closes the dialog. Set MILAGRE_SCREENSHOT_DIR to save screenshots.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");

const LINK = `milagre://pair?relay=wss%3A%2F%2Frelay.milagre.cloud&host=${"h".repeat(22)}&key=${"k".repeat(43)}&token=${"a".repeat(64)}&name=studio&direct=${encodeURIComponent(JSON.stringify(["ws://192.168.1.20:8798"]))}`;
const PRIVATE_LINK = require("@milagre/shared/pairing-link").privatePairingLink(LINK);
const { thisComputer, ThisComputer } = require("@milagre/shared/host-computer");
const OWN = "milagre://pair?relay=wss%3A%2F%2Frelay.milagre.cloud&host=oooooooooooooooooooooo&key=k&token=t&name=desk";

const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { AddComputerDialog } from "/src/components/AddComputerDialog";
import "/src/styles.css";
let pendingListeners = [];
let answer = null;
window.addCalls = [];
window.cancels = 0;
window.milagre = {
  onComputerAddPending: (callback) => {
    pendingListeners.push(callback);
    return () => (pendingListeners = pendingListeners.filter((item) => item !== callback));
  },
  computers: {
    preview: async (link) => {
      if (link === ${JSON.stringify(LINK)}) return { name: "studio", hostId: "h".repeat(22), relayHost: "relay.milagre.cloud" };
      if (link === ${JSON.stringify(PRIVATE_LINK)}) return { name: "studio", hostId: "h".repeat(22), relayHost: "192.168.1.20:8798" };
      if (link === ${JSON.stringify(OWN)}) throw new Error("That's this Mac's own link. Copy the one on the other Mac.");
      throw new Error("That isn't a Milagre pairing link. Copy it from Settings › Devices on the other Mac.");
    },
    add: (link, options) =>
      new Promise((resolve) => {
        window.addCalls.push([link, options]);
        answer = resolve;
      }),
    cancelAdd: async () => {
      window.cancels++;
      answer?.({ ok: false, code: "cancelled", message: "Cancelled." });
    },
  },
};
window.askAllow = () => pendingListeners.forEach((callback) => callback());
window.answerAdd = (result) => answer(result);
function Fixture() {
  const [open, setOpen] = useState(false);
  const [added, setAdded] = useState("");
  return (
    <div style={{ padding: 24 }}>
      <button data-open onClick={() => setOpen(true)}>Open</button>
      <button data-unmount onClick={() => setOpen(false)}>Unmount</button>
      <output data-added>{added}</output>
      {open && (
        <AddComputerDialog
          onClose={() => setOpen(false)}
          onAdded={(computer) => {
            setAdded(computer.name);
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}
createRoot(document.getElementById("root")).render(<Fixture />);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "milagre-add-computer-")));
  await app.whenReady();
  const window = new BrowserWindow({ width: 960, height: 760, show: false, webPreferences: { backgroundThrottling: false } });
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
    throw new Error(`Timed out: ${source}`);
  };
  const screenshot = async (name) => {
    if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
    fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
    window.webContents.invalidate();
    await delay(250);
    fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, name + ".png"), (await window.webContents.capturePage()).toPNG());
  };
  // React reads a field's value from its own setter, so a test types through it.
  const type = (label, text) =>
    evaluate(`(() => {
      const input = document.querySelector('dialog[data-add-computer] input[aria-label=${JSON.stringify(label)}]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(text)});
      input.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
  const press = (text) =>
    evaluate(`[...document.querySelectorAll('dialog[data-add-computer] button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)}).click()`);
  const text = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent.trim() ?? null`);
  try {
    await window.loadURL(process.argv[2]);
    await waitFor(`!!document.querySelector('[data-open]')`);
    await evaluate(`document.querySelector('[data-open]').click()`);
    await waitFor(`document.querySelector('dialog[data-add-computer]')?.open`);
    assert.match(await text("dialog[data-add-computer]"), /Settings › Devices/);

    await type("Pairing link", "hello");
    await waitFor(`!!document.querySelector('[data-add-computer-error]')`);
    assert.equal(await text("[data-add-computer-error]"), "That isn't a Milagre pairing link. Copy it from Settings › Devices on the other Mac.");
    assert.equal(await evaluate(`[...document.querySelectorAll('dialog button')].find((b) => b.textContent.trim() === 'Add computer').disabled`), true);
    await type("Pairing link", OWN);
    await waitFor(`document.querySelector('[data-add-computer-error]')?.textContent.includes("own link")`);

    await type("Pairing link", LINK);
    await waitFor(`!!document.querySelector('[data-add-computer-found]')`);
    assert.match(await text("[data-add-computer-found]"), /studio/);
    assert.match(await text("[data-add-computer-found]"), /Reached through relay\.milagre\.cloud/);
    assert.equal(await evaluate(`document.querySelector('input[aria-label="Show it as"]').value`), "studio");
    assert.match(await text("dialog[data-add-computer]"), /This window gets full control of studio's Projects/);
    await screenshot("add-computer-found");
    console.log("PASS: a pasted link is read before anything is sent, with the computer it names and how it is reached");

    await type("Show it as", "Studio Mac");
    await press("Add computer");
    await waitFor(`window.addCalls.length === 1`);
    assert.deepEqual(await evaluate("window.addCalls[0]"), [LINK, { name: "Studio Mac" }]);
    await evaluate(`window.askAllow()`);
    await waitFor(`!!document.querySelector('[data-add-computer-waiting]')`);
    assert.equal(await text("[data-add-computer-waiting]"), `Waiting for studio to allow ${thisComputer}…`);
    await screenshot("add-computer-waiting");
    await press("Cancel");
    await waitFor(`window.cancels === 1 && !document.querySelector('[data-add-computer-waiting]')`);
    assert.equal(await evaluate(`!!document.querySelector('[data-add-computer-error]')`), false, "a cancel is not an error");
    console.log("PASS: Add waits for the other Mac's Allow, saying so, and Cancel stops it quietly");

    const refusals = [
      ["denied", `studio didn't allow ${thisComputer}.`],
      ["unknown-phone", "This link expired. Copy a new one on studio."],
      ["kind", "Update Milagre on studio to connect."],
      ["full", "studio has too many devices connected. Remove one in its Settings › Devices."],
      ["busy", "studio is answering another computer. Try again in a minute."],
      ["offline", "studio isn't reachable. Open Milagre on it and check Settings › Devices."],
      ["keys", `${ThisComputer} can't keep keys in its keychain, so it can't pair with computers.`],
    ];
    for (const [code, message] of refusals) {
      const before = await evaluate(`window.addCalls.length`);
      await press("Add computer");
      await waitFor(`window.addCalls.length === ${before + 1}`);
      await evaluate(`window.answerAdd(${JSON.stringify({ ok: false, code, message })})`);
      await waitFor(`document.querySelector('[data-add-computer-error]')?.textContent.trim() === ${JSON.stringify(message)}`);
      if (code === "denied") await screenshot("add-computer-denied");
    }
    console.log("PASS: every refusal shows its own words");

    await press("Add computer");
    await waitFor(`window.addCalls.length === ${refusals.length + 2}`);
    await evaluate(`window.answerAdd({ ok: true, computer: { id: "c1", name: "Studio Mac" } })`);
    await waitFor(`!document.querySelector('dialog') && document.querySelector('[data-added]').textContent === 'Studio Mac'`);

    await evaluate(`document.querySelector('[data-open]').click()`);
    await waitFor(`document.querySelector('dialog[data-add-computer]')?.open`);
    await evaluate(`document.querySelector('dialog[data-add-computer]').dispatchEvent(new Event('cancel', { cancelable: true }))`);
    await waitFor(`!document.querySelector('dialog')`);
    // A parent that unmounts the dialog mid-pairing still stops the pairing.
    await evaluate(`document.querySelector('[data-open]').click()`);
    await waitFor(`document.querySelector('dialog[data-add-computer]')?.open`);
    await type("Pairing link", LINK);
    await waitFor(`!!document.querySelector('[data-add-computer-found]')`);
    const calls = await evaluate(`window.addCalls.length`);
    const cancels = await evaluate(`window.cancels`);
    await press("Add computer");
    await waitFor(`window.addCalls.length === ${calls + 1}`);
    await evaluate(`document.querySelector('[data-unmount]').click()`);
    await waitFor(`!document.querySelector('dialog') && window.cancels === ${cancels + 1}`);
    assert.deepEqual(errors, []);
    console.log("PASS: an added computer closes the dialog, and Escape closes it with nothing mounted after; unmounting mid-pairing cancels it");
    await evaluate(`document.querySelector('[data-open]').click()`);
    await type("Pairing link", LINK);
    await waitFor(`!!document.querySelector('[data-add-computer-found]')`);
    await evaluate(`document.querySelector('[role="checkbox"][aria-label="LAN or Tailscale only"]').click()`);
    await waitFor(`document.querySelector('[data-add-computer-found]')?.textContent.includes('192.168.1.20')`);
    await screenshot("add-computer-private");
    const privateCalls = await evaluate(`window.addCalls.length`);
    await press("Add computer");
    await waitFor(`window.addCalls.length === ${privateCalls + 1}`);
    assert.equal(await evaluate(`window.addCalls.at(-1)[0]`), PRIVATE_LINK);
    await evaluate(`window.answerAdd({ ok: false, code: "cancelled", message: "Cancelled." })`);
    console.log("PASS: private pairing removes the remote fallback before Add is sent");
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.error(errors);
    await screenshot("failure").catch(() => {});
    app.exit(1);
  }
}

async function main() {
  const { createServer } = await import("vite");
  const server = await createServer({
    configFile: path.resolve(__dirname, "../apps/desktop/vite.config.ts"),
    cacheDir: path.resolve(__dirname, "../node_modules/.vite-add-computer"),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "add-computer-fixture",
        resolveId(id) {
          if (id === "/__add-computer.tsx") return id;
        },
        load(id) {
          if (id === "/__add-computer.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url !== "/__add-computer") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await server.transformIndexHtml(
                request.url,
                '<html><body><div id="root"></div><script type="module" src="/__add-computer.tsx"></script></body></html>',
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
    const child = require("node:child_process").spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__add-computer`], {
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
