const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const YAML = require("yaml");
const config = require("./windows-azure-signing.cjs");
const { build } = require("../package.json");
const env = {
  AZURE_SIGNING_ENDPOINT: "https://eus.codesigning.azure.net/",
  AZURE_SIGNING_ACCOUNT: "milagre",
  AZURE_SIGNING_PROFILE: "public-trust",
  AZURE_SIGNING_PUBLISHER: "Example Person",
};

test("Azure signing preserves packaging, identifies the publisher for updates, and passes the installed packager's schema", async () => {
  const azure = config(undefined, env);
  assert.equal(azure.forceCodeSigning, true);
  assert.deepEqual(azure.files, build.files);
  assert.deepEqual(azure.directories, build.directories);
  assert.deepEqual(azure.win.target, build.win.target);
  assert.equal(azure.win.azureSignOptions.publisherName, env.AZURE_SIGNING_PUBLISHER);
  assert.equal(azure.win.azureSignOptions.endpoint, "https://eus.codesigning.azure.net");
  const { validateConfiguration } = require("app-builder-lib/out/util/config/config.js");
  await validateConfiguration(azure);
});

test("a missing identity or endpoint cannot silently produce an unsigned installer", () => {
  for (const name of Object.keys(env)) assert.throws(() => config(undefined, { ...env, [name]: "" }), new RegExp(name));
  for (const endpoint of ["http://eus.codesigning.azure.net", "https://example.com", "https://eus.codesigning.azure.net.evil.test"])
    assert.throws(() => config(undefined, { ...env, AZURE_SIGNING_ENDPOINT: endpoint }), /regional HTTPS endpoint/);
});

test("the signed candidate only runs on dispatch, uses OIDC and verifies signatures before uploading without publishing", () => {
  const workflow = YAML.parse(fs.readFileSync(path.join(__dirname, "../.github/workflows/windows-signed-candidate.yml"), "utf8"));
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.equal(workflow.permissions.contents, "read");
  const job = workflow.jobs.windows;
  assert.equal(job.environment, "windows-signing");
  assert.equal(job.permissions["id-token"], "write");
  const login = job.steps.find((step) => step.uses?.startsWith("azure/login@"));
  assert.ok(login.with["client-id"]);
  assert.equal(login.with.creds, undefined, "the job has no stored client password");
  const verify = job.steps.findIndex((step) => step.name === "Verify installer and app Authenticode");
  const upload = job.steps.findIndex((step) => step.name === "Upload signed candidate");
  assert.ok(verify >= 0 && upload > verify);
  assert.match(job.steps[verify].run, /Get-AuthenticodeSignature/);
  assert.match(job.steps[verify].run, /-ne 'Valid'/);
  assert.ok(!job.steps.some((step) => /gh release|--publish always/.test(step.run ?? "")));
});
