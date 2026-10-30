const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createRuntime } = require("./runtime.cjs");

function temporary(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "milagre-clean-machine-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("Install accepts an omitted version after the daemon JSON round trip and still rejects invalid versions", async (t) => {
  const root = temporary(t);
  const calls = [];
  const runtime = createRuntime({
    dataDir: root,
    cwd: root,
    chatsHome: path.join(root, "chats"),
    environmentReady: Promise.resolve(),
    titleModels: {},
    agentCliStatus: async () => ({ claude: { state: "ready" }, codex: { state: "ready" } }),
    runCliUpdate: async (provider, options) => {
      calls.push([provider, options.targetVersion]);
      return { ok: true };
    },
  });
  t.after(() => runtime.close());
  for (const provider of ["claude", "codex"]) {
    const args = JSON.parse(JSON.stringify([provider, undefined]));
    assert.equal((await runtime.invoke("agent:update-cli", args)).ok, true);
  }
  assert.deepEqual(calls, [
    ["claude", undefined],
    ["codex", undefined],
  ]);
  for (const invalid of ["", "latest", "1.2", {}, 0]) await assert.rejects(runtime.invoke("agent:update-cli", ["codex", invalid]), /Invalid provider version/);
  await runtime.invoke("agent:update-cli", ["codex", "1.2.3"]);
  assert.deepEqual(calls.at(-1), ["codex", "1.2.3"]);
});

test("a computer without Git can Skip, create isolated Chat folders, relaunch and open Start from scratch", (t) => {
  const root = temporary(t);
  const script = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs/promises');
    const path = require('node:path');
    const {createRuntime} = require(${JSON.stringify(require.resolve("./runtime.cjs"))});
    const {createOnboardingProjects} = require(${JSON.stringify(require.resolve("./onboarding-projects.cjs"))});
    const {resolveProject} = require(${JSON.stringify(require.resolve("./project-identity.cjs"))});
    const root = process.argv[1];
    const options = {dataDir:path.join(root,'profile'), cwd:root, chatsHome:path.join(root,'chats'), environmentReady:Promise.resolve(), titleModels:{}, onboardingProjects:createOnboardingProjects({root:path.join(root,'projects')})};
    (async () => {
      let runtime = createRuntime(options);
      try {
        const home = await runtime.invoke('chats:ensure');
        assert.equal(home.git, false);
        assert.equal(home.kind, 'chats');
        const first = await runtime.invoke('worktree:create', [{projectPath:home.path, baseBranch:'', prompt:'one'}]);
        const second = await runtime.invoke('worktree:create', [{projectPath:home.path, baseBranch:'', prompt:'two'}]);
        const firstPath = first.project.state.worktrees[first.worktreeId].path;
        const secondPath = second.project.state.worktrees[second.worktreeId].path;
        assert.notEqual(firstPath, secondPath);
        await fs.writeFile(path.join(firstPath,'saved.txt'),'keep');
        await runtime.close();
        runtime = createRuntime(options);
        const restored = await runtime.invoke('project:current');
        assert.equal(restored.kind, 'chats');
        assert.ok(Object.values(restored.state.worktrees).some(w=>w.path===firstPath));
        assert.equal(await fs.readFile(path.join(firstPath,'saved.txt'),'utf8'),'keep');
        assert.deepEqual(await fs.readdir(secondPath), []);
        const plain = await runtime.invoke('onboarding:create',['Notes']);
        assert.equal(plain.git, false);
        assert.equal(plain.name, 'Notes');
        // A missing Git executable must never disguise an existing checkout as a plain folder.
        await fs.mkdir(path.join(root,'repo','.git'),{recursive:true});
        await fs.mkdir(path.join(root,'repo','child'));
        await assert.rejects(resolveProject(path.join(root,'repo')), /git/);
        await assert.rejects(resolveProject(path.join(root,'repo','child')), /git/);
      } finally { await runtime.close(); }
    })().then(()=>process.exit(0), e=>{console.error(e);process.exit(1)});
  `;
  const result = spawnSync(process.execPath, ["-e", script, root], {
    env: { ...process.env, PATH: path.join(root, "no-executables") },
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
