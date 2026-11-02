const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createGit } = require("./git/client.cjs");
const { plainFolder } = require("./recent-projects.cjs");

// Onboarding's ways to a first Project besides opening a folder: a new folder in ~/Code, a clone of a repository, or
// Git set up in a folder that has none. Each answers with the folder to open; the renderer opens it like any other.
const git = createGit().write;

function folderName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > 100 || /[/\\:]/.test(name) || name === "." || name === ".." || name.startsWith("."))
    throw new Error("Use a folder name without slashes, colons or a leading dot.");
  return name;
}

async function freeFolder(folder) {
  try {
    await fs.access(folder);
  } catch {
    return folder;
  }
  throw new Error(`${folder} already exists. Choose another name.`);
}

// A first commit gives Worktrees a base. It needs the user's Git identity, which is never made up: without one the
// folder still has Git and the first commit is left for later.
async function firstCommit(folder) {
  await git.checked(folder, ["add", "-A"]);
  const result = await git.run(folder, ["commit", "--allow-empty", "-m", "Start with Milagre"], { profile: "COMMIT" });
  return result.ok;
}

const NO_GIT = "Git isn't installed on this computer. Install it from https://git-scm.com, then try again.";

function createOnboardingProjects({ root = path.join(os.homedir(), "Code"), plain = plainFolder, writer = git } = {}) {
  return {
    root,
    /** A new, empty folder under ~/Code with Git set up. Without Git on this computer it stays a plain folder. */
    async create(name) {
      const folder = await freeFolder(path.join(root, folderName(name)));
      await fs.mkdir(folder, { recursive: true });
      const init = await writer.run(folder, ["init"]);
      if (init.ok) await firstCommit(folder);
      else if (!init.missing) throw new Error(`Git couldn't set up ${folder}: ${init.message}`);
      return { path: folder };
    },
    /** A clone of `url` into ~/Code/<repository name>. */
    async clone(url) {
      const source = typeof url === "string" ? url.trim() : "";
      if (!/^(https:\/\/|ssh:\/\/|git@)[^\s]+$/.test(source)) throw new Error("Paste an https:// or git@ address of a repository.");
      const folder = await freeFolder(path.join(root, folderName(path.basename(source.replace(/\/+$/, "")).replace(/\.git$/, ""))));
      await fs.mkdir(root, { recursive: true });
      const result = await writer.run(root, ["clone", "--", source, folder], { profile: "NETWORK" });
      if (result.missing) throw new Error(NO_GIT);
      if (!result.ok) {
        await fs.rm(folder, { recursive: true, force: true }).catch(() => {});
        throw new Error(`Git couldn't clone it: ${result.stderr.trim().split("\n").pop() || "check the address and your access."}`);
      }
      return { path: folder };
    },
    /** Git in a folder that has none, with its files as the first commit when the user's Git identity is set. */
    async initGit(folder) {
      if (!(await plain(folder))) throw new Error("That folder already has Git, or isn't a folder.");
      if (path.resolve(folder) === os.homedir()) throw new Error("Choose a project folder, not your home folder.");
      const init = await writer.run(folder, ["init"]);
      if (init.missing) throw new Error(NO_GIT);
      if (!init.ok) throw new Error(`Git couldn't set up ${folder}: ${init.message}`);
      return { path: folder, committed: await firstCommit(folder) };
    },
  };
}

module.exports = { createOnboardingProjects };
