const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { execFile } = require("node:child_process");
const { createSecretsVault } = require("./secrets-vault.cjs");
const { createSecretsAccess } = require("./secrets-access.cjs");
const { createLocalMcpServer } = require("./local-mcp-server.cjs");

const ORIGIN = "github.com/the-ptf/happiergym";

async function fixture(t, { targets = {} } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-secrets-access-"));
  fs.chmodSync(dataDir, 0o700);
  const key = randomBytes(32);
  const vault = createSecretsVault({ dataDir, masterKey: async () => key, computerId: () => "mac-1" });
  let access;
  const server = createLocalMcpServer({ authenticate: () => null, toolsFor: () => [], secretsRequest: (token, body) => access.request(token, body) });
  const endpoint = await server.listen(0);
  access = createSecretsAccess({
    vault,
    dataDir,
    secretsUrl: async (token) => `${new URL(endpoint).origin}/secrets/${token}`,
    target: async (chatId) => targets[chatId] ?? { origin: ORIGIN, unattended: false },
  });
  t.after(async () => {
    await server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { dataDir, vault, access };
}

function run(env, args) {
  const shim = path.join(env.PATH.split(path.delimiter)[0], "milagre-secrets");
  return new Promise((resolve) => {
    execFile(shim, args, { env }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
  });
}

test("an agent's env carries the command, its Chat's address and ambient secrets only", async (t) => {
  const { vault, access, dataDir } = await fixture(t);
  await vault.set({ name: "NPM_TOKEN", value: "npm-ambient-123456", projects: "all", delivery: "ambient" });
  await vault.set({ name: "DEPLOY_TOKEN", value: "deploy-on-demand-123", projects: "all" });
  const env = await access.agentEnv("/p#1", { PATH: "/usr/bin:/bin" });
  assert.equal(env.PATH, `${path.join(dataDir, "secrets-bin")}${path.delimiter}/usr/bin:/bin`);
  assert.match(env.MILAGRE_SECRETS_URL, /^http:\/\/127\.0\.0\.1:\d+\/secrets\/[a-f0-9]{48}$/);
  assert.equal(env.NPM_TOKEN, "npm-ambient-123456");
  assert.equal(env.DEPLOY_TOKEN, undefined);
  assert.equal(fs.statSync(path.join(dataDir, "secrets-bin", "milagre-secrets")).mode & 0o777, 0o700);
});

test(
  "milagre-secrets run gives named secrets to one command, file secrets as a temporary file, and logs it",
  { skip: process.platform === "win32" },
  async (t) => {
    const { vault, access } = await fixture(t);
    await vault.set({ name: "DEPLOY_TOKEN", value: "deploy-on-demand-123", projects: [ORIGIN] });
    await vault.set({ name: "ASC_KEY", value: "-----BEGIN-----\nkey\n", kind: "file", fileName: "AuthKey.p8", projects: [ORIGIN] });
    const env = { ...(await access.agentEnv("/p#1", { PATH: process.env.PATH })), ELECTRON_RUN_AS_NODE: "1" };
    const script =
      'process.stdout.write(JSON.stringify({ token: process.env.DEPLOY_TOKEN, file: process.env.ASC_KEY, body: require("fs").readFileSync(process.env.ASC_KEY, "utf8"), url: process.env.MILAGRE_SECRETS_URL ?? null }))';
    const result = await run(env, ["run", "--with", "DEPLOY_TOKEN,ASC_KEY", "--", process.execPath, "-e", script]);
    assert.equal(result.code, 0, result.stderr);
    const seen = JSON.parse(result.stdout);
    assert.equal(seen.token, "deploy-on-demand-123");
    assert.equal(path.basename(seen.file), "AuthKey.p8");
    assert.equal(seen.body, "-----BEGIN-----\nkey\n");
    assert.equal(seen.url, null);
    assert.equal(fs.existsSync(seen.file), false);
    const [entry] = await vault.log();
    assert.deepEqual(entry.names, ["DEPLOY_TOKEN", "ASC_KEY"]);
    assert.equal(entry.chatId, "/p#1");
    assert.equal(entry.command, path.basename(process.execPath));
  },
);

test("refusals: a secret out of reach, an unattended run without consent, an unknown token", { skip: process.platform === "win32" }, async (t) => {
  const { vault, access } = await fixture(t, { targets: { "/r#1": { origin: ORIGIN, unattended: true } } });
  await vault.set({ name: "OTHER_TOKEN", value: "other-123456789", projects: ["github.com/a/b"] });
  await vault.set({ name: "RELEASE_TOKEN", value: "release-123456789", projects: "all" });
  const env = { ...(await access.agentEnv("/p#1", { PATH: process.env.PATH })), ELECTRON_RUN_AS_NODE: "1" };
  const missing = await run(env, ["run", "--with", "OTHER_TOKEN", "--", "true"]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /Not available to this Chat: OTHER_TOKEN/);
  const routine = { ...(await access.agentEnv("/r#1", { PATH: process.env.PATH })), ELECTRON_RUN_AS_NODE: "1" };
  assert.match((await run(routine, ["run", "--with", "RELEASE_TOKEN", "--", "true"])).stderr, /Unattended runs/);
  const listed = await run(routine, ["list"]);
  assert.equal(listed.stdout, "No secrets for this Chat.\n");
  const forged = { ...env, MILAGRE_SECRETS_URL: env.MILAGRE_SECRETS_URL.replace(/[a-f0-9]{48}$/, "0".repeat(48)) };
  assert.match((await run(forged, ["run", "--with", "RELEASE_TOKEN", "--", "true"])).stderr, /no longer valid/);
  assert.deepEqual(await vault.log(), []);
});

test("the child's exit code passes through", { skip: process.platform === "win32" }, async (t) => {
  const { vault, access } = await fixture(t);
  await vault.set({ name: "A_TOKEN", value: "value-123456789", projects: "all" });
  const env = { ...(await access.agentEnv("/p#1", { PATH: process.env.PATH })), ELECTRON_RUN_AS_NODE: "1" };
  assert.equal((await run(env, ["run", "--with", "A_TOKEN", "--", process.execPath, "-e", "process.exit(7)"])).code, 7);
  assert.equal((await run(env, ["bogus"])).code, 2);
});

test(
  "over 50 names is refused before anything runs; file secrets with one name each get their own folder",
  { skip: process.platform === "win32" },
  async (t) => {
    const { vault, access } = await fixture(t);
    await vault.set({ name: "ONE_FILE", value: "first-file-body", kind: "file", fileName: "credentials.json", projects: "all" });
    await vault.set({ name: "TWO_FILE", value: "second-file-body", kind: "file", fileName: "credentials.json", projects: "all" });
    const env = { ...(await access.agentEnv("/p#1", { PATH: process.env.PATH })), ELECTRON_RUN_AS_NODE: "1" };
    const names = Array.from({ length: 51 }, (_, index) => `N_${index}`).join(",");
    assert.match((await run(env, ["run", "--with", names, "--", "true"])).stderr, /At most 50 secrets/);
    const script =
      'const fs = require("fs"); process.stdout.write(fs.readFileSync(process.env.ONE_FILE, "utf8") + "|" + fs.readFileSync(process.env.TWO_FILE, "utf8"))';
    const both = await run(env, ["run", "--with", "ONE_FILE,TWO_FILE", "--", process.execPath, "-e", script]);
    assert.equal(both.stdout, "first-file-body|second-file-body", both.stderr);
  },
);

test("the use log keeps only the executable, never arguments that may hold a credential", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-secrets-redact-"));
  fs.chmodSync(dataDir, 0o700);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const key = randomBytes(32);
  const vault = createSecretsVault({ dataDir, masterKey: async () => key });
  await vault.set({ name: "A_TOKEN", value: "visible-token-123456", projects: "all" });
  const access = createSecretsAccess({
    vault,
    dataDir,
    secretsUrl: async (token) => `http://127.0.0.1:1/secrets/${token}`,
    target: async () => ({ origin: null, unattended: false }),
    redactText: (text) => text.replaceAll("visible-token-123456", "[secret A_TOKEN]"),
  });
  const token = (await access.agentEnv("/p#1", { PATH: "/bin" })).MILAGRE_SECRETS_URL.split("/").at(-1);
  await access.request(token, { action: "run", names: ["A_TOKEN"], command: "/usr/bin/curl -H Authorization:123456 x" });
  assert.equal((await vault.log())[0].command, "curl");
});
