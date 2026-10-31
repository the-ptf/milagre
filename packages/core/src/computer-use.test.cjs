const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { agentDesktopBinary, createComputerUse, createComputerUseSettings, runCli } = require("./computer-use.cjs");

function setup({ decisions = [], envelopes = {} } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "computer-use-"));
  const settings = createComputerUseSettings({ file: path.join(dataDir, "computer-use.json") });
  const calls = [];
  const asked = [];
  const run = async (_cli, args) => {
    calls.push(args);
    const reply = args[0] === "session" ? { ok: true, data: { session_id: "run-1" } } : envelopes[args[0]];
    return typeof reply === "function" ? reply(args) : (reply ?? { ok: true, data: {} });
  };
  const approve = async (chatId, request) => {
    asked.push({ chatId, request });
    return decisions.shift() ?? "deny";
  };
  const host = createComputerUse({ dataDir, settings, approve, run, cli: { binary: process.execPath, helper: null, version: "1.0.2" }, platform: "darwin" });
  const tools = (chatId = "/p#1") => Object.fromEntries(host.definitions(chatId).map((tool) => [tool.name, tool]));
  return { dataDir, settings, host, calls, asked, tools };
}

const snapshot = (id, app) => ({ ok: true, data: { app, snapshot_id: id, tree: { role: "window" } } });

test("settings start off and save privately", () => {
  const { settings, dataDir } = setup();
  assert.deepEqual(settings.read(), { enabled: false, cursor: true });
  assert.deepEqual(settings.save({ enabled: true }), { enabled: true, cursor: true });
  assert.deepEqual(settings.save({ cursor: false }), { enabled: true, cursor: false });
  assert.equal(fs.statSync(path.join(dataDir, "computer-use.json")).mode & 0o777, 0o600);
  assert.throws(() => settings.save({ enabled: "yes" }), /on or off/);
});

test("the pinned binary resolves for this platform", () => {
  const cli = agentDesktopBinary({ platform: "darwin", arch: "arm64" });
  assert.match(cli.binary, /agent-desktop-darwin-arm64$/);
  assert.match(cli.helper, /agent-desktop-macos-helper-darwin-arm64$/);
  assert.equal(cli.version, "1.0.2");
});

test("the first snapshot of an app asks once, Allow for Chat keeps it", async () => {
  const { tools, calls, asked } = setup({ decisions: ["allow-for-chat"], envelopes: { snapshot: snapshot("s1", "Finder") } });
  const first = JSON.parse(await tools().desktop_snapshot.run({ app: "Finder" }));
  assert.equal(first.snapshot_id, "s1");
  await tools().desktop_snapshot.run({ app: "finder" });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].request.title, "Let the agent use Finder?");
  assert.equal(asked[0].request.allowForChat, true);
  const snapshotCall = calls.find((args) => args[0] === "snapshot");
  assert.deepEqual(snapshotCall.slice(0, 5), ["snapshot", "--app", "Finder", "--compact", "-i"]);
  assert.equal(calls.filter((args) => args[0] === "session").length, 1, "one agent-desktop session per Chat");
  assert.equal(snapshotCall[snapshotCall.indexOf("--session") + 1], "run-1", "its refs live in that session");
  assert.ok(!calls.flat().includes("--headed"), "never physical input");
});

test("Allow once asks again next time; Deny refuses", async () => {
  const { tools, asked } = setup({ decisions: ["allow", "deny"], envelopes: { snapshot: snapshot("s1", "Notes") } });
  await tools().desktop_snapshot.run({ app: "Notes" });
  await assert.rejects(tools().desktop_snapshot.run({ app: "Notes" }), /POLICY_DENIED: the user declined/);
  assert.equal(asked.length, 2);
});

test("grants belong to one Chat", async () => {
  const { tools, asked } = setup({ decisions: ["allow-for-chat", "allow-for-chat"], envelopes: { snapshot: snapshot("s1", "Notes") } });
  await tools("/p#1").desktop_snapshot.run({ app: "Notes" });
  await tools("/p#2").desktop_snapshot.run({ app: "Notes" });
  assert.equal(asked.length, 2);
});

test("blocked apps are refused without a card", async () => {
  const { tools, asked, calls } = setup({ decisions: ["allow"] });
  for (const app of ["Terminal", "milagre", "System Settings", "1Password"])
    await assert.rejects(tools().desktop_launch.run({ app }), /POLICY_DENIED: agents never operate/);
  assert.equal(asked.length, 0);
  assert.equal(calls.length, 0);
});

test("concurrent first uses of an app share one card", async () => {
  let release;
  const { host, settings } = setup();
  settings.save({ enabled: true });
  const asked = [];
  const gate = new Promise((resolve) => (release = resolve));
  const shared = createComputerUse({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "computer-use-")),
    settings,
    approve: (chatId, request) => (asked.push(request), gate),
    run: async () => snapshot("s1", "Notes"),
    cli: { binary: process.execPath, helper: null, version: "1.0.2" },
  });
  const tools = Object.fromEntries(shared.definitions("/p#1").map((tool) => [tool.name, tool]));
  const both = Promise.all([tools.desktop_snapshot.run({ app: "Notes" }), tools.desktop_find.run({ app: "Notes", role: "button" })]);
  release("allow-for-chat");
  await both;
  assert.equal(asked.length, 1);
  assert.ok(host);
});

test("acting on a ref uses the app of the snapshot it came from", async () => {
  const { tools, calls, asked } = setup({
    decisions: ["allow-for-chat"],
    envelopes: { snapshot: snapshot("sAbc1", "Notes"), type: { ok: true, data: { disposition: { delivery: "delivered" } } } },
  });
  await tools().desktop_snapshot.run({ app: "Notes" });
  const result = JSON.parse(await tools().desktop_act.run({ action: "type", ref: "@sAbc1:e4", text: "hello" }));
  assert.equal(result.disposition.delivery, "delivered");
  assert.deepEqual(calls.find((args) => args[0] === "type").slice(0, 3), ["type", "@sAbc1:e4", "hello"]);
  assert.equal(asked.length, 1);
  await assert.rejects(tools().desktop_act.run({ action: "click", ref: "@sZzz9:e1" }), /SNAPSHOT_NOT_FOUND/);
  await assert.rejects(tools().desktop_act.run({ action: "click", ref: "@e1" }), /INVALID_ARGS/);
  await assert.rejects(tools().desktop_act.run({ action: "type", ref: "@sAbc1:e4" }), /needs text/);
  await assert.rejects(tools("/p#2").desktop_act.run({ action: "click", ref: "@sAbc1:e4" }), /SNAPSHOT_NOT_FOUND/, "another Chat's refs are not its own");
});

test("errors pass agent-desktop's code, disposition and suggestion through", async () => {
  const error = { code: "STALE_REF", message: "gone", suggestion: "snapshot again", disposition: { delivery: "not_delivered", retry: "safe" } };
  const { tools } = setup({ decisions: ["allow-for-chat"], envelopes: { snapshot: snapshot("s1", "Notes"), click: { ok: false, error } } });
  await tools().desktop_snapshot.run({ app: "Notes" });
  const result = JSON.parse(await tools().desktop_act.run({ action: "click", ref: "@s1:e2" }));
  assert.deepEqual(result, { error: "STALE_REF", message: "gone", suggestion: "snapshot again", disposition: error.disposition });
});

test("a screenshot comes back as an image", async () => {
  const { tools } = setup({ decisions: ["allow"], envelopes: { screenshot: { ok: true, data: { data: "iVBOR", format: "png" } } } });
  const result = await tools().desktop_screenshot.run({ app: "Finder" });
  assert.deepEqual(result.images, [{ base64: "iVBOR", mime: "image/png" }]);
});

test("status reports the permissions Milagre holds", async () => {
  const { host } = setup({ envelopes: { permissions: { ok: true, data: { accessibility: { state: "granted" }, screen_recording: { state: "denied" } } } } });
  const status = await host.status();
  assert.equal(status.supported, true);
  assert.deepEqual(status.permissions, { accessibility: "granted", screenRecording: "denied" });
  assert.ok(status.blockedApps.includes("Terminal"));
});

test("runCli parses the envelope, and a timeout kills the process", async () => {
  const fake =
    (stdout, { hang = false } = {}) =>
    () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => setImmediate(() => child.emit("close"));
      if (!hang)
        setImmediate(() => {
          child.stdout.emit("data", stdout);
          child.emit("close");
        });
      return child;
    };
  const cli = { binary: "x", helper: "/h", home: "/tmp" };
  assert.deepEqual(await runCli(cli, ["version"], { spawnImpl: fake('{"ok":true,"data":{"version":"1.0.2"}}') }), { ok: true, data: { version: "1.0.2" } });
  assert.equal((await runCli(cli, ["version"], { spawnImpl: fake("not json") })).error.code, "INTERNAL");
  assert.equal((await runCli(cli, ["wait"], { spawnImpl: fake("", { hang: true }), timeoutMs: 20 })).error.code, "TIMEOUT");
});

test("a launch macOS's app list can't settle falls back to open -a", async () => {
  const unstable = { ok: false, error: { code: "TIMEOUT", message: "inventory", details: { kind: "application_inventory_unstable" } } };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "computer-use-"));
  const opened = [];
  const host = createComputerUse({
    dataDir,
    settings: createComputerUseSettings({ file: path.join(dataDir, "computer-use.json") }),
    approve: async () => "allow-for-chat",
    run: async () => unstable,
    open: async (app) => (opened.push(app), true),
    cli: { binary: process.execPath, helper: null, version: "1.0.2" },
    platform: "darwin",
  });
  const launch = host.definitions("/p#1").find((tool) => tool.name === "desktop_launch");
  assert.equal(JSON.parse(await launch.run({ app: "TextEdit" })).via, "open -a");
  assert.deepEqual(opened, ["TextEdit"]);
});

test("before acting on a ref, the cursor goes to its element with the step, unless it is turned off", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "computer-use-"));
  const settings = createComputerUseSettings({ file: path.join(dataDir, "computer-use.json") });
  const events = [];
  const calls = [];
  const host = createComputerUse({
    dataDir,
    settings,
    approve: async () => "allow-for-chat",
    emit: (channel, payload) => events.push({ channel, payload, before: calls.at(-1)?.[0] }),
    sleep: async () => {},
    run: async (_cli, args) => {
      calls.push(args);
      if (args[0] === "session") return { ok: true, data: { session_id: "run-1" } };
      if (args[0] === "snapshot") return snapshot("s1", "Notes");
      if (args[0] === "get") return { ok: true, data: { value: { x: 10, y: 20, width: 30, height: 12 } } };
      return { ok: true, data: {} };
    },
    cli: { binary: process.execPath, helper: null, version: "1.0.2" },
  });
  const tools = Object.fromEntries(host.definitions("/p#1").map((tool) => [tool.name, tool]));
  await tools.desktop_snapshot.run({ app: "Notes" });
  await tools.desktop_act.run({ action: "click", ref: "@s1:e2", intent: "New note" });
  assert.deepEqual(events[0], {
    channel: "computer-use:cursor",
    payload: { chatId: "/p#1", app: "Notes", label: "New note", bounds: { x: 10, y: 20, width: 30, height: 12 } },
    before: "get",
  });
  assert.ok(calls.findIndex((args) => args[0] === "get") < calls.findIndex((args) => args[0] === "click"), "the cursor moves before the action");
  await tools.desktop_press.run({ app: "Notes", keys: "return", intent: "Saving" });
  assert.equal(events.at(-1).payload.bounds, null, "a key press keeps the cursor where it is");
  settings.save({ cursor: false });
  await tools.desktop_act.run({ action: "click", ref: "@s1:e2", intent: "Another step" });
  assert.equal(events.length, 2);
  await host.forget("/p#1");
});
