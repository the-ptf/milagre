#!/usr/bin/env node
const fs = require("node:fs");

const IMAGE_FOLDERS = [
  "apps/desktop/build/icons/",
  "apps/desktop/app/public/",
  "apps/mobile/assets/",
  "apps/site/public/",
  "apps/design-share/assets/",
  "scripts/fixtures/",
  "scripts/site-demo/",
];
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;

const SYNC_LABEL = "single-platform";
const SYNC_RULE =
  "Every change on desktop must also be applied on mobile, and every change on mobile must also be applied on desktop, in the same task. Skip syncing only when the user explicitly says to keep the change on one platform or not to sync it.";
const DESKTOP = "apps/desktop/app/src/";
const MOBILE = "apps/mobile/src/";
const TEST_FILE = /(\.test\.[cm]?[jt]sx?|\.baseline\.json)$|(^|\/)(__tests__|fixtures)\//;

function parseNameStatus(text) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      return { status: parts[0][0], path: parts[parts.length - 1] };
    });
}

function strayImages(changes) {
  return changes
    .filter(({ status, path }) => "AMRC".includes(status) && IMAGE.test(path) && !IMAGE_FOLDERS.some((folder) => path.startsWith(folder)))
    .map(({ path }) => path);
}

function checkImages(changes) {
  const stray = strayImages(changes);
  if (!stray.length) return { ok: true, message: "No images outside the asset folders." };
  return {
    ok: false,
    message:
      `This PR commits images outside the asset folders:\n${stray.map((path) => `  - ${path}`).join("\n")}\n` +
      "Screenshots never go in a PR's own commits (AGENTS.md, Pull requests). Remove them and push them to the orphan " +
      "`screenshots` branch instead (git fetch origin screenshots; add them under <feature>/ in a temporary worktree; commit and push), " +
      "then link each in the PR body as https://raw.githubusercontent.com/the-ptf/milagre-ade/<sha>/<feature>/<name>.png. " +
      `A new app asset belongs in one of: ${IMAGE_FOLDERS.join(", ")}.`,
  };
}

function platformsTouched(changes) {
  const product = changes.filter(({ path }) => !TEST_FILE.test(path));
  return { desktop: product.some(({ path }) => path.startsWith(DESKTOP)), mobile: product.some(({ path }) => path.startsWith(MOBILE)) };
}

function checkSync(changes, labels) {
  const { desktop, mobile } = platformsTouched(changes);
  if (desktop === mobile) return { ok: true, message: desktop ? "The PR changes desktop and mobile." : "The PR changes neither app's UI." };
  const [changed, missing] = desktop ? ["desktop (" + DESKTOP + ")", "mobile (" + MOBILE + ")"] : ["mobile (" + MOBILE + ")", "desktop (" + DESKTOP + ")"];
  if (labels.includes(SYNC_LABEL)) return { ok: true, message: `Only ${changed} changed; the ${SYNC_LABEL} label says that is on purpose.` };
  return {
    ok: false,
    message:
      `This PR changes ${changed} but not ${missing}. AGENTS.md: "${SYNC_RULE}" ` +
      `Apply the change on the other platform too, or, when the user asked for one platform only, add the ${SYNC_LABEL} label.`,
  };
}

if (require.main === module) {
  const [which] = process.argv.slice(2);
  const changes = parseNameStatus(fs.readFileSync(0, "utf8"));
  const labels = JSON.parse(process.env.LABELS || "[]");
  const result = which === "images" ? checkImages(changes) : which === "sync" ? checkSync(changes, labels) : null;
  if (!result) {
    console.error("Usage: node scripts/pr-policy.cjs <images|sync> < git-diff-name-status");
    process.exit(2);
  }
  const warnOnly = which === "sync";
  if (result.ok) console.log(result.message);
  else console.error(process.env.GITHUB_ACTIONS ? `::${warnOnly ? "warning" : "error"}::${result.message.replace(/\n/g, "%0A")}` : result.message);
  process.exit(result.ok || warnOnly ? 0 : 1);
}

module.exports = { IMAGE_FOLDERS, IMAGE, SYNC_LABEL, SYNC_RULE, parseNameStatus, strayImages, checkImages, platformsTouched, checkSync };
