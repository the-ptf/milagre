const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { IMAGE, IMAGE_FOLDERS, SYNC_RULE, parseNameStatus, checkImages, checkSync, platformsTouched } = require("./pr-policy.cjs");

const root = path.resolve(__dirname, "..");
const changes = (...lines) => parseNameStatus(lines.join("\n"));

test("name-status lines keep the new path of a rename or copy", () => {
  assert.deepEqual(changes("M\ta.ts", "R100\told.png\tnew.png", "D\tgone.png", "C75\tsrc.png\tcopy.png"), [
    { status: "M", path: "a.ts" },
    { status: "R", path: "new.png" },
    { status: "D", path: "gone.png" },
    { status: "C", path: "copy.png" },
  ]);
});

test("every image the repository tracks sits in an asset folder, so the allowlist matches git ls-files", (t) => {
  const listed = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" });
  if (listed.status !== 0) return t.skip("not a git checkout");
  const images = listed.stdout.split("\0").filter((file) => IMAGE.test(file));
  assert.ok(images.length > 0);
  assert.deepEqual(
    images.filter((file) => !IMAGE_FOLDERS.some((folder) => file.startsWith(folder))),
    [],
    "An image outside IMAGE_FOLDERS in scripts/pr-policy.cjs: add its folder there with a reason if it is a real asset",
  );
});

test("a screenshot anywhere outside the asset folders fails and points to the screenshots branch", () => {
  const result = checkImages(
    changes("A\tdocs/sidebar.png", "M\tapps/desktop/app/src/shot.JPG", "A\tapps/mobile/assets/new-icon.png", "D\told.png", "A\tnotes.md"),
  );
  assert.equal(result.ok, false);
  assert.match(result.message, /docs\/sidebar\.png/);
  assert.match(result.message, /apps\/desktop\/app\/src\/shot\.JPG/);
  assert.doesNotMatch(result.message, /new-icon|old\.png/);
  assert.match(result.message, /`screenshots` branch/);
  assert.equal(checkImages(changes("A\tapps/site/public/demo/new.webp", "D\tdocs/a.png", "M\tREADME.md")).ok, true);
  assert.equal(checkImages(changes("R090\tapps/site/public/a.gif\tdocs/a.gif")).ok, false, "moving an asset out of its folder counts");
});

test("a UI change on one platform needs its counterpart or the single-platform label", () => {
  const desktopOnly = changes("M\tapps/desktop/app/src/components/Sidebar.tsx", "M\tapps/mobile/src/sidebar.test.ts");
  const result = checkSync(desktopOnly, []);
  assert.equal(result.ok, false);
  assert.ok(result.message.includes(SYNC_RULE), "the error quotes the rule");
  assert.match(result.message, /single-platform/);
  assert.equal(checkSync(desktopOnly, ["single-platform"]).ok, true);
  assert.equal(checkSync(changes("D\tapps/mobile/src/old-sheet.tsx"), []).ok, false, "a deletion is a change");
  assert.equal(checkSync(changes("M\tapps/desktop/app/src/a.tsx", "M\tapps/mobile/src/a.tsx"), []).ok, true);
  assert.equal(checkSync(changes("M\tapps/desktop/electron/main.cjs", "M\tpackages/core/src/x.cjs"), []).ok, true, "only the two UIs count");
});

test("tests, fixtures and baselines are not UI changes", () => {
  for (const file of [
    "apps/desktop/app/src/lib/use-dismiss.test.ts",
    "apps/mobile/src/client.test.tsx",
    "apps/desktop/app/src/components/primitives/design-tokens.baseline.json",
    "apps/mobile/src/__tests__/a.ts",
  ])
    assert.deepEqual(platformsTouched(changes(`M\t${file}`)), { desktop: false, mobile: false }, file);
});

test("the quoted sync rule is still the one in AGENTS.md", () => {
  assert.ok(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8").includes(SYNC_RULE));
});
