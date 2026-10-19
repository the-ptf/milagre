const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const YAML = require("yaml");

const ciWorkflow = YAML.parse(fs.readFileSync(path.join(__dirname, "../.github/workflows/ci.yml"), "utf8"));
const publishWorkflow = YAML.parse(fs.readFileSync(path.join(__dirname, "../.github/workflows/publish.yml"), "utf8"));
const deployWorkflow = YAML.parse(fs.readFileSync(path.join(__dirname, "../.github/workflows/deploy-linux-repository.yml"), "utf8"));
const buildWorkflow = YAML.parse(fs.readFileSync(path.join(__dirname, "../.github/workflows/build-macos.yml"), "utf8"));
const candidateWorkflow = YAML.parse(fs.readFileSync(path.join(__dirname, "../.github/workflows/package-candidates.yml"), "utf8"));
const credentials = ["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"];
const credentialStep = buildWorkflow.jobs["package-macos"].steps.find((step) => step.name === "Check Apple release credentials");
const notarizeStep = buildWorkflow.jobs["package-macos"].steps.find((step) => step.name === "Notarize and staple disk images");
const verifyStep = buildWorkflow.jobs["package-macos"].steps.find((step) => step.name === "Verify macOS signatures, notarization and disk images");
const authStep = buildWorkflow.jobs["package-macos"].steps.find((step) => step.name === "Check Apple notarization authentication");
const publishStep = publishWorkflow.jobs.publish.steps.find((step) => step.name === "Publish the release");

function runStep(step, cwd, overrides = {}) {
  const env = { ...process.env };
  for (const name of credentials) delete env[name];
  return spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", step.run], {
    cwd,
    env: { ...env, ...overrides },
    encoding: "utf8",
  });
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-release-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "release/mac-arm64/Milagre.app"), { recursive: true });
  fs.mkdirSync(path.join(root, "bin"));
  fs.mkdirSync(path.join(root, "scripts"));
  for (const script of ["with-apple-credentials.cjs", "notarize-dmg.cjs"]) fs.copyFileSync(path.join(__dirname, script), path.join(root, "scripts", script));
  fs.writeFileSync(path.join(root, "release/Milagre-arm64.dmg"), "");
  const mock = `#!/bin/bash
printf '%s %s %s %s\\n' "$(basename "$0")" "$1" "$2" "$3" >> "$CALL_LOG"
if [ "$(basename "$0")" = "$FAIL_TOOL" ]; then exit 1; fi
if [ "$1" = notarytool ]; then
  if [ "$2" = wait ] && [ -n "$WAIT_ERROR" ]; then echo "$WAIT_ERROR" >&2; exit 1; fi
  if [ "$2" = wait ] && [ -n "$NOTARY_WAIT_STATUS" ]; then NOTARY_STATUS="$NOTARY_WAIT_STATUS"; fi
  if [ "$2" = wait ] || [[ "$*" == *" --wait "* ]]; then
    if [ "$NETWORK_ALWAYS_FAIL" = 1 ]; then
      echo 'Error Domain=NSURLErrorDomain Code=-1009 The Internet connection appears to be offline. URL=/submissions/ab401def-1234-1234-1234-123456789abc' >&2
      exit 1
    fi
    if [ "$NETWORK_FAIL_ONCE" = 1 ] && [ ! -f "$NETWORK_STATE" ]; then
      touch "$NETWORK_STATE"
      echo 'Error Domain=NSURLErrorDomain Code=-1009 The Internet connection appears to be offline. No network route' >&2
      exit 1
    fi
  fi
  printf '{"id":"12345678-1234-1234-1234-123456789abc","status":"%s"}\\n' "$NOTARY_STATUS"
  exit "$NOTARY_EXIT"
fi
`;
  for (const tool of ["xcrun", "codesign", "spctl", "hdiutil", "sleep"]) {
    fs.writeFileSync(path.join(root, "bin", tool), mock, { mode: 0o755 });
  }
  const env = {
    PATH: `${path.join(root, "bin")}${path.delimiter}${process.env.PATH}`,
    CALL_LOG: path.join(root, "calls.log"),
    NOTARY_STATUS: "Accepted",
    NOTARY_EXIT: "0",
    FAIL_TOOL: "",
    NETWORK_STATE: path.join(root, "network-state"),
    NETWORK_FAIL_ONCE: "0",
    NETWORK_ALWAYS_FAIL: "0",
    WAIT_ERROR: "",
    NOTARY_WAIT_STATUS: "",
    ...Object.fromEntries(credentials.map((name) => [name, `test-secret-${name}`])),
  };
  return {
    root,
    env,
    calls: () => (fs.existsSync(env.CALL_LOG) ? fs.readFileSync(env.CALL_LOG, "utf8") : ""),
  };
}

test("every candidate platform forwards the release version through npm to the packager", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-candidate-args-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "record.cjs"), "require('node:fs').writeFileSync('args.json', JSON.stringify(process.argv.slice(2)))");
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      scripts: {
        "package:mac:local": "node record.cjs",
        "package:win": "node record.cjs",
        "package:linux": "node record.cjs",
      },
    }),
  );
  const build = candidateWorkflow.jobs.package.steps.find((step) => step.name === "Build experimental installers");
  for (const platform of candidateWorkflow.jobs.package.strategy.matrix.include) {
    const command = build.run.replace("${{ matrix.command }}", platform.command);
    const result = runStep({ run: command }, root, { RELEASE_TAG: "v1.2.3" });
    assert.equal(result.status, 0, result.stderr);
    const args = JSON.parse(fs.readFileSync(path.join(root, "args.json"), "utf8"));
    assert.ok(args.includes("--config.extraMetadata.version=1.2.3"), `${platform.platform}: ${JSON.stringify(args)}`);
  }
});

test("missing Apple credentials stop the release without printing secret values", () => {
  const ready = Object.fromEntries(credentials.map((name) => [name, `test-secret-${name}`]));
  for (const missing of credentials) {
    const result = runStep(credentialStep, undefined, { ...ready, [missing]: "" });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, new RegExp(`Missing GitHub Actions secret: ${missing}`));
    assert.doesNotMatch(result.stdout + result.stderr, /test-secret-/);
  }
  assert.equal(runStep(credentialStep, undefined, ready).status, 0);
});

test("Apple rejection stops notarization even when notarytool exits successfully", (t) => {
  const f = fixture(t);
  const result = runStep(notarizeStep, f.root, { ...f.env, NOTARY_STATUS: "Invalid" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Apple notarization failed: Invalid/);
  assert.doesNotMatch(f.calls(), /stapler staple/);
});

test("notarytool failure stops before stapling", (t) => {
  const f = fixture(t);
  const result = runStep(notarizeStep, f.root, { ...f.env, NOTARY_EXIT: "1" });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(f.calls(), /stapler staple/);
});

test("an accepted disk image is stapled", (t) => {
  const f = fixture(t);
  const result = runStep(notarizeStep, f.root, f.env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(f.calls(), /xcrun notarytool submit/);
  assert.match(f.calls(), /xcrun stapler staple/);
});

test("merges cut no release; CI only rewrites the Next beta draft once main passes the required checks", () => {
  assert.equal(ciWorkflow.jobs.release, undefined);
  const job = ciWorkflow.jobs["next-beta"];
  assert.equal(job.if, "github.event_name == 'push' && github.ref == 'refs/heads/main' && github.repository == 'the-ptf/milagre'");
  assert.deepEqual(job.needs, ["javascript", "native-gate", "macos-desktop-smoke"]);
  assert.equal(job.permissions.contents, "write");
  const checkout = job.steps.find((step) => step.uses?.startsWith("actions/checkout"));
  assert.equal(checkout.with["fetch-depth"], 0);
  assert.equal(checkout.with["persist-credentials"], false);
  assert.deepEqual(job.steps.map((step) => step.run).filter(Boolean), ["git fetch --quiet --tags origin\nnode scripts/plan-release.cjs next-draft\n"]);
  assert.ok(!fs.existsSync(path.join(__dirname, "../.releaserc.json")), "semantic-release no longer tags merges");
  assert.ok(!fs.existsSync(path.join(__dirname, "../.github/workflows/release.yml")), "no separate workflow_run release workflow");
});

test("signature, ticket, Gatekeeper and disk image failures stop verification", (t) => {
  const f = fixture(t);
  for (const tool of ["codesign", "xcrun", "spctl", "hdiutil"]) {
    const result = runStep(verifyStep, f.root, { ...f.env, FAIL_TOOL: tool });
    assert.notEqual(result.status, 0, `${tool} failure must block upload`);
  }
  assert.equal(runStep(verifyStep, f.root, f.env).status, 0);
});

test("an invalid app-specific password stops before contacting Apple and is never printed", (t) => {
  const f = fixture(t);
  const secret = "test-private-password-value";
  const result = runStep(authStep, f.root, { ...f.env, APPLE_APP_SPECIFIC_PASSWORD: secret });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /App-specific password has the expected format: false/);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret));
  assert.equal(f.calls(), "");
});

test("Apple authentication rejection stops the preflight without printing credentials", (t) => {
  const f = fixture(t);
  const password = "abcd-efgh-ijkl-mnop";
  const result = runStep(authStep, f.root, { ...f.env, APPLE_APP_SPECIFIC_PASSWORD: password, NOTARY_EXIT: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Apple authentication check failed/);
  assert.doesNotMatch(result.stdout + result.stderr, /abcd-efgh-ijkl-mnop|test-secret-/);
  assert.match(f.calls(), /xcrun notarytool history/);
});

test("accepted Apple credentials pass the authentication preflight", (t) => {
  const f = fixture(t);
  const result = runStep(authStep, f.root, { ...f.env, APPLE_APP_SPECIFIC_PASSWORD: "abcd-efgh-ijkl-mnop" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Apple accepted the configured notarization credentials/);
  assert.match(f.calls(), /xcrun notarytool history/);
});

test("release commands trim Apple credentials, preserve certificate passwords and propagate failure", () => {
  const secret = "certificate-password-with-intentional-spaces";
  const command = [
    path.join(__dirname, "with-apple-credentials.cjs"),
    process.execPath,
    "-e",
    "const assert = require('node:assert/strict'); assert.equal(process.env.APPLE_ID, 'developer@example.test'); assert.equal(process.env.APPLE_APP_SPECIFIC_PASSWORD, 'abcd-efgh-ijkl-mnop'); assert.equal(process.env.APPLE_TEAM_ID, 'TESTTEAM01'); assert.equal(process.env.CSC_KEY_PASSWORD, '  certificate-password-with-intentional-spaces  '); process.exit(7)",
  ];
  const result = spawnSync(process.execPath, command, {
    env: {
      ...process.env,
      APPLE_ID: " developer@example.test\n",
      APPLE_APP_SPECIFIC_PASSWORD: " abcd-efgh-ijkl-mnop\n",
      APPLE_TEAM_ID: " TESTTEAM01\n",
      CSC_KEY_PASSWORD: "  " + secret + "  ",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 7, result.stderr);
  assert.equal(result.stdout + result.stderr, "");
  const build = buildWorkflow.jobs["package-macos"].steps.find((step) => step.name === "Build macOS installers");
  assert.match(build.run, /^node scripts\/with-apple-credentials\.cjs npm run package:mac /);
  assert.match(notarizeStep.run, /^node scripts\/with-apple-credentials\.cjs bash -e -o pipefail/);
});

test("a network drop while waiting resumes the same submission before stapling", (t) => {
  const f = fixture(t);
  const result = runStep(notarizeStep, f.root, { ...f.env, NETWORK_FAIL_ONCE: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal((f.calls().match(/xcrun notarytool submit/g) || []).length, 1);
  assert.equal((f.calls().match(/xcrun notarytool wait 12345678-1234-1234-1234-123456789abc/g) || []).length, 2);
  assert.match(f.calls(), /xcrun stapler staple/);
});

test("persistent network failures stop after four waits without another upload", (t) => {
  const f = fixture(t);
  const result = runStep(notarizeStep, f.root, { ...f.env, NETWORK_ALWAYS_FAIL: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /after four network attempts/);
  assert.equal((f.calls().match(/xcrun notarytool submit/g) || []).length, 1);
  assert.equal((f.calls().match(/xcrun notarytool wait/g) || []).length, 4);
  assert.doesNotMatch(f.calls(), /stapler staple/);
  assert.doesNotMatch(result.stdout + result.stderr, /test-secret-/);
});

test("a rejected DMG status after upload is never retried or stapled", (t) => {
  const f = fixture(t);
  const result = runStep(notarizeStep, f.root, { ...f.env, NOTARY_WAIT_STATUS: "Invalid" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Apple notarization failed: Invalid/);
  assert.equal((f.calls().match(/xcrun notarytool wait/g) || []).length, 1);
  assert.doesNotMatch(f.calls(), /stapler staple|sleep/);
});

test("authentication failure during the wait stops immediately without logging credentials", (t) => {
  const f = fixture(t);
  const result = runStep(notarizeStep, f.root, { ...f.env, WAIT_ERROR: "HTTP status code: 401. Invalid credentials. test-secret-APPLE_APP_SPECIFIC_PASSWORD" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Apple rejected the notarization credentials/);
  assert.equal((f.calls().match(/xcrun notarytool wait/g) || []).length, 1);
  assert.doesNotMatch(f.calls(), /stapler staple|sleep/);
  assert.doesNotMatch(result.stdout + result.stderr, /test-secret-/);
});

test("the macOS build stages its installers on the channel Publish asks for and leaves publishing to Publish", () => {
  const job = publishWorkflow.jobs.macos;
  assert.equal(job.uses, "./.github/workflows/build-macos.yml");
  assert.equal(job.with.channel, "${{ needs.prepare.outputs.feed_channel }}");
  assert.deepEqual(Object.keys(buildWorkflow.on.workflow_call.inputs), ["ref", "version", "channel"]);
  const steps = buildWorkflow.jobs["package-macos"].steps;
  assert.doesNotMatch(JSON.stringify(steps), /gh release (upload|edit|create)/, "the macOS build never changes the release");
  assert.equal(steps.at(-1).with.name, "installers-macos");
  const build = steps.find((step) => step.name === "Build macOS installers");
  assert.match(build.run, /--config\.publish\.channel="\$\{CHANNEL\}"/);
  assert.doesNotMatch(build.run, /generateUpdatesFilesForAllChannels/, "the flag does nothing for the github provider");
});

test("every platform builds the planned commit, and the release tag exists only once Publish creates it", () => {
  const sha = "${{ needs.prepare.outputs.sha }}";
  assert.equal(publishWorkflow.jobs.macos.with.ref, sha);
  assert.equal(buildWorkflow.jobs["package-macos"].steps[0].with.ref, "${{ inputs.ref }}");
  for (const name of ["linux", "windows"]) assert.equal(publishWorkflow.jobs[name].steps[0].with.ref, sha, name);
  assert.equal(publishWorkflow.jobs.linux.env.RELEASE_TAG, "${{ needs.prepare.outputs.release_tag }}");
  assert.equal(publishWorkflow.jobs.publish.env.TARGET, sha);
  assert.doesNotMatch(JSON.stringify(buildWorkflow), /gh release/);
});

test("a stable build mirrors its feed to the beta channel before the feeds are refreshed", () => {
  const steps = buildWorkflow.jobs["package-macos"].steps;
  const names = steps.map((step) => step.name);
  const mirror = steps.find((step) => step.name === "Mirror the stable feed to the beta channel");
  assert.equal(mirror.if, "inputs.channel == 'latest'");
  assert.match(mirror.run, /cp release\/latest-mac\.yml release\/beta-mac\.yml/);
  assert.match(mirror.run, /exit 1/, "a missing stable feed fails the build");
  assert.ok(names.indexOf("Build macOS installers") < names.indexOf("Mirror the stable feed to the beta channel"));
  assert.ok(names.indexOf("Mirror the stable feed to the beta channel") < names.indexOf("Refresh feeds after DMG notarization"));
});

test("reusable workflows take their secrets by name, never inherited", () => {
  assert.deepEqual(buildWorkflow.on.workflow_call.secrets, Object.fromEntries(credentials.map((name) => [name, { required: true }])));
  assert.deepEqual(publishWorkflow.jobs.macos.secrets, Object.fromEntries(credentials.map((name) => [name, `\${{ secrets.${name} }}`])));
  const deploySecrets = Object.keys(deployWorkflow.on.workflow_call.secrets);
  assert.deepEqual(publishWorkflow.jobs["deploy-linux-repository"].secrets, Object.fromEntries(deploySecrets.map((name) => [name, `\${{ secrets.${name} }}`])));
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "../.github/workflows/publish.yml"), "utf8"), /secrets: inherit/);
});

test("one Publish workflow cuts betas on a schedule and either channel on dispatch", () => {
  assert.deepEqual(Object.keys(publishWorkflow.on), ["workflow_dispatch", "schedule"]);
  assert.deepEqual(publishWorkflow.on.schedule, [{ cron: "0 9 * * 1-5" }]);
  const inputs = publishWorkflow.on.workflow_dispatch.inputs;
  assert.deepEqual(Object.keys(inputs), ["channel", "ref", "beta"]);
  assert.deepEqual(inputs.channel.options, ["beta", "stable"]);
  assert.equal(inputs.channel.default, "beta");
  const steps = publishWorkflow.jobs.prepare.steps;
  assert.equal(steps.find((step) => step.uses?.startsWith("actions/checkout")).with["fetch-depth"], 0);
  assert.equal(steps.find((step) => step.id === "channel").env.CHANNEL, "${{ inputs.channel || 'beta' }}");
  const plan = steps.find((step) => step.id === "plan");
  assert.match(plan.run, /node scripts\/plan-release\.cjs plan >> "\$GITHUB_OUTPUT"/);
  assert.equal(plan.env.SCHEDULED, "${{ github.event_name == 'schedule' }}");
  assert.deepEqual(publishWorkflow.permissions, { contents: "write", actions: "read" }, "gh run list needs actions: read");
  assert.equal(steps.at(-1).with.name, "release-notes");
  assert.ok(!fs.existsSync(path.join(__dirname, "pick-release-candidate.cjs")), "drafts are no longer picked");
  for (const name of ["publish-beta.yml", "publish-installers.yml"])
    assert.ok(!fs.existsSync(path.join(__dirname, "../.github/workflows", name)), `${name} is folded into publish.yml`);
});

test("macOS and Linux always build; Windows waits for the RELEASE_WINDOWS variable", () => {
  const jobs = publishWorkflow.jobs;
  assert.equal(jobs.macos.if, "needs.prepare.outputs.changed == 'true'");
  assert.equal(jobs.linux.if, "needs.prepare.outputs.changed == 'true'");
  assert.equal(jobs.windows.if, "needs.prepare.outputs.changed == 'true' && needs.prepare.outputs.windows == 'true'");
  assert.equal(jobs.prepare.steps.find((step) => step.id === "channel").env.WINDOWS, "${{ vars.RELEASE_WINDOWS == 'true' }}");
  assert.match(jobs.windows.steps.find((step) => step.name === "Build signed Windows installer").run, /--config\.publish\.channel="\$\{FEED_CHANNEL\}"/);
});

test("Linux builds on the requested channel and only a stable release signs and builds the package repository", () => {
  const steps = publishWorkflow.jobs.linux.steps;
  const names = steps.map((step) => step.name);
  assert.match(steps.find((step) => step.name === "Build Linux installers").run, /--config\.publish\.channel="\$\{FEED_CHANNEL\}"/);
  for (const name of [
    "Require Linux signing credentials",
    "Mirror the stable feed to the beta channel",
    "Import repository signing key",
    "Retain previous package downloads",
    "Sign RPM and generate signed repositories",
    "Verify signed Linux repository bundle",
    "Install and exercise signed Fedora RPM",
  ])
    assert.equal(steps.find((step) => step.name === name).if, "env.CHANNEL == 'stable'", name);
  assert.ok(names.indexOf("Build Linux installers") < names.indexOf("Mirror the stable feed to the beta channel"));
  assert.ok(names.indexOf("Mirror the stable feed to the beta channel") < names.indexOf("Sign RPM and generate signed repositories"));
  for (const name of ["Exercise installed Linux desktop", "Exercise Linux AppImage payload"])
    assert.equal(steps.find((step) => step.name === name).if, undefined, name);
  // The candidate's own finalizer may predate Linux betas, so the feed is checked with the workflow's copy.
  const check = steps.find((step) => step.name === "Check the beta feed");
  assert.equal(check.if, "env.CHANNEL == 'beta'");
  assert.equal(check.env.WORKFLOW_SHA, "${{ github.sha }}");
  assert.match(check.run, /git show "\$WORKFLOW_SHA:scripts\/finalize-update-feeds\.cjs"/);
});

test("a stable release needs every platform it built; a beta needs only macOS", () => {
  const publish = publishWorkflow.jobs.publish;
  assert.deepEqual(publish.needs, ["prepare", "macos", "linux", "windows"]);
  const condition = publish.if.replace(/\s+/g, " ").trim();
  assert.equal(
    condition,
    "always() && needs.prepare.outputs.changed == 'true' && needs.macos.result == 'success' && (needs.prepare.outputs.channel == 'beta' || (needs.linux.result == 'success' && (needs.windows.result == 'success' || needs.windows.result == 'skipped')))",
  );
  const deploy = publishWorkflow.jobs["deploy-linux-repository"];
  assert.equal(deploy.uses, "./.github/workflows/deploy-linux-repository.yml");
  assert.deepEqual(deploy.needs, ["prepare", "publish"]);
  assert.equal(deploy.if, "needs.prepare.outputs.channel == 'stable'");
  assert.equal(deploy.with.tag, "${{ needs.prepare.outputs.release_tag }}");
});

function publishFixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-publish-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "release"));
  fs.mkdirSync(path.join(root, "bin"));
  for (const name of files) fs.writeFileSync(path.join(root, "release", name), "x");
  const log = '#!/bin/bash\nprintf \'%s %s\\n\' "$(basename "$0")" "$*" >> "$CALL_LOG"\n';
  // Like the real gh, an asset path that doesn't exist fails the upload.
  const missing = 'for a in "$@"; do case "$a" in release/*) [ -e "$a" ] || { echo "no matches found for \\`$a\\`" >&2; exit 1; };; esac; done\n';
  // The tag lookup finds nothing unless TAG_EXISTS is set.
  const tag = 'if [ "$1" = api ]; then [ "${TAG_EXISTS:-0}" = 1 ] || exit 1; fi\n';
  fs.writeFileSync(path.join(root, "bin/gh"), `${log}${missing}${tag}`, { mode: 0o755 });
  fs.writeFileSync(path.join(root, "bin/node"), `${log}exit "\${FEED_EXIT:-0}"\n`, { mode: 0o755 });
  // Run the real generator so platform-specific omissions match the release job.
  const managers = 'if [ "$2" = package:managers ]; then shift 3; exec "$NODE_BINARY" "$PACKAGE_MANAGERS_SCRIPT" "$@"; fi\n';
  fs.writeFileSync(path.join(root, "bin/npm"), `${log}${managers}`, { mode: 0o755 });
  fs.writeFileSync(path.join(root, "notes.md"), "Changes since v9.9.8.\n");
  const env = {
    PATH: `${path.join(root, "bin")}${path.delimiter}${process.env.PATH}`,
    CALL_LOG: path.join(root, "calls.log"),
    TARGET: "0123456789abcdef0123456789abcdef01234567",
    NOTES_FILE: path.join(root, "notes.md"),
    WINDOWS: "false",
    NODE_BINARY: process.execPath,
    PACKAGE_MANAGERS_SCRIPT: path.join(__dirname, "generate-package-managers.cjs"),
  };
  return { root, env, calls: () => (fs.existsSync(env.CALL_LOG) ? fs.readFileSync(env.CALL_LOG, "utf8") : "") };
}
const macFiles = ["Milagre-9.9.9-arm64.dmg", "Milagre-9.9.9-x64.dmg", "Milagre-9.9.9-arm64-mac.zip", "Milagre-9.9.9-arm64.dmg.blockmap"];
const linuxFiles = ["Milagre-9.9.9-x86_64.AppImage", "Milagre-9.9.9-amd64.deb", "Milagre-9.9.9-x86_64.rpm", "milagre-linux-repository.tar.gz"];

test("a beta without Linux ships macOS as a prerelease that is never latest", (t) => {
  const f = publishFixture(t, [...macFiles, "beta-mac.yml"]);
  const result = runStep(publishStep, f.root, { ...f.env, CHANNEL: "beta", RELEASE_TAG: "v9.9.9-beta.3" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /::warning::The Linux build failed/);
  assert.match(f.calls(), /node scripts\/finalize-update-feeds\.cjs --tag v9\.9\.9-beta\.3 --platform macos --check/);
  assert.match(f.calls(), /gh api repos\/\{owner\}\/\{repo\}\/git\/ref\/tags\/v9\.9\.9-beta\.3 --silent\n/);
  assert.match(
    f.calls(),
    /gh release create v9\.9\.9-beta\.3 --target 0123456789abcdef0123456789abcdef01234567 --prerelease --title v9\.9\.9-beta\.3 --notes-file \S+notes\.md [\s\S]*release\/beta-mac\.yml/,
  );
  assert.doesNotMatch(f.calls(), /--latest|package:managers|release (upload|edit)/);
});

test("a tag that already exists stops publication before the release is created", (t) => {
  const f = publishFixture(t, [...macFiles, "beta-mac.yml"]);
  const result = runStep(publishStep, f.root, { ...f.env, CHANNEL: "beta", RELEASE_TAG: "v9.9.9-beta.3", TAG_EXISTS: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /::error::Tag v9\.9\.9-beta\.3 already exists/);
  assert.doesNotMatch(f.calls(), /release create/);
});

test("a beta with Linux ships both platforms", (t) => {
  const f = publishFixture(t, [...macFiles, ...linuxFiles.slice(0, 3), "beta-mac.yml", "beta-linux.yml"]);
  const result = runStep(publishStep, f.root, { ...f.env, CHANNEL: "beta", RELEASE_TAG: "v9.9.9-beta.3" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(f.calls(), /--platform macos,linux --check/);
  assert.match(f.calls(), /gh release create [\s\S]*release\/Milagre-9\.9\.9-x86_64\.AppImage[\s\S]*release\/beta-linux\.yml/);
});

test("a stable release without Linux stops before touching the release", (t) => {
  const f = publishFixture(t, [...macFiles, "latest-mac.yml", "beta-mac.yml"]);
  const result = runStep(publishStep, f.root, { ...f.env, CHANNEL: "stable", RELEASE_TAG: "v9.9.9" });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /Linux installers are missing/);
  assert.doesNotMatch(f.calls(), /gh /);
});

test("a stable release with Windows enabled but missing stops before touching the release", (t) => {
  const f = publishFixture(t, [...macFiles, ...linuxFiles, "latest-mac.yml", "beta-mac.yml", "latest-linux.yml", "beta-linux.yml"]);
  const result = runStep(publishStep, f.root, { ...f.env, CHANNEL: "stable", RELEASE_TAG: "v9.9.9", WINDOWS: "true" });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /Windows installers are missing/);
  assert.doesNotMatch(f.calls(), /gh /);
});

test("a feed check failure stops publication before any upload", (t) => {
  const f = publishFixture(t, [...macFiles, ...linuxFiles, "latest-mac.yml", "beta-mac.yml", "latest-linux.yml", "beta-linux.yml"]);
  const result = runStep(publishStep, f.root, { ...f.env, CHANNEL: "stable", RELEASE_TAG: "v9.9.9", FEED_EXIT: "1" });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(f.calls(), /gh /);
});

test("a stable release with Windows disabled ships macOS and Linux metadata as the latest release on the beta's commit", (t) => {
  const f = publishFixture(t, [...macFiles, ...linuxFiles, "latest-mac.yml", "beta-mac.yml", "latest-linux.yml", "beta-linux.yml"]);
  const result = runStep(publishStep, f.root, { ...f.env, CHANNEL: "stable", RELEASE_TAG: "v9.9.9" });
  assert.equal(result.status, 0, result.stderr);
  const calls = f.calls();
  assert.match(calls, /node scripts\/finalize-update-feeds\.cjs --tag v9\.9\.9 --platform macos,linux --check/);
  assert.match(calls, /npm run package:managers -- --tag v9\.9\.9 --platform macos,linux/);
  for (const asset of [...macFiles, ...linuxFiles, "latest-mac.yml", "beta-mac.yml", "latest-linux.yml", "beta-linux.yml"])
    assert.match(calls, new RegExp(`gh release create v9\\.9\\.9 .*release/${asset.replace(/\./g, "\\.")}`), asset);
  assert.match(calls, /release\/package-managers\/SHA256SUMS release\/package-managers\/homebrew\/milagre\.rb/);
  assert.match(calls, /gh release create v9\.9\.9 --target 0123456789abcdef0123456789abcdef01234567 --latest --title v9\.9\.9 --notes-file \S+notes\.md /);
  assert.doesNotMatch(calls, /release (upload|edit)|--prerelease/);
  assert.doesNotMatch(calls, /winget/);
});

test("a stable release with Windows enabled uploads the WinGet manifest with the installer", (t) => {
  const windowsFiles = ["Milagre-Setup-9.9.9-x64.exe", "latest.yml", "beta.yml"];
  const f = publishFixture(t, [...macFiles, ...linuxFiles, ...windowsFiles]);
  const result = runStep(publishStep, f.root, { ...f.env, CHANNEL: "stable", RELEASE_TAG: "v9.9.9", WINDOWS: "true" });
  assert.equal(result.status, 0, result.stderr);
  const calls = f.calls();
  assert.match(calls, /npm run package:managers -- --tag v9\.9\.9 --platform macos,linux,windows/);
  for (const asset of [...windowsFiles, "package-managers/winget/Milagre.Milagre.yaml"])
    assert.ok(
      calls.split("\n").find((line) => line.startsWith("gh release create v9.9.9 ") && line.includes(`release/${asset}`)),
      asset,
    );
  assert.match(calls, /gh release create v9\.9\.9 --target \S+ --latest /);
});
