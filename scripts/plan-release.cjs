// Plans a desktop release. Merges to main cut no tags: Publish cuts a beta from the newest CI-green main commit, with
// the changes since the previous beta, and promotes the newest beta to stable, with the changes since the previous
// stable. CI keeps one untagged "Next beta" draft that lists what the next beta would ship.
//   node scripts/plan-release.cjs plan        CHANNEL, REQUESTED, SCHEDULED, NOTES_FILE in; key=value lines for $GITHUB_OUTPUT out
//   node scripts/plan-release.cjs preview     the next beta's version and notes, from origin/main
//   node scripts/plan-release.cjs next-draft  rewrites the Next beta draft from origin/main
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const VERSION_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.([1-9]\d*))?$/;
const CONVENTIONAL = /^(?<type>[a-z]+)(?:\((?<scope>[^)]*)\))?(?<bang>!)?: (?<description>.+)$/i;
const MAIN = "origin/main";
const NEXT_DRAFT_TAG = "next-beta";
const LEVELS = [null, "patch", "minor", "breaking"];
const SECTIONS = [
  ["Breaking changes", (commit) => commit.breaking],
  ["New", (commit) => !commit.breaking && commit.type === "feat"],
  ["Fixes", (commit) => !commit.breaking && commit.type === "fix"],
  ["Faster", (commit) => !commit.breaking && commit.type === "perf"],
];

const defaultExec = (command, args) => execFileSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

function parseTag(tag) {
  const match = VERSION_TAG.exec(tag);
  if (!match) return null;
  return { tag, core: [Number(match[1]), Number(match[2]), Number(match[3])], beta: match[4] === undefined ? null : Number(match[4]) };
}
const formatCore = (core) => core.join(".");
const compareCore = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
// A stable release sorts after every beta of its version, as electron-updater orders them.
function compareVersions(a, b) {
  const byCore = compareCore(a.core, b.core);
  if (byCore || a.beta === b.beta) return byCore;
  if (a.beta === null) return 1;
  if (b.beta === null) return -1;
  return a.beta - b.beta;
}
const newestOf = (versions) => versions.reduce((top, version) => (!top || compareVersions(version, top) > 0 ? version : top), null);

function bump(core, level) {
  const [major, minor, patch] = core;
  // Breaking changes stay minor bumps while Milagre is on 0.x.
  if (level === "breaking") return major === 0 ? [0, minor + 1, 0] : [major + 1, 0, 0];
  if (level === "minor") return [major, minor + 1, 0];
  return [major, minor, patch + 1];
}
const highestLevel = (commits) => commits.reduce((top, commit) => (LEVELS.indexOf(commit.level) > LEVELS.indexOf(top) ? commit.level : top), null);

function classify({ sha, subject, body }) {
  const match = CONVENTIONAL.exec(subject);
  const type = match ? match.groups.type.toLowerCase() : null;
  const breaking = Boolean(match?.groups.bang) || /^BREAKING[ -]CHANGE: /m.test(body);
  const level = breaking ? "breaking" : type === "feat" ? "minor" : type === "fix" || type === "perf" ? "patch" : null;
  return { sha, subject, type, scope: match?.groups.scope || null, description: match ? match.groups.description : subject, breaking, level };
}

/** Published releases only: drafts never reached anyone, and the Next beta draft has no version tag. */
function publishedVersions(exec) {
  const releases = JSON.parse(exec("gh", ["release", "list", "--json", "tagName,isDraft", "--limit", "1000"]));
  return releases.filter((release) => !release.isDraft).flatMap((release) => parseTag(release.tagName) ?? []);
}
const existingTags = (exec) => new Set(exec("git", ["tag", "--list", "v*"]).split("\n").filter(Boolean));
const commitOf = (exec, ref) => exec("git", ["rev-parse", "--verify", `${ref}^{commit}`]).trim();
function isAncestor(exec, ancestor, descendant) {
  try {
    exec("git", ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

function commitsSince(exec, fromTag, to) {
  const from = commitOf(exec, fromTag);
  if (!isAncestor(exec, from, to)) throw new Error(`${fromTag} is not an ancestor of ${to.slice(0, 12)}; releases are cut from main`);
  const log = exec("git", ["log", "--format=%H%x1f%s%x1f%b%x1e", `${from}..${to}`]);
  return log
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [sha, subject, body = ""] = entry.split("\x1f");
      return classify({ sha, subject, body });
    });
}

/** The commit a beta ships: the one asked for, or the newest main commit whose CI run passed. */
function greenCommit({ exec, requested }) {
  const runs = ["run", "list", "--workflow", "ci.yml", "--event", "push", "--status", "success", "--limit", "1", "--json", "headSha"];
  if (requested) {
    const sha = commitOf(exec, requested);
    if (!isAncestor(exec, sha, MAIN)) throw new Error(`${requested} is not on main`);
    if (!JSON.parse(exec("gh", [...runs, "--commit", sha])).length) throw new Error(`CI has not passed on ${requested} (${sha.slice(0, 12)})`);
    return sha;
  }
  const [run] = JSON.parse(exec("gh", [...runs, "--branch", "main"]));
  if (!run) throw new Error("No main commit has passed CI");
  return commitOf(exec, run.headSha);
}

function line(commit, repo) {
  let text = commit.description.trim();
  // Capitalize prose, not identifiers such as chat_start.
  if (/^[a-z]+(?=[\s,]|$)/.test(text)) text = text[0].toUpperCase() + text.slice(1);
  const pr = /\s*\(#(\d+)\)$/.exec(text);
  const link = pr ? `[#${pr[1]}](https://github.com/${repo}/pull/${pr[1]})` : `[${commit.sha.slice(0, 7)}](https://github.com/${repo}/commit/${commit.sha})`;
  if (pr) text = text.slice(0, pr.index);
  return `- ${commit.scope ? `**${commit.scope}:** ` : ""}${text} (${link})`;
}

function summary(commits) {
  const counts = [
    [commits.filter((commit) => commit.type === "feat" || commit.breaking).length, "new"],
    [commits.filter((commit) => !commit.breaking && commit.type === "fix").length, "fix"],
    [commits.filter((commit) => !commit.breaking && commit.type === "perf").length, "faster"],
  ];
  return counts
    .filter(([count]) => count)
    .map(([count, label]) => `${count} ${label === "fix" && count > 1 ? "fixes" : label}`)
    .join(", ");
}

function renderNotes({ intro, commits, repo, outro }) {
  const parts = [intro];
  for (const [title, test] of SECTIONS) {
    const items = commits.filter(test);
    if (items.length) parts.push(`### ${title}\n\n${items.map((commit) => line(commit, repo)).join("\n")}`);
  }
  const maintenance = commits.filter((commit) => !SECTIONS.some(([, test]) => test(commit))).length;
  if (maintenance) parts.push(`Also ${maintenance} maintenance ${maintenance === 1 ? "change" : "changes"} (CI, tests, refactors, docs).`);
  if (outro) parts.push(outro);
  return `${parts.join("\n\n")}\n`;
}

/**
 * The next beta from `sha`. Its version line is the last stable plus the biggest change since it; a line already
 * shipped as a beta above that (only true on the switch from per-merge tags) is passed with a minor bump, since beta
 * installs never downgrade. The notes cover the changes since the previous beta (or stable, if it is newer).
 */
function planBeta({ exec, repo, sha, scheduled = false }) {
  const published = publishedVersions(exec);
  const stable = newestOf(published.filter((version) => version.beta === null));
  if (!stable) throw new Error("No stable release is published yet");
  const previous = newestOf(published);
  const sincePrevious = commitsSince(exec, previous.tag, sha);
  if (!sincePrevious.length) return { changed: false, previous: previous.tag, reason: `Nothing new since ${previous.tag}` };
  if (scheduled && !highestLevel(sincePrevious)) return { changed: false, previous: previous.tag, reason: `Only maintenance changes since ${previous.tag}` };
  let core = bump(stable.core, highestLevel(commitsSince(exec, stable.tag, sha)) ?? "patch");
  const shipped = newestOf(published.filter((version) => version.beta !== null && compareCore(version.core, stable.core) > 0));
  if (shipped && compareCore(core, shipped.core) < 0) core = bump(shipped.core, "minor");
  const base = formatCore(core);
  const tags = existingTags(exec);
  if (tags.has(`v${base}`)) throw new Error(`Tag v${base} already exists, so this line could never be promoted; delete the stray tag`);
  const numbers = [...tags, ...published.map((version) => version.tag)].flatMap((tag) => {
    const version = parseTag(tag);
    return version?.beta && formatCore(version.core) === base ? [version.beta] : [];
  });
  const version = `${base}-beta.${Math.max(0, ...numbers) + 1}`;
  const releaseTag = `v${version}`;
  const notes = renderNotes({
    intro: `Changes since ${previous.tag}.`,
    commits: sincePrevious,
    repo,
    outro: `[Everything since stable ${stable.tag}](https://github.com/${repo}/compare/${stable.tag}...${releaseTag})`,
  });
  return { changed: true, sha, base, version, releaseTag, previous: previous.tag, notes };
}

/** Stable promotes the newest beta's commit. An older beta would hand beta installs a release missing changes they run. */
function planStable({ exec, repo, requested }) {
  const published = publishedVersions(exec);
  const stable = newestOf(published.filter((version) => version.beta === null));
  if (!stable) throw new Error("No stable release is published yet");
  const betas = published.filter((version) => version.beta !== null && compareVersions(version, stable) > 0).toSorted(compareVersions);
  const beta = betas.at(-1);
  if (!beta) throw new Error(`No beta is newer than the published ${stable.tag}`);
  if (requested && requested !== beta.tag)
    throw new Error(`${requested} is not the newest beta (${beta.tag}); promoting an older beta would move beta installs back`);
  const base = formatCore(beta.core);
  const releaseTag = `v${base}`;
  if (existingTags(exec).has(releaseTag)) throw new Error(`Tag ${releaseTag} already exists; cut a new beta to promote`);
  const sha = commitOf(exec, beta.tag);
  const commits = commitsSince(exec, stable.tag, sha);
  const notes = renderNotes({
    intro: `Everything since ${stable.tag}: ${summary(commits) || "maintenance only"}. Betas: ${betas.map((version) => version.tag).join(", ")}.`,
    commits,
    repo,
    outro: `[Full diff](https://github.com/${repo}/compare/${stable.tag}...${releaseTag})`,
  });
  return { changed: true, sha, base, version: base, releaseTag, previous: stable.tag, notes };
}

function nextDraft(plan) {
  if (!plan.changed && plan.reason.startsWith("Nothing new"))
    return { title: "Next beta: nothing yet", body: `Nothing merged to main since ${plan.previous}.\n` };
  const intro = `Merged to main since ${plan.previous}, not yet in a beta. A beta cut now would be ${plan.releaseTag}. CI rewrites this draft after every merge; ship betas with the Publish workflow, never by publishing this draft.`;
  return { title: `Next beta: ${plan.releaseTag}`, body: plan.notes.replace(/^Changes since [^\n]+\n/, `${intro}\n`) };
}

/**
 * Rewrites the one untagged Next beta draft, creating it the first time. An update that leaves out tag_name turns a
 * draft whose tag doesn't exist into "untagged-<random>", so every update sends it, and the lookup also matches the
 * title to find a draft that lost it.
 */
function writeNextDraft({ exec, title, body }) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "milagre-next-beta-")), "body.md");
  fs.writeFileSync(file, body);
  const query = `.[] | select(.draft and (.tag_name == "${NEXT_DRAFT_TAG}" or ((.name // "") | startswith("Next beta")))) | .id`;
  const id = exec("gh", ["api", "--paginate", "repos/{owner}/{repo}/releases", "--jq", query]).split("\n").find(Boolean);
  if (id)
    exec("gh", ["api", "-X", "PATCH", `repos/{owner}/{repo}/releases/${id}`, "-f", `tag_name=${NEXT_DRAFT_TAG}`, "-f", `name=${title}`, "-F", `body=@${file}`]);
  else
    exec("gh", [
      "api",
      "-X",
      "POST",
      "repos/{owner}/{repo}/releases",
      "-f",
      `tag_name=${NEXT_DRAFT_TAG}`,
      "-f",
      `name=${title}`,
      "-F",
      "draft=true",
      "-F",
      `body=@${file}`,
    ]);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
}

module.exports = { planBeta, planStable, greenCommit, nextDraft, writeNextDraft, classify, line, NEXT_DRAFT_TAG };

if (require.main === module) {
  const exec = defaultExec;
  try {
    const repo = process.env.GITHUB_REPOSITORY || exec("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).trim();
    const mode = process.argv[2];
    if (mode === "plan") {
      const { CHANNEL: channel, REQUESTED: requested, NOTES_FILE: notesFile } = process.env;
      const scheduled = process.env.SCHEDULED === "true";
      let plan;
      if (channel === "beta") plan = planBeta({ exec, repo, sha: greenCommit({ exec, requested: requested || undefined }), scheduled });
      else if (channel === "stable") plan = planStable({ exec, repo, requested: requested || undefined });
      else throw new Error(`Unknown channel: ${channel}; one of beta, stable`);
      if (!plan.changed) {
        // A scheduled beta with nothing to ship does nothing; one asked for by hand fails loudly.
        if (!scheduled) throw new Error(plan.reason);
        console.error(`${plan.reason}; skipping the scheduled beta.`);
        console.log("changed=false");
      } else {
        if (!notesFile) throw new Error("NOTES_FILE is required");
        fs.writeFileSync(notesFile, plan.notes);
        console.log(`changed=true\nsha=${plan.sha}\nbase=${plan.base}\nversion=${plan.version}\nrelease_tag=${plan.releaseTag}`);
      }
    } else if (mode === "preview") {
      const plan = planBeta({ exec, repo, sha: commitOf(exec, MAIN) });
      if (!plan.changed) console.log(plan.reason);
      else console.log(`Next beta: ${plan.releaseTag} (from ${MAIN}, before its CI check)\n\n${plan.notes}`);
    } else if (mode === "next-draft") {
      const draft = nextDraft(planBeta({ exec, repo, sha: commitOf(exec, MAIN) }));
      writeNextDraft({ exec, ...draft });
      console.log(draft.title);
    } else throw new Error("Usage: node scripts/plan-release.cjs plan|preview|next-draft");
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
