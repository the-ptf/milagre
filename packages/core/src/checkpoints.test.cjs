const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createCheckpoints } = require("./checkpoints.cjs");
async function fixture(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "checkpoints-")));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, "repo");
  await fs.mkdir(root);
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  await fs.writeFile(path.join(root, "a.txt"), "committed\n");
  git("add", ".");
  git("commit", "-qm", "initial");
  const options = { directory: path.join(dir, "saved") };
  const store = createCheckpoints(options);
  const write = (name, body) => fs.writeFile(path.join(root, name), body);
  const read = (name) => fs.readFile(path.join(root, name), "utf8");
  return { root, store, options, git, write, read, chatId: root + "#1" };
}
const decisions = (preview, choice = "restore") => Object.fromEntries(preview.files.map((file) => [file.key, choice]));
test("discard removes only a cancelled continuation's checkpoint, before or after its terminal event", async (t) => {
  const f = await fixture(t);
  for (const finished of [false, true]) {
    await f.store.begin({ chatId: f.chatId, roots: [f.root], messageId: 4 });
    assert.equal(await f.store.discard(f.chatId, 5), false);
    if (finished) await f.store.finish(f.chatId);
    assert.equal(await f.store.discard(f.chatId, 4), true);
    assert.deepEqual(await f.store.list(f.chatId), []);
  }
});
test("checkpoint capture and restore resolve Git's Windows path spelling through the filesystem", async (t) => {
  const f = await fixture(t);
  const reportedRoot = "C:/Projects/account-settings";
  let resolvedRoot = f.root;
  const realpath = fs.realpath;
  // Emulate Git for Windows at the path boundary while using real Git and file operations.
  t.mock.method(fs, "realpath", (name, ...args) => (name === reportedRoot ? Promise.resolve(resolvedRoot) : realpath(name, ...args)));
  const client = require("./git/client.cjs");
  const createGit = client.createGit;
  t.mock.method(client, "createGit", (options) => {
    const git = createGit(options);
    return {
      read: {
        ...git.read,
        text: async (root, args) => {
          const result = await git.read.text(root, args);
          return args[0] === "rev-parse" && args[1] === "--show-toplevel" ? reportedRoot + "\n" : result;
        },
      },
    };
  });
  const filename = require.resolve("./checkpoints.cjs");
  const cached = require.cache[filename];
  let store;
  try {
    delete require.cache[filename];
    store = require(filename).createCheckpoints(f.options);
  } finally {
    require.cache[filename] = cached;
  }
  const item = await store.begin({ chatId: f.chatId, roots: [f.root] });
  await f.write("a.txt", "agent edit\n");
  await store.finish(f.chatId);
  const preview = await store.preview(f.chatId, item.id);
  assert.deepEqual(
    preview.files.map((file) => file.path),
    ["a.txt"],
  );
  await store.restore(f.chatId, { token: preview.token, decisions: decisions(preview), approved: true });
  assert.equal(await f.read("a.txt"), "committed\n");
  resolvedRoot = path.dirname(f.root);
  await assert.rejects(store.begin({ chatId: f.chatId, roots: [f.root] }), /Worktree identity changed/);
});
test("restores dirty tracked and relevant untracked files after restart without changing the index or unrelated edits", async (t) => {
  const f = await fixture(t);
  await f.write("a.txt", "staged\n");
  f.git("add", "a.txt");
  await f.write("a.txt", "manual before task\n");
  await f.write("draft.txt", "my draft\n");
  const item = await f.store.begin({ chatId: f.chatId, roots: [f.root], permissionMode: "ask" });
  await f.write("a.txt", "agent edit\n");
  await f.write("draft.txt", "agent draft\n");
  await f.write("new.txt", "agent new\n");
  await f.store.finish(f.chatId);
  await f.write("unrelated.txt", "other chat\n");
  const restarted = createCheckpoints(f.options);
  assert.equal((await restarted.list(f.chatId))[0].id, item.id);
  const preview = await restarted.preview(f.chatId, item.id);
  assert.deepEqual(
    preview.files.map((file) => file.path),
    ["a.txt", "draft.txt", "new.txt"],
  );
  assert.ok(preview.files.every((file) => !file.conflict));
  await restarted.restore(f.chatId, { token: preview.token, decisions: decisions(preview), approved: true });
  assert.equal(await f.read("a.txt"), "manual before task\n");
  assert.equal(await f.read("draft.txt"), "my draft\n");
  await assert.rejects(f.read("new.txt"), { code: "ENOENT" });
  assert.equal(await f.read("unrelated.txt"), "other chat\n");
  assert.equal(f.git("show", ":a.txt"), "staged\n");
  assert.ok((await restarted.list(f.chatId)).some((item) => item.kind === "recovery"));
});
test("requires explicit resolution, confirmation and a fresh preview for later edits in every mode", async (t) => {
  for (const mode of ["ask", "auto", "full"]) {
    const f = await fixture(t);
    const item = await f.store.begin({ chatId: f.chatId, roots: [f.root], permissionMode: mode });
    await f.write("a.txt", "agent");
    await f.store.finish(f.chatId);
    await f.write("a.txt", "manual later");
    let preview = await f.store.preview(f.chatId, item.id);
    assert.equal(preview.files[0].conflict, true);
    await assert.rejects(f.store.restore(f.chatId, { token: preview.token, decisions: decisions(preview) }), /confirm/i);
    await assert.rejects(f.store.restore(f.chatId, { token: preview.token, decisions: {}, approved: true }), /resolve|decision/i);
    await f.write("a.txt", "changed after preview");
    await assert.rejects(f.store.restore(f.chatId, { token: preview.token, decisions: decisions(preview), approved: true }), /preview.*again|changed/i);
    assert.equal(await f.read("a.txt"), "changed after preview");
    preview = await f.store.preview(f.chatId, item.id);
    await f.store.restore(f.chatId, { token: preview.token, decisions: decisions(preview, "keep"), approved: true });
    assert.equal(await f.read("a.txt"), "changed after preview");
  }
});
test("excludes ignored files, configured artifacts, secrets and symlinks, including tracked secrets", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, ".milagre"));
  await f.write(".milagre/checkpoint-ignore", "**/*.cache\n");
  await f.write(".gitignore", "ignored.txt\n");
  await f.write("ignored.txt", "ignored");
  await f.write("build.cache", "artifact");
  await f.write(".env", "SECRET=value");
  await f.write("id_rsa", "private");
  await f.write("config.txt", "-----BEGIN PRIVATE KEY-----\nsecret");
  f.git("add", ".env");
  await fs.symlink(path.join(f.root, "a.txt"), path.join(f.root, "link.txt"));
  const item = await f.store.begin({ chatId: f.chatId, roots: [f.root] });
  for (const name of [".env", "ignored.txt", "build.cache", "id_rsa", "config.txt"]) await f.write(name, "changed");
  await f.store.finish(f.chatId);
  const preview = await f.store.preview(f.chatId, item.id);
  assert.ok(!preview.files.some((file) => [".env", "ignored.txt", "build.cache", "id_rsa", "config.txt", "link.txt"].includes(file.path)));
  assert.ok(item.excluded > 0);
  const content = await fs.readFile(path.join(f.options.directory, item.id, "manifest.json"), "utf8");
  assert.ok(!content.includes("SECRET=value"));
});
test("rejects active tasks, cross-Chat access and symlink replacement; interrupted snapshots remain conservative", async (t) => {
  const f = await fixture(t);
  const item = await f.store.begin({ chatId: f.chatId, roots: [f.root] });
  await f.write("a.txt", "partial");
  await assert.rejects(f.store.preview(f.chatId, item.id), /running|active|finish/i);
  const restarted = createCheckpoints(f.options);
  const p = await restarted.preview(f.chatId, item.id);
  assert.equal(p.files[0].conflict, true);
  await assert.rejects(restarted.preview(f.root + "#2", item.id), /checkpoint|Chat/i);
  await fs.unlink(path.join(f.root, "a.txt"));
  await fs.symlink(path.join(f.root, ".git/config"), path.join(f.root, "a.txt"));
  await assert.rejects(restarted.restore(f.chatId, { token: p.token, decisions: decisions(p), approved: true }), /changed|symlink|preview/i);
});
test("restores deleted files and executable modes; newer exclusions block a restore", async (t) => {
  const f = await fixture(t);
  await fs.chmod(path.join(f.root, "a.txt"), 0o755);
  const item = await f.store.begin({ chatId: f.chatId, roots: [f.root] });
  await fs.unlink(path.join(f.root, "a.txt"));
  await f.store.finish(f.chatId);
  const p = await f.store.preview(f.chatId, item.id);
  assert.equal(p.files[0].action, "create");
  await f.store.restore(f.chatId, { token: p.token, decisions: decisions(p), approved: true });
  assert.equal((await fs.stat(path.join(f.root, "a.txt"))).mode & 0o777, 0o755);
  await fs.mkdir(path.join(f.root, ".milagre"), { recursive: true });
  await f.write(".milagre/checkpoint-ignore", "a.txt\n");
  assert.equal((await f.store.preview(f.chatId, item.id)).files.length, 0);
});
test("handles prototype-like filenames and preserves newer conflicting edits when kept", async (t) => {
  const f = await fixture(t);
  await f.write("__proto__", "before");
  await f.write("constructor", "before");
  const item = await f.store.begin({ chatId: f.chatId, roots: [f.root] });
  await f.write("__proto__", "agent");
  await f.write("constructor", "agent");
  await f.store.finish(f.chatId);
  await f.write("constructor", "other Chat");
  const p = await f.store.preview(f.chatId, item.id);
  assert.equal(p.files.length, 2);
  const choices = decisions(p);
  choices[p.files.find((file) => file.path === "constructor").key] = "keep";
  await f.store.restore(f.chatId, { token: p.token, decisions: choices, approved: true });
  assert.equal(await f.read("__proto__"), "before");
  assert.equal(await f.read("constructor"), "other Chat");
});
test("a task in a shared Worktree blocks preview of another Chat checkpoint", async (t) => {
  const f = await fixture(t);
  const first = await f.store.begin({ chatId: f.chatId, roots: [f.root] });
  await f.write("a.txt", "first");
  await f.store.finish(f.chatId);
  await f.store.begin({ chatId: f.root + "#2", roots: [f.root] });
  await assert.rejects(f.store.preview(f.chatId, first.id), /running|finish/i);
});
test("creates recovery data before any write and can undo the restore after restart", async (t) => {
  const f = await fixture(t);
  const item = await f.store.begin({ chatId: f.chatId, roots: [f.root] });
  await f.write("a.txt", "agent");
  await f.store.finish(f.chatId);
  const p = await f.store.preview(f.chatId, item.id);
  const result = await f.store.restore(f.chatId, { token: p.token, decisions: decisions(p), approved: true });
  await assert.rejects(f.store.restore(f.chatId, { token: p.token, decisions: decisions(p), approved: true }), /preview/i);
  const restart = createCheckpoints(f.options);
  const recovery = await restart.preview(f.chatId, result.recoveryId);
  await restart.restore(f.chatId, { token: recovery.token, decisions: decisions(recovery), approved: true });
  assert.equal(await f.read("a.txt"), "agent");
});
test("nonregular tracked files do not block checkpoint capture", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.root, "a.txt"));
  execFileSync("mkfifo", [path.join(f.root, "a.txt")]);
  // A child timeout detects blocking opens without leaving a hung promise in this runner.
  const result = execFileSync(
    process.execPath,
    [
      "-e",
      `const {createCheckpoints}=require(process.argv[1]);createCheckpoints({directory:process.argv[2]}).begin({chatId:'fifo',roots:[process.argv[3]]}).then(x=>console.log(x.excluded))`,
      path.join(__dirname, "checkpoints.cjs"),
      f.options.directory,
      f.root,
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.equal(result.trim(), "1");
});
test("a parent symlink swap at deletion cannot delete an external file", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  const parent = path.join(f.root, "sub");
  await fs.mkdir(parent);
  await f.write("sub/created.txt", "owned");
  const outside = path.join(path.dirname(f.root), "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "created.txt"), "external");
  const crypto = require("node:crypto");
  const stat = await fs.stat(f.root);
  const payload = {
    op: "apply",
    root: f.root,
    identity: { dev: stat.dev, ino: stat.ino },
    blobDirectory: path.join(f.options.directory, "blobs"),
    files: [
      {
        path: "sub/created.txt",
        expected: { hash: crypto.createHash("sha256").update("owned").digest("hex"), mode: (await fs.stat(path.join(parent, "created.txt"))).mode & 0o777 },
        target: null,
      },
    ],
  };
  const script = `const fs=require('node:fs'); const request=JSON.parse(process.argv[1]); const unlink=fs.unlinkSync; fs.unlinkSync=name=>{if(name==='created.txt'){fs.renameSync(request.root+'/sub',request.root+'/moved');fs.symlinkSync(process.argv[2],request.root+'/sub');}return unlink(name);}; const result=require(process.argv[3]).execute(request); console.log(JSON.stringify(result));`;
  const result = execFileSync(process.execPath, ["-e", script, JSON.stringify(payload), outside, path.join(__dirname, "checkpoint-files.cjs")], {
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(JSON.parse(result).restored, 1);
  assert.equal(await fs.readFile(path.join(outside, "created.txt"), "utf8"), "external");
  await assert.rejects(fs.stat(path.join(f.root, "moved/created.txt")), { code: "ENOENT" });
});
test("a FIFO ignore file fails promptly instead of hanging the global queue", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, ".milagre"));
  execFileSync("mkfifo", [path.join(f.root, ".milagre/checkpoint-ignore")]);
  await assert.rejects(f.store.begin({ chatId: f.chatId, roots: [f.root] }), /ignore file must be a regular file/);
  await fs.unlink(path.join(f.root, ".milagre/checkpoint-ignore"));
  assert.ok((await f.store.begin({ chatId: f.chatId, roots: [f.root] })).id);
});
test("parent replacement during a read cannot capture outside bytes", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, "sub"));
  await f.write("sub/file.txt", "owned");
  const outside = path.join(path.dirname(f.root), "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "file.txt"), "external");
  const stat = await fs.stat(f.root);
  const payload = { op: "inspect", root: f.root, identity: { dev: stat.dev, ino: stat.ino }, names: ["sub/file.txt"] };
  const script = `const fs=require('node:fs'); const request=JSON.parse(process.argv[1]); const open=fs.openSync; fs.openSync=(name,...args)=>{if(name==='file.txt'){fs.renameSync(request.root+'/sub',request.root+'/moved');fs.symlinkSync(process.argv[2],request.root+'/sub');}return open(name,...args);}; console.log(JSON.stringify(require(process.argv[3]).execute(request)));`;
  const result = execFileSync(process.execPath, ["-e", script, JSON.stringify(payload), outside, path.join(__dirname, "checkpoint-files.cjs")], {
    encoding: "utf8",
    timeout: 10000,
  });
  const crypto = require("node:crypto");
  assert.equal(JSON.parse(result).files["sub/file.txt"].hash, crypto.createHash("sha256").update("owned").digest("hex"));
  assert.equal(await fs.readFile(path.join(outside, "file.txt"), "utf8"), "external");
});
test("leaf replacement at descriptor chmod cannot modify or install an external symlink", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  const crypto = require("node:crypto");
  await f.write("a.txt", "agent");
  const original = Buffer.from("checkpoint");
  const blobDirectory = path.join(f.options.directory, "blobs");
  await fs.mkdir(blobDirectory, { recursive: true });
  const originalHash = crypto.createHash("sha256").update(original).digest("hex");
  await fs.writeFile(path.join(blobDirectory, originalHash), original);
  const outside = path.join(path.dirname(f.root), "outside.txt");
  await fs.writeFile(outside, "external", { mode: 0o600 });
  const stat = await fs.stat(f.root);
  const payload = {
    op: "apply",
    root: f.root,
    identity: { dev: stat.dev, ino: stat.ino },
    blobDirectory,
    files: [
      {
        path: "a.txt",
        expected: { hash: crypto.createHash("sha256").update("agent").digest("hex"), mode: (await fs.stat(path.join(f.root, "a.txt"))).mode & 0o777 },
        target: { hash: originalHash, mode: 0o755 },
      },
    ],
  };
  const script = `const fs=require('node:fs');const chmod=fs.fchmodSync;fs.fchmodSync=(fd,mode)=>{fs.unlinkSync('a.txt');fs.symlinkSync(process.argv[2],'a.txt');chmod(fd,mode);};try{require(process.argv[3]).execute(JSON.parse(process.argv[1]));process.exitCode=2;}catch(error){console.log(error.message);}`;
  const result = execFileSync(process.execPath, ["-e", script, JSON.stringify(payload), outside, path.join(__dirname, "checkpoint-files.cjs")], {
    encoding: "utf8",
    timeout: 10000,
  });
  assert.match(result, /target changed during restore/);
  assert.equal((await fs.stat(outside)).mode & 0o777, 0o600);
  assert.equal(await fs.readFile(outside, "utf8"), "external");
});
test("restores content and original permissions after a task makes its file read-only", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  await fs.chmod(path.join(f.root, "a.txt"), 0o644);
  const item = await f.store.begin({ chatId: f.chatId, roots: [f.root] });
  await f.write("a.txt", "agent");
  await fs.chmod(path.join(f.root, "a.txt"), 0o444);
  await f.store.finish(f.chatId);
  const p = await f.store.preview(f.chatId, item.id);
  await f.store.restore(f.chatId, { token: p.token, decisions: decisions(p), approved: true });
  assert.equal(await f.read("a.txt"), "committed\n");
  assert.equal((await fs.stat(path.join(f.root, "a.txt"))).mode & 0o777, 0o644);
});
test("a task checkpoint keeps the message that started it and counts its changes; restoring reports what it did and redo puts the files back", async (t) => {
  const f = await fixture(t);
  await f.write("b.txt", "before\n");
  const item = await f.store.begin({ chatId: f.chatId, roots: [f.root], messageId: 7, prompt: "  Update the login redirect\nand its test  " });
  assert.equal(item.messageId, 7);
  assert.equal(item.prompt, "Update the login redirect\nand its test");
  assert.equal(item.changed, undefined);
  await f.write("a.txt", "agent edit\n");
  await f.write("b.txt", "agent b\n");
  await f.write("new.txt", "agent new\n");
  await f.store.finish(f.chatId);
  const [listed] = await f.store.list(f.chatId);
  assert.equal(listed.changed, 3);
  assert.equal(listed.messageId, 7);
  await f.write("b.txt", "mine\n");
  const preview = await f.store.preview(f.chatId, item.id);
  const choices = Object.fromEntries(preview.files.map((file) => [file.key, file.path === "b.txt" ? "keep" : "restore"]));
  const result = await f.store.restore(f.chatId, { token: preview.token, decisions: choices, approved: true });
  assert.deepEqual({ ...result, recoveryId: typeof result.recoveryId }, { restored: 2, kept: 1, checkpointId: item.id, redo: false, recoveryId: "string" });
  assert.equal(await f.read("a.txt"), "committed\n");
  assert.equal(await f.read("b.txt"), "mine\n");
  const recovery = (await f.store.list(f.chatId)).find((entry) => entry.id === result.recoveryId);
  assert.equal(recovery.kind, "recovery");
  assert.equal(recovery.changed, 2);
  assert.equal(recovery.messageId, 7);
  const back = await f.store.preview(f.chatId, result.recoveryId);
  assert.deepEqual(back.files.map((file) => file.path).toSorted(), ["a.txt", "new.txt"]);
  const redo = await f.store.restore(f.chatId, { token: back.token, decisions: decisions(back), approved: true });
  assert.equal(redo.redo, true);
  assert.equal(redo.restored, 2);
  assert.equal(await f.read("a.txt"), "agent edit\n");
  assert.equal(await f.read("new.txt"), "agent new\n");
});
test("a file over 5 MiB stays out of the checkpoint instead of failing the capture", async (t) => {
  const f = await fixture(t);
  await f.write("recording.mov", Buffer.alloc(5 * 1024 * 1024 + 1));
  const item = await f.store.begin({ chatId: f.chatId, roots: [f.root] });
  assert.equal(item.excluded, 1);
  await f.write("a.txt", "agent edit\n");
  await f.write("recording.mov", "agent");
  await f.store.finish(f.chatId);
  const preview = await f.store.preview(f.chatId, item.id);
  assert.deepEqual(
    preview.files.map((file) => file.path),
    ["a.txt"],
  );
});
test("past the size budget the largest files stay out, and a Chat's Worktrees share one budget", async (t) => {
  const f = await fixture(t);
  const other = path.join(path.dirname(f.root), "other");
  await fs.mkdir(other);
  execFileSync("git", ["init", "-q", other]);
  // a.txt holds 10 bytes. The 80-byte asset sorts before the source file, yet the source is the one an agent edits.
  await f.write("assets.bin", "x".repeat(80));
  await f.write("src.txt", "y".repeat(20));
  await fs.writeFile(path.join(other, "notes.txt"), "z".repeat(75));
  const store = createCheckpoints({ ...f.options, budget: 100 });
  const item = await store.begin({ chatId: f.chatId, roots: [f.root, other] });
  // 30 bytes fit from the first Worktree; the second gets the 70 left, short of its 75-byte file.
  assert.equal(item.excluded, 2);
  for (const name of ["a.txt", "assets.bin", "src.txt"]) await f.write(name, "agent");
  await fs.writeFile(path.join(other, "notes.txt"), "agent");
  await store.finish(f.chatId);
  const preview = await store.preview(f.chatId, item.id);
  assert.deepEqual(preview.files.map((file) => file.path).toSorted(), ["a.txt", "src.txt"]);
});
test("an undo saves its recovery copy of the files it writes, however full the Worktree is", async (t) => {
  const f = await fixture(t);
  const store = createCheckpoints({ ...f.options, budget: 100 });
  const item = await store.begin({ chatId: f.chatId, roots: [f.root] });
  await f.write("a.txt", "agent edit\n");
  await store.finish(f.chatId);
  // Smaller files written since would take the whole budget ahead of a.txt.
  for (let n = 0; n < 10; n++) await f.write(`note-${n}.txt`, "x".repeat(10));
  const preview = await store.preview(f.chatId, item.id);
  const result = await store.restore(f.chatId, { token: preview.token, decisions: decisions(preview), approved: true });
  assert.equal(result.restored, 1);
  assert.equal(await f.read("a.txt"), "committed\n");
  const back = await store.preview(f.chatId, result.recoveryId);
  await store.restore(f.chatId, { token: back.token, decisions: decisions(back), approved: true });
  assert.equal(await f.read("a.txt"), "agent edit\n");
});
test("a later capture reads again every file whose stamp moved", async (t) => {
  const f = await fixture(t);
  const manifest = async (id) => JSON.parse(await fs.readFile(path.join(f.options.directory, id, "manifest.json"), "utf8"));
  const past = new Date(Date.now() - 60_000);
  for (const name of ["kept.txt", "same-size.txt", "fresh.txt"]) await f.write(name, `${name}\n`);
  for (const name of ["kept.txt", "same-size.txt"]) await fs.utimes(path.join(f.root, name), past, past);
  const first = await f.store.begin({ chatId: f.chatId, roots: [f.root] });
  await f.store.finish(f.chatId);
  const before = (await manifest(first.id)).before[0].files;
  // Same size and mtime put back, but a new ctime: read again. A file written just before the last scan is too.
  await f.write("same-size.txt", "same-sizE.txt\n");
  await fs.utimes(path.join(f.root, "same-size.txt"), past, past);
  await f.write("fresh.txt", "fresh.txT\n");
  const second = await f.store.begin({ chatId: f.chatId + "x", roots: [f.root] });
  await f.store.finish(f.chatId + "x");
  const after = (await manifest(second.id)).before[0].files;
  assert.deepEqual(after["kept.txt"], before["kept.txt"]);
  assert.notEqual(after["same-size.txt"].hash, before["same-size.txt"].hash);
  assert.notEqual(after["fresh.txt"].hash, before["fresh.txt"].hash);
});
test("a scan trusts a file's unchanged stamp and reads it again once any stamp field moves", async (t) => {
  const f = await fixture(t);
  const blobs = path.join(path.dirname(f.root), "blobs");
  const scan = (known) => {
    const stat = require("node:fs").statSync(f.root);
    const request = {
      op: "scan",
      root: f.root,
      identity: { dev: stat.dev, ino: stat.ino },
      names: ["a.txt", "new.txt"],
      blobDirectory: blobs,
      known,
      racyMs: 0,
    };
    const out = execFileSync(process.execPath, [path.join(__dirname, "checkpoint-files.cjs")], {
      cwd: f.root,
      input: JSON.stringify(request),
      encoding: "utf8",
    });
    return JSON.parse(out).result;
  };
  await f.write("new.txt", "new\n");
  const first = scan();
  assert.ok(first.stamps["a.txt"] && first.stamps["new.txt"]);
  // A planted entry with the file's own stamp is taken as it is, without reading the file.
  const planted = first.files["new.txt"].hash;
  const second = scan({ "a.txt": [...first.stamps["a.txt"].slice(0, 5), planted, first.stamps["a.txt"][6]] });
  assert.equal(second.files["a.txt"].hash, planted);
  // One stamp field off, and the file is read.
  const third = scan({ "a.txt": [first.stamps["a.txt"][0] + 1, ...first.stamps["a.txt"].slice(1, 5), planted, first.stamps["a.txt"][6]] });
  assert.equal(third.files["a.txt"].hash, first.files["a.txt"].hash);
});
