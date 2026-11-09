const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { readMedia, MAX_MEDIA, scopeRootsVia } = require("./media-access.cjs");

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);

async function scope(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "media-access-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  const dataDir = path.join(root, "data");
  await fs.mkdir(path.join(project, ".milagre", "images"), { recursive: true });
  await fs.mkdir(path.join(root, "home", ".ssh"), { recursive: true });
  await fs.mkdir(dataDir);
  await fs.writeFile(path.join(project, ".milagre", "images", "shot.png"), PNG);
  await fs.writeFile(path.join(project, "fake.png"), "not an image at all");
  await fs.writeFile(path.join(root, "home", ".ssh", "id_rsa.png"), "-----BEGIN OPENSSH PRIVATE KEY-----");
  await fs.writeFile(path.join(root, "shared.png"), PNG);
  await fs.symlink(path.join(root, "home", ".ssh", "id_rsa.png"), path.join(project, "link.png"));
  const big = await fs.open(path.join(project, "big.png"), "w");
  await big.write(PNG, 0, PNG.length, 0);
  await big.truncate(MAX_MEDIA + 1);
  await big.close();
  const options = {
    dataDir,
    scopeRoots: async () => [project],
    // As project:chat-image: an image a reply shared is copied into .milagre/images and that copy is served.
    chatImage: async (_scope, requested) => (requested === path.join(root, "shared.png") ? path.join(project, ".milagre", "images", "shot.png") : null),
  };
  return { root, project, options };
}

test("an image a scope's chat shows is read with its type, by the phone's rules", async (t) => {
  const { project, root, options } = await scope(t);
  const read = await readMedia({ scope: project, path: path.join(project, ".milagre", "images", "shot.png") }, options);
  assert.deepEqual({ type: read.type, size: read.size }, { type: "image/png", size: PNG.length });
  assert.deepEqual(Buffer.from(read.base64, "base64"), PNG);
  assert.equal((await readMedia({ scope: project, path: path.join(root, "shared.png") }, options)).type, "image/png", "an image a reply shared");
});

test("anything the phone can't get is refused, and no bytes leave", async (t) => {
  const { project, root, options } = await scope(t);
  const refused = async (request, code) => assert.rejects(readMedia(request, options), { code }, JSON.stringify(request));
  await refused({ scope: project, path: path.join(root, "home", ".ssh", "id_rsa.png") }, "NOT_SERVED");
  await refused({ scope: project, path: path.join(project, "link.png") }, "NOT_SERVED");
  await refused({ scope: project, path: path.join(project, "fake.png") }, "NOT_AN_IMAGE");
  await refused({ scope: project, path: path.join(project, "notes.txt") }, "NOT_AN_IMAGE");
  await refused({ scope: project, path: path.join(project, "big.png") }, "TOO_LARGE");
  await refused({ scope: project, path: path.join(project, ".milagre", "images", "gone.png") }, "NOT_FOUND");
  await refused({ scope: project, path: "shot.png" }, "BAD_REQUEST");
  await refused({ scope: "relative", path: path.join(project, "x.png") }, "BAD_REQUEST");
});

test("a Chat's images ask for their scope's Worktrees once, and a Worktree made since is still served", async (t) => {
  const { project, root, options } = await scope(t);
  const worktree = path.join(root, "worktree");
  await fs.mkdir(worktree);
  await fs.writeFile(path.join(worktree, "new.png"), PNG);
  let clock = 0;
  let worktrees = [project];
  const asked = [];
  const scopeRoots = scopeRootsVia({
    dataDir: options.dataDir,
    now: () => clock,
    call: async (method, args) => {
      asked.push([method, ...args]);
      return [...worktrees];
    },
  });
  const read = (file) => readMedia({ scope: project, path: file }, { ...options, scopeRoots });
  const images = await Promise.all(Array.from({ length: 30 }, () => read(path.join(project, ".milagre", "images", "shot.png"))));
  assert.equal(images.length, 30);
  assert.deepEqual(asked, [["project:worktree-paths", project]], "30 reads, one question");
  // The scope gains a Worktree: an image there is not among the kept folders, so they are read again before refusing.
  worktrees = [project, worktree];
  assert.equal((await read(path.join(worktree, "new.png"))).type, "image/png");
  assert.equal(asked.length, 2);
  await read(path.join(worktree, "new.png"));
  assert.equal(asked.length, 2, "and kept again");
  // A Worktree gone is out of the folders once the kept answer ages.
  worktrees = [project];
  clock += 5000;
  await assert.rejects(read(path.join(worktree, "new.png")), { code: "NOT_SERVED" });
  // What is refused is refused on fresh folders, every time.
  await assert.rejects(read(path.join(root, "home", ".ssh", "id_rsa.png")), { code: "NOT_SERVED" });
  await assert.rejects(read(path.join(project, "link.png")), { code: "NOT_SERVED" });
  assert.ok(asked.length >= 5, "each refusal asked again");
});

test("a scope's Worktrees that couldn't be read are not kept", async (t) => {
  const { project, options } = await scope(t);
  let failing = true;
  let asked = 0;
  const scopeRoots = scopeRootsVia({
    dataDir: options.dataDir,
    call: async () => {
      asked++;
      if (failing) throw new Error("Open the project before reading its worktrees.");
      return [project];
    },
  });
  assert.deepEqual(await scopeRoots(project), []);
  failing = false;
  assert.deepEqual(await scopeRoots(project), [project]);
  assert.deepEqual(await scopeRoots(project), [project]);
  assert.equal(asked, 2);
});
