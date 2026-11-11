// Actual Node runtime and Accounts, fresh generated state only. No provider/credential discovery.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "milagre-bootstrap-oracle-")));
const home = path.join(root, "home");
fs.mkdirSync(home);
process.env.HOME = home;
for (const name of Object.keys(process.env)) if (/TOKEN|SECRET|API_KEY|CODEX_HOME|CLAUDE_CONFIG_DIR|MILAGRE_DATA_DIR/.test(name)) delete process.env[name];
const { createRuntime } = require("../../../packages/core/src/runtime.cjs");
const { createAccounts } = require("../../../packages/core/src/accounts.cjs");
const project = path.join(root, "fixture");
const profile = path.join(root, "profile");
const date = "2026-01-01T00:00:00.000Z";
const catalog = {
  claude: [],
  codex: [],
  antigravity: [],
  kiro: [
    {
      id: "scripted",
      name: "Scripted Rust fixture",
      description: "In-process simulation. No vendor CLI, account or network.",
      recommended: true,
      efforts: [],
      ultracode: false,
      fastMode: false,
    },
  ],
};
const status = Object.fromEntries(
  ["claude", "codex", "antigravity", "kiro"].map((provider) => [
    provider,
    provider === "kiro"
      ? { state: "ready", message: "In-process scripted fixture. No vendor CLI or account is inspected." }
      : { state: "missing", message: "Unavailable in the Rust fixture." },
  ]),
);
async function main() {
  fs.mkdirSync(path.join(project, ".milagre"), { recursive: true });
  fs.mkdirSync(profile);
  const seed = {
    next_id: 10,
    name: "actor",
    worktrees: { 1: { id: 1, path: project, name: "main" } },
    sessions: { 1: { id: 1, worktree_id: 1 }, 2: { id: 2, worktree_id: 1 } },
    messages: [],
  };
  fs.writeFileSync(path.join(project, ".milagre/coordination.json"), JSON.stringify(seed));
  const registry = {
    scanned: true,
    projects: [{ id: project, path: project, name: "fixture", git: false, position: null, openedAt: date }],
    links: [],
    projectGroups: [],
    worktreePositions: {},
  };
  const recent = [{ path: project, name: "fixture", openedAt: date }];
  fs.writeFileSync(path.join(profile, "project-registry.json"), JSON.stringify(registry));
  fs.writeFileSync(path.join(profile, "recent-projects.json"), JSON.stringify(recent));
  const runtime = createRuntime({
    dataDir: profile,
    cwd: project,
    chatsHome: path.join(root, "chats"),
    worktreeRoot: path.join(root, "worktrees"),
    registryRoots: [],
    antigravityTempRoot: path.join(root, "antigravity-tmp"),
    environmentReady: Promise.resolve(),
    titleModels: {},
    expandSkills: false,
    agentCli: async () => ({}),
    agentModels: async () => catalog,
    agentCliStatus: async () => status,
  });
  const cases = [];
  try {
    for (const [method, args] of [
      ["project:read", [project]],
      ["project:read", [project, { state: false }]],
      ["chat:runs", []],
      ["project:registry", []],
      ["project:recent", []],
      ["project:known", []],
      ["canvas:links", []],
      ["link:list", []],
      ["canvas:snapshot", []],
      ["accounts:scopes", []],
      ["agent:models", []],
      ["agent:models", [project]],
      ["agent:cli-status", [project]],
    ])
      cases.push({ method, args, result: await runtime.invoke(method, args) });
    // Metadata-only fixture account route: real Accounts snapshot, deliberately no list/inspect/login.
    const accounts = createAccounts({
      dataDir: path.join(root, "metadata-accounts"),
      home,
      env: {},
      cli: async () => {
        throw Error("must not discover a CLI");
      },
      inspect: async () => {
        throw Error("must not inspect credentials");
      },
    });
    cases.push({ method: "accounts:list", args: [], result: accounts.snapshot() });
    cases.push({ method: "accounts:scope", args: [project], result: accounts.assign(project, "kiro", null) });
    const output =
      JSON.stringify({ seed: cases[0].result.state, registry, recent, catalog, status, cases }, null, 2)
        .replaceAll(project, "$PROJECT")
        .replaceAll(profile, "$PROFILE")
        .replaceAll(root, "$ROOT") + "\n";
    const file = path.join(__dirname, "app-bootstrap.json");
    if (process.argv.includes("--check")) {
      require("node:assert/strict").deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), JSON.parse(output), "Node bootstrap fixtures changed");
    } else fs.writeFileSync(file, output);
  } finally {
    await runtime.close();
  }
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(root, { recursive: true, force: true }));
