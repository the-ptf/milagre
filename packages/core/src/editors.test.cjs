const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { requireWorktreeRoot, detectEditors, openCommand, openInEditor, resolveInside } = require("./editors.cjs");

test("a validated shared workspace opens member aliases but refuses unrelated symlink targets", async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-editor-owned-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace"),
    member = path.join(root, "member");
  await fs.mkdir(workspace);
  await fs.mkdir(member);
  await fs.writeFile(path.join(member, "file.ts"), "owned");
  await fs.writeFile(path.join(root, "secret.txt"), "external");
  await fs.symlink(member, path.join(workspace, "api"));
  await fs.symlink(root, path.join(workspace, "escape"));
  assert.equal((await resolveInside(workspace, "api/file.ts", [member])).target, path.join(member, "file.ts"));
  await assert.rejects(resolveInside(workspace, "escape/secret.txt", [member]), /outside/);
});

const fakeFs = (present) => ({
  access: async (target) => {
    if (!present.includes(target)) throw new Error("ENOENT");
  },
});
const fakeWhich = (found) => async (name) => found[name] ?? null;

test("detects editors in the fixed order, from apps and CLIs", async () => {
  const editors = await detectEditors({
    platform: "darwin",
    fs: fakeFs(["/Applications/Zed.app", "/Users/me/Applications/Cursor.app", "/Applications/Sublime Text.app"]),
    which: fakeWhich({ code: "/usr/local/bin/code", subl: "/usr/local/bin/subl" }),
    home: "/Users/me",
  });
  assert.deepEqual(
    editors.map((editor) => editor.id),
    ["cursor", "vscode", "zed", "sublime"],
  );
  assert.deepEqual(
    editors.map((editor) => editor.name),
    ["Cursor", "Visual Studio Code", "Zed", "Sublime Text"],
  );
  assert.equal(editors[0].appPath, "/Users/me/Applications/Cursor.app");
  assert.equal(editors[0].cli, null);
  assert.equal(editors[1].appPath, null);
  assert.equal(editors[1].cli, "/usr/local/bin/code");
  assert.equal(editors[3].appPath, "/Applications/Sublime Text.app");
  assert.equal(editors[3].cli, "/usr/local/bin/subl");
});

test("lists Windsurf and VSCodium, and nothing when nothing is installed", async () => {
  const some = await detectEditors({
    platform: "darwin",
    fs: fakeFs(["/Applications/Windsurf.app", "/Applications/VSCodium.app"]),
    which: fakeWhich({}),
    home: "/h",
  });
  assert.deepEqual(
    some.map((editor) => editor.id),
    ["windsurf", "vscodium"],
  );
  assert.deepEqual(await detectEditors({ platform: "darwin", fs: fakeFs([]), which: fakeWhich({}), home: "/h" }), []);
});

const cursor = { id: "cursor", name: "Cursor", appPath: "/Applications/Cursor.app", cli: "/usr/local/bin/cursor" };
const appOnly = { ...cursor, cli: null };
const cliOnly = { ...cursor, appPath: null };

test("a CLI with a line uses the editor's goto form", () => {
  assert.deepEqual(openCommand(cursor, { target: "/r/a.ts", line: 42 }), { file: "/usr/local/bin/cursor", args: ["-g", "/r/a.ts:42"] });
  assert.deepEqual(openCommand({ ...cursor, id: "vscode", cli: "/bin/code" }, { target: "/r/a.ts", line: 3 }), {
    file: "/bin/code",
    args: ["-g", "/r/a.ts:3"],
  });
  assert.deepEqual(openCommand({ ...cursor, id: "windsurf", cli: "/bin/windsurf" }, { target: "/r/a.ts", line: 3 }), {
    file: "/bin/windsurf",
    args: ["-g", "/r/a.ts:3"],
  });
  assert.deepEqual(openCommand({ ...cursor, id: "vscodium", cli: "/bin/codium" }, { target: "/r/a.ts", line: 3 }), {
    file: "/bin/codium",
    args: ["-g", "/r/a.ts:3"],
  });
  assert.deepEqual(openCommand({ ...cursor, id: "zed", cli: "/bin/zed" }, { target: "/r/a.ts", line: 9 }), { file: "/bin/zed", args: ["/r/a.ts:9"] });
  assert.deepEqual(openCommand({ ...cursor, id: "sublime", cli: "/bin/subl" }, { target: "/r/a.ts", line: 9 }), { file: "/bin/subl", args: ["/r/a.ts:9"] });
});

test("without a line, or without a CLI, it opens with open -a and no line", () => {
  assert.deepEqual(openCommand(cursor, { target: "/r/a.ts" }), { file: "/usr/bin/open", args: ["-a", "/Applications/Cursor.app", "/r/a.ts"] });
  assert.deepEqual(openCommand(appOnly, { target: "/r/a.ts", line: 42 }), { file: "/usr/bin/open", args: ["-a", "/Applications/Cursor.app", "/r/a.ts"] });
  assert.deepEqual(openCommand(appOnly, { target: "/r" }), { file: "/usr/bin/open", args: ["-a", "/Applications/Cursor.app", "/r"] });
});

test("a CLI without an app opens the path with the CLI alone", () => {
  assert.deepEqual(openCommand(cliOnly, { target: "/r/a.ts" }), { file: "/usr/local/bin/cursor", args: ["/r/a.ts"] });
  assert.deepEqual(openCommand(cliOnly, { target: "/r" }), { file: "/usr/local/bin/cursor", args: ["/r"] });
});

test("a folder never gets a line", () => {
  assert.deepEqual(openCommand(cursor, { target: "/r", line: 4, isDirectory: true }), {
    file: "/usr/bin/open",
    args: ["-a", "/Applications/Cursor.app", "/r"],
  });
});

async function tempProject() {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-editors-")));
  const root = path.join(base, "repo");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "a.ts"), "x");
  await fs.writeFile(path.join(base, "secret.txt"), "s");
  await fs.symlink(path.join(base, "secret.txt"), path.join(root, "link.txt"));
  await fs.symlink(base, path.join(root, "outside"));
  return { base, root };
}

test("the path guard resolves files inside the root", async (t) => {
  const { base, root } = await tempProject();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  assert.deepEqual(await resolveInside(root, "src/a.ts"), { target: path.join(root, "src", "a.ts"), isDirectory: false });
  assert.deepEqual(await resolveInside(root, path.join(root, "src", "a.ts")), { target: path.join(root, "src", "a.ts"), isDirectory: false });
  assert.deepEqual(await resolveInside(root, undefined), { target: root, isDirectory: true });
  assert.deepEqual(await resolveInside(root, "src"), { target: path.join(root, "src"), isDirectory: true });
});

test("the path guard refuses escapes and missing files", async (t) => {
  const { base, root } = await tempProject();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await assert.rejects(resolveInside(root, "../secret.txt"), /outside/i);
  await assert.rejects(resolveInside(root, "src/../../secret.txt"), /outside/i);
  await assert.rejects(resolveInside(root, path.join(base, "secret.txt")), /outside/i);
  await assert.rejects(resolveInside(root, "link.txt"), /outside/i);
  await assert.rejects(resolveInside(root, "outside/secret.txt"), /outside/i);
  await assert.rejects(resolveInside(root, "src/missing.ts"), /File not found/);
  await assert.rejects(resolveInside(path.join(base, "nope"), "a.ts"), /File not found|Folder not found/);
  await assert.rejects(resolveInside(root, "src/a.ts\0"), /File not found/);
});

test("openInEditor runs the editor and reports a short error string", async (t) => {
  const { base, root } = await tempProject();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const calls = [];
  const run = async (file, args) => {
    calls.push({ file, args });
  };
  const deps = { editors: [cursor], run, checkRoot: async () => {} };
  assert.equal(await openInEditor({ root, path: "src/a.ts", line: 7, editor: "cursor" }, deps), null);
  assert.deepEqual(calls[0], { file: "/usr/local/bin/cursor", args: ["-g", `${path.join(root, "src", "a.ts")}:7`] });
  assert.equal(await openInEditor({ root }, deps), null);
  assert.deepEqual(calls[1], { file: "/usr/bin/open", args: ["-a", "/Applications/Cursor.app", root] });
  assert.equal(await openInEditor({ root, path: "src/none.ts", editor: "cursor" }, deps), "File not found");
  assert.match(await openInEditor({ root, path: "../secret.txt", editor: "cursor" }, deps), /outside/i);
  assert.equal(calls.length, 2);
});

test("openInEditor falls back to the first editor, and reports no editor or a failed launch", async (t) => {
  const { base, root } = await tempProject();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const calls = [];
  const run = async (file, args) => {
    calls.push({ file, args });
  };
  assert.equal(await openInEditor({ root, path: "src/a.ts", editor: "nonsense" }, { editors: [appOnly], run, checkRoot: async () => {} }), null);
  assert.equal(calls.length, 1);
  assert.equal(await openInEditor({ root }, { editors: [], run, checkRoot: async () => {} }), "No editor found");
  const failing = async () => {
    throw new Error("spawn failed");
  };
  assert.equal(await openInEditor({ root }, { editors: [cursor], run: failing, checkRoot: async () => {} }), "Couldn't open Cursor");
  assert.equal(await openInEditor({ root, line: "7; rm", path: "src/a.ts" }, { editors: [cursor], run, checkRoot: async () => {} }), null);
  assert.deepEqual(calls.at(-1).args, ["-a", "/Applications/Cursor.app", path.join(root, "src", "a.ts")]);
});

test("a missing path opens the first fallback inside the root, and nothing else falls back", async (t) => {
  // A routine's agent works in .routines/r and names its case file `casos/a.md` from there.
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-editor-fallback-")));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, "repo");
  const caseFile = path.join(root, ".routines", "r", "casos", "a.md");
  const elsewhere = path.join(base, "elsewhere", "casos", "a.md");
  for (const file of [caseFile, elsewhere, path.join(root, "src", "a.ts")]) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "x");
  }
  const calls = [];
  const run = async (file, args) => {
    calls.push(args.at(-1));
  };
  const deps = { editors: [cursor], run, checkRoot: async () => {} };
  const open = (request) => openInEditor({ root, editor: "cursor", ...request }, deps);
  // Outside the root and relative fallbacks are skipped; the first one inside the root opens, once.
  assert.equal(await open({ path: "casos/a.md", line: 3, fallbacks: [elsewhere, "casos/a.md", caseFile] }), null);
  assert.deepEqual(calls, [`${caseFile}:3`]);
  // A path that is there opens as named.
  assert.equal(await open({ path: "src/a.ts", fallbacks: [caseFile] }), null);
  assert.equal(calls.at(-1), path.join(root, "src", "a.ts"));
  // No fallback inside the root: the named path's own error, and no launch.
  assert.equal(await open({ path: "casos/a.md", fallbacks: [elsewhere] }), "File not found");
  assert.equal(await open({ path: "casos/a.md" }), "File not found");
  // A path that walks outside is refused as such, not answered by a fallback.
  assert.match(await open({ path: "../elsewhere/casos/a.md", fallbacks: [caseFile] }), /outside/i);
  assert.equal(calls.length, 2);
  // A failed launch is reported as it is, never retried with a fallback.
  let launches = 0;
  const failing = async () => {
    launches++;
    throw new Error("timed out");
  };
  assert.equal(await openInEditor({ root, path: "casos/a.md", fallbacks: [caseFile, caseFile] }, { ...deps, run: failing }), "Couldn't open Cursor");
  assert.equal(launches, 1);
});

test("a CLI that is not on PATH is found inside the app bundle", async () => {
  const editors = await detectEditors({
    platform: "darwin",
    fs: fakeFs([
      "/Applications/Cursor.app",
      "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
      "/Applications/Zed.app",
      "/Applications/Zed.app/Contents/MacOS/cli",
    ]),
    which: fakeWhich({ zed: "/usr/local/bin/zed" }),
    home: "/h",
  });
  assert.equal(editors[0].cli, "/Applications/Cursor.app/Contents/Resources/app/bin/cursor");
  assert.equal(editors[1].cli, "/usr/local/bin/zed");
});

const { execFileSync } = require("node:child_process");

test("editor:open only accepts the top folder of a checkout", async (t) => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-roots-")));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const repo = path.join(base, "repo");
  await fs.mkdir(path.join(repo, "sub"), { recursive: true });
  await fs.writeFile(path.join(repo, "sub", "a.ts"), "x");
  execFileSync("/usr/bin/git", ["init", "-q"], { cwd: repo });
  await fs.mkdir(path.join(base, "plain"));
  await fs.writeFile(path.join(base, "plain", "b.ts"), "x");
  await requireWorktreeRoot(repo);
  const calls = [];
  const run = async (file, args) => {
    calls.push({ file, args });
  };
  const deps = { editors: [cursor], run };
  assert.equal(await openInEditor({ root: repo, path: "sub/a.ts" }, deps), null);
  assert.equal(calls.length, 1);
  for (const root of ["/", path.join(base, "plain"), path.join(repo, "sub"), path.join(base, "missing"), "repo", undefined, 7]) {
    assert.equal(await openInEditor({ root, path: "etc/passwd" }, deps), "That folder isn't a project", String(root));
  }
  assert.equal(calls.length, 1);
});
