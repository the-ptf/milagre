// Settings sections in Electron: Experimental lists only Floating inbox, Ultracode Fatality, Bots and Delegate (Routines and Designs left it; Designs are always
// on and Published pages are in Milagre), plus the Babysit PRs row, which opens its own page; Notifications holds the
// chime picker (picking one saves and plays it; the replay button plays it again); Devices holds Drive other computers, which
// tells main each time it flips. The legacy sidebar switch is gone everywhere.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");

const fixture = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SettingsNav, SettingsPanel } from '/src/components/Settings';
import { useApplyTheme } from '/src/lib/settings';
import { useApplyOtherComputers } from '/src/lib/computers';
import '/src/styles.css';
window.enabledCalls = [];
window.computersEnabled = false;
// Chimes record what would play instead of making noise.
window.played = [];
HTMLMediaElement.prototype.play = function () { window.played.push(this.src.split('/').pop().split('?')[0]); return Promise.resolve(); };
window.savedShare = { id: "orphan", url: "https://share.milagre.cloud/s/orphan", title: "Deleted Chat page", createdAt: 1780000000000, designCount: 2 };
window.shareCalls = [];
window.botsSaves = [];
window.deviceNotes = { enabled: false };
window.deviceNotesSaves = [];
// Babysit PRs as the host keeps it: saves merge shallowly, like babysit-settings.cjs.
window.babysit = { enabled: false, intervalMinutes: 1, wake: ["comments", "checks", "conflicts"], level: 3, resolveThreads: true, stopWhenGreen: true, stopAfterDays: { on: true, days: 7 }, stopAfterFailures: { on: false, times: 3 }, ownRule: false, ownRuleText: "", instructions: "" };
window.babysitSaves = [];
window.milagre = {
  readDeviceNotesEnabled: async () => window.deviceNotes,
  saveDeviceNotesEnabled: async (enabled) => {
    window.deviceNotesSaves.push(enabled);
    if (window.holdDeviceNotesSave) await new Promise(resolve => { window.finishDeviceNotesSave = resolve; });
    if (window.failDeviceNotesSave) { window.failDeviceNotesSave = false; throw new Error("Device notes save failed"); }
    return (window.deviceNotes = { enabled });
  },
  onDeviceNotesEnabledChanged: (listener) => { window.deviceNotesListener = listener; return () => { window.deviceNotesListener = null; }; },
  readBabysitSettings: async () => window.babysit,
  saveBabysitSettings: async (patch) => {
    // The test sets failBabysitSave to make the next save fail, as when the daemon is down.
    if (window.failBabysitSave) { window.failBabysitSave = false; throw new Error("Daemon is not running"); }
    window.babysitSaves.push(patch); window.babysit = { ...window.babysit, ...patch }; return window.babysit; },
  onBabysitSettings: () => () => {},
  listEditors: async () => [], setWindowBackground: async () => {},
  getPhoneStatus: async () => ({ enabled: false, state: "off", remote: "none" }),
  onPhoneStatus: () => () => {},
  readComputerResources: async () => ({ memory: { total: 16 * 1024 ** 3, available: 8 * 1024 ** 3, milagre: 1024 ** 3 }, disk: null }),
  listDevices: async () => [],
  acknowledgeDevices: async () => {},
  listRecentProjects: async () => [],
  listProjects: async () => [],
  readDesignsEnabled: async () => ({ enabled: true }),
  onDesignsEnabledChanged: () => () => {},
  readRemoteDelegationEnabled: async () => ({ enabled: false }),
  saveRemoteDelegationEnabled: async (enabled) => ({ enabled }),
  onRemoteDelegationEnabledChanged: () => () => {},
  readRoutinesEnabled: async () => ({ enabled: true }),
  listRoutines: async () => ({ routines: [] }),
  readBotsEnabled: async () => ({ enabled: false }),
  saveBotsEnabled: async (enabled) => { window.botsSaves.push(enabled); return { enabled }; },
  onBotsEnabledChanged: () => () => {},
  listBots: async () => ({ enabled: false, bots: [], gates: [], grants: [], chats: [] }),
  onBotsChanged: () => () => {},
  artifacts: {
    allPageShares: async () => { window.shareCalls.push(["all"]); return [window.savedShare]; },
    revokeSavedPageShare: async ({ id }) => { window.shareCalls.push(["revoke", id]); window.savedShare = { ...window.savedShare, revoked: true }; },
    pageShares: async () => { throw new Error("No Chat exists"); },
  },
  computers: {
    list: async () => ({ thisMac: "test-computer", computers: [], enabled: window.computersEnabled }),
    setEnabled: async (on) => { window.enabledCalls.push(on); window.computersEnabled = on; },
  },
};
function Fixture() {
  const [section, setSection] = useState('appearance');
  useApplyTheme();
  useApplyOtherComputers();
  return (
    <div style={{ display: 'flex', gap: 12, height: '100vh', padding: '0 12px 0 0' }}>
      <div className="flex shrink-0 pt-[var(--window-chrome-height)] pb-3 pl-3">
        <SettingsNav section={section} onSelect={setSection} onSelectProject={() => {}} onBack={() => {}} showProjectSettings={false} />
      </div>
      <main style={{ flex: 1, minWidth: 0 }}><SettingsPanel section={section} models={[]} update={null} /></main>
    </div>
  );
}
createRoot(document.getElementById('root')).render(<Fixture />);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", fs.mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-settings-sections-")));
  await app.whenReady();
  const window = new BrowserWindow({ width: 1100, height: 700, show: false, webPreferences: { backgroundThrottling: false } });
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
  const screenshot = async (name) => {
    if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
    fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
    window.webContents.invalidate();
    await delay(250);
    fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, name + ".png"), (await window.webContents.capturePage()).toPNG());
  };
  const openSection = async (label) => {
    await waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === ${JSON.stringify(label)})`);
    await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)}).click()`);
    await waitFor(`document.querySelector('main h1')?.textContent.trim() === ${JSON.stringify(label)}`);
  };
  const switches = () => evaluate(`[...document.querySelectorAll('main [data-setting-checkbox]')].map((s) => s.getAttribute("aria-label"))`);
  try {
    await window.loadURL(process.argv[2]);
    // Appearance: every control is a menu; picking a size saves it and the preview follows; fonts draw in their own face.
    // The mini window preview shows where each row applies: hovering a row highlights its region.
    await waitFor(`!!document.querySelector('[data-preview-area="sidebar"]')`);
    // Back sits in the top bar on every decoration, after the window controls when they lead, and stays
    // above the app's drag strip.
    await evaluate(`Object.defineProperty(navigator, 'windowControlsOverlay', { configurable: true, value: undefined })`);
    for (const [controls, expectedLeft] of [
      ["leading", 92],
      ["overlay", 12],
      ["external", 12],
    ]) {
      await evaluate(`window.milagreWindowChrome = { controls: ${JSON.stringify(controls)} }; window.dispatchEvent(new Event('resize'))`);
      await waitFor(
        `(() => { const r = document.querySelector('button[aria-label="Back"]').getBoundingClientRect(); return r.top === 6 && r.left === ${expectedLeft}; })()`,
      );
    }
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('button[aria-label="Back"]')).webkitAppRegion`), "no-drag");
    const region = (area) => `document.querySelector('[data-preview-area=${JSON.stringify(area)}]')`;
    const rowOf = (label) => `document.querySelector('button[aria-label=${JSON.stringify(label)}]').closest('[data-preview-row]')`;
    assert.equal(await evaluate(`${region("sidebar")}.hasAttribute("data-highlighted")`), false, "nothing is highlighted at rest");
    await evaluate(`${rowOf("Interface font")}.scrollIntoView({ block: "center" })`);
    await screenshot("preview");
    await evaluate(`${rowOf("Sidebar size")}.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }))`);
    await waitFor(`${region("sidebar")}.hasAttribute("data-highlighted")`);
    assert.equal(await evaluate(`${region("width")}.hasAttribute("data-highlighted")`), false, "only the sidebar is highlighted");
    await evaluate(`${rowOf("Sidebar size")}.scrollIntoView({ block: "center" })`);
    await screenshot("preview-sidebar");
    await evaluate(`${rowOf("Sidebar size")}.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, pointerType: "mouse" }))`);
    await waitFor(`!${region("sidebar")}.hasAttribute("data-highlighted")`);
    assert.equal(await evaluate(`document.querySelectorAll('main input[type="number"]').length`), 0, "no number fields on Appearance");
    const openMenu = async (label) => {
      await evaluate(`document.querySelector('button[aria-label=${JSON.stringify(label)}]').click()`);
      await waitFor(`!!document.querySelector('[role="listbox"][aria-label=${JSON.stringify(label)}]')`);
    };
    const pick = (text) =>
      evaluate(
        `[...document.querySelectorAll('[role="listbox"] [role="option"]')].find((o) => o.textContent.trim().startsWith(${JSON.stringify(text)})).click()`,
      );
    // Custom chat width: a px field beside the menu; Enter commits, blur clamps, Escape restores.
    assert.equal(await evaluate(`!!document.querySelector('input[aria-label="Custom chat width in pixels"]')`), false, "no px field until Custom");
    await openMenu("Chat width");
    await pick("Custom");
    await waitFor(`!!document.querySelector('input[aria-label="Custom chat width in pixels"]')`);
    const widthField = `document.querySelector('input[aria-label="Custom chat width in pixels"]')`;
    const typeWidth = (text) =>
      evaluate(
        `(() => { const input = ${widthField}; input.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(text)}); input.dispatchEvent(new Event("input", { bubbles: true })); })()`,
      );
    const widthKey = (key) => evaluate(`${widthField}.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, bubbles: true }))`);
    await typeWidth("1100");
    await widthKey("Enter");
    await waitFor(`JSON.parse(localStorage.getItem("milagre-settings")).appearance?.chatWidthPx === 1100`);
    await waitFor(`document.documentElement.style.getPropertyValue('--chat-width') === "1100px"`);
    await typeWidth("99999");
    await evaluate(`${widthField}.dispatchEvent(new FocusEvent("focusout", { bubbles: true }))`);
    await waitFor(`${widthField}.value === "2400"`);
    await waitFor(`JSON.parse(localStorage.getItem("milagre-settings")).appearance?.chatWidthPx === 2400`);
    await typeWidth("700");
    await widthKey("Escape");
    await waitFor(`${widthField}.value === "2400"`);
    assert.equal(await evaluate(`JSON.parse(localStorage.getItem("milagre-settings")).appearance.chatWidthPx`), 2400, "Escape saves nothing");
    await evaluate(`document.querySelector('button[aria-label="Chat width"]').scrollIntoView({ block: "center" })`);
    await screenshot("width");
    // Wide: the preview's chat column is 1024 css px before the scale, labelled, and stays highlighted after the change.
    await openMenu("Chat width");
    await pick("Wide");
    await waitFor(`${region("width")}.offsetWidth === 1024`);
    assert.match(await evaluate(`${region("width")}.textContent`), /1024 px/, "the column is labelled with its width");
    assert.equal(await evaluate(`${region("width")}.hasAttribute("data-highlighted")`), true, "a change holds the highlight");
    await screenshot("preview-width");
    await openMenu("Chat size");
    await pick("15 px");
    await waitFor(`JSON.parse(localStorage.getItem("milagre-settings")).appearance?.chatSize === "large"`);
    await waitFor(`getComputedStyle(document.querySelector('[data-preview-text]')).fontSize === "15px"`);
    assert.equal(
      await evaluate(`getComputedStyle(document.querySelector('[data-preview-composer]')).fontSize`),
      "15px",
      "the preview composer follows Chat size",
    );
    const diffStyle = (property) => evaluate(`getComputedStyle(document.querySelector('[data-preview-diff]')).${property}`);
    assert.match(await diffStyle("fontFamily"), /monospace/, "the preview diff is monospace by default");
    assert.equal(await diffStyle("fontSize"), "12px", "the preview diff follows Code size");
    await openMenu("Code size");
    await pick("14 px");
    await waitFor(`getComputedStyle(document.querySelector('[data-preview-diff]')).fontSize === "14px"`);
    await openMenu("Monospace font");
    await pick("JetBrains Mono");
    await waitFor(`getComputedStyle(document.querySelector('[data-preview-diff]')).fontFamily.startsWith('"JetBrains Mono Variable"')`);
    await openMenu("Sidebar size");
    assert.deepEqual(
      await evaluate(`[...document.querySelectorAll('[role="listbox"] [role="option"]')].map((o) => o.textContent.trim())`),
      ["12 px", "13 pxdefault", "14 px", "15 px"],
      "sidebar sizes show the chat-name size, the default tagged",
    );
    await evaluate(`document.querySelector('button[aria-label="Sidebar size"]').click()`);
    await waitFor(`!document.querySelector('[role="listbox"]')`);
    await openMenu("Interface font");
    const search = `document.querySelector('[role="listbox"][aria-label="Interface font"]').parentElement.querySelector('input')`;
    await evaluate(
      `(() => { const input = ${search}; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "inter"); input.dispatchEvent(new Event("input", { bubbles: true })); })()`,
    );
    await waitFor(`[...document.querySelectorAll('[role="listbox"] [role="option"]')].some((o) => o.textContent.trim() === "Inter")`);
    assert.ok(
      await evaluate(
        `getComputedStyle([...document.querySelectorAll('[role="listbox"] [role="option"] strong')].find((o) => o.textContent.trim() === "Inter")).fontFamily.startsWith('"Inter')`,
      ),
      "the Inter row is drawn in Inter",
    );
    await evaluate(`document.querySelector('button[aria-label="Interface font"]').click()`);
    await waitFor(`!document.querySelector('[role="listbox"]')`);
    await screenshot("appearance");
    // Sticky: scrolled down to Motion, the preview is still on screen.
    await evaluate(`document.querySelector('button[aria-label="Panel animations"]').scrollIntoView({ block: "end" })`);
    await delay(100);
    const previewBox = await evaluate(
      `(() => { const r = document.querySelector('[data-slot="appearance-window-preview"]').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: innerHeight }; })()`,
    );
    assert.ok(previewBox.top >= 0 && previewBox.bottom <= previewBox.height, `the preview stays in view: ${JSON.stringify(previewBox)}`);
    await screenshot("preview-sticky");
    // Panel animations replays the Changes panel in the preview, which then closes again.
    await openMenu("Panel animations");
    await pick("Fast");
    await waitFor(`!!document.querySelector("[data-preview-panel]")`);
    await delay(400);
    await screenshot("preview-motion");
    await waitFor(`!document.querySelector("[data-preview-panel]")`);
    // Full: the column fills the miniature and the markers say so.
    await openMenu("Chat width");
    await pick("Full");
    await waitFor(`${region("width")}.textContent.includes("Full")`);
    await openMenu("Provider icons");
    await pick("Simplified");
    await waitFor(`JSON.parse(localStorage.getItem("milagre-settings")).appearance?.providerIcons === "simplified"`);
    await waitFor(
      `(() => { const logos = [...document.querySelectorAll("[data-provider-logo]")]; return logos.length >= 3 && logos.every(svg => svg.children.length === 1 && svg.firstElementChild.getAttribute("fill") === "currentColor"); })()`,
    );
    await openMenu("Provider icons");
    await pick("Original");
    await waitFor(`!!document.querySelector("[data-provider-logo=codex] linearGradient")`);
    // Sidebar usage: switches between Expanded and Compact in the preview and saves to appearance.sidebarUsage.
    assert.equal(await evaluate(`${region("usage")}.dataset.previewUsage`), "expanded");
    await openMenu("Sidebar usage");
    await pick("Compact");
    await waitFor(`JSON.parse(localStorage.getItem("milagre-settings")).appearance?.sidebarUsage === "compact"`);
    await waitFor(`${region("usage")}.dataset.previewUsage === "compact"`);
    assert.equal(await evaluate(`${region("usage")}.hasAttribute("data-highlighted")`), true, "changing Sidebar usage highlights the usage area");
    await openMenu("Sidebar usage");
    await pick("Expanded");
    await waitFor(`${region("usage")}.dataset.previewUsage === "expanded"`);
    await openSection("Experimental");
    await waitFor(`!!document.querySelector('main [role="checkbox"][aria-label="Bots"]')`);
    // Routines have no switch: every computer runs them.
    await delay(300);
    assert.deepEqual(
      [...(await switches())].sort(),
      ["Bots", "Delegate to other computers", "Device notes", "Floating inbox", "Ultracode Fatality"],
      "Experimental retains Device notes alongside the other settings",
    );
    const deviceNotes = `document.querySelector('main [role="checkbox"][aria-label="Device notes"]')`;
    assert.equal(await evaluate(`${deviceNotes}.getAttribute("aria-checked")`), "false", "device notes default off");
    assert.ok(
      await evaluate(
        `document.querySelector('[data-slot="device-notes-setting"]').textContent.includes("Adds about 100 tokens to every message you send from another device.")`,
      ),
    );
    await evaluate(`window.holdDeviceNotesSave = true; ${deviceNotes}.click()`);
    await waitFor(`${deviceNotes}.disabled && typeof window.finishDeviceNotesSave === "function"`);
    assert.equal(await evaluate(`${deviceNotes}.getAttribute("aria-checked")`), "false", "pending save retains the confirmed value, like mobile");
    await evaluate(`${deviceNotes}.click()`);
    assert.deepEqual(await evaluate(`window.deviceNotesSaves`), [true], "pending saves cannot be repeated");
    await evaluate(`window.holdDeviceNotesSave = false; window.finishDeviceNotesSave()`);
    await waitFor(`${deviceNotes}.getAttribute("aria-checked") === "true" && !${deviceNotes}.disabled`);
    await evaluate(`window.failDeviceNotesSave = true; ${deviceNotes}.click()`);
    await waitFor(`document.querySelector('[data-slot="device-notes-setting"] [role="alert"]')?.textContent === "Device notes save failed"`);
    assert.equal(await evaluate(`${deviceNotes}.getAttribute("aria-checked")`), "true", "failed save retains the daemon's value");
    await evaluate(`${deviceNotes}.click()`);
    await waitFor(`${deviceNotes}.getAttribute("aria-checked") === "false" && !${deviceNotes}.disabled`);
    await evaluate(`window.deviceNotesListener({ enabled: true })`);
    await waitFor(`${deviceNotes}.getAttribute("aria-checked") === "true"`);
    await openSection("Appearance");
    await evaluate(`window.deviceNotesRead = window.milagre.readDeviceNotesEnabled; delete window.milagre.readDeviceNotesEnabled`);
    await openSection("Experimental");
    assert.equal(await evaluate(`!!${deviceNotes}`), false, "a bridge without device notes hides the setting");
    await openSection("Appearance");
    await evaluate(`window.milagre.readDeviceNotesEnabled = window.deviceNotesRead; void 0`);
    await openSection("Experimental");
    await waitFor(`${deviceNotes}?.getAttribute("aria-checked") === "false"`);
    assert.equal(
      await evaluate(
        `/legacy sidebar|Notification chime|Custom theme|usage limits|Linear|Published pages/i.test(document.querySelector("main").textContent) || /Other computers|Designs/.test(document.querySelector("main").textContent)`,
      ),
      false,
      "settings that graduated are not in Experimental",
    );
    await screenshot("experimental");
    // Babysit PRs is a row that opens its own page; Back returns to Experimental.
    const babysitRow = `document.querySelector("main [data-babysit-prs-row]")`;
    await waitFor(`${babysitRow}?.textContent.includes("Off")`);
    assert.equal(
      await evaluate(`${babysitRow}.textContent.includes("Watch every PR a Chat opens and fix review comments, failed checks and conflicts.")`),
      true,
    );
    await evaluate(`${babysitRow}.click()`);
    await waitFor(`!!document.querySelector("main [data-babysit-prs-page] [role=checkbox]")`);
    assert.equal(await evaluate(`document.querySelectorAll("main h1").length`), 1, "the page's title replaces Experimental's");
    assert.equal(await evaluate(`document.querySelector("main h1").textContent`), "ExperimentalBabysit PRs");
    assert.deepEqual(await switches(), ["Babysit new PRs", "Resolve threads it answered"]);
    assert.equal(
      await evaluate(
        `document.querySelector("main [data-babysit-prs-page]").textContent.includes("Each PR keeps the settings it started with: changes here apply to PRs opened afterwards.")`,
      ),
      true,
    );
    assert.deepEqual(await evaluate(`[...document.querySelectorAll("main h2")].map((h) => h.textContent)`), [
      "Babysit PRs",
      "When something needs fixing",
      "Stop babysitting when",
      "Your instructions",
    ]);
    assert.deepEqual(
      await evaluate(`[...document.querySelectorAll('main [role="group"] [aria-pressed]')].map((b) => b.textContent + ":" + b.getAttribute("aria-pressed"))`),
      ["Review comments:true", "Failed checks:true", "Merge conflicts:true", "Branch behind base:false"],
    );
    assert.deepEqual(
      await evaluate(
        `[...document.querySelectorAll("main [data-babysit-level]")].map((row) => [...row.querySelectorAll("[data-step]")].map((s) => s.dataset.step).join(">"))`,
      ),
      ["report", "fix", "fix>push", "fix>push>reply", "fix>push>reply>rerequest"],
      "one pill of steps per level",
    );
    assert.equal(await evaluate(`document.querySelector('main [data-babysit-level="3"]').textContent.includes("Default")`), true);
    assert.equal(await evaluate(`document.querySelector('main [role="radio"][aria-checked="true"]').value`), "3");
    // Switches, chips, levels and stop rules save at once; a number rule sends its whole object.
    await evaluate(`document.querySelector('main [role="checkbox"][aria-label="Babysit new PRs"]').click()`);
    await waitFor(`document.querySelector('main [role="checkbox"][aria-label="Babysit new PRs"]').getAttribute("aria-checked") === "true"`);
    await evaluate(`[...document.querySelectorAll('main [aria-pressed]')].find((b) => b.textContent === "Branch behind base").click()`);
    await evaluate(`document.querySelector('main [data-babysit-level="4"]').click()`);
    await waitFor(`document.querySelector('main [role="radio"][aria-checked="true"]')?.value === "4"`);
    await evaluate(`document.querySelector("#babysit-stop-failures").click()`);
    await evaluate(`document.querySelector("#babysit-stop-own").click()`);
    await waitFor(`!!document.querySelector('main input[aria-label="Your own rule"]')`);
    assert.deepEqual(await evaluate("window.babysitSaves"), [
      { enabled: true },
      { wake: ["comments", "checks", "conflicts", "behind"] },
      { level: 4 },
      { stopAfterFailures: { on: true, times: 3 } },
      { ownRule: true },
    ]);
    await evaluate(`document.querySelector("main h1").scrollIntoView({ block: "start" })`);
    await screenshot("babysit-prs-top");
    // Typed fields save once, shortly after typing stops, and show Saved under the instructions.
    const typeInto = (selector, text) =>
      evaluate(
        `(() => { const field = document.querySelector(${JSON.stringify(selector)}); field.focus(); const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, "value").set.call(field, ${JSON.stringify(text)}); field.dispatchEvent(new Event("input", { bubbles: true })); })()`,
      );
    await typeInto('main textarea[aria-label="Your instructions"]', "Run bun");
    await typeInto('main textarea[aria-label="Your instructions"]', "Run bun check before every push. Never force-push.");
    await waitFor(`!!document.querySelector("main [data-saved]")`);
    assert.deepEqual(await evaluate("window.babysitSaves.slice(5)"), [{ instructions: "Run bun check before every push. Never force-push." }]);
    // Blur saves the own rule at once.
    await typeInto('main input[aria-label="Your own rule"]', "The PR gets the do-not-merge label");
    await evaluate(`document.querySelector('main input[aria-label="Your own rule"]').blur()`);
    await waitFor(`window.babysitSaves.length === 7`);
    assert.deepEqual(await evaluate("window.babysitSaves[6]"), { ownRuleText: "The PR gets the do-not-merge label" });
    await screenshot("babysit-prs");
    // A save the host refuses goes back and says why; typed text stays and shows Not saved.
    const resolveSwitch = `document.querySelector('main [role="checkbox"][aria-label="Resolve threads it answered"]')`;
    const pageText = `document.querySelector("main [data-babysit-prs-page]").textContent`;
    await evaluate(`window.failBabysitSave = true; ${resolveSwitch}.click()`);
    await waitFor(`${pageText}.includes("Daemon is not running")`);
    await waitFor(`${resolveSwitch}.getAttribute("aria-checked") === "true"`);
    assert.equal(await evaluate("window.babysitSaves.length"), 7, "the refused change is not kept");
    await evaluate(`window.failBabysitSave = true`);
    await typeInto('main textarea[aria-label="Your instructions"]', "Never force-push.");
    await waitFor(`${pageText}.includes("Not saved")`);
    assert.equal(await evaluate(`document.querySelector('main textarea[aria-label="Your instructions"]').value`), "Never force-push.", "the text stays");
    await screenshot("babysit-prs-error");
    await typeInto('main textarea[aria-label="Your instructions"]', "Never force-push. Keep one commit per round.");
    await waitFor(`!!document.querySelector("main [data-saved]")`);
    assert.equal(await evaluate(`${pageText}.includes("Daemon is not running") || ${pageText}.includes("Not saved")`), false, "a later save clears the error");
    assert.deepEqual(await evaluate("window.babysitSaves.at(-1)"), { instructions: "Never force-push. Keep one commit per round." });
    // Reset while a field is focused and half typed: the typed text is dropped and the field shows the default.
    await typeInto('main textarea[aria-label="Your instructions"]', "Half typed");
    const savesBeforeReset = await evaluate("window.babysitSaves.length");
    await evaluate(`document.querySelector("main [data-babysit-reset]").click()`);
    await waitFor(`document.querySelector('main [role="checkbox"][aria-label="Babysit new PRs"]').getAttribute("aria-checked") === "false"`);
    await waitFor(`document.querySelector('main textarea[aria-label="Your instructions"]').value === ""`);
    await delay(700);
    assert.equal(await evaluate(`document.querySelector('main textarea[aria-label="Your instructions"]').value`), "", "the reset text stays");
    assert.equal(await evaluate(`document.activeElement?.getAttribute("aria-label")`), null, "Reset leaves the field");
    assert.equal(await evaluate("window.babysitSaves.length"), savesBeforeReset + 1, "only the reset saves, not the half-typed text");
    assert.equal(await evaluate(`!!document.querySelector('main input[aria-label="Your own rule"]')`), false, "reset turns Your own rule off");
    await evaluate(`document.querySelector('main button[aria-label="Back to Experimental"]').click()`);
    await waitFor(`document.querySelector('main h1')?.textContent.trim() === "Experimental"`);
    // Typing then going Back at once still saves the text.
    await evaluate(`${babysitRow}.click()`);
    await waitFor(`!!document.querySelector('main textarea[aria-label="Your instructions"]')`);
    await typeInto('main textarea[aria-label="Your instructions"]', "Report checks that fail outside this PR.");
    await evaluate(`document.querySelector('main button[aria-label="Back to Experimental"]').click()`);
    await delay(100);
    // Well inside the 500 ms debounce: leaving the page saved it, not the timer.
    assert.deepEqual(await evaluate("window.babysitSaves.at(-1)"), { instructions: "Report checks that fail outside this PR." });
    await waitFor(`document.querySelector('main h1')?.textContent.trim() === "Experimental"`);
    assert.deepEqual(
      [...(await switches())].sort(),
      ["Bots", "Delegate to other computers", "Device notes", "Floating inbox", "Ultracode Fatality"],
      "Back returns to Experimental",
    );
    // Designs are always on now: Settings › Milagre has no switch, only Published pages, above the Milagre MCP.
    await openSection("Milagre");
    await waitFor(`!!document.querySelector("main [data-slot=published-pages-setting]")`);
    assert.equal(await evaluate(`!!document.querySelector('main [role="checkbox"][aria-label="Designs"]')`), false, "Designs can't be turned off");
    await screenshot("milagre");
    assert.equal(
      await evaluate(`[...document.querySelectorAll("main h2")].map((h) => h.textContent).join("|")`).then((t) =>
        t.startsWith("Designs and artifacts|Milagre MCP"),
      ),
      true,
    );
    const pagesSetting = 'document.querySelector("[data-slot=published-pages-setting]")';
    await evaluate(`[...${pagesSetting}.querySelectorAll("button")].find((b) => b.textContent === "Manage").click()`);
    const shareDialog = 'document.querySelector("[data-slot=design-page-share]")';
    await waitFor(`${shareDialog}?.open && ${shareDialog}.textContent.includes("Deleted Chat page")`);
    assert.equal(await evaluate(`${shareDialog}.querySelector("[data-slot=design-page-publish]") === null`), true, "global manager has no publication action");
    assert.deepEqual(await evaluate("window.shareCalls"), [["all"]], "deleted Chat history requires no Chat or service health call");
    await screenshot("published-pages-orphan");
    await evaluate(`[...${shareDialog}.querySelectorAll("button")].find((b) => b.textContent === "Revoke link").click()`);
    await evaluate(`${shareDialog}.querySelector("[data-slot=design-page-revoke-confirm]").click()`);
    await waitFor(`${shareDialog}.textContent.includes("Revoked")`);
    assert.deepEqual(await evaluate("window.shareCalls"), [["all"], ["revoke", "orphan"]]);
    await screenshot("published-pages-orphan-revoked");
    await evaluate(`[...${shareDialog}.querySelectorAll("button")].find((b) => b.textContent === "Close").click()`);
    await waitFor(`!${shareDialog}`);
    await openSection("Experimental");
    const botsSwitch = 'document.querySelector("[data-slot=bots-setting] [role=checkbox][aria-label=Bots]")';
    await waitFor(`${botsSwitch} && !${botsSwitch}.disabled`);
    assert.equal(await evaluate(`${botsSwitch}.getAttribute("aria-checked")`), "false", "Bots is off by default");
    assert.equal(
      await evaluate(
        'document.querySelector("[data-slot=bots-setting]").textContent.includes("Named bots that work for you and ask before anything irreversible.")',
      ),
      true,
    );
    await evaluate(`${botsSwitch}.click()`);
    await waitFor(`${botsSwitch}.getAttribute("aria-checked") === "true"`);
    assert.deepEqual(await evaluate("window.botsSaves"), [true]);
    await screenshot("bots-on");
    assert.equal(await evaluate(`!!document.querySelector('[aria-label="Murilo mode"]')`), false, "Murilo mode moved to Settings › Chat");
    for (const label of ["Appearance", "Notifications", "Devices"]) {
      await openSection(label);
      assert.equal(
        await evaluate(`!!document.querySelector('[aria-label="Use legacy sidebar"]') || /legacy sidebar/i.test(document.querySelector("main").textContent)`),
        false,
        "no legacy sidebar switch in " + label,
      );
    }
    await openSection("Devices");
    const other = `document.querySelector('main [role="checkbox"][aria-label="Drive other computers"]')`;
    await waitFor(`!!${other}`);
    assert.equal(await evaluate(`${other}.getAttribute("aria-checked")`), "false", "Drive other computers is off by default");
    assert.deepEqual(await evaluate("window.enabledCalls"), [], "opening Settings preserves the host's saved choice");
    await screenshot("devices-other-computers");
    await evaluate(`${other}.click()`);
    await waitFor(`${other}.getAttribute("aria-checked") === "true"`);
    await waitFor(`JSON.stringify(window.enabledCalls) === '[true]'`);
    await screenshot("other-computers-on");
    await evaluate(`${other}.click()`);
    await waitFor(`JSON.stringify(window.enabledCalls) === '[true,false]'`);
    await openSection("Notifications");
    assert.deepEqual(
      await switches(),
      ["Notify when finished", "Dock badge", "Notify when waiting", "Attention button"],
      "Notifications lists the four alerts, then the chime picker",
    );
    const scheduleTrigger = `document.querySelector('button[aria-label="Notification schedule"]')`;
    assert.equal(await evaluate(`${scheduleTrigger}.textContent.trim()`), "Anytime");
    await evaluate(`${scheduleTrigger}.scrollIntoView({ block: "center" }); ${scheduleTrigger}.click()`);
    const scheduleOption = (label) =>
      `[...document.querySelectorAll('[role="listbox"][aria-label="Notification schedule"] [role="option"]')].find(o => o.textContent.trim() === ${JSON.stringify(label)})`;
    await waitFor(`!!${scheduleOption("Weekdays, 9 AM to 5 PM")}`);
    await evaluate(`${scheduleOption("Weekdays, 9 AM to 5 PM")}.click()`);
    await waitFor(`document.querySelector('button[aria-label="Notification start time"]')?.textContent.trim() === "9:00 AM"`);
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('[aria-label="Notification days"] [aria-pressed="true"]')].map(b => b.textContent)`), [
      "Mon",
      "Tue",
      "Wed",
      "Thu",
      "Fri",
    ]);
    await evaluate(`document.querySelector('[aria-label="Notification days"] button[aria-label="Sat"]').click()`);
    await waitFor(`${scheduleTrigger}.textContent.trim() === "Custom hours"`);
    await screenshot("notification-schedule-custom");
    await openSection("Appearance");
    await openSection("Notifications");
    assert.equal(
      await evaluate(`document.querySelector('[aria-label="Notification days"] button[aria-label="Sat"]').getAttribute('aria-pressed')`),
      "true",
      "custom days persist across navigation",
    );
    await evaluate(`${scheduleTrigger}.scrollIntoView({ block: "center" }); ${scheduleTrigger}.click()`);
    await waitFor(`!!${scheduleOption("Anytime")}`);
    await evaluate(`${scheduleOption("Anytime")}.click()`);
    await waitFor(`!document.querySelector('button[aria-label="Notification start time"]')`);
    const chimeTrigger = `document.querySelector('button[aria-label="Notification chime"]')`;
    assert.equal(await evaluate(`${chimeTrigger}.textContent.trim()`), "System default", "the system sound by default");
    assert.equal(await evaluate(`!!document.querySelector("[data-chime-play]")`), false, "nothing to replay for the system sound");
    await evaluate(`${chimeTrigger}.scrollIntoView({ block: "center" })`);
    await evaluate(`${chimeTrigger}.click()`);
    const chimeOption = (label) =>
      `[...document.querySelectorAll('[role="listbox"][aria-label="Notification chime"] [role="option"]')].find((o) => o.textContent.trim() === ${JSON.stringify(label)})`;
    await waitFor(`!!${chimeOption("Miracle")}`);
    await screenshot("chime-menu");
    await evaluate(`${chimeOption("Miracle")}.click()`);
    await waitFor(`${chimeTrigger}.textContent.trim() === "Miracle"`);
    assert.equal(await evaluate("window.played.length"), 1, "picking a chime plays it");
    assert.match(await evaluate("window.played[0]"), /^chime_miracle/);
    assert.equal(await evaluate(`JSON.parse(localStorage.getItem("milagre-settings")).notificationChime`), "miracle", "and saves it");
    await screenshot("chime-miracle");
    await evaluate(`document.querySelector("[data-chime-play]").click()`);
    await evaluate(`${chimeTrigger}.click()`);
    await waitFor(`!!${chimeOption("Bombastic side eye")}`);
    await evaluate(`${chimeOption("Bombastic side eye")}.click()`);
    await waitFor(`${chimeTrigger}.textContent.trim() === "Bombastic side eye"`);
    assert.equal(await evaluate("window.played.length"), 3, "the replay button plays it again, and each pick plays");
    assert.match(await evaluate("window.played[2]"), /^chime_bombastic_side_eye/);
    assert.deepEqual(errors, []);
    await screenshot("notifications");
    console.log(
      "PASS: Experimental lists only Floating inbox, Ultracode Fatality, Bots and Delegate (no Routines or Designs switch), and its Babysit PRs row opens a page that saves each change and goes Back; Milagre holds Published pages (no Designs switch) above the Milagre MCP; with no legacy sidebar switch or Murilo mode; Bots is off by default and saves on the host; Notifications holds the chime picker, which starts on the system sound, and picking one saves and plays it; Devices holds Drive other computers, off by default, telling main each time it flips",
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
  const server = await createServer({
    configFile: path.resolve(__dirname, "../apps/desktop/vite.config.ts"),
    cacheDir: path.resolve(__dirname, "../node_modules/.vite-settings-sections"),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "settings-sections-fixture",
        resolveId(id) {
          if (id === "/__settings-sections.tsx") return id;
        },
        load(id) {
          if (id === "/__settings-sections.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url !== "/__settings-sections") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await server.transformIndexHtml(
                request.url,
                '<html><body><div id="root"></div><script type="module" src="/__settings-sections.tsx"></script></body></html>',
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
    const child = require("node:child_process").spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__settings-sections`], {
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
