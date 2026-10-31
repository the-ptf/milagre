const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const { AttentionNotifier } = require("./notifications.cjs");
const { thisComputer } = require("@milagre/shared/host-computer");

function setup({ focused = false } = {}) {
  const shown = [];
  const opened = [];
  const state = { focused };
  const notifier = new AttentionNotifier({
    createNotification: (options) => {
      const notification = Object.assign(new EventEmitter(), { options, visible: false, closed: false });
      notification.show = () => {
        notification.visible = true;
      };
      notification.close = () => {
        notification.closed = true;
      };
      shown.push(notification);
      return notification;
    },
    isAppFocused: () => state.focused,
    openChat: (chatId) => opened.push(chatId),
    openPhoneSettings: () => opened.push("settings:phone"),
  });
  return { notifier, shown, opened, state };
}

const question = { type: "question-request", requestId: "q1", questions: [] };
const notice = { chatId: "/shop#2", requestId: "q1", title: "Fix login", subtitle: "shop / main", body: "Which color?" };

test("notifies once about a request the agent waits on while Milagre is in the background", () => {
  const { notifier, shown } = setup();
  notifier.observe("/shop#2", question);
  assert.equal(notifier.notify(notice), true);
  assert.equal(notifier.notify(notice), false);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].visible, true);
  assert.deepEqual(shown[0].options, { title: "Fix login", subtitle: "", body: "Which color?" });
});

test("stays quiet while a Milagre window has focus", () => {
  const { notifier, shown } = setup({ focused: true });
  notifier.observe("/shop#2", question);
  assert.equal(notifier.notify(notice), false);
  assert.equal(shown.length, 0);
});

test("ignores requests no agent is waiting on", () => {
  const { notifier, shown } = setup();
  assert.equal(notifier.notify(notice), false);
  notifier.observe("/shop#2", question);
  notifier.observe("/shop#2", { type: "question-resolved", requestId: "q1", outcome: "answered" });
  assert.equal(notifier.notify(notice), false);
  assert.equal(shown.length, 0);
});

test("closes the notification when the request is answered", () => {
  const { notifier, shown } = setup();
  notifier.observe("/shop#2", { type: "permission-request", requestId: "p1" });
  notifier.notify({ ...notice, requestId: "p1" });
  notifier.observe("/shop#2", { type: "permission-resolved", requestId: "p1", decision: "allow" });
  assert.equal(shown[0].closed, true);
});

test("closes a chat's notifications when its turn ends, and leaves other chats alone", () => {
  const { notifier, shown } = setup();
  notifier.observe("/shop#2", question);
  notifier.observe("/shop#3", question);
  notifier.notify(notice);
  notifier.notify({ ...notice, chatId: "/shop#3" });
  notifier.observe("/shop#2", { type: "turn-cancelled" });
  assert.deepEqual(
    shown.map((item) => item.closed),
    [true, false],
  );
  assert.equal(notifier.notify(notice), false);
});

test("clicking opens the chat", () => {
  const { notifier, shown, opened } = setup();
  notifier.observe("/shop#2", question);
  notifier.notify(notice);
  shown[0].emit("click");
  assert.deepEqual(opened, ["/shop#2"]);
});

test("caps long text and falls back to a title", () => {
  const { notifier, shown } = setup();
  notifier.observe("/shop#2", question);
  notifier.notify({ chatId: "/shop#2", requestId: "q1", title: " ", body: "x".repeat(500) });
  assert.equal(shown[0].options.title, "Milagre");
  assert.equal(shown[0].options.body.length, 240);
  assert.ok(shown[0].options.body.endsWith("…"));
});

test("completion alerts use observed output, show once, and open the originating chat", () => {
  const { notifier, shown, opened } = setup();
  notifier.sync({ projectPath: "/shop", activeChatId: "/shop#2", unread: [], notifyOnCompletion: true, showDockBadge: true });
  notifier.observe("/shop#2", { type: "turn-started" });
  notifier.observe("/shop#2", { type: "text-delta", text: "Tests passed." });
  notifier.observe("/shop#2", { type: "turn-completed" });
  assert.equal(notifier.notifyCompletion({ chatId: "/shop#2", title: "Fix login" }), true);
  assert.equal(shown[0].options.title, "Fix login");
  assert.equal(shown[0].options.subtitle, "");
  assert.equal(shown[0].options.body, "Tests passed.");
  assert.equal(notifier.notifyCompletion({ chatId: "/shop#2" }), false);
  shown[0].emit("click");
  assert.deepEqual(opened, ["/shop#2"]);
});
test("completion alerts suppress the focused chat, cancellation, disabled preference and fabricated results", () => {
  const { notifier, shown } = setup({ focused: true });
  notifier.sync({ projectPath: "/shop", activeChatId: "/shop#2", unread: [], notifyOnCompletion: true });
  notifier.observe("/shop#2", { type: "turn-completed" });
  assert.equal(notifier.notifyCompletion({ chatId: "/shop#2" }), false);
  notifier.observe("/shop#3", { type: "turn-cancelled" });
  assert.equal(notifier.notifyCompletion({ chatId: "/shop#3" }), false);
  assert.equal(notifier.notifyCompletion({ chatId: "/shop#4" }), false);
  notifier.sync({ projectPath: "/shop", unread: [], notifyOnCompletion: false });
  notifier.observe("/shop#3", { type: "turn-failed", message: "Connection lost" });
  assert.equal(notifier.notifyCompletion({ chatId: "/shop#3" }), false);
  assert.equal(shown.length, 0);
});
test("another chat can notify while focused, with failure details and no stale preview on next turn", () => {
  const { notifier, shown } = setup({ focused: true });
  notifier.sync({ projectPath: "/shop", activeChatId: "/shop#2", unread: [], notifyOnCompletion: true });
  notifier.observe("/shop#3", { type: "turn-failed", message: "Connection lost" });
  assert.equal(notifier.notifyCompletion({ chatId: "/shop#3", title: "shop" }), true);
  assert.equal(shown[0].options.body, "Turn failed: Connection lost");
  assert.equal(shown[0].options.title, "shop");
  notifier.observe("/shop#3", { type: "turn-started" });
  notifier.observe("/shop#3", { type: "turn-completed" });
  notifier.notifyCompletion({ chatId: "/shop#3" });
  assert.equal(shown[1].options.body, "Turn completed.");
});
test("Dock counts distinct waiting or unread chats, survives project changes, and clears when disabled", () => {
  let badge;
  const notifier = new AttentionNotifier({
    setBadge: (value) => {
      badge = value;
    },
    isAppFocused: () => false,
  });
  notifier.sync({ projectPath: "/shop", unread: ["/shop#2"], showDockBadge: true });
  notifier.observe("/shop#2", question);
  notifier.observe("/shop#3", question);
  notifier.observe("/shop#3", { ...question, requestId: "q2" });
  assert.equal(badge, "2");
  notifier.sync({ projectPath: "/other", unread: ["/other#1"], showDockBadge: true });
  assert.equal(badge, "3");
  notifier.observe("/shop#3", { type: "turn-cancelled" });
  assert.equal(badge, "2");
  notifier.sync({ projectPath: "/shop", unread: [], showDockBadge: false });
  assert.equal(badge, "");
});

test("a first phone pairing is announced even while Milagre has focus, and its click opens Settings › Devices", () => {
  const { notifier, shown, opened } = setup({ focused: true });
  assert.equal(notifier.notifyDevicePaired(), true);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].visible, true);
  assert.equal(shown[0].options.title, "New phone paired");
  assert.match(shown[0].options.body, /If it wasn't you, remove it in Settings → Devices/);
  shown[0].emit("click");
  assert.deepEqual(opened, ["settings:phone"]);
  // A second pairing replaces the first notice.
  notifier.notifyDevicePaired();
  assert.equal(shown[0].closed, true);
  assert.equal(shown[1].visible, true);
});

test("a computer's first pairing says another Mac can now drive this one, and its click opens Settings › Devices", () => {
  const { notifier, shown, opened } = setup();
  assert.equal(notifier.notifyDevicePaired("computer"), true);
  assert.equal(shown[0].options.title, "New computer paired");
  assert.equal(shown[0].options.body, `Another computer can now drive your agents on ${thisComputer}. If it wasn't you, remove it in Settings → Devices.`);
  shown[0].emit("click");
  assert.deepEqual(opened, ["settings:phone"]);
  // One pairing notice at a time, whatever paired.
  notifier.notifyDevicePaired("phone");
  assert.equal(shown[0].closed, true);
  assert.equal(shown[1].options.title, "New phone paired");
});

test("phones that paired while Milagre was closed are named and announced as such, and the click opens Settings › Devices", () => {
  const { notifier, shown, opened } = setup({ focused: true });
  assert.equal(notifier.notifyPhonesPaired([]), false, "nothing paired, nothing shown");
  assert.equal(notifier.notifyPhonesPaired([{ name: "Victor's iPhone" }], { away: true }), true);
  assert.deepEqual(shown[0].options, {
    title: "New phone paired",
    subtitle: "",
    body: `Victor's iPhone paired with ${thisComputer} while Milagre was closed. If it wasn't you, remove it in Settings → Devices.`,
  });
  shown[0].emit("click");
  assert.deepEqual(opened, ["settings:phone"]);
  notifier.notifyPhonesPaired([{ name: null }, { name: "Pixel" }], { away: true });
  assert.equal(shown[0].closed, true, "one pairing notice at a time");
  assert.deepEqual(shown[1].options, {
    title: "2 new phones paired",
    subtitle: "",
    body: `2 phones paired with ${thisComputer} while Milagre was closed. If one wasn't you, remove it in Settings → Devices.`,
  });
  // While Milagre is open: named when the phone sent a name, as before otherwise.
  notifier.notifyPhonesPaired([{ name: "Victor's iPhone" }]);
  assert.equal(shown[2].options.body, `Victor's iPhone can now reach your agents on ${thisComputer}. If it wasn't you, remove it in Settings → Devices.`);
  notifier.notifyPhonesPaired([{ name: null }]);
  assert.equal(shown[3].options.body, `A phone can now reach your agents on ${thisComputer}. If it wasn't you, remove it in Settings → Devices.`);
});

test("a computer waiting for Allow is announced once while Milagre is in the background, and its click opens the window", () => {
  const { notifier, shown, opened, state } = setup();
  const studio = { key: "s".repeat(43), name: "studio", at: 1 };
  assert.equal(notifier.notifyComputerWaiting([studio]), true);
  assert.equal(shown[0].options.title, `studio wants to drive ${thisComputer}'s chats`);
  assert.equal(shown[0].options.body, "Open Milagre to allow or deny it.");
  shown[0].emit("click");
  assert.deepEqual(opened, ["settings:phone"]);
  // The same request again (another computer joined the list) says nothing more about it.
  const lab = { key: "l".repeat(43), name: null, at: 2 };
  assert.equal(notifier.notifyComputerWaiting([studio, lab]), true);
  assert.equal(shown[1].options.title, `A computer wants to drive ${thisComputer}'s chats`);
  assert.equal(shown[0].closed, true, "one notice at a time");
  assert.equal(notifier.notifyComputerWaiting([studio, lab]), false);
  // Answered: the notice goes.
  assert.equal(notifier.notifyComputerWaiting([]), false);
  assert.equal(shown[1].closed, true);
  // With the window focused the prompt is on screen; no notification.
  state.focused = true;
  assert.equal(notifier.notifyComputerWaiting([{ key: "x".repeat(43), name: "x", at: 3 }]), false);
});

test("a remote chat notification keeps only the chat name and still opens that computer's chat", () => {
  const { notifier, shown, opened } = setup();
  const chatId = "studio|/shop#2";
  notifier.observe(chatId, question);
  notifier.notify({ ...notice, chatId, subtitle: "studio · shop / main" });
  assert.deepEqual(shown[0].options, { title: "Fix login", subtitle: "", body: "Which color?" });
  shown[0].emit("click");
  assert.deepEqual(opened, [chatId]);
});

test("forgetComputer closes what a removed computer waited on and clears the badge", () => {
  const badges = [];
  const { notifier, shown } = setup();
  notifier.setBadge = (badge) => badges.push(badge);
  const remote = "c1|/shop#2";
  notifier.observe(remote, question);
  notifier.observe("/mine#1", question);
  notifier.notify({ ...notice, chatId: remote });
  notifier.unread.add("c1|/shop#3");
  notifier.updateBadge();
  assert.equal(badges.at(-1), "3");
  notifier.forgetComputer("c1");
  assert.equal(shown[0].closed, true);
  assert.equal(badges.at(-1), "1");
  assert.equal(notifier.open.size, 1);
});
const backgroundAgent = (id, status) => ({
  type: "subagent-update",
  agent: { id, title: "Review", status, background: true, startedAt: 1, updatedAt: 1, transcript: [] },
});
test("a turn that ends while a background subagent runs is held; the turn its result wakes is announced once", () => {
  const { notifier, shown } = setup();
  notifier.sync({ projectPath: "/shop", activeChatId: null, unread: [], notifyOnCompletion: true });
  notifier.observe("/shop#2", { type: "turn-started", turnId: "t1" });
  notifier.observe("/shop#2", backgroundAgent("a", "running"));
  notifier.observe("/shop#2", { type: "text-delta", text: "Waiting on the reviewer." });
  notifier.observe("/shop#2", { type: "turn-completed" });
  assert.equal(notifier.notifyCompletion({ chatId: "/shop#2", title: "Fix login" }), false);
  assert.equal(shown.length, 0);
  notifier.observe("/shop#2", { type: "turn-started", turnId: "t2", continues: "t1" });
  notifier.observe("/shop#2", backgroundAgent("a", "completed"));
  notifier.observe("/shop#2", { type: "text-delta", text: "Review done: all good." });
  notifier.observe("/shop#2", { type: "turn-completed" });
  assert.equal(notifier.notifyCompletion({ chatId: "/shop#2", title: "Fix login" }), true);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].options.body, "Review done: all good.");
});
test("a held completion shows once its last background subagent ends with no turn to take the result; failures and foreground subagents never hold", () => {
  const { notifier, shown } = setup();
  notifier.sync({ projectPath: "/shop", activeChatId: null, unread: [], notifyOnCompletion: true });
  notifier.observe("/shop#2", { type: "turn-started", turnId: "t1" });
  notifier.observe("/shop#2", backgroundAgent("a", "running"));
  notifier.observe("/shop#2", backgroundAgent("b", "running"));
  notifier.observe("/shop#2", { type: "text-delta", text: "Dispatched two reviewers." });
  notifier.observe("/shop#2", { type: "turn-completed" });
  assert.equal(notifier.notifyCompletion({ chatId: "/shop#2", title: "Fix login" }), false);
  notifier.observe("/shop#2", backgroundAgent("a", "completed"));
  assert.equal(shown.length, 0);
  notifier.observe("/shop#2", backgroundAgent("b", "failed"));
  assert.equal(shown.length, 1);
  assert.equal(shown[0].options.title, "Fix login");
  assert.equal(shown[0].options.subtitle, "");
  assert.equal(shown[0].options.body, "Dispatched two reviewers.");
  notifier.observe("/shop#3", { type: "turn-started", turnId: "t3" });
  notifier.observe("/shop#3", backgroundAgent("c", "running"));
  notifier.observe("/shop#3", { type: "turn-failed", message: "Connection lost" });
  assert.equal(notifier.notifyCompletion({ chatId: "/shop#3", title: "shop" }), true);
  notifier.observe("/shop#4", { type: "turn-started", turnId: "t4" });
  notifier.observe("/shop#4", { type: "subagent-update", agent: { id: "d", title: "Review", status: "running", startedAt: 1, updatedAt: 1, transcript: [] } });
  notifier.observe("/shop#4", { type: "turn-completed" });
  assert.equal(notifier.notifyCompletion({ chatId: "/shop#4", title: "shop" }), true);
  assert.equal(shown.length, 3);
});

test("a command left running in the background (a dev server) doesn't hold the turn's announcement", () => {
  const { notifier, shown } = setup();
  notifier.sync({ projectPath: "/shop", activeChatId: null, unread: [], notifyOnCompletion: true });
  notifier.observe("/shop#2", { type: "turn-started", turnId: "t1" });
  notifier.observe("/shop#2", { type: "background-tasks", tasks: [{ id: "srv", kind: "local_bash", title: "npm run dev", startedAt: 1 }] });
  notifier.observe("/shop#2", { type: "text-delta", text: "The dev server is up." });
  notifier.observe("/shop#2", { type: "turn-completed" });
  assert.equal(notifier.notifyCompletion({ chatId: "/shop#2", title: "Fix login" }), true);
  assert.equal(shown[0].options.body, "The dev server is up.");
});

test("a stopped turn is never announced, even once its background subagent ends", () => {
  const { notifier, shown } = setup();
  notifier.sync({ projectPath: "/shop", activeChatId: null, unread: [], notifyOnCompletion: true });
  notifier.observe("/shop#2", { type: "turn-started", turnId: "t1" });
  notifier.observe("/shop#2", backgroundAgent("a", "running"));
  notifier.observe("/shop#2", { type: "turn-cancelled" });
  assert.equal(notifier.notifyCompletion({ chatId: "/shop#2", title: "Fix login" }), false);
  notifier.observe("/shop#2", backgroundAgent("a", "cancelled"));
  assert.equal(shown.length, 0);
});

test("completion previews keep the start of the latest reply, without markdown or a cut-off first word", () => {
  const { notifier, shown } = setup();
  notifier.observe("/shop#2", { type: "turn-started" });
  notifier.observe("/shop#2", { type: "text-delta", messageId: "turn-1", text: "I'll investigate the redirect." });
  // Providers send this separate delta between assistant messages in the same turn.
  notifier.observe("/shop#2", { type: "text-delta", messageId: "turn-1", text: "\n\n", startsMessage: true });
  notifier.observe("/shop#2", {
    type: "text-delta",
    messageId: "turn-1",
    text: "## Login fixed\n\n**The redirect** now uses [the callback](/src/auth.ts).\n- Tests passed. ",
  });
  notifier.observe("/shop#2", { type: "text-delta", messageId: "turn-1", text: "Further details about the fix. ".repeat(30) });
  notifier.observe("/shop#2", { type: "turn-completed" });
  notifier.notifyCompletion({ chatId: "/shop#2", title: "Fix login" });
  const { title, subtitle, body } = shown[0].options;
  assert.equal(title, "Fix login");
  assert.equal(subtitle, "");
  assert.ok(body.startsWith("Login fixed The redirect now uses the callback. Tests passed."));
  assert.ok(!body.includes("investigate"));
  assert.ok(!/[#*[\]\n]/.test(body));
  assert.ok(body.length <= 240);
  assert.ok(body.endsWith("…"));
  assert.ok(/\w…$/.test(body));
});

test("ordinary paragraph breaks keep the opening context in a completion preview", () => {
  const { notifier, shown } = setup();
  notifier.observe("/shop#2", { type: "turn-started" });
  for (const text of ["Login fixed.", "\n\n", "Tests passed."]) notifier.observe("/shop#2", { type: "text-delta", messageId: "turn-1", text });
  notifier.observe("/shop#2", { type: "turn-completed" });
  notifier.notifyCompletion({ chatId: "/shop#2", title: "Fix login" });
  assert.equal(shown[0].options.body, "Login fixed. Tests passed.");
});

test("desktop approval notifications preserve the command's shell syntax", () => {
  const { notifier, shown } = setup();
  notifier.observe("/shop#2", { type: "permission-request", requestId: "p1" });
  notifier.notify({
    chatId: "/shop#2",
    requestId: "p1",
    title: "Fix login",
    body: "Codex needs approval: Run: find . -name *test* && printf '%s' 'two   spaces' && rm -rf __pycache__",
  });
  assert.equal(shown[0].options.body, "Codex needs approval: Run: find . -name *test* && printf '%s' 'two   spaces' && rm -rf __pycache__");
});

test("a chosen chime silences a chat's notification and plays in the window; with no window the system sound stays", () => {
  const played = [];
  let window = true;
  const shown = [];
  const notifier = new AttentionNotifier({
    createNotification: (options) => {
      const notification = Object.assign(new EventEmitter(), { options, show() {}, close() {} });
      shown.push(notification);
      return notification;
    },
    isAppFocused: () => false,
    openChat: () => {},
    canPlayChime: () => window,
    playChime: (chime) => played.push(chime),
  });
  notifier.observe("/shop#2", question);
  notifier.notify(notice);
  assert.equal(shown[0].options.silent, undefined);
  assert.deepEqual(played, []);

  notifier.setChime("faaah");
  notifier.observe("/shop#2", { type: "turn-started" });
  notifier.observe("/shop#2", { type: "turn-completed" });
  notifier.notifyCompletion({ chatId: "/shop#2", title: "Fix login" });
  assert.equal(shown[1].options.silent, true);
  assert.deepEqual(played, ["faaah"]);

  window = false;
  notifier.observe("/shop#2", { type: "turn-started" });
  notifier.observe("/shop#2", { type: "turn-completed" });
  notifier.notifyCompletion({ chatId: "/shop#2", title: "Fix login" });
  assert.equal(shown[2].options.silent, undefined);
  assert.deepEqual(played, ["faaah"]);

  notifier.setChime("air-horn");
  assert.equal(notifier.chime, "system");
});

test("a quiet turn (a heartbeat's pass) leaves no completion alert", () => {
  const { notifier, shown } = setup();
  notifier.sync({ projectPath: "/shop", activeChatId: "/shop#1", unread: [], notifyOnCompletion: true });
  notifier.observe("/shop#2", { type: "turn-started" });
  notifier.observe("/shop#2", { type: "text-delta", text: "(pass) CI green" });
  notifier.observe("/shop#2", { type: "turn-completed", quiet: true });
  assert.equal(notifier.notifyCompletion({ chatId: "/shop#2", title: "Fix login" }), false);
  notifier.observe("/shop#2", { type: "turn-started" });
  notifier.observe("/shop#2", { type: "turn-completed" });
  assert.equal(notifier.notifyCompletion({ chatId: "/shop#2", title: "Fix login" }), true);
  assert.equal(shown.length, 1);
});

test("a quiet failed turn (a heartbeat failing again) leaves no alert", () => {
  const { notifier, shown } = setup();
  notifier.sync({ projectPath: "/shop", activeChatId: "/shop#1", unread: [], notifyOnCompletion: true });
  notifier.observe("/shop#2", { type: "turn-started" });
  notifier.observe("/shop#2", { type: "turn-failed", message: "boom", quiet: true });
  assert.equal(notifier.notifyCompletion({ chatId: "/shop#2", title: "Fix login" }), false);
  notifier.observe("/shop#2", { type: "turn-started" });
  notifier.observe("/shop#2", { type: "turn-failed", message: "boom" });
  assert.equal(notifier.notifyCompletion({ chatId: "/shop#2", title: "Fix login" }), true);
  assert.equal(shown.length, 1);
});

test("notification schedules silence waiting and completion alerts while retaining unread badges", () => {
  let clock = Date.parse("2026-10-21T12:59Z");
  const shown = [];
  const badges = [];
  const notifier = new AttentionNotifier({
    now: () => clock,
    createNotification: () => {
      shown.push(true);
      return Object.assign(new EventEmitter(), { show() {}, close() {} });
    },
    isAppFocused: () => false,
    openChat() {},
    setBadge: (value) => badges.push(value),
  });
  notifier.setSchedule({ days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00", timeZone: "America/Toronto" });
  notifier.observe("/shop#2", question);
  assert.equal(notifier.notify(notice), false);
  notifier.observe("/shop#3", { type: "turn-started" });
  notifier.observe("/shop#3", { type: "turn-completed" });
  assert.equal(notifier.notifyCompletion({ chatId: "/shop#3", title: "Finished" }), false);
  assert.equal(badges.at(-1), "1");
  assert.equal(shown.length, 0);
  clock = Date.parse("2026-10-21T13:00Z");
  assert.equal(notifier.notifyCompletion({ chatId: "/shop#3", title: "Finished" }), false, "no delayed completion backlog");
  notifier.observe("/shop#4", question);
  assert.equal(notifier.notify({ ...notice, chatId: "/shop#4" }), true);
  assert.equal(shown.length, 1);
});
