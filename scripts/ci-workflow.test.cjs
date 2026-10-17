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

test("a run is at most 10 jobs, so two runs fit under the account's 20 concurrent jobs", () => {
  const jobs = Object.entries(ci.jobs).filter(([name]) => name !== "release");
  const total = jobs.reduce((sum, [, job]) => sum + (job.strategy?.matrix?.shard?.length ?? 1), 0);
  assert.ok(total <= 10, `${total} jobs per run`);
});

test("CI typechecks once and builds the renderer without a second typecheck", () => {
  const commands = new Set(runs(ci.jobs.javascript));
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

test("the release job waits for the required checks, not the change filter or desktop-checks", () => {
  const needs = [ci.jobs.release.needs].flat();
  assert.ok(needs.includes("javascript"));
  assert.ok(!needs.includes("desktop-checks"));
  assert.ok(!needs.includes("changes"));
});

test("CI runs the whole unit suite through the single test command, as one step of the javascript job", () => {
  assert.ok(runs(ci.jobs.javascript).includes("npm test -- --unit"));
  const every = Object.values(ci.jobs).flatMap((job) => runs(job));
  assert.ok(!every.some((run) => /npm run test:/.test(run)), "no per-suite scripts left in CI");
  assert.ok(!every.some((run) => /--unit --shard/.test(run)), "node --test already uses every core; a second unit shard on the runner would fight it for them");
});

test("the required javascript check is one job whose checks run as parallel steps, each with its own log", () => {
  const job = ci.jobs.javascript;
  assert.equal(job.needs, undefined);
  assert.equal(job.if, undefined, "javascript always runs");
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
    "npm run typecheck:site",
    "npm run build:site",
    "npm run build:renderer --workspace milagre",
    "npm audit signatures",
    "npm test -- --unit",
  ])
    assert.ok(commands.includes(command), command);
  for (const step of group.parallel) assert.ok(step.name && step.run, "every parallel step is named and runs a command");
  // The gate job went with the jobs it gathered.
  for (const name of ["static", "supply-chain", "unit"]) assert.equal(ci.jobs[name], undefined, `${name} folded into javascript`);
});

test("Windows native tests run on PRs without building an installer; Linux repository signing is a javascript step", () => {
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
  const signing = steps(ci.jobs.javascript).find((step) => step.name === "Test real Linux repository signing");
  assert.match(signing.run, /MILAGRE_LINUX_REPOSITORY_INTEGRATION=1 node --test scripts\/linux-repository\.test\.cjs/);
  assert.match(signing.run, /apt-get install .*rpm createrepo-c gnupg/);
  assert.match(signing.run, /rm -rf "\$GNUPGHOME"/);
});

test("native tests and Electron checks run only when a PR touches desktop code; the JavaScript job always runs", () => {
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
  for (const name of ["native-tests", "desktop-checks"]) {
    assert.equal(ci.jobs[name].needs, "changes", `${name} waits for the change detection`);
    assert.equal(ci.jobs[name].if, "needs.changes.outputs.desktop == 'true'", `${name} is skipped on PRs without desktop changes`);
  }
  assert.equal(ci.jobs.javascript.if, undefined, "javascript always runs");
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

test("Electron checks run on Ubuntu under xvfb, two streams per runner on displays of their own, screenshots kept per runner", () => {
  const job = ci.jobs["desktop-checks"];
  assert.equal(job["runs-on"], "ubuntu-24.04");
  const shards = job.strategy.matrix.shard;
  assert.deepEqual(
    shards,
    Array.from({ length: shards.length }, (_, i) => i + 1),
  );
  // Each runner takes slices 2k-1 and 2k of 2n; both come from the matrix, so the counts cannot drift apart.
  const slices = job.steps.find((step) => step.name === "Name this runner's two slices").run;
  assert.ok(slices.includes("SLICE_A=$((2 * ${{ matrix.shard }} - 1))/$((2 * ${{ strategy.job-total }}))"), slices);
  assert.ok(slices.includes("SLICE_B=$((2 * ${{ matrix.shard }}))/$((2 * ${{ strategy.job-total }}))"), slices);
  const group = job.steps.find((step) => step.parallel);
  assert.equal(group.parallel.length, 2);
  const displays = new Set();
  for (const [stream, slice] of [
    [group.parallel[0], "$SLICE_A"],
    [group.parallel[1], "$SLICE_B"],
  ]) {
    const display = /^xvfb-run -n (\d+) /.exec(stream.run);
    assert.ok(display, stream.run);
    displays.add(display[1]);
    assert.ok(stream.run.endsWith(`npm test -- --electron --skip-build --shard "${slice}"`), stream.run);
  }
  assert.equal(displays.size, 2, "the streams never share an X display");
  // The renderer is built once before the streams start, so no stream writes dist while the other reads it.
  const build = job.steps.findIndex((step) => step.run === "npm run build:renderer --workspace milagre");
  assert.ok(build >= 0 && build < job.steps.indexOf(group), "build before the streams");
  // The ffmpeg lookup covers both slices.
  const libraries = job.steps.find((step) => step.name === "Install display and Electron libraries").run;
  assert.ok(libraries.includes('--shard "$SLICE_A"') && libraries.includes('--shard "$SLICE_B"'), libraries);
  for (const name of ["LIBGL_ALWAYS_SOFTWARE", "ELECTRON_ENABLE_LOGGING"]) assert.ok(job.env[name], name);
  // A job-level env can't name runner.temp; the slices step exports the folder, and the upload names the same one.
  assert.ok(slices.includes('echo "MILAGRE_SCREENSHOT_DIR=$RUNNER_TEMP/electron-screenshots"') && slices.includes('} >> "$GITHUB_ENV"'), slices);
  const upload = job.steps.find((step) => step.uses?.startsWith("actions/upload-artifact"));
  assert.equal(upload.if, "always()");
  // upload-artifact v4 rejects a second artifact with the same name in one run.
  assert.match(upload.with.name, /\$\{\{ matrix\.shard \}\}/);
  assert.equal(upload.with.path, "${{ runner.temp }}/electron-screenshots");
});

test("CI lints every workspace with oxlint, which carries the Expo rules for mobile", () => {
  const commands = new Set(runs(ci.jobs.javascript));
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
  const commands = runs(ci.jobs.javascript);
  for (const command of ["npm run lint", "npm run format:check", "npm run knip"]) assert.ok(commands.includes(command), command);
  const scripts = require("../package.json").scripts;
  assert.equal(scripts["format:check"], "oxfmt --check .");
  assert.equal(scripts.knip, "knip");
});

test("CI lints the lockfile before installing and verifies signatures after", () => {
  const job = ci.jobs.javascript;
  const install = job.steps.findIndex((step) => step.uses === `./${installAction}`);
  assert.equal(
    job.steps[install - 1].run,
    "npx --yes lockfile-lint@5.0.1 --path package-lock.json --type npm --allowed-hosts npm --validate-https --validate-integrity",
  );
  const group = job.steps.findIndex((step) => step.parallel);
  assert.ok(group > install, "the checks, signatures among them, run after the install");
  assert.ok(runs(job).includes("npm audit signatures"));
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
  assert.equal(setup.with["node-version"], 24);
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
  assert.deepEqual(ci.jobs.release.needs, ["javascript", "native-gate", "macos-desktop-smoke"]);
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
  // The release candidate keeps its own gate list; desktop-gate guards merges, not candidates.
  assert.ok(!ci.jobs.release.needs.includes("desktop-gate"));
});
