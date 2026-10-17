// Discovery and selection for `npm test`. Pure: no process spawning here (see test.cjs).
const fs = require("node:fs");
const path = require("node:path");

const UNIT_ROOTS = ["apps", "packages", "scripts"];
const SKIP_DIRS = new Set(["node_modules", "dist", "release", ".expo", "ios", "android", "squashfs-root"]);

/**
 * Checks that need more than Node, Vite and Electron. Everything else runs anywhere.
 * `seconds` is a check's time on the Linux CI runner (run 39032341784, 2026-10-17) so --shard balances the shards;
 * a check without one counts as TYPICAL_CHECK_SECONDS. Stale numbers cost real time: with the previous table one
 * shard ran 169 s while another ran 71 s. Refresh them from a green main run's PASS lines when a shard stands out.
 */
const MANIFEST = {
  "test-artifacts.cjs": { seconds: 85 },
  // Six Lighthouse runs (three mobile, three desktop) on a site build.
  "test-site-lighthouse.cjs": { seconds: 49 },
  "test-theming-gallery.cjs": { seconds: 38 },
  "test-design-editor.cjs": { seconds: 35 },
  "test-design-live.cjs": { seconds: 32 },
  "test-simulators.cjs": { seconds: 29 },
  "test-update-flow.cjs": { seconds: 25 },
  "test-floating-inbox.cjs": { seconds: 25 },
  "test-chat-attachments.cjs": { seconds: 24 },
  "test-site.cjs": { seconds: 23 },
  "test-task-track.cjs": { seconds: 20 },
  "test-chat-pins.cjs": { seconds: 17 },
  "test-sidebar-links.cjs": { seconds: 16 },
  "test-usage-limit.cjs": { seconds: 14 },
  "test-project-links.cjs": { seconds: 14, needsBuild: true },
  "test-image-generation.cjs": { seconds: 13 },
  "test-worktree-setup.cjs": { seconds: 13 },
  "test-settings-devices.cjs": { seconds: 13 },
  "test-terminal.cjs": { seconds: 13 },
  "test-sidebar-all-projects.cjs": { seconds: 13 },
  "test-sidebar-rail.cjs": { seconds: 12 },
  "test-diff-view.cjs": { seconds: 12 },
  "test-sidebar-computers.cjs": { seconds: 12 },
  "test-archive-enter.cjs": { seconds: 11 },
  "test-allow-computer.cjs": { seconds: 11 },
  "test-chat-selections.cjs": { seconds: 11 },
  "test-popover-dismiss.cjs": { seconds: 11 },
  "test-genui.cjs": { seconds: 10 },
  "test-canvas-links.cjs": { seconds: 10 },
  "test-floating-inbox-native.cjs": { seconds: 10, needsBuild: true },
  "test-desktop.cjs": { seconds: 10, needsBuild: true },
  "test-permission-chip.cjs": { seconds: 10 },
  "test-chat-drafts.cjs": { seconds: 10 },
  "test-chat-timer.cjs": { seconds: 10 },
  // 7s for the check plus about 20s for its shard to install ffmpeg (.github/workflows/ci.yml).
  "test-chat-titles.cjs": { seconds: 27 },
  "test-windows-cli.cjs": { platforms: ["win32"] },
  "test-ports.cjs": { needs: ["zsh", "ps", "lsof"] },
  // needsBuild: loads apps/desktop/dist; test-project-links only passed serially because test-desktop built it first.
  "test-design-csp.cjs": { needsBuild: true },
  // Red on the Linux CI runner (xvfb); each issue holds the log and the triage notes.
  "test-chat-layout.cjs": { platforms: ["darwin"], reason: "message preview overlaps the prompt on Linux, #234" },
  "test-chat-send-feedback.cjs": { platforms: ["darwin"], reason: "message navigation rebuilds on Linux, #235" },
  "test-command-palette.cjs": { platforms: ["darwin"], reason: "presses Meta, the Mac-only hint modifier, #236" },
  "test-find-in-chat.cjs": { platforms: ["darwin"], reason: "presses Meta+G, the Mac-only find-next shortcut, #237" },
  "test-prompt-skills.cjs": { platforms: ["darwin"], reason: "skill tooltip never shows on hover under xvfb, #238" },
  "test-sidebar-resize.cjs": { platforms: ["darwin"], reason: "reads the width mid-transition on Linux, #239" },
  "test-subagents.cjs": { platforms: ["darwin"], reason: "eyes do not follow the pointer under xvfb, #240" },
  "test-sidebar-usage.cjs": { platforms: ["darwin"], reason: "usage card text differs on Linux, #254" },
};

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (/\.test\.(ts|mjs|cjs)$/.test(entry.name)) out.push(path.join(dir, entry.name));
  }
}

function discoverUnitTests(root) {
  const out = [];
  for (const dir of UNIT_ROOTS) walk(path.join(root, dir), out);
  return out.map((file) => path.relative(root, file)).sort();
}

function discoverElectronChecks(root) {
  return fs
    .readdirSync(path.join(root, "scripts"))
    .filter((name) => /^test-.*\.cjs$/.test(name) && !name.endsWith(".test.cjs") && name !== "test-runner.cjs")
    .sort()
    .map((name) => `scripts/${name}`);
}

const WORKSPACES = {
  shared: "packages/shared/",
  core: "packages/core/",
  desktop: "apps/desktop/",
  daemon: "apps/daemon/",
  relay: "apps/relay/",
  mobile: "apps/mobile/",
  scripts: "scripts/",
};

function parseArgs(argv) {
  const filters = { unit: false, electron: false, workspace: null, only: null, list: false, shard: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--changed") throw new Error("--changed is not implemented yet; use --only or --workspace");
    if (arg === "--unit" || arg === "--electron" || arg === "--list") filters[arg.slice(2)] = true;
    else if (arg === "--workspace" || arg === "--only") {
      filters[arg.slice(2)] = argv[++i];
      if (!filters[arg.slice(2)]) throw new Error(`${arg} needs a value`);
    } else if (arg === "--shard") {
      const value = argv[++i];
      if (!value) throw new Error("--shard needs a value");
      const match = /^(\d+)\/(\d+)$/.exec(value);
      const [index, count] = match ? [Number(match[1]), Number(match[2])] : [0, 0];
      if (!(index >= 1 && count >= 1 && index <= count)) throw new Error(`--shard needs <index>/<count> with 1 <= index <= count, got ${value}`);
      filters.shard = { index, count };
    } else throw new Error(`Unknown option ${arg}`);
  }
  if (filters.workspace && !WORKSPACES[filters.workspace])
    throw new Error(`Unknown workspace ${filters.workspace}; one of ${Object.keys(WORKSPACES).join(", ")}`);
  return filters;
}

function selectTests({ unit, electron, filters }) {
  const wantUnit = filters.unit || !filters.electron;
  const wantElectron = filters.electron || !filters.unit;
  let pickedUnit = wantUnit ? unit : [];
  let pickedElectron = wantElectron ? electron : [];
  if (filters.workspace) {
    const prefix = WORKSPACES[filters.workspace];
    pickedUnit = pickedUnit.filter((file) => file.startsWith(prefix));
    pickedElectron = filters.workspace === "scripts" || filters.workspace === "desktop" ? pickedElectron : [];
  }
  if (filters.only) {
    pickedUnit = pickedUnit.filter((file) => file.includes(filters.only));
    pickedElectron = pickedElectron.filter((file) => file.includes(filters.only));
    if (pickedUnit.length + pickedElectron.length === 0) throw new Error(`no test matched "${filters.only}"`);
  }
  const skipped = [];
  pickedElectron = pickedElectron.filter((file) => {
    const rule = MANIFEST[path.basename(file)];
    if (!rule) return true;
    if (rule.platforms && !rule.platforms.includes(filters.platform)) {
      skipped.push({ file, reason: `needs ${rule.platforms.join("/")}${rule.reason ? `: ${rule.reason}` : ""}` });
      return false;
    }
    const missing = (rule.needs ?? []).filter((name) => !filters.commandExists(name));
    if (missing.length) {
      skipped.push({ file, reason: `needs ${missing.join(", ")}` });
      return false;
    }
    return true;
  });
  skipped.sort((a, b) => a.file.localeCompare(b.file));
  // CI splits the tests across runners; the split happens after skips so each shard gets an even share of real work.
  if (filters.shard) {
    pickedUnit = shardOf(pickedUnit, filters.shard, () => 1);
    pickedElectron = shardOf(pickedElectron, filters.shard, (file) => MANIFEST[path.basename(file)]?.seconds ?? TYPICAL_CHECK_SECONDS);
  }
  return { unit: pickedUnit, electron: pickedElectron, skipped };
}

/** About what an Electron check without a `seconds` entry takes on the Linux CI runner. */
const TYPICAL_CHECK_SECONDS = 8;

/** Longest first, each to the least loaded shard: the slowest shard stays close to the average. Keeps the input order. */
function shardOf(files, { index, count }, weight) {
  const loads = Array.from({ length: count }, () => 0);
  const owner = new Map();
  for (const file of files.toSorted((a, b) => weight(b) - weight(a) || a.localeCompare(b))) {
    const lightest = loads.indexOf(Math.min(...loads));
    loads[lightest] += weight(file);
    owner.set(file, lightest);
  }
  return files.filter((file) => owner.get(file) === index - 1);
}

/** Chromium's GPU process sometimes fails to start under Xvfb on the Linux CI runner; one retry absorbs it. */
function shouldRetry({ platform, ci, attempt }) {
  return platform === "linux" && Boolean(ci) && attempt === 1;
}

module.exports = { shouldRetry, discoverUnitTests, discoverElectronChecks, selectTests, parseArgs, MANIFEST, WORKSPACES };
