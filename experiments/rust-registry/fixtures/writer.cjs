const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
let ids = 0;
crypto.randomUUID = () => `00000000-0000-0000-0000-${String(++ids).padStart(12, "0")}`;
const { createProjectRegistry } = require("../../../packages/core/src/project-registry.cjs");
const { createRecentProjects } = require("../../../packages/core/src/recent-projects.cjs");
const { resolveProject, activeWorktrees } = require("../../../packages/core/src/project-identity.cjs");
(async () => {
  const request = JSON.parse(await fs.readFile(process.argv[2], "utf8"));
  const profile = request.profile;
  await fs.mkdir(profile);
  const registryFile = path.join(profile, "project-registry.json"),
    recentFile = path.join(profile, "recent-projects.json");
  for (const [file, seed] of [
    [registryFile, request.registry],
    [recentFile, request.recent],
  ])
    if (seed !== null) await fs.writeFile(file, seed);
  let clock = 0;
  const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++));
  const registry = createProjectRegistry(registryFile, { roots: [], now }),
    recent = createRecentProjects(recentFile, { now });
  const bytes = (file) =>
    fs.readFile(file, "utf8").catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  const inode = (file) =>
    fs.stat(file).then(
      (s) => s.ino,
      () => null,
    );
  const active = async () =>
    Object.fromEntries(
      await Promise.all(
        (await registry.snapshot()).projects.map(async (project) => [project.id, (await activeWorktrees(project.path)).map((tree) => tree.path)]),
      ),
    );
  const results = [];
  for (const { method, args } of request.operations) {
    const before = await Promise.all([inode(registryFile), inode(recentFile)]);
    let result, error;
    try {
      switch (method) {
        case "register":
          result = await registry.add(await resolveProject(args.path));
          break;
        case "position":
          result = await registry.setPosition(args.id, args.position);
          break;
        case "worktree-position":
          result = await registry.setWorktreePosition(args.id, args.path, args.position);
          break;
        case "group:create":
          result = await registry.createProjectGroup(args);
          break;
        case "group:update":
          result = await registry.updateProjectGroup(args);
          break;
        case "group:delete":
          result = await registry.deleteProjectGroup(args.id);
          break;
        case "link:add":
          result = await registry.addLink(args.a, args.b, await active());
          break;
        case "link:restore":
          result = await registry.restoreLink(args.link, await active());
          break;
        case "link:remove":
          result = await registry.removeLink(args.id);
          break;
        case "link:prune":
          result = await registry.pruneLinks(await active());
          break;
        case "recent:add":
          result = await recent.add(args.path);
          break;
        case "recent:forget":
          result = await recent.forget(args.path);
          break;
        default:
          throw Error(`Unknown fixture method ${method}`);
      }
    } catch (caught) {
      error = caught.message;
    }
    const after = await Promise.all([inode(registryFile), inode(recentFile)]);
    results.push({
      result: result === undefined ? { fixtureUndefined: true } : result,
      ...(error ? { error } : {}),
      registry: await bytes(registryFile),
      recent: await bytes(recentFile),
      changed: after.map((id, index) => id !== before[index]),
      clock,
      ids,
    });
  }
  await fs.writeFile(request.output, JSON.stringify(results));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
