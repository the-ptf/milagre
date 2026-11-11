#!/usr/bin/env node
// Execute only Node policy functions and their existing tests. Never execute shell inputs.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const { createRequire } = require("node:module");
const root = path.resolve(__dirname, "../../..");
const filename = path.join(root, "packages/core/src/babysit-guard.cjs");
const local = createRequire(filename);
const loaded = { exports: {} };
vm.runInNewContext(
  fs.readFileSync(filename, "utf8") + "\nmodule.exports.actionsOf=actionsOf;",
  {
    module: loaded,
    exports: loaded.exports,
    require: (id) => (id === "@milagre/shared/babysit" ? local(path.join(root, "packages/shared/src/babysit.mjs")) : local(id)),
  },
  { filename },
);
const { actionsOf, babysitDenial } = loaded.exports;
const traces = new Map();
function record(command, guard) {
  traces.set(command, { command, actions: [...actionsOf(command)] });
  return babysitDenial(command, guard);
}
const suite = path.join(root, "packages/core/src/babysit-guard.test.cjs");
vm.runInNewContext(
  fs.readFileSync(suite, "utf8"),
  {
    require: (id) => (id === "node:test" ? (name, run) => run() : id === "./babysit-guard.cjs" ? { babysitDenial: record } : local(id)),
  },
  { filename: suite },
);
const extras = JSON.parse(fs.readFileSync(path.join(__dirname, "../tests/adversarial.json"), "utf8"));
extras.push(...JSON.parse(fs.readFileSync(path.join(__dirname, "../tests/git-abbreviations.json"), "utf8")).cases);
const arity = JSON.parse(fs.readFileSync(path.join(__dirname, "../tests/git-value-arity.json"), "utf8"));
extras.push(...arity.cases, arity.chain);
for (const { command } of extras) record(command, { level: 1 });
const target = path.join(__dirname, "../tests/node-traces.json");
const output = execFileSync(path.join(root, "node_modules/.bin/oxfmt"), ["--stdin-filepath", target], {
  input: JSON.stringify([...traces.values()], null, 2) + "\n",
  encoding: "utf8",
});
if (process.argv.includes("--check")) {
  if (fs.readFileSync(target, "utf8") !== output) throw Error("Node policy fixtures changed");
} else fs.writeFileSync(target, output);
console.log(`${traces.size} distinct actual Node command classifications`);
