const assert = require("node:assert/strict");
const { test } = require("node:test");
const { launchOptions } = require("./launch-env.cjs");

test("--dev-server reaches Electron as the dev server variable, not as an argument", () => {
  const { args, env } = launchOptions(["--dev-server=http://127.0.0.1:5180", "--window-decoration=overlay"], { PATH: "/bin" });
  assert.deepEqual(args, ["--window-decoration=overlay"]);
  assert.deepEqual(env, { PATH: "/bin", MILAGRE_DEV_SERVER_URL: "http://127.0.0.1:5180" });
});

test("a Chat's ELECTRON_RUN_AS_NODE never reaches the app", () => {
  const source = { ELECTRON_RUN_AS_NODE: "1" };
  assert.equal("ELECTRON_RUN_AS_NODE" in launchOptions([], source).env, false);
  assert.equal(source.ELECTRON_RUN_AS_NODE, "1");
});

test("MILAGRE_USER_DATA_DIR selects the profile, and without it Electron keeps its own", () => {
  assert.deepEqual(launchOptions([], { MILAGRE_USER_DATA_DIR: "/tmp/my profile" }).args, ["--user-data-dir=/tmp/my profile"]);
  assert.deepEqual(launchOptions([], {}).args, []);
});
