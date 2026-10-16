import { test } from "node:test";
import assert from "node:assert/strict";
import { BOT_RUNNING_CHAT_CAP, GATE_EXPIRY_MS, GATE_KINDS, MEMORY_BYTE_CAP, MEMORY_LINE_CAP, botIdFromName, isQuietChat } from "./bots.mjs";
import { PERMISSION_MODE_LABEL, PERMISSION_MODES } from "./model-copy.ts";

test("the bots constants", () => {
  assert.deepEqual(GATE_KINDS, ["merge", "publish", "post", "delete", "spend"]);
  assert.equal(GATE_EXPIRY_MS, 3_600_000);
  assert.equal(BOT_RUNNING_CHAT_CAP, 3);
  assert.equal(MEMORY_LINE_CAP, 200);
  assert.equal(MEMORY_BYTE_CAP, 24 * 1024);
});

test("botIdFromName makes a stable slug", () => {
  assert.equal(botIdFromName("Ops"), "ops");
  assert.equal(botIdFromName("  Release Manager! "), "release-manager");
  assert.equal(botIdFromName("Ops"), botIdFromName("ops"));
});

test("quiet chats are bot threads and bot-opened Chats", () => {
  const snapshot = {
    enabled: true,
    bots: [{ id: "ops", homePath: "/d/bots/ops", threadSessionId: 1 }],
    gates: [],
    grants: [],
    chats: [
      { chatKey: "/p#4", botId: "ops", status: "running" },
      { chatKey: "/p#6", botId: "ops", status: "taken-over" },
    ],
  };
  assert.equal(isQuietChat(snapshot, "/d/bots/ops#1"), true);
  assert.equal(isQuietChat(snapshot, "/p#4"), true);
  assert.equal(isQuietChat(snapshot, "/p#5"), false);
  // A Chat the user took over is theirs again, and tells them when it finishes.
  assert.equal(isQuietChat(snapshot, "/p#6"), false);
  assert.equal(isQuietChat(undefined, "/p#4"), false);
});

test("the bot mode label, which the mode picker never offers", () => {
  assert.equal(PERMISSION_MODE_LABEL.bot, "Bot rules");
  assert.deepEqual(
    PERMISSION_MODES.map((mode) => mode.id),
    ["ask", "auto", "full"],
  );
});
