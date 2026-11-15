#!/usr/bin/env node
// Fails when a commit or PR description credits an AI tool: a co-author trailer, a commit authored as one, or a
// "Generated with" footer. Main squash-merges with the PR's commit messages as the body, so a trailer in any PR commit
// lands on main, where it can't be removed without rewriting history (done once, 2026-10-13).
//
// Local:  node scripts/check-attribution.cjs                    commits in origin/main..HEAD
//         node scripts/check-attribution.cjs --commit-msg <file>  lefthook commit-msg
// CI:     node scripts/check-attribution.cjs --github-pr        the PR's commits and description (.github/workflows/pr-title.yml)
// Fix:    git rebase origin/main --exec "node scripts/check-attribution.cjs --amend-head"

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

const AI_EMAIL = /@(anthropic\.com|openai\.com)>?\s*$/i;
// Hand-typed trailers sometimes leave out the address. A first name alone isn't enough: people are called Claude.
const AI_NAME = /:\s*(claude( code| (opus|sonnet|haiku|fable)\b[^<]*)?|codex|chatgpt)\s*(<[^>]*>)?\s*$/i;
const TRAILER = /^\s*co-authored-by:/i;
const FOOTER = /generated (with|by) \[?(claude|codex|chatgpt)/i;

/** The lines of a commit message or PR description that credit an AI tool. */
function attributionLines(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .filter((line) => (TRAILER.test(line) && (AI_EMAIL.test(line) || AI_NAME.test(line))) || FOOTER.test(line))
    .map((line) => line.trim());
}

const isAiIdentity = (person) => /@(anthropic\.com|openai\.com)$/i.test(person?.email ?? "");

/**
 * @param {{ commits?: { sha: string, message: string, author?: { name?: string, email?: string } }[], body?: string }} input
 * @returns {string[]} one problem per offending commit line, author or description line
 */
function findAttribution({ commits = [], body } = {}) {
  const problems = [];
  for (const { sha, message, author } of commits) {
    const short = sha.slice(0, 9);
    for (const line of attributionLines(message)) problems.push(`commit ${short}: ${line}`);
    if (isAiIdentity(author)) problems.push(`commit ${short}: authored by ${author.name} <${author.email}>`);
  }
  for (const line of attributionLines(body)) problems.push(`PR description: ${line}`);
  return problems;
}

const FIX = [
  "Milagre's commits and PRs carry no AI attribution (.claude/settings.json turns Claude Code's off for this repo).",
  "Fix the commits on your branch, then push with --force-with-lease:",
  '  git rebase origin/main --exec "node scripts/check-attribution.cjs --amend-head"',
  "Fix the PR description: gh pr edit <number> --body-file <file without those lines>.",
].join("\n");

function report(problems) {
  if (!problems.length) return 0;
  console.error(`AI attribution found:\n${problems.map((problem) => `  ${problem}`).join("\n")}\n\n${FIX}`);
  return 1;
}

const git = (args) => execFileSync("git", args, { encoding: "utf8" });

function localCommits(range) {
  const out = git(["log", "--format=%H%x1f%an%x1f%ae%x1f%B%x1e", range]);
  return out
    .split("\x1e")
    .map((record) => record.replace(/^\n/, ""))
    .filter(Boolean)
    .map((record) => {
      const [sha, name, email, message] = record.split("\x1f");
      return { sha, message, author: { name, email } };
    });
}

function githubCommits(repo, number) {
  const out = execFileSync("gh", ["api", "--paginate", `repos/${repo}/pulls/${number}/commits`, "--jq", ".[] | @json"], { encoding: "utf8" });
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .map((entry) => ({ sha: entry.sha, message: entry.commit.message, author: entry.commit.author }));
}

function stripFile(file) {
  const text = fs.readFileSync(file, "utf8");
  const bad = new Set(attributionLines(text));
  const kept = text.split(/\r?\n/).filter((line) => !bad.has(line.trim()));
  fs.writeFileSync(file, `${kept.join("\n").trimEnd()}\n`);
}

function main(argv) {
  const [mode, value] = argv;
  if (mode === "--commit-msg") return report(attributionLines(fs.readFileSync(value, "utf8")).map((line) => `commit message: ${line}`));
  if (mode === "--amend-head") {
    // Drops the lines from HEAD's message and, when an AI tool authored it, makes you the author.
    const message = git(["log", "-1", "--format=%B"]);
    const aiAuthor = isAiIdentity({ email: git(["log", "-1", "--format=%ae"]).trim() });
    if (!attributionLines(message).length && !aiAuthor) return 0;
    const file = git(["rev-parse", "--git-path", "ATTRIBUTION_MSG"]).trim();
    fs.writeFileSync(file, message);
    stripFile(file);
    execFileSync("git", ["commit", "--amend", "--allow-empty", ...(aiAuthor ? ["--reset-author"] : []), "-F", file], { stdio: "inherit" });
    return 0;
  }
  if (mode === "--github-pr") {
    const { GITHUB_REPOSITORY: repo, PR_NUMBER: number, PR_BODY: body } = process.env;
    return report(findAttribution({ commits: githubCommits(repo, number), body }));
  }
  return report(findAttribution({ commits: localCommits(mode ?? "origin/main..HEAD") }));
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { attributionLines, findAttribution };
