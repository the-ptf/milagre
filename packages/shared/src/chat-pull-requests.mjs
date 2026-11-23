const PR_URL = /^https?:\/\/[^\s/]+\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;

function pullRequestIdentity(value) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.port) return null;
    const match = /^\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)(?:\/|$)/.exec(url.pathname);
    return match ? `${url.hostname.toLowerCase()}/${match[1].toLowerCase()}/${match[2].toLowerCase()}/${match[3]}` : null;
  } catch {
    return null;
  }
}

export function associatedPullRequest(url, choices) {
  const identity = pullRequestIdentity(url);
  return identity ? choices.find((choice) => pullRequestIdentity(choice.url) === identity) : undefined;
}
// `gh pr merge` flags followed by a value, so the value isn't read as the PR.
const MERGE_VALUE_FLAGS = new Set(["-t", "--subject", "-b", "--body", "-F", "--body-file", "-A", "--author-email", "--match-head-commit", "-R", "--repo"]);
/**
 * The PRs a chat's commands created (`gh pr create`), merged (`gh pr merge <pr>`, or `gh pr merge` of the branch the
 * host saw checked out when it started, as `branch:<branch>`) or pushed to (`git push`, as `push:<owner>/<repo>:<branch>`,
 * the newest PR from that repository's branch), in the order they ran.
 */
export function pullRequestRefs(messages) {
  const refs = [];
  const add = (ref) => {
    if (ref && !refs.includes(ref)) refs.push(ref);
  };
  for (const step of messages.flatMap((message) => message.steps ?? [])) {
    if (step.kind !== "shell" || step.status !== "done" || !step.detail?.startsWith("$ ")) continue;
    if (/\bgh\s+pr\s+create\b/.test(step.detail)) add(createdPullRequestUrl(step.detail));
    for (const match of step.detail.matchAll(MERGES)) {
      const merged = mergedRef(match[1]);
      const branch = merged === CHECKED_OUT && step.branch ? branchOf(step.branch) : null;
      add(merged === CHECKED_OUT ? branch && `branch:${branch}` : merged);
    }
    for (const { repo, branch } of pushedBranches(step.detail)) add(`push:${repo}:${branch}`);
  }
  return refs.filter((ref) => !/^\d+$/.test(ref) || !refs.some((other) => other.endsWith(`/pull/${ref}`)));
}
export function pullRequestRefsCache() {
  const cached = new Map();
  return (key, messages) => {
    const hit = cached.get(key);
    if (hit && hit.messages.length === messages.length && hit.messages.every((message, index) => message === messages[index])) return hit.refs;
    const refs = pullRequestRefs(messages);
    cached.set(key, { messages, refs });
    return refs;
  };
}
// gh prints the new PR's URL alone on the last line; URLs in the body come before it.
export function createdPullRequestUrl(detail) {
  const lines = detail
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const index = lines.map((line) => PR_URL.test(line)).lastIndexOf(true);
  return index > 0 ? lines[index] : null;
}
function mergedRef(args) {
  const words = [...args.matchAll(/"[^"]*"|'[^']*'|\S+/g)].map(([word]) => word.replace(/^['"]|['"]$/g, ""));
  let repo;
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    if (word === "-R" || word === "--repo") repo = words[index + 1];
    if (MERGE_VALUE_FLAGS.has(word)) index++;
    else if (word.startsWith("-")) continue;
    else if (PR_URL.test(word)) return word;
    else if (/^\d+$/.test(word)) return repo && REPO.test(repo) ? `https://github.com/${repo}/pull/${word}` : word;
    else return null;
  }
  return CHECKED_OUT;
}
// `gh pr merge` with no PR named: it merges the checked-out branch's PR.
const CHECKED_OUT = Symbol("checked-out branch");
const MERGES = /\bgh\s+pr\s+merge\b([^\n;&|]*)/g;
/** Whether a command runs `gh pr merge` on the checked-out branch, whose name the host then keeps on the step. */
export function mergesCheckedOutBranch(command) {
  return [...command.matchAll(MERGES)].some((match) => mergedRef(match[1]) === CHECKED_OUT);
}
// A branch name a push ref may carry: nothing gh or GraphQL could read as anything else.
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)[\w./-]{1,200}$/;
const branchOf = (name) => {
  const branch = name.replace(/^refs\/heads\//, "");
  return branch !== "HEAD" && !branch.endsWith(".lock") && !branch.endsWith("/") && BRANCH.test(branch) ? branch : null;
};
// The repository a push went to, from git's `To <url>` line: a GitHub-style host with owner and name.
const PUSH_TARGET = /^To\s+(?:[a-z+]+:\/\/)?(?:[^@/\s]+@)?[^:/\s]+(?::\d+)?[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/;
// One updated ref in git's report: `   a1b2..c3d4  x -> x`, ` * [new branch]  HEAD -> x`, ` + a...b x -> x (forced update)`,
// or --porcelain's `*\trefs/heads/x:refs/heads/x\t[new branch]`.
const PUSH_UPDATE = /^\s*[ +*]?\s*(?:\S+\.\.\.?\S+|\[new branch\])\s+\S+\s+->\s+(\S+)/;
const PORCELAIN_UPDATE = /^[ +*]\t[^:\t]+:(\S+)\t(?!\[rejected\]|\[up to date\])/;
/**
 * The branches a successful `git push` updated and the repository each went to, from git's own report. A dry run
 * changes nothing, and a push whose report doesn't name the repository (`-q`, a local path) links nothing.
 */
export function pushedBranches(detail) {
  const [command = "", ...output] = detail.split("\n");
  const pushes = [...command.matchAll(/\bgit\s+(?:-C\s+\S+\s+)?push\b([^\n;&|]*)/g)].map((match) => match[1]);
  if (!pushes.length || pushes.some((args) => /(?:^|\s)(?:-n|--dry-run)(?=\s|$)/.test(args))) return [];
  const pushed = [];
  let repo = null;
  for (const line of output) {
    const target = /^To\s/.test(line) ? PUSH_TARGET.exec(line.trim()) : null;
    if (/^To\s/.test(line)) repo = target ? `${target[1]}/${target[2]}` : null;
    const update = PUSH_UPDATE.exec(line) ?? PORCELAIN_UPDATE.exec(line);
    const branch = update && repo ? branchOf(update[1]) : null;
    if (branch && !pushed.some((item) => item.repo === repo && item.branch === branch)) pushed.push({ repo, branch });
  }
  return pushed;
}

/**
 * Whether a Chat has its Worktree to itself: not the Project's own folder, and no other unarchived Chat works in it.
 * Only then is the Worktree branch's PR the Chat's own; elsewhere a Chat shows only the PRs its commands worked on.
 */
export function ownsWorktree(state, sessionId, projectPath) {
  const session = state?.sessions?.[sessionId];
  const worktree = session ? state.worktrees?.[session.worktree_id] : undefined;
  if (!worktree || worktree.path === projectPath) return false;
  return !Object.values(state.sessions).some((other) => other.id !== session.id && other.worktree_id === session.worktree_id && !other.archived);
}

/** Whether a new Chat started in `worktreePath` would own it (ownsWorktree): outside the Project folder, no open Chat in it. */
export function worktreeFree(state, worktreePath, projectPath) {
  if (!worktreePath || worktreePath === projectPath) return false;
  const worktree = Object.values(state?.worktrees ?? {}).find((candidate) => candidate?.path === worktreePath);
  if (!worktree) return false;
  return !Object.values(state.sessions ?? {}).some((other) => String(other.worktree_id) === String(worktree.id) && !other.archived);
}

/**
 * The chat's PRs that could be read, in the order it made them, with the worktree branch's PR included once. Pass `branch`
 * only for a Chat that owns its Worktree (ownsWorktree).
 */
export function chatPullRequests(refs, found, branch) {
  const prs = [];
  for (const read of [...refs.map((ref) => found[ref]), branch]) {
    const pr = read && branch && read.url === branch.url ? branch : read;
    if (pr && !prs.some((other) => other.url === pr.url)) prs.push(pr);
  }
  return prs;
}
