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
 * The PRs a chat's commands created (`gh pr create`), merged (`gh pr merge <pr>`) or pushed to (`git push`, as
 * `push:<branch>`, the newest PR of that branch), in the order they ran.
 */
export function pullRequestRefs(messages) {
  const refs = [];
  const add = (ref) => {
    if (ref && !refs.includes(ref)) refs.push(ref);
  };
  for (const step of messages.flatMap((message) => message.steps ?? [])) {
    if (step.kind !== "shell" || step.status !== "done" || !step.detail?.startsWith("$ ")) continue;
    if (/\bgh\s+pr\s+create\b/.test(step.detail)) add(createdPullRequestUrl(step.detail));
    for (const match of step.detail.matchAll(/\bgh\s+pr\s+merge\b([^\n;&|]*)/g)) add(mergedRef(match[1]));
    for (const branch of pushedBranches(step.detail)) add(`push:${branch}`);
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
  return null;
}
// A branch name a push ref may carry: nothing gh or GraphQL could read as anything else.
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)[\w./-]{1,200}$/;
const branchOf = (name) => {
  const branch = name.replace(/^refs\/heads\//, "");
  return branch !== "HEAD" && !branch.endsWith(".lock") && !branch.endsWith("/") && BRANCH.test(branch) ? branch : null;
};
// `git push` flags followed by a value, so the value isn't read as the remote or a refspec.
const PUSH_VALUE_FLAGS = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec", "--signed"]);
/**
 * The branches a successful `git push` updated: from git's own report (`a1b2..c3d4  x -> x`, ` * [new branch]  HEAD -> x`),
 * or, when it printed none (`-q`), from the command's refspecs. Deletions, tags and pushes of every ref name none.
 */
export function pushedBranches(detail) {
  const [command = "", ...output] = detail.split("\n");
  const pushes = [...command.matchAll(/\bgit\s+(?:-C\s+\S+\s+)?push\b([^\n;&|]*)/g)].map((match) => match[1]);
  if (!pushes.length) return [];
  const branches = [];
  const add = (name) => {
    const branch = name && branchOf(name);
    if (branch && !branches.includes(branch)) branches.push(branch);
  };
  for (const line of output) {
    const report = /^\s*[ +*=]?\s*(?:\S+\.\.\.?\S+|\[new branch\])\s+\S+\s+->\s+(\S+)/.exec(line);
    if (report) add(report[1]);
  }
  if (branches.length) return branches;
  for (const args of pushes) {
    const words = [...args.matchAll(/"[^"]*"|'[^']*'|\S+/g)].map(([word]) => word.replace(/^['"]|['"]$/g, ""));
    if (words.some((word) => /^(?:-d|--delete|--all|--mirror|--tags|--prune)$/.test(word))) continue;
    const positional = [];
    for (let index = 0; index < words.length; index++) {
      const word = words[index];
      if (PUSH_VALUE_FLAGS.has(word)) index++;
      else if (!word.startsWith("-")) positional.push(word);
    }
    for (const refspec of positional.slice(1)) {
      const spec = refspec.replace(/^\+/, "");
      if (spec.startsWith("refs/tags/")) continue;
      add(spec.includes(":") ? spec.slice(spec.indexOf(":") + 1) : spec);
    }
  }
  return branches;
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
