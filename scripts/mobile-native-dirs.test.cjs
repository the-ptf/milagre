const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { test } = require("node:test");

// apps/mobile uses Continuous Native Generation: `expo prebuild` writes ios/ and android/ from app.json and the config
// plugins, so a hand edit there is lost on the next build (apps/mobile/AGENTS.md, Rules).
test("nothing under apps/mobile/ios or apps/mobile/android is committed", (t) => {
  const listed = spawnSync("git", ["ls-files", "-z", "--", "apps/mobile/ios", "apps/mobile/android"], { cwd: path.resolve(__dirname, ".."), encoding: "utf8" });
  if (listed.status !== 0) return t.skip("not a git checkout");
  assert.deepEqual(
    listed.stdout.split("\0").filter(Boolean),
    [],
    "apps/mobile/ios and apps/mobile/android are generated (CNG): configure native behavior in apps/mobile/app.json or a config plugin, and git rm the generated files",
  );
});
