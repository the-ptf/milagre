const test = require("node:test");
const assert = require("node:assert/strict");
const { qualifyKey } = require("@milagre/shared/chat-scopes");
const { routeBrowserPanelClose } = require("./browser-panel-close.cjs");

const calls = () => {
  const received = [];
  return {
    received,
    closePage: (chatKey, targetId) => received.push(["page", chatKey, targetId]),
    closeAll: (chatKey) => received.push(["all", chatKey]),
  };
};

test("routes exact local page close ids to the controller", () => {
  const f = calls();
  assert.equal(routeBrowserPanelClose("browser-panel:close-page", { chatId: "/p#1", pageId: "panel-hash:ABC" }, { ...f, qualifyKey }), true);
  assert.deepEqual(f.received, [["page", "/p#1", "panel-hash:ABC"]]);
});

test("qualifies remote Chat keys before routing wrapped close events", () => {
  const f = calls();
  assert.equal(
    routeBrowserPanelClose(
      "computers:event",
      { computerId: "computer-1", channel: "browser-panel:close-page", payload: { chatId: "/p#1", pageId: "panel-hash:ABC" } },
      { ...f, qualifyKey },
    ),
    true,
  );
  assert.equal(
    routeBrowserPanelClose(
      "computers:event",
      { computerId: "computer-1", channel: "browser-panel:close-chat-pages", payload: { chatId: "/p#1" } },
      { ...f, qualifyKey },
    ),
    true,
  );
  assert.deepEqual(f.received, [
    ["page", "computer-1|/p#1", "panel-hash:ABC"],
    ["all", "computer-1|/p#1"],
  ]);
});

test("ignores malformed and unrelated remote events", () => {
  const f = calls();
  assert.equal(
    routeBrowserPanelClose(
      "computers:event",
      { computerId: "computer-1", channel: "browser-panel:close-page", payload: { pageId: "id" } },
      { ...f, qualifyKey },
    ),
    false,
  );
  assert.equal(
    routeBrowserPanelClose("computers:event", { computerId: "computer-1", channel: "agent:event", payload: { chatId: "/p#1" } }, { ...f, qualifyKey }),
    false,
  );
  assert.deepEqual(f.received, []);
});
