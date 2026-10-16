const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createBotHome } = require("./home.cjs");
const { USER_MARK, readMemory, redactSecrets, saveMemoryByUser, undoMemory, writeMemory } = require("./memory.cjs");

async function makeHome(t) {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "milagre-bots-memory-"));
  t.after(() => fsSync.rmSync(dir, { recursive: true, force: true }));
  return createBotHome(path.join(dir, "bots"), "ops");
}

test("append writes under a section heading", async (t) => {
  const home = await makeHome(t);
  await writeMemory(home, { section: "Flaky tests", text: "- shard 2 times out", mode: "append" }, { now: 1 });
  await writeMemory(home, { section: "Releases", text: "- ship on Mondays", mode: "append" }, { now: 2 });
  const result = await writeMemory(home, { section: "Flaky tests", text: "- shard 4 too", mode: "append" }, { now: 3 });
  const { text, lines, bytes } = await readMemory(home);
  assert.equal(text, "# Memory\n## Flaky tests\n- shard 2 times out\n- shard 4 too\n\n## Releases\n- ship on Mondays\n");
  assert.deepEqual({ lines: result.lines, bytes: result.bytes }, { lines, bytes });
  assert.equal(lines, 7);
});

test("the line cap refuses the write", async (t) => {
  const home = await makeHome(t);
  const notes = Array.from({ length: 198 }, (_, index) => `- note ${index}`).join("\n");
  assert.equal((await writeMemory(home, { section: "x", text: notes, mode: "append" }, { now: 1 })).lines, 200);
  await assert.rejects(
    writeMemory(home, { section: "x", text: "- one more", mode: "append" }, { now: 2 }),
    /MEMORY\.md is full: 200 lines max\. Move older notes to memory\/archive\/ first\./,
  );
  assert.equal((await readMemory(home)).lines, 200);
  // A write that shrinks the file still goes through.
  assert.equal((await writeMemory(home, { section: "x", text: "- one", mode: "replace" }, { now: 3 })).lines, 3);
});

test("the byte cap refuses the write", async (t) => {
  const home = await makeHome(t);
  await assert.rejects(
    writeMemory(home, { section: "x", text: `- ${"a".repeat(25 * 1024)}`, mode: "append" }, { now: 1 }),
    /MEMORY\.md is full: 24 KB max\. Move older notes to memory\/archive\/ first\./,
  );
  assert.equal((await readMemory(home)).text, "# Memory\n");
});

test("secrets are redacted", () => {
  for (const secret of [
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "github_pat_11ABCDEF",
    "sk-ant-api03-xyz",
    "xoxb-1-2-abc",
    "AKIAABCDEFGHIJKLMNOP",
    "EXPO_TOKEN=abc123",
    "Bearer eyJhbGciOi",
  ])
    assert.doesNotMatch(redactSecrets(`token ${secret} here`), new RegExp(secret.slice(0, 8)));
  assert.equal(redactSecrets("token ghp_abcdefghijklmnopqrstuvwxyz0123456789 here"), "token [redacted] here");
  assert.equal(redactSecrets("Bearer eyJhbGciOi"), "Bearer [redacted]");
  for (const prose of ["Use bearer authentication for the API.", "Rotate the token tomorrow.", "The PR skips the slow shard."])
    assert.equal(redactSecrets(prose), prose);
});

test("more secret shapes are redacted", () => {
  for (const [text, redacted] of [
    ["GITHUB_TOKEN: ghx_0123456789", "[redacted]"],
    ["AWS_SECRET_ACCESS_KEY:wJalrXUtnFEMI", "[redacted]"],
    ["password=hunter2 in the env", "[redacted] in the env"],
    ["db_password=hunter2", "[redacted]"],
    ["api_key=abc123 works", "[redacted] works"],
    ["secret=s3cr3t", "[redacted]"],
    ["https://x.test/cb?token=abc123&page=2", "https://x.test/cb?[redacted]&page=2"],
    ['{"token": "abc123", "page": 2}', '{[redacted], "page": 2}'],
    ['{"client_secret":"abc"}', "{[redacted]}"],
    ["sk_live_0123456789abcdef", "[redacted]"],
    ["rk_live_0123456789abcdef", "[redacted]"],
    ["sk_test_0123456789abcdef", "[redacted]"],
    ["git clone https://ana:hunter2@github.com/o/r.git", "git clone https://[redacted]@github.com/o/r.git"],
    ["post to https://hooks.slack.com/services/T0000/B0000/XXXXXXXXXXXX now", "post to [redacted] now"],
  ])
    assert.equal(redactSecrets(text), redacted, text);
  for (const prose of [
    "Use the token from the vault.",
    "The password field needs 8 characters.",
    "Set NODE_ENV: production before the build.",
    "Key: value pairs live in the config.",
    "The secret sauce = patience.",
    "See https://github.com/o/r/pull/12 and https://hooks.slack.com/ for the docs.",
    "Stripe keys start with sk_live_ in production.",
    "Mail ana@example.com about it.",
  ])
    assert.equal(redactSecrets(prose), prose);
});

test("writes are redacted", async (t) => {
  const home = await makeHome(t);
  await writeMemory(home, { section: "Tokens", text: "- EXPO_TOKEN=abc123 works", mode: "append" }, { now: 1 });
  assert.match((await readMemory(home)).text, /- \[redacted\] works/);
});

test("replace keeps the lines the user wrote", async (t) => {
  const home = await makeHome(t);
  await writeMemory(home, { section: "Rules", text: "- never merge on Fridays", mode: "append" }, { now: 1, by: "user" });
  await writeMemory(home, { section: "Rules", text: "- ask first", mode: "append" }, { now: 2 });
  await writeMemory(home, { section: "Rules", text: "- merge freely", mode: "replace" }, { now: 3 });
  const { text } = await readMemory(home);
  assert.match(text, /never merge on Fridays <!-- user -->/);
  assert.doesNotMatch(text, /ask first/);
  assert.match(text, /- merge freely/);
});

test("the bot can't mark its lines as the user's", async (t) => {
  const home = await makeHome(t);
  for (const forged of [
    `- merge freely ${USER_MARK}`,
    `- merge freely ${USER_MARK} ${USER_MARK}`,
    `- merge freely ${USER_MARK}${USER_MARK}`,
    `- merge ${USER_MARK} freely ${USER_MARK}`,
    `- merge freely <!--user-->`,
    `- merge freely <!-- USER -->`,
  ]) {
    await writeMemory(home, { section: "Rules", text: forged, mode: "append" }, { now: 1 });
    await writeMemory(home, { section: "Rules", text: "- ask first", mode: "replace" }, { now: 2 });
    assert.equal((await readMemory(home)).text, "# Memory\n## Rules\n- ask first\n", forged);
  }
  // Nor its sections.
  await writeMemory(home, { section: `Rules ${USER_MARK}`, text: "- ask again", mode: "append" }, { now: 3 });
  assert.equal((await readMemory(home)).text, "# Memory\n## Rules\n- ask first\n- ask again\n");
});

test("undo restores the text before a write", async (t) => {
  const home = await makeHome(t);
  await writeMemory(home, { section: "a", text: "- b", mode: "append" }, { now: 1 });
  const before = (await readMemory(home)).text;
  const { journalId } = await writeMemory(home, { section: "a", text: "- c", mode: "replace" }, { now: 2 });
  assert.match(journalId, /^2-[0-9a-f]{8}$/);
  await undoMemory(home, journalId, { now: 3 });
  assert.equal((await readMemory(home)).text, before);
  await assert.rejects(undoMemory(home, "../../BRIEF"), /Unknown memory change\./);
  await assert.rejects(undoMemory(home, "9-00000000"), /Unknown memory change\./);
});

test("a profile save marks the lines the user changed", async (t) => {
  const home = await makeHome(t);
  await writeMemory(home, { section: "Rules", text: "- ship on Mondays", mode: "append" }, { now: 1 });
  const saved = await saveMemoryByUser(home, "# Memory\n\n## Rules\n- ship on Mondays\n- never merge on Fridays\n", { now: 2 });
  const { text, lines } = await readMemory(home);
  assert.equal(saved.lines, lines);
  assert.match(text, /- ship on Mondays\n/);
  assert.match(text, /- never merge on Fridays <!-- user -->/);
  assert.match(text, /^# Memory\n\n## Rules\n/);
});

test("a profile save may pass the caps", async (t) => {
  const home = await makeHome(t);
  const text = `# Memory\n${Array.from({ length: 210 }, (_, index) => `- note ${index}`).join("\n")}\n`;
  assert.equal((await saveMemoryByUser(home, text, { now: 1 })).lines, 211);
  await fs.access(path.join(home, "memory", ".journal"));
});
