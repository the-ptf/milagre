const fs = require("node:fs/promises");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createProjectRegistry } = require("../../../packages/core/src/project-registry.cjs");
const { createRecentProjects } = require("../../../packages/core/src/recent-projects.cjs");
const { inspectProject } = require("../../../packages/core/src/project-identity.cjs");
const { createLinkWorkspaces } = require("../../../packages/core/src/link-workspaces.cjs");
const links = require("../../../packages/core/src/project-links.cjs");
const groups = require("../../../packages/core/src/project-groups.cjs");
const scopes = require("../../../packages/shared/src/chat-scopes.mjs");
(async () => {
  const root = await fs.realpath(process.argv[2]);
  const cases = [];
  const run = async (kind, args, fn) => {
    try {
      cases.push({ kind, args, result: await fn() });
    } catch (error) {
      cases.push({ kind, args, error: error.message });
    }
  };
  const git = (cwd, ...args) =>
    execFileSync("/usr/bin/git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@invalid", "-c", "commit.gpgsign=false", ...args], {
      cwd,
      env: { PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"],
    });
  const plain = path.join(root, "plain"),
    repo = path.join(root, "repo"),
    worktree = path.join(root, "branch"),
    home = path.join(root, "home"),
    profile = path.join(root, "profile");
  for (const p of [plain, repo, home, profile]) await fs.mkdir(p);
  git(repo, "init", "-b", "main");
  git(repo, "commit", "--allow-empty", "-m", "fixture");
  git(repo, "worktree", "add", "-b", "branch", "--", worktree);
  await fs.mkdir(path.join(repo, "nested"));
  await fs.symlink(repo, path.join(root, "alias"));
  await fs.writeFile(path.join(home, ".milagre-folder-chats"), "1\n");
  for (const name of ["chat-12345678-1234-1234-1234-123456789abc", "chat-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "chat-invalid", "other"])
    await fs.mkdir(path.join(home, ".chat-folders", name), { recursive: true });
  await fs.symlink(plain, path.join(home, ".chat-folders", "chat-11111111-1111-1111-1111-111111111111"));
  for (const p of [plain, repo, worktree, path.join(repo, "nested"), path.join(root, "alias"), home])
    await run("identify", { path: p }, () => inspectProject(p));
  const ids = await Promise.all([repo, plain, home].map(async (p) => (await inspectProject(p)).identity));
  const linkId = "12345678-1234-1234-1234-123456789abc";
  const original = {
    scanned: true,
    projects: ids,
    links: [{ id: "canonical-edge", a: { project_id: ids[0].id }, b: { project_id: ids[1].id } }],
    projectGroups: [{ id: linkId, name: "Pair", projectIds: ids.slice(0, 2).map((p) => p.id) }],
    worktreePositions: { [ids[0].id]: { [worktree]: { x: 1, y: 2 } } },
  };
  const variants = [
    original,
    null,
    {},
    [],
    { projects: "bad" },
    {
      projects: [...ids, ids[0], {}, null, { id: "relative", path: plain }, { id: plain, path: "relative" }],
      links: [{ id: "raw" }],
      projectGroups: [...original.projectGroups, { id: "bad", name: "x", projectIds: ["a", "b"] }],
      worktreePositions: [],
    },
    { projects: [], links: null, projectGroups: "bad", worktreePositions: null },
  ];
  for (let i = 0; i < variants.length; i++) {
    const dir = path.join(root, `profile-${i}`);
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "project-registry.json"), JSON.stringify(variants[i]));
    await run("snapshot", { profile: dir }, () => createProjectRegistry(path.join(dir, "project-registry.json"), { roots: [] }).snapshot());
  }
  for (const [suffix, body] of [
    ["missing", null],
    ["corrupt", "{bad"],
  ]) {
    const dir = path.join(root, `profile-${suffix}`);
    await fs.mkdir(dir);
    if (body) await fs.writeFile(path.join(dir, "project-registry.json"), body);
    await run("snapshot", { profile: dir }, () => createProjectRegistry(path.join(dir, "project-registry.json"), { roots: [] }).snapshot());
  }
  await fs.writeFile(path.join(profile, "project-registry.json"), JSON.stringify(original));
  const admittedActive = Object.fromEntries(
    await Promise.all(ids.map(async (identity) => [identity.id, (await inspectProject(identity.path)).worktrees.map((tree) => tree.path)])),
  );
  for (const [project, sourceWorktree] of [
    [repo, repo],
    [repo, worktree],
    [plain, plain],
  ])
    await run("reachable", { profile, project, worktree: sourceWorktree }, async () =>
      links.linkedWorktrees({ project_id: (await inspectProject(project)).identity.id, worktree_path: sourceWorktree }, original.links, admittedActive),
    );
  const recent = [
    { path: plain, name: "Custom", openedAt: "yesterday" },
    { path: plain + "/./", name: "Duplicate" },
    { path: repo + "/nested/.." },
    { path: worktree },
    { path: path.join(root, "missing") },
    { path: "relative" },
    null,
  ];
  await fs.writeFile(path.join(profile, "recent-projects.json"), JSON.stringify(recent));
  await run("recent", { profile }, () => createRecentProjects(path.join(profile, "recent-projects.json")).list());
  const manager = createLinkWorkspaces({
    store: {},
    registry: createProjectRegistry(path.join(profile, "project-registry.json"), { roots: [] }),
    ownProject: async () => {
      throw Error("No owner writes in read fixture");
    },
  });
  for (const group of [original.projectGroups[0], { id: linkId, name: "Missing", projectIds: [ids[0].id, path.join(root, "absent", ".git")] }])
    await run("members", { profile, group }, () => manager.membersAvailable(group));
  const projects = [{ id: "a" }, { id: "b" }, { id: "c" }],
    active = { a: ["/a/main", "/a/other"], b: ["/b/main", "/b/other"], c: ["/c/main"] };
  const endpoints = [
    { project_id: "a" },
    { project_id: "a", worktree_path: "/a/main" },
    { project_id: "a", worktree_path: "/a/other" },
    { project_id: "b" },
    { project_id: "b", worktree_path: "/b/main" },
    { project_id: "b", worktree_path: "/missing" },
    { project_id: "x" },
    { project_id: "a", worktree_path: null },
  ];
  for (const a of endpoints) for (const b of endpoints) await run("canLink", { a, b, projects, active }, () => links.canLink(a, b, projects, active));
  const edges = [
    { id: "one", a: endpoints[0], b: endpoints[3] },
    { id: "two", a: endpoints[1], b: endpoints[4] },
    { id: "three", a: endpoints[1], b: endpoints[2] },
    { id: "four", a: endpoints[4], b: { project_id: "c" } },
    { id: "stale", a: endpoints[0], b: endpoints[5] },
  ];
  for (const source of endpoints) await run("linked", { source, links: edges, active }, () => links.linkedWorktrees(source, edges, active));
  await run("prune", { links: edges, projects, active }, () => links.pruneLinks(edges, projects, active));
  for (const group of [
    original.projectGroups[0],
    { id: linkId, name: " ", projectIds: ["a", "b"] },
    { id: linkId, name: "\ufeff", projectIds: ["a", "b"] },
    { id: linkId, name: "\u0085", projectIds: ["a", "b"] },
    { id: linkId.toUpperCase(), name: "Unicode", projectIds: ["a", "b"] },
    { id: linkId, name: "x", projectIds: ["a", "a"] },
    null,
    {},
  ])
    await run("validGroup", { group }, () => groups.validProjectGroup(group) || false);
  const keys = [
    "/repo",
    "/repo#2",
    `milagre-link:${linkId}`,
    `milagre-link:remote|${linkId}`,
    `milagre-link:local|${linkId}`,
    "remote|/repo",
    "local|/repo",
    "bad id|/repo",
    "C:\\repo",
    null,
    23,
    "relative",
    "milagre-link:bad",
  ];
  for (const key of keys) {
    await run("scopeFromKey", { key }, () => scopes.scopeFromKey(key));
    await run("isLink", { key }, () => scopes.isLinkScopeKey(key));
    await run("computer", { key }, () => scopes.computerOfKey(key));
    await run("unqualify", { key }, () => scopes.unqualifyKey(key));
    await run("scopeFromChat", { key }, () => scopes.scopeFromChatKey(key));
    for (const computer of ["local", "remote", "bad id", true, 42, 0, null, ["remote"], {}])
      await run("qualify", { computer, key }, () => scopes.qualifyKey(computer, key));
  }
  for (const scope of [
    { kind: "project", projectPath: repo },
    { kind: "project", projectPath: "remote|/repo" },
    { kind: "link", linkId },
    { kind: "link", linkId: `remote|${linkId}` },
    { kind: "link", linkId: "bad" },
    {},
  ]) {
    await run("scopeKey", { scope }, () => scopes.scopeKey(scope));
    for (const id of [1, 0, -1, 1.5, 9007199254740991, 9007199254740992, "2"]) await run("chatKey", { scope, id }, () => scopes.chatKeyForScope(scope, id));
  }
  await fs.writeFile(path.join(root, "cases.json"), JSON.stringify(cases));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
