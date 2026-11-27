export const REVIEW_SEVERITIES = ["high", "medium", "low"];
export const REVIEW_FINDING_STATUSES = ["open", "sent", "dismissed"];

const MAX_FINDINGS = 50;
const MAX_TEXT = 4000;
const PR_URL = /^https:\/\/[a-z0-9.-]+\/[\w.-]+\/[\w.-]+\/pull\/\d+$/i;

const text = (value, limit = MAX_TEXT) => (typeof value === "string" ? value.trim().slice(0, limit) : "");

/** What "Review for me" asks the Orchestrator. With `report`, the agent hands its findings to Milagre with `pr_review_report`. */
export function reviewForMePrompt({ url, repo, number, title }, { report = false } = {}) {
  const ask = `Review pull request ${url} (${repo}#${number}: ${title}). Check out its head in a fresh Worktree, read the diff in context, and report findings with file, line, severity (high/medium/low) and a suggested fix. Don't push, comment on GitHub, approve or merge.`;
  return report
    ? `${ask} When you're done, call the milagre pr_review_report tool once with the PR's URL, a one-paragraph summary and every finding (an empty list when you found nothing); Milagre shows them on the PR.`
    : ask;
}

/** Whether `prompt` names `url` itself, not a longer URL it begins (`…/pull/12` inside `…/pull/123`). */
export function mentionsPullRequestUrl(prompt, url) {
  if (!url || typeof prompt !== "string") return false;
  for (let at = prompt.indexOf(url); at >= 0; at = prompt.indexOf(url, at + 1)) {
    if (!/[0-9A-Za-z/]/.test(prompt[at + url.length] ?? "")) return true;
  }
  return false;
}

/** A `pr_review_report` call checked and trimmed, or an Error naming what's wrong. */
export function parseReviewReport(input) {
  const url = text(input?.url, 300).replace(/\/+$/, "");
  if (!PR_URL.test(url)) return new Error("url must be the PR's GitHub URL, like https://github.com/owner/repo/pull/12.");
  const raw = Array.isArray(input?.findings) ? input.findings : null;
  if (!raw) return new Error("findings must be a list (empty when you found nothing).");
  if (raw.length > MAX_FINDINGS) return new Error(`Report at most ${MAX_FINDINGS} findings; merge the small ones.`);
  const findings = [];
  for (const [index, finding] of raw.entries()) {
    const severity = REVIEW_SEVERITIES.includes(finding?.severity) ? finding.severity : null;
    const title = text(finding?.title, 200);
    const path = text(finding?.path, 500);
    if (!severity || !title || !path) return new Error(`Finding ${index + 1} needs path, severity (high, medium or low) and title.`);
    const line = Number.isSafeInteger(finding?.line) && finding.line > 0 ? finding.line : null;
    findings.push({ path, line, severity, title, body: text(finding?.body), suggestion: text(finding?.suggestion) || null });
  }
  findings.sort((a, b) => REVIEW_SEVERITIES.indexOf(a.severity) - REVIEW_SEVERITIES.indexOf(b.severity));
  return { url, summary: text(input?.summary, 2000), findings };
}

/** How many open findings a review has, by severity. */
export function reviewCounts(review) {
  const counts = { open: 0, high: 0, medium: 0, low: 0 };
  for (const finding of review?.findings ?? []) {
    if (finding.status === "dismissed") continue;
    counts.open += 1;
    counts[finding.severity] += 1;
  }
  return counts;
}

const where = (finding) => (finding.line ? `${finding.path}:${finding.line}` : finding.path);

/** The message Fix in Chat sends: the PR and each finding with where it is, what's wrong and the suggested fix. */
export function reviewFixMessage(url, findings) {
  const lines = [`Fix these review findings on ${url}:`, ""];
  for (const finding of findings) {
    lines.push(`- [${finding.severity}] ${where(finding)}: ${finding.title}`);
    if (finding.body) lines.push(`  ${finding.body.replace(/\n+/g, " ")}`);
    if (finding.suggestion) lines.push(`  Suggested fix: ${finding.suggestion.replace(/\n+/g, " ")}`);
  }
  return lines.join("\n");
}

/** One Babysit change per finding, as the PR poller hands them over. */
export function reviewBabysitChanges(findings) {
  return findings.map((finding) => ({
    id: `review:${finding.id}`,
    text: `Review finding (${finding.severity}) at ${where(finding)}: ${finding.title}${finding.suggestion ? `. Suggested fix: ${finding.suggestion}` : ""}`,
  }));
}

export const REVIEW_AGENT_DESCRIPTION = "Review for me saves findings on this computer. High-severity findings go to an active Babysit Heartbeat for the PR.";

export function findingsLabel(count) {
  return count ? `${count} finding${count === 1 ? "" : "s"}` : "No findings";
}

export function latestReviewSources(entries) {
  const result = new Map();
  for (const [source, counts] of entries)
    for (const [url, count] of Object.entries(counts ?? {}))
      if (!result.has(url) || count.reviewedAt > result.get(url).reviewedAt) result.set(url, { ...count, source });
  return result;
}
