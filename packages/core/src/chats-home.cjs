const fs = require("node:fs");
const path = require("node:path");
const { COMMIT_CONFIG } = require("./bots/home.cjs");

// The Chats home: one internal Git repository per computer (<root>, ~/.milagre/chats). A Chat started without a Project
// runs in a Milagre Worktree of it, so it gets the same isolation and diff as any other Chat. It holds no files of its
// own, only the empty commit the Worktrees branch from.

const realOrResolved = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/** `git` is the runtime's helper (createGit()), the one createBotHome uses. */
function createChatsHome({ root, git }) {
  const home = path.resolve(root);
  let inFlight = null;

  // Checked by its own .git: inside another repository, rev-parse alone would find that one's HEAD.
  const exists = () =>
    fs.promises.stat(path.join(home, ".git")).then(
      () => true,
      () => false,
    );

  async function make() {
    await fs.promises.mkdir(home, { recursive: true });
    const real = await fs.promises.realpath(home);
    if (!(await exists())) await git.write.checked(real, ["init", "-b", "main"]);
    if (!(await git.refExists(real, "HEAD")))
      await git.write.checked(real, ["commit", "--allow-empty", "-m", "Chats home"], { profile: "COMMIT", config: COMMIT_CONFIG });
    return real;
  }

  // Concurrent callers share one run; a failure is not kept, so the next call retries.
  function ensure() {
    inFlight ??= make().catch((error) => {
      inFlight = null;
      throw error;
    });
    return inFlight;
  }

  return Object.freeze({
    path: home,
    exists,
    ensure,
    isHome: (candidate) => typeof candidate === "string" && candidate !== "" && realOrResolved(candidate) === realOrResolved(home),
  });
}

module.exports = { createChatsHome };
