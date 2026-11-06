const assert = require("node:assert/strict");
const test = require("node:test");
const { createHiddenChats } = require("./hidden-chats.cjs");

const store = (values) => ({ get: (key) => values[key] });

test("a paired computer's Project hidden here, and this Mac's reported ones, are hidden", () => {
  const values = { "milagre.hiddenRemoteScopes": JSON.stringify(["studio|/gym"]) };
  const hidden = createHiddenChats(store(values));
  assert.equal(hidden.isHidden("studio|/gym#2"), true);
  assert.equal(hidden.isHidden("studio|/shop#2"), false);
  assert.equal(hidden.isHidden("/blog#1"), false);
  hidden.setReported(["/blog"]);
  assert.equal(hidden.isHidden("/blog#1"), true);
  values["milagre.hiddenRemoteScopes"] = null;
  assert.equal(hidden.isHidden("studio|/gym#2"), false);
});

test("a computer unchecked in Filters is hidden only while Other computers is on", () => {
  const values = { "milagre.hiddenComputers": JSON.stringify(["studio", "local"]), "milagre-settings": JSON.stringify({ otherComputers: true }) };
  const hidden = createHiddenChats(store(values));
  assert.equal(hidden.isHidden("studio|/shop#2"), true);
  assert.equal(hidden.isHidden("/mine#1"), true);
  assert.equal(hidden.isHidden("atlas|/api#1"), false);
  values["milagre-settings"] = JSON.stringify({ otherComputers: false });
  assert.equal(hidden.isHidden("studio|/shop#2"), false);
});

test("broken preferences hide nothing, and only the hidden keys count as changes", () => {
  const hidden = createHiddenChats(store({ "milagre.hiddenRemoteScopes": "{", "milagre.hiddenComputers": "[1]" }));
  assert.equal(hidden.isHidden("studio|/gym#2"), false);
  assert.equal(hidden.affects("milagre.hiddenComputers"), true);
  assert.equal(hidden.affects("milagre-settings"), true);
  assert.equal(hidden.affects("milagre.sidebarWidth"), false);
});
