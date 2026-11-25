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
const { MAX_SHARDS, NATIVE_TESTS } = require("./affected-tests.cjs");
/** A matrix axis's legs on a PR: an expression picks the PR branch (`'[26]'`) or the change filter's shard count. */
const prLegs = (values) =>
  Array.isArray(values) ? values.length : values.includes("needs.changes.outputs.shards") ? MAX_SHARDS : JSON.parse(/'(\[[^']*\])'/.exec(values)[1]).length;

test("CI and candidate runs on one ref cancel the previous PR run but never a main run", () => {
  assert.equal(ci.concurrency.group, "ci-${{ github.event_name }}-${{ github.ref }}");
  assert.equal(candidates.concurrency.group, "build-package-candidates-${{ github.ref }}");
  for (const workflow of [ci, candidates]) {
    assert.equal(workflow.concurrency["cancel-in-progress"], "${{ github.event_name == 'pull_request' }}");
  }
});

test("every CI job has a timeout", () => {
  for (const [name, job] of Object.entries(ci.jobs)) assert.ok(Number.isInteger(job["timeout-minutes"]), `${name} needs timeout-minutes`);
});

test("a PR run is at most 20 jobs, the account's concurrency", () => {
  const jobs = Object.values(ci.jobs).filter((job) => !/github\.event_name (== 'push'|== 'schedule'|!= 'pull_request')|outputs\.smoke/.test(job.if ?? ""));
  const total = jobs.reduce((sum, job) => {
    const matrix = job.strategy?.matrix ?? {};
    assert.ok(!("include" in matrix) && !("exclude" in matrix), "update the counter before using matrix include/exclude");
    return sum + Object.values(matrix).reduce((legs, values) => legs * prLegs(values), 1);
  }, 0);
  assert.ok(total <= 20, `${total} jobs per PR run`);
});

test("CI typechecks once and builds the renderer without a second typecheck", () => {
  const commands = new Set(runs(ci.jobs["quick-checks"]));
  assert.ok(commands.has("npm run typecheck"));
  assert.ok(commands.has("npm run build:renderer --workspace milagre"));
  assert.ok(!commands.has("npm run build"));
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

test("CI tests both supported Node runtimes on separate runners outside PRs, and Node 26 on PRs", () => {
  const job = ci.jobs.unit;
  assert.deepEqual(job.strategy.matrix, { node: "${{ fromJSON(github.event_name == 'pull_request' && '[26]' || '[24, 26]') }}" });
  const install = job.steps.find((step) => step.uses === `./${installAction}`);
  assert.equal(install.with["node-version"], "${{ matrix.node }}");
  assert.ok(
    runs(job).includes('npm test -- --unit ${BASE:+--changed "$BASE"}'),
    "PRs and pushes run affected tests; merge groups and nightly runs use the whole suite",
  );
  const cli = job.steps.find((step) => step.run === "node scripts/test-cli-package.cjs");
  assert.equal(cli.if, "matrix.node == 24 && needs.changes.outputs.cli == 'true'", "Node 26 already runs the installed CLI in the Electron shards");
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
});

test("independent quick checks run in parallel, while the site commands sharing Astro's cache run sequentially", () => {
  const job = ci.jobs["quick-checks"];
  assert.equal(job.needs, "changes");
  assert.equal(job.if, undefined);
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

test("the required javascript check passes only when the change filter, the quick checks and the planned unit tests passed", () => {
  const gate = ci.jobs.javascript;
  assert.equal(gate.if, "always()");
  assert.deepEqual(gate.needs, ["changes", "quick-checks", "unit"]);
  // A skipped or cancelled job must fail the gate, or the queue would accept a PR whose checks never ran.
  for (const need of ["changes", "quick-checks"]) assert.ok(gate.steps[0].env.RESULTS.includes(`needs.${need}.result`), need);
  assert.match(runs(gate).join("\n"), /\[ "\$result" = success \] \|\| exit 1/);
  assertSkipOnlyWhenUnplanned(gate, "UNIT", "unit");
});

/** A gate accepts a skipped job only when the change filter planned none of it: a failed filter skips it too. */
function assertSkipOnlyWhenUnplanned(gate, name, output) {
  const env = gate.steps[0].env;
  assert.equal(env[`${["UNIT", "SMOKE"].includes(name) ? `${name}_PLANNED` : "PLANNED"}`], `\${{ needs.changes.outputs.${output} }}`);
  const planned = ["UNIT", "SMOKE"].includes(name) ? `${name}_PLANNED` : "PLANNED";
  assert.ok(
    runs(gate).join("\n").includes(`[ "$${name}" = success ] || { [ "$${name}" = skipped ] && [ "$${planned}" = false ]; } || exit 1`),
    `${gate.name ?? name}: a skip passes only when the change filter planned nothing`,
  );
}

test("the macOS smoke follows the change plan and gates desktop verification", () => {
  const job = ci.jobs["macos-desktop-smoke"];
  assert.equal(job.if, "needs.changes.outputs.smoke == 'true'");
  assert.equal(job.needs, "changes");
  assert.ok(
    job.steps.some((step) => step.uses === `./${installAction}`),
    "node_modules come from the cache, not a 64 s npm ci",
  );
  assert.ok(runs(job).includes("npm test -- --only test-desktop"));
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
  assert.ok(text.includes("npm test -- --unit --only scripts/test-runner"), "the runner itself runs on Windows");
  assert.ok(!text.includes("package:"), "native tests never package");
  const signing = steps(ci.jobs["quick-checks"]).find((step) => step.name === "Test real Linux repository signing");
  assert.match(signing.run, /MILAGRE_LINUX_REPOSITORY_INTEGRATION=1 node --test scripts\/linux-repository\.test\.cjs/);
  assert.equal(signing.if, "needs.changes.outputs.signing == 'true'");
  assert.match(signing.run, /apt-get install .*rpm createrepo-c gnupg/);
  assert.match(signing.run, /rm -rf "\$GNUPGHOME"/);
});

test("PRs and pushes use the same base across CI jobs; the merge queue and nightly runs have no filter", () => {
  const changes = ci.jobs.changes;
  assert.equal(changes.if, undefined, "the change filter runs on every event, so the gates can require it");
  const checkout = changes.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
  assert.equal(checkout.with["fetch-depth"], "${{ github.event.commits[1] && '0' || 2 }}", "a PR's merge commit and its base");
  const plan = changes.steps.find((step) => step.id === "plan");
  assert.equal(
    ci.env.BASE,
    "${{ github.event_name == 'pull_request' && 'HEAD^1' || github.event_name == 'push' && !github.event.forced && github.event.before || '' }}",
  );
  assert.deepEqual(ci.on.schedule, [{ cron: "17 5 * * *" }]);
  const report = ci.jobs["nightly-failure"];
  assert.equal(report.if, "failure() && github.event_name == 'schedule'");
  assert.deepEqual(report.needs, ["javascript", "native-gate", "desktop-gate"]);
  assert.ok(runs(report)[0].includes("gh issue create"));
  assert.equal(plan.run, 'node scripts/affected-tests.cjs ${BASE:+--base "$BASE"} --github-output');
  for (const output of ["unit", "electron", "native", "shards", "smoke", "signing", "site", "cli"])
    assert.equal(changes.outputs[output], `\${{ steps.plan.outputs.${output} }}`);
  assert.equal(ci.jobs.unit.if, "needs.changes.outputs.unit == 'true'");
  assert.equal(ci.jobs["desktop-checks"].if, "needs.changes.outputs.electron == 'true'");
  assert.equal(ci.jobs["native-tests"].if, "needs.changes.outputs.native == 'true'");
  for (const name of ["unit", "desktop-checks", "native-tests"]) assert.equal(ci.jobs[name].needs, "changes", name);
  assert.equal(ci.jobs["quick-checks"].if, undefined, "quick-checks always runs");
  // Each job that selects by --changed recomputes the same selection, so it needs the base commit too.
  for (const name of ["unit", "desktop-checks"]) {
    const job = ci.jobs[name];
    assert.ok(
      runs(job).some((run) => run.includes('${BASE:+--changed "$BASE"}')),
      name,
    );
    const jobCheckout = job.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    assert.equal(jobCheckout.with["fetch-depth"], "${{ github.event.commits[1] && '0' || 2 }}", name);
  }
});

test("the Windows job's test files are the ones the change filter watches for it", () => {
  const named = new Set(JSON.stringify(ci.jobs["native-tests"].steps).match(/[\w/.-]+\.test\.cjs/g));
  for (const prefix of ["scripts/test-runner", "scripts/launch-env"]) named.add(`${prefix}.test.cjs`);
  assert.deepEqual([...named].toSorted(), NATIVE_TESTS.toSorted());
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
  assert.equal(job.strategy.matrix.shard, "${{ fromJSON(needs.changes.outputs.shards) }}", "the change filter sizes the matrix");
  const run = job.steps.map((step) => step.run).find((command) => command?.includes("npm test -- --electron"));
  assert.match(run, /^xvfb-run /);
  assert.ok(run.endsWith('npm test -- --electron ${BASE:+--changed "$BASE"} --shard ${{ matrix.shard }}/${{ strategy.job-total }}'), run);
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
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, "../.oxlintrc.json"), "utf8"));
  const mobile = config.overrides.find((override) => override.files.includes("apps/mobile/**"));
  assert.deepEqual(mobile.jsPlugins, ["./apps/mobile/lint/expo-env.mjs"]);
  for (const rule of ["react/refs", "react/set-state-in-effect", "react/purity", "expo/no-env-var-destructuring", "expo/no-dynamic-env-var"]) {
    assert.equal(mobile.rules[rule], "error", rule);
  }
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
  const cache = steps.find((step) => step.id === "cache");
  assert.equal(cache.with.key, "fingerprint-${{ github.event.pull_request.head.sha }}-${{ github.event.pull_request.base.sha }}");
  const compare = steps.at(-1);
  assert.equal(compare.name, "Compare");
  assert.equal(compare.if, undefined);
  assert.ok(compare.env.APPROVED.includes("github.event.pull_request.labels"));
  for (const step of steps.slice(1, -1)) assert.equal(step.if, "steps.cache.outputs.cache-hit != 'true'");
  const save = steps.at(-2);
  assert.ok(save.uses.startsWith("actions/cache/save@"));
  assert.equal(save.with.key, "${{ steps.cache.outputs.cache-primary-key }}");
  assert.equal(save.with.path, cache.with.path);
  assert.ok(steps.find((step) => step.name === "Compare").run.includes("Could not read a fingerprint hash"));
});

test("a native-gate job always reports for branch protection and only fails when native tests failed or were wrongly skipped", () => {
  const gate = ci.jobs["native-gate"];
  assert.ok(gate, "native-gate job exists");
  assert.equal(gate.if, "always()");
  assert.deepEqual(gate.needs, ["changes", "native-tests"]);
  assert.match(runs(gate).join("\n"), /\[ "\$CHANGES" = success \] \|\| exit 1/);
  assertSkipOnlyWhenUnplanned(gate, "RESULT", "native");
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
  assert.deepEqual(gate.needs, ["changes", "desktop-checks", "macos-desktop-smoke"]);
  // The Electron checks are skipped on PRs whose change reaches none, which must stay mergeable; a failure, a
  // cancellation or a skip caused by a failed change filter must not.
  const script = runs(gate).join("\n");
  assert.match(script, /\[ "\$CHANGES" = success \] \|\| exit 1/);
  assertSkipOnlyWhenUnplanned(gate, "CHECKS", "electron");
  assert.equal(gate.steps[0].env.SMOKE, "${{ needs.macos-desktop-smoke.result }}");
  assertSkipOnlyWhenUnplanned(gate, "SMOKE", "smoke");
});

test("PR policy reruns on label changes, checks each rule in its own step and reports green on merge groups", () => {
  const workflow = read("pr-policy.yml");
  assert.deepEqual(workflow.on.pull_request.types, ["opened", "edited", "synchronize", "reopened", "labeled", "unlabeled"]);
  assert.deepEqual(workflow.on.merge_group, { types: ["checks_requested"] });
  assert.deepEqual(Object.keys(workflow.jobs), ["policy"], "one cheap job");
  const job = workflow.jobs.policy;
  assert.ok(Number.isInteger(job["timeout-minutes"]));
  const checkout = job.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
  assert.equal(checkout.with["fetch-depth"], 2, "the merge commit and the base it merges into, not the whole history");
  // A merge group has no PR, so every step is skipped there and the job reports green.
  for (const step of job.steps) assert.match(step.if, /github\.event_name == 'pull_request'/, step.name ?? step.uses);
  const run = runs(job).join("\n");
  assert.match(run, /git diff --name-status -M HEAD\^1 HEAD/);
  assert.match(run, /node scripts\/pr-policy\.cjs images/);
  assert.match(run, /node scripts\/pr-policy\.cjs sync/);
  assert.match(run, /node scripts\/check-lighthouse-budget\.cjs .*apps\/site\/lighthouse-budget\.json/);
  for (const name of ["Desktop and mobile change together (warning only)", "Lighthouse budget never gets looser"]) {
    const step = job.steps.find((candidate) => candidate.name === name);
    assert.equal(step.env.LABELS, "${{ toJSON(github.event.pull_request.labels.*.name) }}", name);
    assert.match(step.if, /!cancelled\(\)/, `${name} reports even when an earlier rule failed`);
  }
});

test("a PR touching the site runs the Lighthouse budget check in its own workflow", () => {
  const workflow = read("site-lighthouse.yml");
  for (const file of [
    "apps/site/src/pages/index.astro",
    "scripts/site-og.cjs",
    "scripts/share-og.cjs",
    "scripts/site-demo/record.cjs",
    "scripts/test-site.cjs",
  ])
    assert.ok(
      workflow.on.pull_request.paths.some((pattern) => path.matchesGlob(file, pattern)),
      file,
    );
  const quick = steps(ci.jobs["quick-checks"]);
  const smoke = quick.find((step) => step.run?.includes("--only test-site.cjs"));
  assert.equal(smoke.if, "needs.changes.outputs.site == 'true'");
  assert.equal(quick.find((step) => step.run === "npm test -- --only lighthouse").if, "github.event_name == 'push' && needs.changes.outputs.site == 'true'");
  assert.ok(workflow.on.pull_request.paths.includes("DESIGN.md"), "the /design page is built from DESIGN.md");
  assert.ok(Number.isInteger(workflow.jobs.lighthouse["timeout-minutes"]));
  assert.equal(workflow.jobs.lighthouse["runs-on"], "ubuntu-24.04");
  assert.ok(workflow.jobs.lighthouse.steps.some((step) => step.uses === `./${installAction}`));
  assert.ok(runs(workflow.jobs.lighthouse).includes("npm test -- --only lighthouse"));
});
