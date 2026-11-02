#!/usr/bin/env node
// node scripts/html-eval/run.cjs --out /tmp/html-eval-baseline --repeat 2 --concurrency 3
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { runSession, SYSTEM_PROMPT, sha, writeJson, WORKTREE } = require("./session.cjs");
function parseArgs(args) {
  const options = { cases: path.join(__dirname, "cases.json"), repeat: 2, concurrency: 3, model: "claude-opus-5-5", cli: "claude", timeout: 180, budget: 2 };
  const known = new Set(["out", "cases", "repeat", "concurrency", "model", "cli", "timeout", "budget", "case", "system-prompt"]);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (args[i] === "--help") {
      options.help = true;
      continue;
    }
    const key = args[i].replace(/^--/, "");
    if (!args[i].startsWith("--") || !known.has(key) || !args[i + 1] || args[i + 1].startsWith("--")) throw Error(`Invalid option: ${args[i]}`);
    options[key] = args[++i];
  }
  for (const key of ["repeat", "concurrency", "timeout", "budget"]) {
    options[key] = Number(options[key]);
    if (!Number.isFinite(options[key]) || options[key] <= 0 || (key !== "budget" && !Number.isInteger(options[key]))) throw Error(`Invalid --${key}`);
  }
  if (options.concurrency > 3) throw Error("--concurrency cannot exceed 3");
  return options;
}
function loadCases(file, filter) {
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  if (doc.version !== 1 || !Array.isArray(doc.cases)) throw Error("Expected cases schema version 1");
  const ids = new Set();
  for (const c of doc.cases) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(c.id) || ids.has(c.id) || typeof c.prompt !== "string" || !c.prompt.trim())
      throw Error(`Invalid or duplicate case: ${c.id}`);
    ids.add(c.id);
  }
  const cases = filter ? doc.cases.filter((c) => filter.split(",").includes(c.id)) : doc.cases;
  if (!cases.length) throw Error("No matching cases");
  if (filter && filter.split(",").some((id) => !ids.has(id))) throw Error("Unknown --case id");
  return cases;
}
async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    console.log(
      "Usage: node scripts/html-eval/run.cjs --out EXTERNAL_DIRECTORY [--repeat 2] [--concurrency 3] [--case id,id] [--model claude-opus-5-5] [--cli claude] [--timeout 180] [--budget 2] [--system-prompt FILE] [--dry-run]",
    );
    return;
  }
  if (!o.out) throw Error("--out is required");
  const root = path.resolve(o.out),
    relative = path.relative(WORKTREE, root);
  if (!relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)) throw Error("--out must be outside the checkout");
  const cases = loadCases(path.resolve(o.cases), o.case);
  const jobs = cases.flatMap((caseSpec) => Array.from({ length: o.repeat }, (_, i) => ({ caseSpec, iteration: i + 1 })));
  const systemPrompt = o["system-prompt"] ? fs.readFileSync(path.resolve(o["system-prompt"]), "utf8") : SYSTEM_PROMPT;
  const sourceFiles = [
    "packages/core/src/html-render.cjs",
    "packages/shared/src/html-render.mjs",
    "scripts/html-eval/session.cjs",
    "scripts/html-eval/run.cjs",
  ];
  const sources = Object.fromEntries(sourceFiles.map((file) => [file, sha(fs.readFileSync(path.join(WORKTREE, file)))]));
  const manifest = {
    version: 1,
    startedAt: new Date().toISOString(),
    worktree: WORKTREE,
    output: root,
    gitHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: WORKTREE, encoding: "utf8" }).trim(),
    gitDirty: !!execFileSync("git", ["status", "--porcelain"], { cwd: WORKTREE, encoding: "utf8" }).trim(),
    model: o.model,
    casesFile: path.resolve(o.cases),
    casesSha256: sha(fs.readFileSync(path.resolve(o.cases))),
    sources,
    systemPromptSha256: sha(systemPrompt),
    repeat: o.repeat,
    concurrency: o.concurrency,
    sessionCount: jobs.length,
    previewNarrowWidth: 340,
    plannedSessions: jobs.map(({ caseSpec, iteration }) => ({ sessionId: `${caseSpec.id}-r${iteration}`, caseId: caseSpec.id, repeat: iteration })),
    timeoutSeconds: o.timeout,
    maxBudgetPerSessionUsd: o.budget,
    cases,
    note: "Independent generations, frozen current tool instructions; inspection is separate. A successful tool call is not a visual-quality score.",
  };
  if (o.dryRun) {
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }
  fs.mkdirSync(root); // Fail on existing output, even empty: no accidental overwrite or mixed runs.
  for (const dir of ["sessions", "private", "snapshot"]) fs.mkdirSync(path.join(root, dir), { mode: dir === "private" ? 0o700 : 0o755 });
  fs.writeFileSync(path.join(root, "snapshot", "system.txt"), systemPrompt);
  writeJson(path.join(root, "snapshot", "cases.json"), { version: 1, cases });
  for (const file of sourceFiles) fs.copyFileSync(path.join(WORKTREE, file), path.join(root, "snapshot", file.replaceAll("/", "__")));
  writeJson(path.join(root, "manifest.json"), manifest);
  const results = [];
  let cursor = 0;
  const save = () =>
    writeJson(path.join(root, "summary.json"), {
      version: 1,
      total: jobs.length,
      settled: results.length,
      completed: results.filter((r) => r.status === "completed").length,
      failed: results.filter((r) => r.status === "failed").length,
      costUsd: results.reduce((n, r) => n + (r.costUsd || 0), 0),
      sessions: results,
    });
  await Promise.all(
    Array.from({ length: Math.min(o.concurrency, jobs.length) }, async () => {
      while (cursor < jobs.length) {
        const job = jobs[cursor++];
        let record;
        console.log(`START ${job.caseSpec.id}-r${job.iteration}`);
        try {
          record = await runSession({ root, ...job, model: o.model, cli: o.cli, systemPrompt, timeoutMs: o.timeout * 1000, maxBudget: o.budget });
        } catch (error) {
          record = {
            sessionId: `${job.caseSpec.id}-r${job.iteration}`,
            caseId: job.caseSpec.id,
            repeat: job.iteration,
            status: "failed",
            error: error.message,
          };
        }
        results.push(record);
        save();
        console.log(`DONE ${record.sessionId} ${record.status} calls=${record.calls ?? 0} cost=${record.costUsd ?? "unknown"}`);
      }
    }),
  );
  manifest.finishedAt = new Date().toISOString();
  manifest.sourcesUnchanged = sourceFiles.every((file) => sources[file] === sha(fs.readFileSync(path.join(WORKTREE, file))));
  writeJson(path.join(root, "manifest.json"), manifest);
  console.log(`Evidence: ${root}; completed=${results.filter((r) => r.status === "completed").length}/${jobs.length}`);
  if (results.some((r) => r.status !== "completed") || !manifest.sourcesUnchanged) process.exitCode = 1;
}
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { parseArgs, loadCases };
