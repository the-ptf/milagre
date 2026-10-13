const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const execFile = promisify(require("node:child_process").execFile);
const { createAdvisorReads } = require("./advisor-reads.cjs");
const { runTool } = require("./linked-tools.cjs");
const { configuredHelper } = require("./git/test-helpers.cjs");

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-advisor-reads-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, "project");
  const refs = path.join(directory, "references");
  await fs.mkdir(root);
  await fs.mkdir(refs);
  await fs.writeFile(path.join(root, "notes.txt"), "first\nfind this\nlast\n");
  await fs.writeFile(path.join(refs, "guide.md"), "Product instructions");
  await fs.writeFile(path.join(directory, "outside.txt"), "Do not read");
  await fs.symlink(path.join(directory, "outside.txt"), path.join(root, "escape.txt"));
  await execFile("git", ["init", "-q", root]);
  const definitions = createAdvisorReads({ roots: [root], referenceRoots: [refs] });
  const call = (name, input) =>
    runTool(
      definitions.find((tool) => tool.name === name),
      input,
    );
  return { root, refs, directory, definitions, call };
}

test("advisor reads files and explicitly allowed references with numbered lines", async (t) => {
  const { root, refs, call } = await fixture(t);
  assert.deepEqual(await call("advisor_read_file", { root, path: "notes.txt", start: 2, end: 2 }), { text: "2\tfind this", images: [], isError: false });
  assert.match((await call("advisor_read_file", { root: refs, path: "guide.md" })).text, /Product instructions/);
});

test("advisor file reads reject unowned roots, path escapes, symlinks and extra input", async (t) => {
  const { root, directory, call } = await fixture(t);
  for (const input of [
    { root: directory, path: "outside.txt" },
    { root, path: "../outside.txt" },
    { root, path: "escape.txt" },
    { root, path: "/etc/passwd" },
    { root, path: "-notes.txt" },
    { root, path: "notes.txt", command: "touch other.txt" },
  ])
    assert.equal((await call("advisor_read_file", input)).isError, true, JSON.stringify(input));
});

test("advisor file listings and literal searches do not follow escaping symlinks", async (t) => {
  const { root, call } = await fixture(t);
  assert.match((await call("advisor_list_files", { root })).text, /notes.txt/);
  assert.match((await call("advisor_search_files", { root, query: "find this" })).text, /notes.txt:2:find this/);
  const outside = await call("advisor_search_files", { root, query: "Do not read" });
  assert.equal(outside.isError, false);
  assert.equal(outside.text, "No matches.");
});

test("advisor Git operations are fixed and cannot mutate files or use reference roots", async (t) => {
  const { root, refs, call } = await fixture(t);
  assert.match((await call("advisor_git", { root, operation: "status" })).text, /notes.txt/);
  for (const input of [
    { root, operation: "reset" },
    { root, operation: "diff", path: "../outside.txt" },
    { root, operation: "diff", path: "escape.txt" },
    { root, operation: "status", args: ["--output=notes.txt"] },
    { root: refs, operation: "status" },
  ])
    assert.equal((await call("advisor_git", input)).isError, true);
  assert.equal(await fs.readFile(path.join(root, "notes.txt"), "utf8"), "first\nfind this\nlast\n");
});

test("advisor reads cap output and reject files over two MB", async (t) => {
  const { root, call } = await fixture(t);
  await fs.writeFile(path.join(root, "large.txt"), "a".repeat(60_000));
  assert.ok((await call("advisor_read_file", { root, path: "large.txt" })).text.length < 40_100);
  await fs.writeFile(path.join(root, "huge.txt"), "a".repeat(2 * 1024 * 1024 + 1));
  assert.equal((await call("advisor_read_file", { root, path: "huge.txt" })).isError, true);
});

for (const kind of ["external diff", "textconv", "fsmonitor", "clean", "process"]) {
  test(`advisor Git never executes a configured ${kind} helper`, async (t) => {
    const { root, call } = await fixture(t);
    await execFile("git", ["-C", root, "add", "notes.txt"]);
    await execFile("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "Initial notes"]);
    await fs.appendFile(path.join(root, "notes.txt"), "added\n");
    const { marker } = await configuredHelper(root, kind, "notes.txt");
    const response = await call("advisor_git", { root, operation: kind === "fsmonitor" ? "status" : "diff" });
    await assert.rejects(fs.access(marker), { code: "ENOENT" });
    assert.equal(response.isError, false, response.text);
    assert.match(response.text, kind === "fsmonitor" ? /notes\.txt/ : /\+added/);
  });
}
