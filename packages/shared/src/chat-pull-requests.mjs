const PR_URL = /^https?:\/\/[^\s/]+\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;

/** The same repository and PR, including links to its files, checks or comments. */
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

/** Finds a link's PR only among the Chat's known PRs, preserving its Worktree when supplied by the caller. */
export function associatedPullRequest(url, choices) {
  const identity = pullRequestIdentity(url);
  return identity ? choices.find((choice) => pullRequestIdentity(choice.url) === identity) : undefined;
}
// `gh pr merge` flags followed by a value, so the value isn't read as the PR.
const MERGE_VALUE_FLAGS = new Set(["-t", "--subject", "-b", "--body", "-F", "--body-file", "-A", "--author-email", "--match-head-commit", "-R", "--repo"]);
/** The PRs a chat's commands created (`gh pr create`) or merged (`gh pr merge <pr>`), in the order they ran. */
export function pullRequestRefs(messages) {
  const refs = [];
  const add = (ref) => {
    if (ref && !refs.includes(ref)) refs.push(ref);
  };
  for (const step of messages.flatMap((message) => message.steps ?? [])) {
    // Saved shell steps are "$ command" then the output; a failed one has no PR to show.
    if (step.kind !== "shell" || step.status !== "done" || !step.detail?.startsWith("$ ")) continue;
    if (/\bgh\s+pr\s+create\b/.test(step.detail)) add(createdPullRequestUrl(step.detail));
    for (const match of step.detail.matchAll(/\bgh\s+pr\s+merge\b([^\n;&|]*)/g)) add(mergedRef(match[1]));
  }
  // A number that a created URL already covers is the same PR (both run in the chat's repository).
  return refs.filter((ref) => !/^\d+$/.test(ref) || !refs.some((other) => other.endsWith(`/pull/${ref}`)));
}
/**
 * pullRequestRefs per chat, recomputed only when one of its messages changed. The state keeps unchanged
 * message objects as they were (reconcileState), so a chat's messages compare by identity; the sidebar
 * asks for every chat on each rebuild and would otherwise rescan every shell step.
 */
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
/** The URL `gh pr create` printed, from a shell step's detail; null when there is none. */
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
  // Quoted values stay one word, so `--body "two words"` doesn't read "words" as the PR.
  const words = [...args.matchAll(/"[^"]*"|'[^']*'|\S+/g)].map(([word]) => word.replace(/^['"]|['"]$/g, ""));
  let repo;
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    if (word === "-R" || word === "--repo") repo = words[index + 1];
    if (MERGE_VALUE_FLAGS.has(word)) index++;
    else if (word.startsWith("-")) continue;
    else if (PR_URL.test(word)) return word;
    else if (/^\d+$/.test(word)) return repo && REPO.test(repo) ? `https://github.com/${repo}/pull/${word}` : word;
    // A branch name, a variable or anything else isn't followed: the branch PR shows on its own.
    else return null;
  }
  return null;
}
/** The chat's PRs that could be read, in the order it made them, with the worktree branch's PR included once. */
export function chatPullRequests(refs, found, branch) {
  const prs = [];
  for (const read of [...refs.map((ref) => found[ref]), branch]) {
    // The branch PR is also read at every turn end, so it is the fresher copy of a PR the chat named too.
    const pr = read && branch && read.url === branch.url ? branch : read;
    if (pr && !prs.some((other) => other.url === pr.url)) prs.push(pr);
  }
  return prs;
}
