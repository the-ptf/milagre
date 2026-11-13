#!/usr/bin/env node
// Node's summarizeStep (packages/shared/src/tool-activity.mjs) and capOutput (agent-runs.mjs) over the cases in
// fixtures/summary-cases.json; tests/summary.rs compares the Rust port. Prints one JSON array.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const shared = path.resolve(here, "../../../packages/shared/src");
const { summarizeStep } = await import(pathToFileURL(path.join(shared, "tool-activity.mjs")).href);
const { capOutput } = await import(pathToFileURL(path.join(shared, "agent-runs.mjs")).href);
const cases = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const out = cases.map((step) => ({ summary: summarizeStep(step), capped: typeof step.detail === "string" ? capOutput(step.detail) : null }));
process.stdout.write(JSON.stringify(out));
