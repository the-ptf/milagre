#!/usr/bin/env node
// Actual repository helpers, synthetic host observations only. Never spawn, install, read a
// profile or inherit process.env. Every unexpected require/host probe throws.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const root = path.resolve(__dirname, "../../..");
const files = [
  "packages/core/src/agents/kiro-acp.cjs",
  "packages/core/src/agents/antigravity-acp.cjs",
  "packages/core/src/agents/antigravity-install.cjs",
  "packages/shared/src/kiro-models.mjs",
  "packages/shared/src/antigravity-models.mjs",
];
const output = path.join(__dirname, "../tests/fixtures/node-planning.json");
const readable = new Set([...files.map((file) => path.join(root, file)), output]);
function readRecorded(file) {
  if (!readable.has(file)) throw new Error("unapproved recorder read");
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024 || fs.realpathSync(file) !== file) throw new Error("invalid recorder source path or size");
  return fs.readFileSync(file, "utf8");
}
const source = Object.fromEntries(files.map((file) => [file, readRecorded(path.join(root, file))]));
const forbiddenCalls = [];
const deny = (operation = "host") => {
  forbiddenCalls.push(operation);
  throw new Error("unexpected host operation in planning recorder");
};
const host = new Proxy(
  {},
  {
    get:
      (_, key) =>
      (..._args) =>
        deny(String(key)),
  },
);
async function main() {
  function pureModule(file) {
    const names = [...source[file].matchAll(/^export (?:const|function) (\w+)/gm)].map((m) => m[1]);
    const context = { module: { exports: {} } };
    vm.runInNewContext(source[file].replace(/^export (?=const|function)/gm, "") + `\nmodule.exports = {${names.join(",")}};`, context, {
      filename: file,
      timeout: 1000,
    });
    return context.module.exports;
  }
  const kiroModels = pureModule(files[3]);
  const antiModels = pureModule(files[4]);
  function helpers(platform, override) {
    const p = platform === "win32" ? path.win32 : path.posix;
    const process = { platform, arch: "arm64", env: override ? { MILAGRE_KIRO_PATH: override } : {} };
    function load(file, extras = {}) {
      const context = {
        module: { exports: {} },
        process,
        require: (id) => {
          if (id in extras) return extras[id];
          if (["node:fs", "node:fs/promises", "node:child_process"].includes(id)) return host;
          if (id === "node:os")
            return new Proxy({ tmpdir: () => "/synthetic-temp" }, { get: (target, key) => (Object.hasOwn(target, key) ? target[key] : deny("os probe")) });
          if (id === "node:path") return p;
          if (["node:crypto", "node:stream", "node:stream/promises"].includes(id)) return require(id);
          return deny("unexpected require");
        },
      };
      vm.runInNewContext(source[file], context, { filename: file, timeout: 1000 });
      return context.module.exports;
    }
    const install = load(files[2]);
    const kiro = load(files[0], { "@milagre/shared/kiro-models": kiroModels });
    const anti = load(files[1], {
      "./antigravity-install.cjs": install,
      "@milagre/shared/antigravity-models": antiModels,
      "./antigravity-subagents.cjs": {
        AntigravitySubagents: deny,
      },
    });
    return { p, install, kiro, anti };
  }
  function base(vendor, platform) {
    const home = platform === "windows" ? "C:/fixture" : "/fixture";
    const account = { id: vendor === "kiro" ? "default" : "account-fixture", scope: "project-fixture", generation: 7 };
    return {
      vendor,
      platform,
      expected_account: account,
      account: { vendor, selected: { ...account }, ready: true },
      install:
        vendor === "kiro"
          ? { vendor, override_candidate: { path: `${home}/override-agent`, executable: true }, real_sibling: null, launcher_sibling: null, mac_app: null }
          : { vendor, agent: { path: `${home}/agent`, executable: true }, harness: { path: `${home}/harness`, executable: true }, pair_matches: true },
      resources: {
        cwd: `${home}/workspace`,
        profile: vendor === "antigravity" ? `${home}/profile` : null,
        scratch: vendor === "antigravity" ? `${home}/scratch` : null,
      },
      environment: [
        { key: "PATH", value: `${home}/bin` },
        { key: "LANG", value: "en_US.UTF-8" },
      ],
      ambient: vendor === "antigravity" ? ["google-credentials", "google-project", "browser", "electron-run-as-node"] : [],
      policy: "ask",
      requires_host_guard: false,
      requires_mcp_guard: false,
      models: { model: vendor === "kiro" ? "kiro:auto" : "gemini-4-argon", effort: null, offered: [] },
      mcp: [
        { id: "disabled", enabled: false, required: false },
        { id: "linked", enabled: true, required: true },
      ],
    };
  }
  // Prove real profile/install probes are denied, including a helper that catches fs errors.
  let outsideReadRefused = false;
  try {
    readRecorded("/forbidden-account-profile/token.json");
  } catch {
    outsideReadRefused = true;
  }
  if (!outsideReadRefused) throw new Error("recorder read allowlist failed");
  const audit = helpers("darwin");
  let refused = false;
  try {
    audit.install.hasToken("/forbidden-account-profile");
  } catch {
    refused = true;
  }
  if (!refused || forbiddenCalls.length !== 1) throw new Error("profile probe guard failed");
  audit.kiro.kiroAgentFor(null);
  if (forbiddenCalls.length !== 2) throw new Error("caught install probe was not tracked");
  const allowedAuditCalls = forbiddenCalls.length;
  const launches = [];
  function record(input, command, h) {
    if (!command) {
      launches.push({ input, node: null });
      return;
    }
    let env = Object.fromEntries(input.environment.map(({ key, value }) => [key, value]));
    if (input.vendor === "antigravity") {
      env = { ...env, ...Object.fromEntries(h.install.AMBIENT_ENV.map((key) => [key, "synthetic-presence"])), GEMINI_HOME: input.resources.profile };
    }
    const config = input.vendor === "kiro" ? h.kiro.kiroAcp : h.anti.antigravityAcp;
    const offered = input.models.offered.map((m) => ({ value: m.value, name: m.name, _meta: { kiro: { effortLevels: m.efforts } } }));
    const model = config.resolveModel({ model: input.models.model, effort: input.models.effort, offered });
    const spawn = config.spawn({ command, env, harness: input.install.harness?.path, tmpdir: input.resources.scratch });
    launches.push({
      input,
      node: {
        ...spawn,
        model,
        effort: config.resolveEffort?.({ model, effort: input.models.effort, offered }) ?? null,
        mode_option: config.modeOption ?? "mode",
        mode_value: config.modes.ask,
      },
    });
  }
  for (const [platform, native] of [
    ["mac", "darwin"],
    ["linux", "linux"],
    ["windows", "win32"],
  ]) {
    for (let mask = 0; mask < 16; mask++) {
      const input = base("kiro", platform);
      const home = platform === "windows" ? "C:/fixture" : "/fixture";
      const override = `${home}/override-agent`;
      const h = helpers(native, override);
      const launcher = `${home}/launch/kiro-cli`;
      const real = `${home}/real/kiro-cli`;
      const name = native === "win32" ? "kiro-cli-chat.exe" : "kiro-cli-chat";
      const slots = [
        override,
        h.p.join(h.p.dirname(real), name),
        h.p.join(h.p.dirname(launcher), name),
        "/Applications/Kiro CLI.app/Contents/MacOS/kiro-cli-chat",
      ];
      ["override_candidate", "real_sibling", "launcher_sibling", "mac_app"].forEach((key, index) => {
        input.install[key] = index === 3 && platform !== "mac" ? null : { path: slots[index], executable: Boolean(mask & (1 << index)) };
      });
      record(input, h.kiro.kiroAgentFor(launcher, { exists: (file) => slots.some((s, i) => s === file && mask & (1 << i)), realpath: () => real }), h);
    }
    const input = base("antigravity", platform);
    const h = helpers(native);
    record(input, input.install.agent.path, h);
  }
  const modelCases = [
    ["kiro", "kiro:auto", "high", []],
    ["kiro", "raw", "none", [{ value: "raw", name: "Raw", efforts: ["low", "none"] }]],
    ["kiro", "kiro:raw", "high", [{ value: "raw", name: "Raw", efforts: ["low", "high"] }]],
    ["kiro", "kiro:raw", "max", [{ value: "raw", name: "Raw", efforts: ["low", "high"] }]],
  ];
  for (const model of ["gemini-4-argon", "gemini-4-argon-low", "gemini-3.8-flash", "unknown", "claude-opus", "antigravity:claude-opus", "test-family"]) {
    for (const effort of [null, "low", "high", "max"]) {
      modelCases.push(["antigravity", model, effort, []]);
      modelCases.push([
        "antigravity",
        model,
        effort,
        [
          { value: "c-low", name: "Claude Opus (Low)", efforts: [] },
          { value: "c-high", name: "Claude Opus (High)", efforts: [] },
          { value: "t-low", name: "Test Family (Low)", efforts: [] },
          { value: "t-max", name: "Test Family (Max)", efforts: [] },
          { value: "duplicate", name: "Test Family (Low)", efforts: [] },
          { value: "bare", name: "Test Family", efforts: [] },
        ],
      ]);
    }
  }
  for (const [vendor, model, effort, offered] of modelCases) {
    const input = base(vendor, "mac");
    input.models = { model, effort, offered };
    const h = helpers("darwin");
    record(input, vendor === "kiro" ? input.install.override_candidate.path : input.install.agent.path, h);
  }
  const failures = [];
  for (const vendor of ["kiro", "antigravity"])
    for (const rpc_error of [false, true])
      for (const code of [-32000, -32601]) {
        for (const message of [
          "ordinary refusal",
          "Sign-in needed",
          "Sign in",
          "signin",
          "NOT LOGGED IN",
          "Authenticate",
          "kiro-cli login",
          "token has expired",
          "token expired",
          "unauthorised",
          "unauthorized",
          "API key is missing",
          "login required",
          "SUBSCRIPTION_REQUIRED",
          "sign-in SUBSCRIPTION_REQUIRED",
        ]) {
          for (const data_text of [null, "SUBSCRIPTION_REQUIRED", "not logged in"]) {
            const input = { rpc_error, code, message, data_text };
            const error = { message, ...(rpc_error ? { rpcError: { code, data: data_text } } : {}) };
            const h = helpers("darwin");
            const c = vendor === "kiro" ? h.kiro.kiroAcp : h.anti.antigravityAcp;
            const expected = !rpc_error ? "transport" : c.isSubscriptionError?.(error) ? "subscription" : c.isLoginError(error) ? "authentication" : "server";
            failures.push({ vendor, input, expected });
          }
        }
      }
  if (forbiddenCalls.length !== allowedAuditCalls) throw new Error("helper attempted a real host/profile/install probe");
  const sources = Object.fromEntries(files.map((file) => [file, crypto.createHash("sha256").update(source[file]).digest("hex")]));
  const result = JSON.stringify({ sources, launches, failures }, null, 2) + "\n";
  if (process.argv.includes("--check")) {
    if (JSON.stringify(JSON.parse(readRecorded(output))) !== JSON.stringify(JSON.parse(result))) throw new Error("Node planning source/result drift");
  } else fs.writeFileSync(output, result);
  console.log(`${launches.length} Node launch/model cases, ${failures.length} Node failure cases verified`);
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
