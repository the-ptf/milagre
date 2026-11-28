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
  // 62 s with 250 ms before each of its 35 screenshots; it was 85 s at 900 ms.
  "test-artifacts.cjs": { seconds: 62 },
  // Twelve Lighthouse runs on a site build: three mobile and three desktop on /, one each on /docs, /docs/cli and /design.
  "test-site-lighthouse.cjs": { seconds: 135 },
  "test-theming-gallery.cjs": { seconds: 38 },
  "test-design-live.cjs": { seconds: 32 },
  "test-simulators.cjs": { seconds: 29 },
  "test-update-flow.cjs": { seconds: 25 },
  "test-floating-inbox.cjs": { seconds: 25 },
  "test-chat-attachments.cjs": { seconds: 24 },
  // #234: about 50 s locally on Ubuntu 24.04 amd64 through OrbStack; refresh from CI when available.
  "test-chat-layout.cjs": { seconds: 50 },
  // #972: about 37 s on a Mac (three parked returns, twenty first opens); provisional until a green CI timing.
  "test-chat-scroll-return.cjs": { seconds: 40 },
  "test-chat-scroll-intent.cjs": { seconds: 15 },
  "test-site.cjs": { seconds: 23 },
  // Its headless Chrome is warmed up first on Linux CI (html-preview-warmup.cjs).
  "test-html-replies.cjs": { previewsHtml: true },
  "test-task-track.cjs": { seconds: 20 },
  // #526 removed the canvas behind #240; the replacement Subagents check runs on Linux too.
  "test-subagents.cjs": { seconds: 20 },
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
  "test-find-in-chat.cjs": { seconds: 10 },
  "test-genui.cjs": { seconds: 10 },
  "test-canvas-links.cjs": { seconds: 10 },
  "test-floating-inbox-native.cjs": { seconds: 10, needsBuild: true },
  "test-desktop.cjs": { seconds: 10, needsBuild: true },
  "test-permission-chip.cjs": { seconds: 10 },
  "test-chat-drafts.cjs": { seconds: 10 },
  "test-chat-timer.cjs": { seconds: 10 },
  "test-windows-cli.cjs": { platforms: ["win32"] },
  "test-terminal-clipboard.cjs": { platforms: ["win32"] },
  "test-ports.cjs": { needs: ["zsh", "ps", "lsof"] },
  // needsBuild: loads apps/desktop/dist; test-project-links only passed serially because test-desktop built it first.
  "test-design-csp.cjs": { needsBuild: true },
  // #235: restored Linux coverage; provisional weight until the next green CI timing.
  "test-chat-send-feedback.cjs": { seconds: 28 },
  // The Routines page, form and Chat surfaces on a Vite fixture (no build); about 6s on a Mac, so a Linux runner guess.
  "test-routines.cjs": { seconds: 9 },
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
  // Forward slashes on every platform: WORKSPACES and UNIT_SECONDS match on them.
  return out.map((file) => path.relative(root, file).split(path.sep).join("/")).sort();
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
  site: "apps/site/",
  scripts: "scripts/",
};

function parseArgs(argv) {
  const filters = { unit: false, electron: false, workspace: null, only: null, list: false, shard: null, changed: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--unit" || arg === "--electron" || arg === "--list") filters[arg.slice(2)] = true;
    else if (arg === "--workspace" || arg === "--only" || arg === "--changed") {
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
  // --changed: only the tests the change reaches (affected-tests.cjs); null means the whole suite.
  if (filters.affected) {
    pickedUnit = pickedUnit.filter((file) => filters.affected.has(file));
    pickedElectron = pickedElectron.filter((file) => filters.affected.has(file));
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
    pickedUnit = shardOf(pickedUnit, filters.shard, (file) => UNIT_SECONDS[file] ?? TYPICAL_UNIT_SECONDS);
    // The checks that load the built renderer travel together: the shard that has them builds it once (test.cjs).
    pickedElectron = shardOf(pickedElectron, filters.shard, electronSeconds, {
      groupOf: (file) => (MANIFEST[path.basename(file)]?.needsBuild ? "renderer build" : null),
      groupSeconds: RENDERER_BUILD_SECONDS,
    });
  }
  return { unit: pickedUnit, electron: pickedElectron, skipped };
}

/**
 * The tests a change reaches, for --changed: `{ full: reason }` when it touches something the dependency graph cannot
 * follow, else `{ full: null, tests }`. A check that loads the built renderer depends on all of the desktop app.
 */
function affectedSelection({ root, changed, files, unit, electron }) {
  const extraDependencies = Object.fromEntries(electron.filter((file) => MANIFEST[path.basename(file)]?.needsBuild).map((file) => [file, ["apps/desktop/"]]));
  const { selectAffected, narrowWorkspace } = require("./affected-tests.cjs");
  const selection = selectAffected({
    changed,
    files,
    tests: [...unit, ...electron],
    read: (file) => fs.readFileSync(path.join(root, file), "utf8"),
    extraDependencies,
  });
  const workspace = narrowWorkspace(changed);
  if (workspace && selection.tests) {
    for (const file of unit)
      if (file.startsWith(WORKSPACES[workspace]) || (workspace === "mobile" && file.startsWith("scripts/mobile-"))) selection.tests.add(file);
  }
  return selection;
}

const electronSeconds = (file) => MANIFEST[path.basename(file)]?.seconds ?? TYPICAL_CHECK_SECONDS;

/** About what an Electron check without a `seconds` entry takes on the Linux CI runner. */
const TYPICAL_CHECK_SECONDS = 8;
/** `npm run build:renderer` on that runner, paid once by the shard whose checks need dist. */
const RENDERER_BUILD_SECONDS = 10;
/** A unit test file without an entry in UNIT_SECONDS takes about this long on its own there. */
const TYPICAL_UNIT_SECONDS = 0.3;
/**
 * Unit test files that take more than a couple of seconds on their own (measured locally, 2026-10-17), so --shard
 * can share the time rather than the file count: by count one CI shard ran 48 s and the other 80 s.
 */
const UNIT_SECONDS = {
  "packages/core/src/runtime.test.cjs": 117.9,
  "packages/core/src/delegations.test.cjs": 79.4,
  "apps/daemon/src/mobile-bridge.test.cjs": 52.8,
  "packages/core/src/git-actions.test.cjs": 26.9,
  "apps/daemon/src/server.test.cjs": 25.0,
  "apps/daemon/src/confine.test.cjs": 24.3,
  "scripts/mobile-ui.test.cjs": 23.2,
  "packages/core/src/link-runtime.test.cjs": 22.4,
  "packages/core/src/runtime-local-mcp.test.cjs": 21.3,
  "packages/core/src/worktree-cleanup.test.cjs": 20.6,
  "packages/core/src/runtime-project-accounts.test.cjs": 15.9,
  "packages/core/src/runtime-advisors.test.cjs": 15.3,
  "scripts/mobile-demo.test.cjs": 14.4,
  "packages/shared/src/relay-rpc.test.mjs": 14.3,
  "packages/core/src/checkpoints.test.cjs": 13.3,
  "packages/core/src/runtime-setup-review.test.cjs": 12.6,
  "packages/core/src/agents/chat-host.test.cjs": 11.8,
  "apps/desktop/electron/daemon-runtime.test.cjs": 11.8,
  "apps/daemon/src/relay-host.test.cjs": 11.3,
  "packages/core/src/worktrees.test.cjs": 11.2,
  "packages/core/src/link-workspaces.test.cjs": 10.3,
  "scripts/monorepo.test.cjs": 9.3,
  "scripts/mobile-host.test.cjs": 8.6,
  "apps/desktop/electron/computers-e2e.test.cjs": 8.5,
  "scripts/review-demo.test.cjs": 8.4,
  "packages/core/src/main-sync.test.cjs": 8.0,
  "packages/core/src/worktree-chats.test.cjs": 7.9,
  "packages/core/src/agents/codex-provider.test.cjs": 7.1,
  "apps/daemon/src/bootstrap.test.cjs": 7.0,
  "scripts/release-workflow.test.cjs": 5.9,
  "apps/daemon/src/connections.test.cjs": 5.8,
  "scripts/package-managers.test.cjs": 4.7,
  "packages/core/src/runtime-lazy-messages.test.cjs": 4.6,
  "apps/daemon/src/lan-host.test.cjs": 4.5,
  "packages/core/src/agents/claude-provider.test.cjs": 4.3,
  "packages/core/src/agents/acp-session.test.cjs": 4.3,
  "apps/desktop/electron/computers.test.cjs": 4.2,
  "apps/desktop/electron/floating-inbox.test.cjs": 4.1,
  "packages/core/src/git-diff.test.cjs": 3.7,
  "apps/daemon/src/peer-e2e.test.cjs": 3.5,
  "apps/desktop/app/src/lib/state-events-computers.test.ts": 3.2,
  "apps/desktop/app/src/lib/state-events.test.ts": 3.2,
  "packages/core/src/project-groups.test.cjs": 2.8,
  "apps/daemon/src/perf-budget.test.cjs": 2.8,
  "packages/core/src/simulators-helper.test.cjs": 2.7,
  "packages/core/src/diffstat.test.cjs": 2.7,
  "apps/mobile/src/relay-transport.test.ts": 2.5,
  "scripts/mobile-push-native.test.cjs": 2.5,
  "apps/daemon/src/cli.test.cjs": 2.2,
  "packages/core/src/runtime-linear-issue.test.cjs": 2.2,
  "packages/shared/src/themes/custom.test.ts": 2.1,
  "apps/daemon/src/windows-transport.test.cjs": 2.1,
};

/**
 * Longest first, each to the least loaded shard: the slowest shard stays close to the average. Keeps the input order.
 * Files with the same `groupOf` key go to one shard as a single item, with `groupSeconds` added once for the cost they share.
 */
function shardOf(files, { index, count }, weight, { groupOf = () => null, groupSeconds = 0 } = {}) {
  const items = new Map();
  for (const file of files) {
    const key = groupOf(file) ?? file;
    const item = items.get(key) ?? { files: [], seconds: groupOf(file) ? groupSeconds : 0 };
    item.files.push(file);
    item.seconds += weight(file);
    items.set(key, item);
  }
  const loads = Array.from({ length: count }, () => 0);
  const owner = new Map();
  for (const item of [...items.values()].toSorted((a, b) => b.seconds - a.seconds || a.files[0].localeCompare(b.files[0]))) {
    const lightest = loads.indexOf(Math.min(...loads));
    loads[lightest] += item.seconds;
    for (const file of item.files) owner.set(file, lightest);
  }
  return files.filter((file) => owner.get(file) === index - 1);
}

/** Chromium's GPU process sometimes fails to start under Xvfb on the Linux CI runner; one retry absorbs it. */
function shouldRetry({ platform, ci, attempt }) {
  return platform === "linux" && Boolean(ci) && attempt === 1;
}

/**
 * One line per failed test or check, the same in every log, so triage across CI runs is a grep for `FAILED-TEST:`:
 * `FAILED-TEST: <file> › <test name> :: <reason>`, the test name only for node:test files.
 */
function failureLine(file, name, reason) {
  const flat = (text) =>
    String(text ?? "")
      .replace(/\s+/g, " ")
      .trim();
  return `FAILED-TEST: ${file}${name ? ` › ${flat(name)}` : ""} :: ${flat(reason).slice(0, 300) || "no error message"}`;
}

/**
 * What an Electron check printed about its failure: the last line that starts with an error (its catch prints the error
 * last), not Chromium's own `[pid:...:ERROR:...]` logging. Falls back to the last line printed.
 */
function failureReason(output) {
  const lines = String(output ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.findLast((line) => /^(?:\[?\w*(?:Error|Exception)\b|Timed out)/.test(line)) ?? lines.at(-1) ?? "";
}

/**
 * Only npm needs cmd.exe on Windows, where it is a .cmd script. Node must not go through it: cmd.exe splits its path at
 * "C:\Program Files" and caps a command line at 8,191 characters, under the length of the unit test file list.
 */
function needsShell(command, platform) {
  return platform === "win32" && command === "npm";
}

/**
 * Variables an agent's shell carries that CI never has. Inside a Milagre Chat, CLAUDE_CONFIG_DIR / CODEX_HOME /
 * GEMINI_HOME point at the Chat's account, so tests of the "connected CLI account" read that profile instead of the
 * default (runtime-project-accounts.test.cjs failed in a dozen agent sessions). ELECTRON_RUN_AS_NODE turns Electron
 * into Node. Git exports GIT_DIR and friends to hooks, and a fixture's `git init` then re-initialized the hook's own
 * repository as bare (#1044). The list of git's is `git rev-parse --local-env-vars`.
 */
const HOST_ENV = [
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "GEMINI_HOME",
  "ELECTRON_RUN_AS_NODE",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
];

/** The environment every test and check runs in: the caller's, minus HOST_ENV, so a run in an agent shell or a git hook matches CI. */
function testEnv(env) {
  const next = { ...env };
  for (const name of HOST_ENV) delete next[name];
  return next;
}

/** node:test file concurrency: CI keeps node's default (every core but one); a contributor's computer gets half its cores. */
function unitConcurrency({ ci, cores }) {
  return ci ? null : Math.max(1, Math.floor(cores / 2));
}

module.exports = {
  testEnv,
  unitConcurrency,
  failureLine,
  failureReason,
  HOST_ENV,
  needsShell,
  shouldRetry,
  discoverUnitTests,
  discoverElectronChecks,
  selectTests,
  affectedSelection,
  electronSeconds,
  parseArgs,
  MANIFEST,
  UNIT_SECONDS,
  WORKSPACES,
};
