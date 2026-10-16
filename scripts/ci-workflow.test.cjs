const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const YAML = require("yaml");

const read = (name) => YAML.parse(fs.readFileSync(path.join(__dirname, "../.github/workflows", name), "utf8"));
const ci = read("ci.yml");
const installAction = ".github/actions/install-dependencies";
const runs = (job) => job.steps.map((step) => step.run).filter(Boolean);
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

test("CI typechecks once and builds the renderer without a second typecheck", () => {
  const steps = new Set(runs(ci.jobs.static));
  assert.ok(steps.has("npm run typecheck"));
  assert.ok(steps.has("npm run build:renderer --workspace milagre"));
  assert.ok(!steps.has("npm run build"));
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

test("CI runs the unit suite through the single test command, one shard per matrix leg", () => {
  const job = ci.jobs.unit;
  const shards = job.strategy.matrix.shard;
  assert.deepEqual(
    shards,
    Array.from({ length: shards.length }, (_, i) => i + 1),
  );
  // The shard count comes from the matrix itself, so the two cannot drift apart.
  assert.ok(runs(job).includes("npm test -- --unit --shard ${{ matrix.shard }}/${{ strategy.job-total }}"));
  assert.ok(!Object.values(ci.jobs).some((other) => runs(other).some((run) => /npm run test:/.test(run))), "no per-suite scripts left in CI");
});

test("the required javascript check passes only when every JavaScript job passed", () => {
  const gate = ci.jobs.javascript;
  assert.equal(gate.if, "always()");
  assert.deepEqual(gate.needs, ["static", "supply-chain", "unit"]);
  // A skipped or cancelled job must fail the gate, or branch protection would accept a PR whose checks never ran.
  const script = runs(gate).join("\n");
  for (const need of gate.needs) assert.ok(gate.steps[0].env.RESULTS.includes(`needs.${need}.result`), need);
  assert.match(script, /\[ "\$result" = success \] \|\| exit 1/);
});

test("Windows and Linux native tests run on PRs without building an installer", () => {
  const job = ci.jobs["native-tests"];
  assert.deepEqual(
    job.strategy.matrix.include.map((item) => item.os),
    ["windows-latest", "ubuntu-24.04"],
  );
  const runs = JSON.stringify(job.steps);
  assert.ok(
    runs.includes("windows-runtime.test.cjs") &&
      runs.includes("windows-transport.test.cjs") &&
      runs.includes("process-tree.test.cjs") &&
      runs.includes("ownership.test.cjs"),
  );
  assert.ok(runs.includes("MILAGRE_LINUX_REPOSITORY_INTEGRATION=1"));
  assert.ok(!runs.includes("package:"), "native tests never package");
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
  for (const name of ["static", "supply-chain", "unit"]) assert.equal(ci.jobs[name].if, undefined, `${name} always runs`);
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
  assert.ok(occurrences.length >= 2, "the ffmpeg lookup and the test run both name the shard");
  for (const rest of occurrences) assert.ok(rest.startsWith("${{ matrix.shard }}/${{ strategy.job-total }}"), rest.slice(0, 40));
  const upload = job.steps.find((step) => step.uses?.startsWith("actions/upload-artifact"));
  assert.equal(upload.if, "always()");
  // upload-artifact v4 rejects a second artifact with the same name in one run.
  assert.match(upload.with.name, /\$\{\{ matrix\.shard \}\}/);
  assert.equal(upload.with.path, "${{ runner.temp }}/electron-screenshots");
});

test("CI lints every workspace with oxlint, which carries the Expo rules for mobile", () => {
  const steps = new Set(runs(ci.jobs.static));
  assert.ok(steps.has("npm run lint"));
  assert.ok(!steps.has("npm run lint --workspace @milagre/mobile"));
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, "../.oxlintrc.json"), "utf8"));
  const mobile = config.overrides.find((override) => override.files.includes("apps/mobile/**"));
  assert.deepEqual(mobile.jsPlugins, ["./apps/mobile/lint/expo-env.mjs"]);
  for (const rule of ["react/refs", "react/set-state-in-effect", "react/purity", "expo/no-env-var-destructuring", "expo/no-dynamic-env-var"]) {
    assert.equal(mobile.rules[rule], "error", rule);
  }
});

test("CI checks formatting right after linting", () => {
  const steps = ci.jobs.static.steps;
  const lint = steps.findIndex((step) => step.run === "npm run lint");
  assert.equal(steps[lint + 1].name, "Format check");
  assert.equal(steps[lint + 1].run, "npm run format:check");
  assert.equal(require("../package.json").scripts["format:check"], "oxfmt --check .");
});

test("CI looks for dead code right after the format check", () => {
  const steps = ci.jobs.static.steps;
  const format = steps.findIndex((step) => step.run === "npm run format:check");
  assert.equal(steps[format + 1].name, "Dead code");
  assert.equal(steps[format + 1].run, "npm run knip");
  assert.equal(require("../package.json").scripts.knip, "knip");
});

test("CI lints the lockfile before installing and verifies signatures after", () => {
  const steps = ci.jobs["supply-chain"].steps;
  const install = steps.findIndex((step) => step.uses === `./${installAction}`);
  assert.equal(
    steps[install - 1].run,
    "npx --yes lockfile-lint@5.0.1 --path package-lock.json --type npm --allowed-hosts npm --validate-https --validate-integrity",
  );
  assert.equal(steps[install + 1].run, "npm audit signatures");
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
