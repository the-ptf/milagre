#!/usr/bin/env node
// Actual Node instruction builders over explicit synthetic bundled-skills directories.
// The real bundled-skills.cjs source is compiled with a synthetic __dirname, so its
// bundledWritingInstructions/bundledAgents/personaAgent and events.cjs run unchanged against
// fixture files. No provider, credential, profile, host discovery or network is used.
//   NODE_PATH=<checkout>/node_modules node experiments/rust-runtime/fixtures/instructions-node.cjs [--check]
// --check writes nothing and fails if the committed JSON differs from fresh output.
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const repo = path.resolve(__dirname, "../../..");
const bundledPath = path.join(repo, "packages/core/src/bundled-skills.cjs");
const eventsPath = path.join(repo, "packages/core/src/agents/events.cjs");
const { SessionManager } = require(path.join(repo, "packages/core/src/agents/session-manager.cjs"));
// --check: build fresh actual Node output and compare it with the committed file without writing.
// The comparison is compact JSON (structure, values and key order; whitespace/formatting ignored).
// `node` is informational: it is excluded from the comparison and both values are printed.
function record(file, output, pretty) {
  if (!process.argv.includes("--check")) {
    fs.writeFileSync(file, JSON.stringify(output, null, pretty) + "\n");
    return "wrote";
  }
  const committed = JSON.parse(fs.readFileSync(file, "utf8"));
  const fresh = JSON.parse(JSON.stringify(output));
  if ("node" in committed || "node" in fresh)
    console.log(`${path.basename(file)}: node version excluded (committed ${committed.node ?? "absent"}, fresh ${fresh.node ?? "absent"})`);
  delete committed.node;
  delete fresh.node;
  if (JSON.stringify(committed) !== JSON.stringify(fresh)) {
    const a = JSON.stringify(committed);
    const b = JSON.stringify(fresh);
    let at = 0;
    while (at < a.length && a[at] === b[at]) at++;
    throw Error(`${path.basename(file)} drifted from fresh Node output at offset ${at}: committed ${JSON.stringify(a.slice(at, at + 80))}, fresh ${JSON.stringify(b.slice(at, at + 80))}`);
  }
  return "matched";
}
// A fixed root keeps the recorded skill paths stable; it must not already exist.
const root = "/tmp/milagre-instructions-oracle";
fs.mkdirSync(root, { mode: 0o700 });

function load(name, files) {
  const base = path.join(root, name);
  for (const [file, text] of Object.entries(files)) {
    const target = path.join(base, "bundled-skills", file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  const filename = path.join(base, "bundled-skills.cjs");
  const fake = new Module(filename, module);
  fake.filename = filename;
  fake.paths = Module._nodeModulePaths(base);
  fake._compile(fs.readFileSync(bundledPath, "utf8"), filename);
  fake.loaded = true;
  require.cache[bundledPath] = fake;
  delete require.cache[eventsPath];
  const events = require(eventsPath);
  delete require.cache[eventsPath];
  delete require.cache[bundledPath];
  return { events, bundled: fake.exports };
}

const realTldr = fs.readFileSync(path.join(repo, "packages/core/src/bundled-skills/tldr/default.md"), "utf8");
const realQa = path.join(repo, "packages/core/src/bundled-skills/qa-fleet");
const realRules = fs.readFileSync(path.join(realQa, "agent.md"), "utf8");
const realPersonas = fs
  .readdirSync(path.join(realQa, "personas"))
  .filter((file) => file.endsWith(".md"))
  .map((file) => [file, fs.readFileSync(path.join(realQa, "personas", file), "utf8")]);
const syntheticPersonas = [
  ["a-crlf.md", "---\r\nname: qa-crlf\r\ndescription:  Windows line endings 　\r\n---\r\n\r\nCRLF body\r\n"],
  ["b-extra.md", "---\nother: x\nname:  qa-spaced \ndescription: second\nname: ignored\n---\n﻿ Body with BOM \u0085\n"],
  ["c-dup.md", "---\nname: qa-crlf\ndescription: replaced value\n---\nReplacement body"],
  ["notes.txt", "not a persona"],
];
const bundles = [
  { name: "real", tldr: realTldr, qa: { "agent.md": realRules, personas: realPersonas } },
  {
    name: "synthetic",
    tldr: "﻿　 Synthetic rules\r\nline two \u0085\n\n",
    qa: { "agent.md": "\r\n  Shared QA rules\r\n", personas: syntheticPersonas },
  },
  { name: "empty", tldr: "", qa: { "agent.md": "", personas: [] } },
];
const hosts = [
  {},
  { name: "box", addresses: [] },
  { name: 'Victor\'s "Mac"', addresses: ["192.0.2.10", "100.64.0.7"] },
  { name: "", addresses: ["10.0.0.2"] },
  { addresses: ["fe80::1"] },
];
const workspaces = [undefined, "", "Workspace: synthetic \u{1F600} text"];

(async () => {
  const output = { generatedBy: "fixtures/instructions-node.cjs", node: process.version, bundles: [], personaErrors: [] };
  try {
    for (const spec of bundles) {
      const files = { "tldr/default.md": spec.tldr, "qa-fleet/agent.md": spec.qa["agent.md"] };
      for (const [file, text] of spec.qa.personas) files[`qa-fleet/personas/${file}`] = text;
      if (!spec.qa.personas.length) fs.mkdirSync(path.join(root, spec.name, "bundled-skills/qa-fleet/personas"), { recursive: true });
      const { events, bundled } = load(spec.name, files);
      const record = {
        name: spec.name,
        skillsDir: bundled.BUNDLED_SKILLS_DIRECTORY,
        tldrDefault: spec.tldr,
        writing: bundled.bundledWritingInstructions(),
        subagentPlan: events.SUBAGENT_PLAN_INSTRUCTIONS,
        subagentDesign: events.SUBAGENT_DESIGN_INSTRUCTIONS,
        agentMd: spec.qa["agent.md"],
        // The order readdirSync actually returned, which Rust is handed explicitly.
        personas: fs.readdirSync(path.join(bundled.BUNDLED_SKILLS_DIRECTORY, "qa-fleet/personas")).map((file) => [
          file,
          fs.readFileSync(path.join(bundled.BUNDLED_SKILLS_DIRECTORY, "qa-fleet/personas", file), "utf8"),
        ]),
        agents: bundled.bundledAgents(),
        instructions: [],
        sessions: [],
      };
      for (const tldrEnabled of [true, false])
        for (const workspace of workspaces)
          for (const sharedLink of [false, true])
            record.instructions.push({ tldrEnabled, workspace: workspace ?? null, sharedLink, text: events.milagreInstructions(tldrEnabled, workspace, { sharedLink }) });
      // The actual SessionManager composition of request workspace and host instructions.
      for (const host of hosts)
        for (const workspace of workspaces) {
          const hostText = events.hostNetworkInstructions(host);
          let captured;
          const manager = new SessionManager({
            createSession: (_provider, options) => {
              captured = options;
              return { closed: false, turnActive: false, close: async () => {} };
            },
            send: () => {},
            hostInstructions: () => hostText,
          });
          await manager.currentEntry({ chatId: "/fixture#1", provider: "claude", cwd: "/fixture", workspaceInstructions: workspace, tldrEnabled: true });
          const composed = captured.workspaceInstructions;
          record.sessions.push({
            host,
            hostText,
            workspace: workspace ?? null,
            composed: composed ?? null,
            text: events.sessionInstructions({ ...captured, analysisOnly: false, executionAdvisor: false }),
          });
        }
      output.bundles.push(record);
    }
    const { bundled } = load("errors", { "tldr/default.md": "x" });
    for (const text of ["no frontmatter", "---\nname: x\n---\nmissing description", "---\nname: \ndescription: d\n---\nempty name", "---\r\nname: x\r\ndescription: d\r\n---"])
      try {
        output.personaErrors.push({ text, value: bundled.personaAgent(text, "rules") });
      } catch (error) {
        output.personaErrors.push({ text, throws: error.constructor.name });
      }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  if (fs.existsSync(root)) throw Error(`temporary oracle root ${root} was not removed`);
  // Long texts repeat across cases: store each once and refer to it by index.
  const texts = [];
  const intern = (text) => {
    const at = texts.indexOf(text);
    return at === -1 ? texts.push(text) - 1 : at;
  };
  for (const bundle of output.bundles) {
    for (const entry of [...bundle.instructions, ...bundle.sessions]) entry.text = intern(entry.text);
    for (const agent of Object.values(bundle.agents)) agent.prompt = intern(agent.prompt);
    bundle.personas = bundle.personas.map(([file, text]) => [file, intern(text)]);
    bundle.agentMd = intern(bundle.agentMd);
  }
  output.texts = texts;
  const file = path.join(__dirname, "instructions-node.json");
  const verb = record(file, output);
  console.log(`${verb} ${output.bundles.length} bundles, ${output.bundles.reduce((n, b) => n + b.instructions.length + b.sessions.length, 0)} instruction texts; temporary root removed`);
})().catch((error) => {
  fs.rmSync(root, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
