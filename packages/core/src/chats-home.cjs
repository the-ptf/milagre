const fs = require("node:fs");
const path = require("node:path");
const { createGit } = require("./git/client.cjs");
const { isFolderChatsHome, createFolderChatsHome } = require("./chats-home-folders.cjs");

const COMMIT_CONFIG = Object.freeze(["user.name=Milagre", "user.email=milagre@localhost", "commit.gpgsign=false"]);

const realOrResolved = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

function createChatsHome({ root, git = createGit() }) {
  const home = path.resolve(root);
  let inFlight = null;

  const hasGit = () =>
    fs.promises.stat(path.join(home, ".git")).then(
      () => true,
      () => false,
    );
  const exists = async () => (await hasGit()) || (await isFolderChatsHome(home));

  async function make() {
    await fs.promises.mkdir(home, { recursive: true });
    const real = await fs.promises.realpath(home);
    if (await isFolderChatsHome(real)) return real;
    if (!(await hasGit())) {
      try {
        await git.write.checked(real, ["init", "-b", "main"]);
      } catch (error) {
        if (!error.missing) throw error;
        await createFolderChatsHome(real);
        return real;
      }
    }
    if (!(await git.refExists(real, "HEAD")))
      await git.write.checked(real, ["commit", "--allow-empty", "-m", "Chats home"], { profile: "COMMIT", config: COMMIT_CONFIG });
    return real;
  }

  function ensure() {
    inFlight ??= make().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return Object.freeze({
    get path() {
      return realOrResolved(home);
    },
    exists,
    ensure,
    isHome: (candidate) => typeof candidate === "string" && candidate !== "" && realOrResolved(candidate) === realOrResolved(home),
  });
}

module.exports = { createChatsHome };
