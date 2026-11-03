const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { EditScopes, policyFor, violation, snapshot, editScopeToolDefinitions } = require("./edit-scopes.cjs");
async function fixture(t) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "edit-scope-")));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "work");
  await fs.mkdir(root);
  execFileSync("git", ["init", "-q", root]);
  const file = path.join(temporary, "state.json");
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src/allowed"), "original");
  await fs.writeFile(path.join(root, "protected"), "original");
  const policy = { allowed: [{ root, path: "src" }], protected: [{ root, path: "protected" }] };
  return { root, temporary, file, policy };
}
test("scope validation rejects escape paths and lets protected rules override allowed paths", async (t) => {
  const { root, policy } = await fixture(t);
  const all = { ...policy, allowed: [{ root, path: "." }] };
  assert.equal(violation(all, [root], "src/new", root), null);
  assert.match(violation(all, [root], "protected", root), /protected/);
  assert.match(violation(policy, [root], "other", root), /outside/);
  for (const name of ["../escape", "/absolute", "C:\\escape", "src/../../escape", ".git/config", "a\0b"])
    assert.throws(() => policyFor({ allowed: [{ root, path: name }], protected: [] }, [root]));
  assert.throws(() => policyFor(policy, [path.dirname(root)]));
  assert.equal(violation(null, [root], "../any", root), null);
});
test("symlinks cannot bypass protected targets or escape the owned root", { skip: process.platform === "win32" }, async (t) => {
  const { root, temporary, policy } = await fixture(t);
  await fs.symlink(path.join(root, "protected"), path.join(root, "src/alias"));
  assert.match(violation(policy, [root], "src/alias", root), /protected/);
  await fs.symlink(temporary, path.join(root, "src/out"));
  assert.match(violation(policy, [root], "src/out/new", root), /outside/);
  assert.throws(() => policyFor({ allowed: [{ root, path: "src/out/new" }], protected: [] }, [root]), /outside/);
  await fs.symlink(path.join(temporary, "missing"), path.join(root, "src/dangling"));
  assert.match(violation(policy, [root], "src/dangling", root), /outside/);
  assert.match(violation(policy, [root], "src/dangling/new", root), /outside/);
  assert.throws(() => policyFor({ allowed: [{ root, path: "src/dangling" }], protected: [] }, [root]), /outside/);
  await fs.symlink(path.join(root, "protected-missing"), path.join(root, "src/inside-dangling"));
  const missingPolicy = { allowed: [{ root, path: "." }], protected: [{ root, path: "protected-missing" }] };
  assert.match(violation(missingPolicy, [root], "src/inside-dangling", root), /protected/);
});
test("observation detects preexisting dirty edits, committed writes, deletions, untracked and ignored protected files", async (t) => {
  const { root, policy } = await fixture(t);
  await fs.writeFile(path.join(root, ".gitignore"), "ignored\n");
  await fs.writeFile(path.join(root, "ignored"), "secret");
  policy.protected.push({ root, path: "ignored" });
  execFileSync("git", ["-C", root, "add", "."]);
  const before = await snapshot([root], policy);
  assert.deepEqual(before.errors, []);
  await fs.writeFile(path.join(root, "protected"), "new dirty bytes");
  await fs.writeFile(path.join(root, "ignored"), "new ignored bytes");
  await fs.writeFile(path.join(root, "new"), "untracked");
  await fs.unlink(path.join(root, ".gitignore"));
  await fs.writeFile(path.join(root, "src/allowed"), "allowed bytes");
  const after = await snapshot([root], policy);
  assert.deepEqual(after.errors, []);
  for (const name of ["protected", "ignored", "new", ".gitignore"])
    assert.notEqual(before.files[JSON.stringify([root, name])], after.files[JSON.stringify([root, name])]);
  assert.equal(after.files[JSON.stringify([root, "src/allowed"])], undefined);
  assert.ok(!JSON.stringify(after).includes("new dirty bytes"));
  execFileSync("git", ["-C", root, "add", "protected"]);
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-qm",
    "During task",
  ]);
  const committed = await snapshot([root], policy);
  assert.notEqual(
    before.files[JSON.stringify([root, "protected"])],
    committed.files[JSON.stringify([root, "protected"])],
    "committing a write cannot hide its content change",
  );
  await fs.rename(path.join(root, "new"), path.join(root, "renamed"));
  const renamed = await snapshot([root], policy);
  assert.equal(renamed.files[JSON.stringify([root, "new"])], undefined);
  assert.equal(renamed.files[JSON.stringify([root, "renamed"])], after.files[JSON.stringify([root, "new"])]);
});
test("scope changes need an idle Chat, matching revision and explicit expansion approval", async (t) => {
  const { file, root, policy } = await fixture(t);
  let busy = false;
  const scopes = new EditScopes({ file, roots: async () => [root], busy: () => busy, pollMs: 60000 });
  t.after(() => scopes.close());
  await scopes.save("chat", 0, policy);
  busy = true;
  await assert.rejects(scopes.save("chat", 1, null), /Stop/);
  busy = false;
  await scopes.begin("chat", [root]);
  const proposal = { allowed: [{ root, path: "." }], protected: policy.protected };
  await scopes.request("chat", proposal, "Need another file");
  assert.match(scopes.check("chat", ["other"], root), /outside/);
  const first = await scopes.read("chat");
  await assert.rejects(scopes.resolve("chat", "wrong", true), /current/);
  await scopes.resolve("chat", first.pending.id, true);
  assert.match(scopes.check("chat", ["other"], root), /outside/, "approval cannot change the running turn");
  await scopes.observe("chat", true);
  await scopes.begin("chat", [root]);
  assert.equal(scopes.check("chat", ["other"], root), null);
  assert.match(scopes.check("chat", ["protected"], root), /protected/);
  await scopes.observe("chat", true);
  await assert.rejects(scopes.save("chat", 1, null), /changed/);
  const current = await scopes.read("chat");
  await scopes.save("chat", current.revision, null);
  assert.equal(scopes.check("chat", ["protected"], root), null);
});
test("warnings and pending requests survive restart, with honest interrupted-observation status", async (t) => {
  const { file, root, policy } = await fixture(t);
  const scopes = new EditScopes({ file, roots: async () => [root], pollMs: 60000 });
  t.after(() => scopes.close());
  await scopes.save("chat", 0, policy);
  await scopes.begin("chat", [root]);
  await scopes.request("chat", policy, "More paths");
  await fs.writeFile(path.join(root, "protected"), "changed");
  await scopes.observe("chat");
  assert.equal((await scopes.read("chat")).warnings[0].kind, "outside");
  await scopes.begin("chat", [root]);
  const next = new EditScopes({ file, roots: async () => [root], pollMs: 60000 });
  t.after(() => next.close());
  const view = await next.read("chat");
  assert.ok(view.pending);
  assert.ok(view.warnings.some((w) => /restart/.test(w.message)));
  await next.resolve("chat", view.pending.id, false);
  assert.equal((await next.read("chat")).pending, undefined);
});
test("observation failures never turn into a clean result; tools are bound to one Chat and cannot approve", async (t) => {
  const { file, root, policy } = await fixture(t);
  const scopes = new EditScopes({ file, roots: async () => [root], pollMs: 60000, capture: async () => ({ files: {}, errors: ["read failed"] }) });
  t.after(() => scopes.close());
  await scopes.save("parent", 0, policy);
  await scopes.begin("parent", [root]);
  assert.ok((await scopes.read("parent")).warnings.some((w) => w.kind === "incomplete"));
  assert.match(scopes.check("parent", [], root), /could not/);
  const tools = editScopeToolDefinitions("parent", scopes);
  assert.deepEqual(
    tools.map((t) => t.name),
    ["edit_scope_request", "edit_scope_read"],
  );
  await tools[0].run({ ...policy, reason: "Need file" });
  assert.ok((await scopes.read("parent")).pending);
  assert.equal((await scopes.read("other")).pending, undefined);
});

test("a protected alias also protects its target, and scope spans only explicitly owned roots", { skip: process.platform === "win32" }, async (t) => {
  const { root, temporary } = await fixture(t);
  const other = path.join(temporary, "other");
  await fs.mkdir(other);
  await fs.symlink(path.join(root, "protected"), path.join(root, "alias"));
  const policy = policyFor(
    {
      allowed: [
        { root, path: "." },
        { root: other, path: "." },
      ],
      protected: [{ root, path: "alias" }],
    },
    [root, other],
  );
  assert.match(violation(policy, [root, other], "protected", root), /protected/);
  assert.equal(violation(policy, [root, other], path.join(other, "new"), root), null);
  assert.match(violation(policy, [root], path.join(other, "new"), root), /outside/);
});
test("a new turn applies an approved scope even if the host is already preparing that turn", async (t) => {
  const { file, root, policy } = await fixture(t);
  let busy = true;
  const scopes = new EditScopes({ file, roots: async () => [root], busy: () => busy, pollMs: 60000 });
  t.after(() => scopes.close());
  busy = false;
  await scopes.save("chat", 0, policy);
  await scopes.begin("chat", [root]);
  busy = true;
  await scopes.request("chat", { ...policy, allowed: [{ root, path: "." }] }, "Need more");
  await scopes.resolve("chat", (await scopes.read("chat")).pending.id, true);
  await scopes.begin("chat", [root], true);
  assert.match(scopes.check("chat", ["other"], root), /outside/, "steering retains the frozen scope");
  await scopes.begin("chat", [root], false);
  assert.equal(scopes.check("chat", ["other"], root), null, "a new task boundary applies approval");
});
test("failed observation stays visibly incomplete and retries without claiming success", async (t) => {
  const { file, root, policy } = await fixture(t);
  let fail = false;
  const scopes = new EditScopes({
    file,
    roots: async () => [root],
    pollMs: 60000,
    capture: async () => {
      if (fail) throw Error("disk unavailable");
      return { files: {}, errors: [] };
    },
  });
  t.after(() => scopes.close());
  await scopes.save("chat", 0, policy);
  await scopes.begin("chat", [root]);
  fail = true;
  await assert.rejects(scopes.observe("chat"), /disk unavailable/);
  assert.ok((await scopes.read("chat")).warnings.some((w) => w.kind === "incomplete" && /disk unavailable/.test(w.message)));
  fail = false;
  await scopes.observe("chat");
  assert.equal((await scopes.read("chat")).monitoring, false);
});
