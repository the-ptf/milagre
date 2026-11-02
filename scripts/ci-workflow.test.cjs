const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const YAML = require("yaml");

const read = (name) => YAML.parse(fs.readFileSync(path.join(__dirname, "../.github/workflows", name), "utf8"));
const ci = read("ci.yml");
const installAction = ".github/actions/install-dependencies";
/** A job's steps with every `parallel` group unfolded into its members. */
const steps = (job) => job.steps.flatMap((step) => step.parallel ?? [step]);
const runs = (job) =>
  steps(job)
    .map((step) => step.run)
    .filter(Boolean);
const candidates = read("package-candidates.yml");

test("CI and candidate runs on one ref cancel the previous PR run but never a main run", () => {
  for (const workflow of [ci, candidates]) {
    assert.equal(workflow.concurrency.group, `${workflow.name.toLowerCase().replace(/ /g, "-")}-\${{ github.ref }}`);
    assert.equal(workflow.concurrency["cancel-in-progress"], "${{ github.event_name == 'pull_request' }}");
  }
});

test("every CI job has a timeout", () => {
  for (const [name, job] of Object.entries(ci.jobs)) assert.ok(Number.isInteger(job["timeout-minutes"]), `${name} needs timeout-minutes`);
});

test("a PR run is at most 20 jobs, the account's concurrency", () => {
  // Jobs that only run on a push to main (Next beta draft, macOS smoke) never take a PR run's slots.
  const jobs = Object.values(ci.jobs).filter((job) => !/github\.event_name (== 'push'|!= 'pull_request')/.test(job.if ?? ""));
  const total = jobs.reduce((sum, job) => {
    const matrix = job.strategy?.matrix ?? {};
    assert.ok(!("include" in matrix) && !("exclude" in matrix), "update the counter before using matrix include/exclude");
    return sum + Object.values(matrix).reduce((legs, values) => legs * values.length, 1);
  }, 0);
  assert.ok(total <= 20, `${total} jobs per PR run`);
});

test("CI typechecks once and builds the renderer without a second typecheck", () => {
  const commands = new Set(runs(ci.jobs["quick-checks"]));
  assert.ok(commands.has("npm run typecheck"));
  assert.ok(commands.has("npm run build:renderer --workspace milagre"));
  assert.ok(!commands.has("npm run build"));
});

test("desktop agent tests do not repeat the renderer logic tests", () => {
  const desktop = require("../apps/desktop/package.json").scripts;
  assert.equal(desktop["test:agent"], "node --test electron/*.test.cjs");
  assert.equal(desktop["test:ui"], 'node --test "app/src/**/*.test.ts"');
});

test("every action is pinned to a full SHA with its version in a comment", () => {
  const files = [...fs.readdirSync(path.join(__dirname, "../.github/workflows")).map((name) => `workflows/${name}`), `actions/install-dependencies/action.yml`];
  for (const name of files) {
    const text = fs.readFileSync(path.join(__dirname, "../.github", name), "utf8");
    for (const line of text.split("\n").filter((line) => /^\s*-?\s*uses:/.test(line))) {
      assert.match(line, /uses: (\.\/\S+|[^@\s]+@[0-9a-f]{40} # v\d+\.\d+\.\d+)/, `${name}: ${line.trim()}`);
    }
  }
});

test("the Next beta draft waits for the required checks, not the change filter or desktop-checks", () => {
  assert.equal(ci.jobs.release, undefined, "merges cut no release");
  const needs = new Set([ci.jobs["next-beta"].needs].flat());
  assert.ok(needs.has("javascript"));
  assert.ok(!needs.has("desktop-checks"));
  assert.ok(!needs.has("changes"));
});

test("CI tests both supported Node runtimes on separate runners and gates on both", () => {
  const job = ci.jobs.unit;
  assert.deepEqual(job.strategy.matrix, { node: [24, 26] });
  const install = job.steps.find((step) => step.uses === `./${installAction}`);
  assert.equal(install.with["node-version"], "${{ matrix.node }}");
  assert.ok(runs(job).includes("npm test -- --unit"), "each runtime runs the entire suite");
  const cli = job.steps.find((step) => step.run === "node scripts/test-cli-package.cjs");
  assert.equal(cli.if, "matrix.node == 24", "Node 26 already runs the installed CLI in the Electron shards");
  assert.ok(ci.jobs.javascript.needs.includes("unit"), "both versions gate JavaScript CI");
  const action = YAML.parse(fs.readFileSync(path.join(__dirname, "../.github/actions/install-dependencies/action.yml"), "utf8"));
  assert.equal(action.inputs["node-version"].default, "26");
  assert.equal(action.runs.steps[0].with["node-version"], "${{ inputs.node-version }}");
  assert.ok(
    action.runs.steps.find((step) => step.id === "cache").with.key.includes("node${{ inputs.node-version }}-"),
    "native caches are isolated by Node version",
  );
  // Beside the quick checks the suite took longer: node --test wants the whole runner.
  assert.ok(!runs(ci.jobs["quick-checks"]).some((run) => /--unit/.test(run)), "no unit tests among the quick checks");
  const every = Object.values(ci.jobs).flatMap((job) => runs(job));
  assert.ok(!every.some((run) => /npm run test:/.test(run)), "no per-suite scripts left in CI");
});

test("independent quick checks run in parallel, while the site commands sharing Astro's cache run sequentially", () => {
  const job = ci.jobs["quick-checks"];
  assert.equal(job.needs, undefined);
  assert.equal(job.if, undefined, "quick-checks always runs");
  const group = job.steps.find((step) => step.parallel);
  assert.ok(group, "the checks form a parallel group");
  const commands = group.parallel.map((step) => step.run);
  for (const command of [
    "npm run typecheck",
    "npm run lint",
    "npm run format:check",
    "npm run knip",
    "npm run typecheck:mobile",
    "npm run typecheck:relay",
    "npm run build:renderer --workspace milagre",
  ])
    assert.ok(commands.includes(command), command);
  const site = commands.filter((command) => /npm run (typecheck|build):site/.test(command));
  assert.equal(site.length, 1, "Astro commands must share one sequential step to avoid a .vite cache rename race");
  assert.deepEqual(
    site[0]
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim()),
    ["npm run typecheck:site", "npm run build:site"],
  );
  for (const step of group.parallel) assert.ok(step.name && step.run, "every parallel step is named and runs a command");
  for (const name of ["static", "supply-chain"]) assert.equal(ci.jobs[name], undefined, `${name} folded into quick-checks`);
});

test("package signatures are verified once per lockfile: a cached marker keyed on its hash stands in afterwards", () => {
  const job = ci.jobs["quick-checks"];
  const cache = job.steps.find((step) => step.uses?.startsWith("actions/cache@"));
  assert.equal(cache.with.path, "${{ runner.temp }}/signatures-verified");
  assert.match(cache.with.key, /hashFiles\('package-lock\.json'\)/);
  assert.ok(job.steps.indexOf(cache) < job.steps.findIndex((step) => step.parallel), "restored before the checks run");
  const verify = steps(job).find((step) => step.name === "Verify package signatures").run;
  assert.match(verify, /if \[ -f "\$RUNNER_TEMP\/signatures-verified" \]; then .* exit 0; fi/);
  assert.match(verify, /npm audit signatures && touch "\$RUNNER_TEMP\/signatures-verified"/);
});

test("the required javascript check passes only when the quick checks and both runtime suites passed", () => {
  const gate = ci.jobs.javascript;
  assert.equal(gate.if, "always()");
  assert.deepEqual(gate.needs, ["quick-checks", "unit"]);
  // A skipped or cancelled job must fail the gate, or the queue would accept a PR whose checks never ran.
  for (const need of gate.needs) assert.ok(gate.steps[0].env.RESULTS.includes(`needs.${need}.result`), need);
  assert.match(runs(gate).join("\n"), /\[ "\$result" = success \] \|\| exit 1/);
});

test("the macOS smoke runs on pushes to main only and still gates the Next beta draft and the desktop gate", () => {
  const job = ci.jobs["macos-desktop-smoke"];
  assert.equal(job.if, "github.event_name == 'push'");
  assert.equal(job.needs, undefined);
  assert.ok(
    job.steps.some((step) => step.uses === `./${installAction}`),
    "node_modules come from the cache, not a 64 s npm ci",
  );
  assert.ok(runs(job).includes("npm test -- --only test-desktop"));
  // A beta ships only a main commit whose whole CI run passed, this job included (scripts/plan-release.cjs).
  assert.ok(ci.jobs["next-beta"].needs.includes("macos-desktop-smoke"));
  assert.ok(ci.jobs["desktop-gate"].needs.includes("macos-desktop-smoke"), "skipped on a PR, which the gate accepts");
  // The local run replaces it on PRs.
  assert.match(fs.readFileSync(path.join(__dirname, "../AGENTS.md"), "utf8"), /npm test -- --only test-desktop` on your Mac/);
});

test("Windows native tests run without building an installer; Linux repository signing is a quick-checks step", () => {
  const job = ci.jobs["native-tests"];
  assert.equal(job["runs-on"], "windows-latest");
  assert.equal(job.strategy, undefined, "one leg, no matrix");
  const text = JSON.stringify(job.steps);
  assert.ok(
    text.includes("windows-runtime.test.cjs") &&
      text.includes("windows-transport.test.cjs") &&
      text.includes("process-tree.test.cjs") &&
      text.includes("ownership.test.cjs"),
  );
  assert.ok(!text.includes("package:"), "native tests never package");
  const signing = steps(ci.jobs["quick-checks"]).find((step) => step.name === "Test real Linux repository signing");
  assert.match(signing.run, /MILAGRE_LINUX_REPOSITORY_INTEGRATION=1 node --test scripts\/linux-repository\.test\.cjs/);
  assert.match(signing.run, /apt-get install .*rpm createrepo-c gnupg/);
  assert.match(signing.run, /rm -rf "\$GNUPGHOME"/);
});

test("Electron and Windows checks run when a PR touches desktop code; the JavaScript jobs always run", () => {
  const changes = ci.jobs.changes;
  assert.ok(changes, "a changes job decides what a PR touched");
  const filter = changes.steps.find((step) => step.id === "filter");
  assert.equal(filter.if, "github.event_name == 'pull_request'", "the filter only runs where a PR base exists; pushes run every job");
  assert.equal(filter.uses, "dorny/paths-filter@d1c1ffe0248fe513906c8e24db8ea791d46f8590");
  const desktop = YAML.parse(filter.with.filters).desktop;
  assert.ok(desktop.includes("apps/desktop/**") && desktop.includes("packages/**"));
  assert.ok(desktop.includes(".github/actions/**"), "a change to the install action reruns the jobs that use it");
  assert.ok(!desktop.includes("apps/mobile/**"), "mobile-only PRs skip the desktop jobs");
  assert.equal(changes.outputs.desktop, "${{ github.event_name != 'pull_request' || steps.filter.outputs.desktop == 'true' }}");
  assert.equal(ci.jobs["desktop-checks"].needs, "changes", "desktop-checks waits for the change detection");
  assert.equal(ci.jobs["desktop-checks"].if, "needs.changes.outputs.desktop == 'true'", "desktop-checks is skipped on PRs without desktop changes");
  assert.equal(ci.jobs["native-tests"].if, "needs.changes.outputs.desktop == 'true'");
  assert.equal(ci.jobs["native-tests"].needs, "changes");
  for (const name of ["quick-checks", "unit"]) assert.equal(ci.jobs[name].if, undefined, `${name} always runs`);
});

test("installers build on main, on dispatch, and on PRs only with the preview:installers label", () => {
  assert.deepEqual(candidates.on.pull_request.types, ["labeled", "synchronize", "reopened"]);
  assert.equal(candidates.on.pull_request.paths, undefined);
  assert.deepEqual(candidates.on.push, { branches: ["main"], paths: candidates.on.push.paths });
  assert.equal(
    candidates.jobs.package.if,
    "${{ github.event_name != 'pull_request' || contains(github.event.pull_request.labels.*.name, 'preview:installers') }}",
  );
});

test("Electron checks run on Ubuntu under xvfb, one shard per matrix leg, with screenshots kept per shard", () => {
  const job = ci.jobs["desktop-checks"];
  assert.equal(job["runs-on"], "ubuntu-24.04");
  // The shard count in the command must match the matrix, or checks are silently dropped or run twice.
  const shards = job.strategy.matrix.shard;
  assert.deepEqual(
    shards,
    Array.from({ length: shards.length }, (_, i) => i + 1),
  );
  const run = job.steps.map((step) => step.run).find((command) => command?.includes("npm test -- --electron"));
  assert.match(run, /^xvfb-run /);
  assert.ok(run.endsWith("npm test -- --electron --shard ${{ matrix.shard }}/${{ strategy.job-total }}"), run);
  // Every place the job names a shard (the ffmpeg lookup too) takes the count from the matrix, or the lookup picks the wrong shard.
  const occurrences = JSON.stringify(job.steps).split("--shard ").slice(1);
  assert.ok(occurrences.length >= 1, "the test run names the shard");
  for (const rest of occurrences) assert.ok(rest.startsWith("${{ matrix.shard }}/${{ strategy.job-total }}"), rest.slice(0, 40));
  // One Electron stream per runner: two streams were measured 30 s slower with three to eight retries a run.
  assert.ok(!job.steps.some((step) => step.parallel), "no parallel group in the Electron job");
  const upload = job.steps.find((step) => step.uses?.startsWith("actions/upload-artifact"));
  assert.equal(upload.if, "always()");
  // upload-artifact v4 rejects a second artifact with the same name in one run.
  assert.match(upload.with.name, /\$\{\{ matrix\.shard \}\}/);
  assert.equal(upload.with.path, "${{ runner.temp }}/electron-screenshots");
});

test("CI lints every workspace with oxlint, which carries the Expo rules for mobile", () => {
  const commands = new Set(runs(ci.jobs["quick-checks"]));
  assert.ok(commands.has("npm run lint"));
  assert.ok(!commands.has("npm run lint --workspace @milagre/mobile"));
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, "../.oxlintrc.json"), "utf8"));
  const mobile = config.overrides.find((override) => override.files.includes("apps/mobile/**"));
  assert.deepEqual(mobile.jsPlugins, ["./apps/mobile/lint/expo-env.mjs"]);
  for (const rule of ["react/refs", "react/set-state-in-effect", "react/purity", "expo/no-env-var-destructuring", "expo/no-dynamic-env-var"]) {
    assert.equal(mobile.rules[rule], "error", rule);
  }
});

test("lint, format check and dead code are parallel steps of the javascript job, on the repo's oxfmt and knip scripts", () => {
  const commands = runs(ci.jobs["quick-checks"]);
  for (const command of ["npm run lint", "npm run format:check", "npm run knip"]) assert.ok(commands.includes(command), command);
  const scripts = require("../package.json").scripts;
  assert.equal(scripts["format:check"], "oxfmt --check .");
  assert.equal(scripts.knip, "knip");
});

test("CI lints the lockfile before installing and verifies signatures after", () => {
  const job = ci.jobs["quick-checks"];
  const install = job.steps.findIndex((step) => step.uses === `./${installAction}`);
  assert.equal(
    job.steps[install - 1].run,
    "npx --yes lockfile-lint@5.0.1 --path package-lock.json --type npm --allowed-hosts npm --validate-https --validate-integrity",
  );
  const group = job.steps.findIndex((step) => step.parallel);
  assert.ok(group > install, "the checks, signatures among them, run after the install");
  assert.ok(runs(job).some((run) => /npm audit signatures/.test(run)));
});

test("a cached install is keyed on the lockfile and installs with npm ci only on a miss", () => {
  const action = YAML.parse(fs.readFileSync(path.join(__dirname, "..", installAction, "action.yml"), "utf8"));
  const cache = action.runs.steps.find((step) => step.uses?.startsWith("actions/cache@"));
  // A key without the lockfile and the mobile patches would restore a stale tree after either changes.
  assert.match(cache.with.key, /hashFiles\('package-lock\.json', 'apps\/mobile\/patches\/\*\*'\)/);
  assert.match(cache.with.key, /runner\.os/);
  const steps = action.runs.steps;
  const install = steps.findIndex((step) => step.run?.startsWith("npm ci"));
  // The download cache is only for misses: a warm run restores node_modules and nothing else.
  for (const step of steps.filter((step) => /actions\/cache\/(restore|save)@/.test(step.uses ?? "")))
    assert.match(step.if, new RegExp(`^steps\\.${cache.id}\\.outputs\\.cache-hit != 'true'`));
  assert.equal(steps[install].if, `steps.${cache.id}.outputs.cache-hit != 'true'`);
  // No install script runs before the lockfile's hosts and integrity hashes are checked.
  assert.match(steps[install - 1].run, /^npx --yes lockfile-lint@\d+\.\d+\.\d+ --path package-lock\.json/);
  assert.equal(steps[install - 1].if, steps[install].if);
});

test("PR titles must be Conventional Commits", () => {
  const regex = "/^(feat|fix|perf|docs|refactor|chore|ci|test|style|build|revert)(\\([a-z0-9-]+\\))?!?: \\S/";
  const workflow = read("pr-title.yml");
  assert.deepEqual(workflow.on.pull_request.types, ["opened", "edited", "synchronize", "reopened"]);
  const [setup, check] = workflow.jobs.conventional.steps;
  assert.match(setup.uses, /^actions\/setup-node@/);
  assert.equal(setup.with["node-version"], 26);
  const run = check.run;
  assert.ok(run.includes(regex), "workflow carries the expected regex");
  const title = new Function(`return ${regex}`)();
  assert.ok(title.test("feat!: x"));
  assert.ok(title.test("fix(mobile): y"));
  assert.ok(!title.test("Update readme"));
});

test("mobile fingerprint check watches the native inputs, needs the approval label and never builds", () => {
  const workflow = read("mobile-fingerprint.yml");
  assert.deepEqual(workflow.on.pull_request.paths, ["apps/mobile/**", "package-lock.json", "packages/shared/**"]);
  const text = fs.readFileSync(path.join(__dirname, "../.github/workflows/mobile-fingerprint.yml"), "utf8");
  assert.ok(!/eas build/.test(text), "the check never starts a build");
  assert.ok(text.includes("native-build-approved"));
  assert.ok(workflow.on.pull_request.types.includes("labeled") && workflow.on.pull_request.types.includes("unlabeled"));
  assert.ok(Number.isInteger(workflow.jobs.fingerprint["timeout-minutes"]));
  const steps = workflow.jobs.fingerprint.steps;
  assert.ok(steps.find((step) => step.name === "Fingerprint main").run.includes("npx patch-package --patch-dir apps/mobile/patches"));
  assert.ok(steps.find((step) => step.name === "Compare").run.includes("Could not read a fingerprint hash"));
});

test("a native-gate job always reports for branch protection and only fails when native tests failed", () => {
  const gate = ci.jobs["native-gate"];
  assert.ok(gate, "native-gate job exists");
  assert.equal(gate.if, "always()");
  assert.deepEqual(gate.needs, ["native-tests"]);
  const run = gate.steps.map((step) => step.run).join("\n");
  assert.match(run, /success\|skipped\) exit 0/);
  assert.deepEqual(ci.jobs["next-beta"].needs, ["javascript", "native-gate", "macos-desktop-smoke"]);
});

test("CI and the title check run on merge groups, so every required check reports before the queue merges", () => {
  // The merge queue tests the PR squashed onto current main; a required check that never reports there blocks the queue.
  assert.deepEqual(ci.on.merge_group, { types: ["checks_requested"] });
  // A merge group ref is never a pull request, so the change filter runs every job there (see the changes job test).
  const title = read("pr-title.yml");
  assert.deepEqual(title.on.merge_group, { types: ["checks_requested"] });
  // The title was checked to enter the queue; the merge group has no PR title, so the job reports green with every step skipped.
  for (const step of title.jobs.conventional.steps) assert.equal(step.if, "github.event_name == 'pull_request'", step.name ?? step.uses);
});

test("a desktop-gate job always reports for the merge queue and only fails when an Electron check or the macOS smoke failed", () => {
  const gate = ci.jobs["desktop-gate"];
  assert.ok(gate, "desktop-gate job exists");
  assert.equal(gate.if, "always()");
  assert.deepEqual(gate.needs, ["desktop-checks", "macos-desktop-smoke"]);
  // Both are skipped on PRs without desktop changes, which must stay mergeable; a failure or cancellation must not.
  for (const need of gate.needs) assert.ok(gate.steps[0].env.RESULTS.includes(`needs.${need}.result`), need);
  const script = runs(gate).join("\n");
  assert.match(script, /success\|skipped\) ;;/);
  assert.match(script, /\*\) exit 1/);
  // The Next beta draft keeps its own gate list; desktop-gate guards merges, not releases.
  assert.ok(!ci.jobs["next-beta"].needs.includes("desktop-gate"));
});
