const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { resolveProjectImage, githubOwner } = require("./project-image.cjs");

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const photo = (id, type = "User") => ({ type, avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4` });

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-project-image-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("recognizes GitHub HTTPS and SSH remotes without contacting other hosts", () => {
  for (const remote of [
    "https://github.com/acme/shop.git",
    "git@github.com:acme/shop.git",
    "ssh://git@github.com/acme/shop.git",
    "git@github.com-work:acme/shop.git",
    "ssh://git@github.com-work/acme/shop.git",
  ]) {
    assert.equal(githubOwner(remote), "acme");
  }
  assert.equal(githubOwner("https://github.com.evil.test/acme/shop.git"), null);
  assert.equal(githubOwner("git@gitlab.com:acme/shop.git"), null);
  assert.equal(githubOwner("git@github.com.evil.test:acme/shop.git"), null);
});

test("a folder without a remote shows the organization of the folders that speak for it", async (t) => {
  const root = await fixture(t);
  const remotes = { [path.join(root, "api")]: "git@github.com-work:acme/api.git" };
  const image = await resolveProjectImage(root, {
    related: [path.join(root, "docs"), path.join(root, "api")],
    readGit: async (folder) => {
      if (!remotes[folder]) throw new Error("no remote");
      return remotes[folder];
    },
    account: async (endpoint) => (endpoint === "users/acme" ? photo(1, "Organization") : photo(2)),
  });
  assert.equal(image, `${photo(1).avatar_url}&s=80`);
});

test("project image wins over organization and profile; configured icons are supported", async (t) => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, "brand.png"), PNG);
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ build: { mac: { icon: "brand.png" } } }));
  const image = await resolveProjectImage(root, {
    account: () => assert.fail("Project icons must not require GitHub"),
    readGit: () => assert.fail("No Git access needed"),
  });
  assert.equal(image, `data:image/png;base64,${PNG.toString("base64")}`);
  await fs.mkdir(path.join(root, ".milagre"));
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><circle cx="10" cy="10" r="10"/></svg>';
  await fs.writeFile(path.join(root, ".milagre/icon.svg"), svg);
  assert.equal(await resolveProjectImage(root), `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
});

test("organization avatar wins over the connected user", async (t) => {
  const root = await fixture(t);
  const calls = [];
  const image = await resolveProjectImage(root, {
    readGit: async () => "git@github.com:acme/shop.git",
    account: async (endpoint) => {
      calls.push(endpoint);
      return endpoint === "users/acme" ? photo(1, "Organization") : photo(2);
    },
  });
  assert.equal(image, "https://avatars.githubusercontent.com/u/1?v=4&s=80");
  assert.deepEqual(calls, ["users/acme"]);
});

test("web favicons are detected before any GitHub lookup", async (t) => {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2); // ICO type
  header.writeUInt16LE(1, 4); // One embedded PNG
  header[6] = 1;
  header[7] = 1;
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(PNG.length, 14);
  header.writeUInt32LE(22, 18);
  const ico = Buffer.concat([header, PNG]);
  for (const location of [
    "favicon.ico",
    "public/favicon.ico",
    "app/public/favicon.ico",
    "app/favicon.ico",
    "src/app/favicon.ico",
    "static/favicon.ico",
    "public/favicon.png",
    "src/app/icon.png",
  ]) {
    const root = await fixture(t);
    const file = path.join(root, location);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const data = location.endsWith(".ico") ? ico : PNG;
    await fs.writeFile(file, data);
    const image = await resolveProjectImage(root, {
      account: () => assert.fail("Favicon must win over GitHub avatars"),
      readGit: () => assert.fail("Favicon must not require Git"),
    });
    assert.equal(image, `data:${location.endsWith(".ico") ? "image/x-icon" : "image/png"};base64,${data.toString("base64")}`, location);
  }
});

test("explicit project image has priority over favicon", async (t) => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, "favicon.png"), PNG);
  await fs.writeFile(path.join(root, "logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  assert.match(await resolveProjectImage(root), /^data:image\/svg\+xml;base64,/);
});

test("personal repositories use the connected GitHub profile", async (t) => {
  const root = await fixture(t);
  const image = await resolveProjectImage(root, {
    readGit: async () => "https://github.com/owner/shop.git",
    account: async (endpoint) => (endpoint === "user" ? photo(2) : photo(1)),
  });
  assert.equal(image, "https://avatars.githubusercontent.com/u/2?v=4&s=80");
});

test("no Git remote can still use the connected profile; offline results are empty", async (t) => {
  const root = await fixture(t);
  const readGit = async () => {
    throw new Error("Not a git repo");
  };
  assert.equal(await resolveProjectImage(root, { readGit, account: async () => photo(2) }), "https://avatars.githubusercontent.com/u/2?v=4&s=80");
  assert.equal(await resolveProjectImage(root, { readGit, account: async () => null }), null);
});

test("a personal owner provides the fallback when gh is not authenticated", async (t) => {
  const root = await fixture(t);
  assert.equal(
    await resolveProjectImage(root, {
      readGit: async () => "git@github.com:owner/shop.git",
      account: async (endpoint) => (endpoint === "user" ? null : photo(1)),
    }),
    "https://avatars.githubusercontent.com/u/1?v=4&s=80",
  );
});

test("ignores image paths outside the project and untrusted avatar URLs", async (t) => {
  const root = await fixture(t);
  const project = path.join(root, "project");
  await fs.mkdir(project);
  await fs.writeFile(path.join(root, "private.png"), PNG);
  await fs.writeFile(path.join(project, "package.json"), JSON.stringify({ build: { icon: "../private.png" } }));
  assert.equal(
    await resolveProjectImage(project, {
      readGit: async () => "git@github.com:owner/shop.git",
      account: async () => ({ type: "User", avatar_url: "http://localhost/private" }),
    }),
    null,
  );
});
