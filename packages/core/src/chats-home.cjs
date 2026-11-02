const fs = require("node:fs");
const path = require("node:path");
const { createGit } = require("./git/client.cjs");
const { isFolderChatsHome, createFolderChatsHome } = require("./chats-home-folders.cjs");

// The Chats home: one internal Git repository per computer (<root>, ~/.milagre/chats). A Chat started without a Project
// runs in a Milagre Worktree of it, so it gets the same isolation and diff as any other Chat. It holds no files of its
// own, only the empty commit the Worktrees branch from.

// The empty commit is the home's, not the user's: no identity of theirs, no signing prompt.
const COMMIT_CONFIG = Object.freeze(["user.name=Milagre", "user.email=milagre@localhost", "commit.gpgsign=false"]);

const realOrResolved = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/** `git` is the runtime's helper; a test or caller without one gets its own. */
function createChatsHome({ root, git = createGit() }) {
  const home = path.resolve(root);
  let inFlight = null;

  // Checked by its own .git: inside another repository, rev-parse alone would find that one's HEAD.
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

  // Concurrent callers share one run. Nothing is kept once it settles, so a home deleted while the daemon runs is made
  // again by the next call, and a failure is retried.
  function ensure() {
    inFlight ??= make().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return Object.freeze({
    // What ensure() returns: the real path once the folder exists, so a symlinked root reads the same either way.
    get path() {
      return realOrResolved(home);
    },
    exists,
    ensure,
    isHome: (candidate) => typeof candidate === "string" && candidate !== "" && realOrResolved(candidate) === realOrResolved(home),
  });
}

module.exports = { createChatsHome };
