const assert = require("node:assert/strict");
const test = require("node:test");
const { createHiddenChats } = require("./hidden-chats.cjs");

const store = (values) => ({
  get: (key) => values[key],
  set: (key, value) => {
    values[key] = value;
  },
});

test("a paired computer's Project hidden here, and this Mac's reported ones, are hidden", () => {
  const values = { "milagre.hiddenRemoteScopes": JSON.stringify(["studio|/gym"]) };
  const hidden = createHiddenChats(store(values));
  assert.equal(hidden.isHidden("studio|/gym#2"), true);
  assert.equal(hidden.isHidden("studio|/shop#2"), false);
  assert.equal(hidden.isHidden("/blog#1"), false);
  assert.equal(hidden.setReported(["/blog"]), true);
  assert.equal(hidden.isHidden("/blog#1"), true);
  assert.equal(hidden.setReported(["/blog"]), false, "the same list is not saved again");
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

test("this Mac's hidden Projects are saved, so a restart knows them before the host or window reports", () => {
  const values = {};
  createHiddenChats(store(values)).setReported(["/gym", "/blog", "/gym"]);
  assert.equal(values["milagre.hiddenLocalProjects"], JSON.stringify(["/blog", "/gym"]));
  const restarted = createHiddenChats(store(values));
  assert.equal(restarted.isHidden("/gym#4"), true);
  assert.equal(restarted.setReported([]), true);
  assert.equal(values["milagre.hiddenLocalProjects"], null);
  assert.equal(restarted.isHidden("/gym#4"), false);
});
