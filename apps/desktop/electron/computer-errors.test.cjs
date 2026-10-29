const test = require("node:test");
const assert = require("node:assert/strict");
const { computerProblem } = require("./computer-errors.cjs");
const { thisComputer, ThisComputer } = require("@milagre/shared/host-computer");

test("each problem reads as the spec words it, naming the computer", () => {
  const name = "studio";
  const pairing = true;
  assert.equal(computerProblem("unknown-phone", { name }), "Removed on studio. Pair again with a new link.");
  assert.equal(computerProblem("unknown-phone", { name, pairing }), "This link expired. Copy a new one on studio.");
  assert.equal(computerProblem("outdated", { name }), "Update Milagre on studio to connect.");
  assert.equal(computerProblem("kind", { name, pairing }), "Update Milagre on studio to connect.");
  assert.equal(computerProblem("full", { name }), "studio has too many devices connected. Remove one in its Settings › Devices.");
  assert.equal(computerProblem("denied", { name, pairing }), `studio didn't allow ${thisComputer}.`);
  assert.equal(computerProblem("busy", { name, pairing }), "studio is answering another computer. Try again in a minute.");
  assert.equal(computerProblem("reset", { name }), "studio was reset. Pair again with a new link.");
  assert.equal(computerProblem("bad-token", { name, pairing }), "This link is out of date. Copy a new one on studio.");
  assert.equal(computerProblem("bad-host", { name, pairing }), "This isn't the computer the link was made on. Copy a new link on studio.");
  assert.equal(computerProblem("offline", { name, pairing }), "studio isn't reachable. Open Milagre on it and check Settings › Devices.");
  assert.equal(computerProblem("keys", { name }), `${ThisComputer} lost its keys for studio. Remove it and pair again.`);
  assert.equal(computerProblem("lost", { name, pairing }), "Couldn't reach studio. Check your connection and try again.");
  assert.equal(computerProblem("lost", { name }), "studio is offline.");
});
