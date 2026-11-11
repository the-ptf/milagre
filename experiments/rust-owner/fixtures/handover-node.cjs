#!/usr/bin/env node
// Node's handover.cjs (packages/core/src/agents/handover.cjs) over fixtures/handover-cases.json; tests/handover.rs
// compares the Rust port. Prints one JSON array, one entry per case. Run with TZ=UTC (a Routine run's time).
//
//   TZ=UTC node handover-node.cjs <cases.json>
//
// A case value { "$repeat": text, "$times": n } stands for text.repeat(n) and { "$concat": [...] } for its parts
// joined, so long transcripts stay small here. A case that throws in Node gives { "error": true }.

const Module = require("node:module");
const fs = require("node:fs");
const path = require("node:path");

const { execFileSync } = require("node:child_process");

const repo = path.resolve(__dirname, "../../..");
const installed =
  process.env.MILAGRE_NODE_MODULES ??
  path.resolve(execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: repo, encoding: "utf8" }).trim(), "..", "node_modules");
// oxlint-disable-next-line no-underscore-dangle -- the one hook that maps a workspace package without node_modules
const resolve = Module._resolveFilename;
// oxlint-disable-next-line no-underscore-dangle
Module._resolveFilename = function (request, parent, ...rest) {
  if (request.startsWith("@milagre/shared/")) return path.join(repo, "packages/shared/src", `${request.slice("@milagre/shared/".length)}.mjs`);
  try {
    return resolve.call(this, request, parent, ...rest);
  } catch (error) {
    if (error.code !== "MODULE_NOT_FOUND" || request.startsWith(".") || path.isAbsolute(request)) throw error;
    return resolve.call(this, request, { ...parent, paths: [installed] }, ...rest);
  }
};
const handover = require(path.join(repo, "packages/core/src/agents/handover.cjs"));

function build(value) {
  if (Array.isArray(value)) return value.map(build);
  if (value && typeof value === "object") {
    if ("$repeat" in value) return build(value.$repeat).repeat(value.$times);
    if ("$concat" in value) return value.$concat.map(build).join("");
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, build(item)]));
  }
  return value;
}

async function run(spec) {
  const c = build(spec);
  switch (c.op) {
    case "render": {
      const transcript = handover.renderTranscript(c.state, c.sessionId, "after" in c ? { after: c.after } : undefined);
      return { transcript, cut: handover.cutTranscript(transcript) };
    }
    case "cut":
      return { cut: handover.cutTranscript(c.text) };
    case "framed":
      return { framed: handover.framedBrief(c.brief) };
    case "path":
      return { path: handover.transcriptPath(c.dir, c.projectPath, c.sessionId) };
    case "brief": {
      let asked = null;
      const models =
        "reply" in c
          ? {
              [c.provider]: async ({ system, prompt }) => {
                asked = { system, prompt };
                if (c.rejects) throw new Error("model failed");
                return c.reply;
              },
            }
          : {};
      const brief = await handover.generateBrief(
        {
          transcript: c.transcript,
          transcriptPath: c.file,
          provider: c.provider,
          lastUserMessage: c.lastUserMessage,
          changedFiles: async () => {
            if (c.changedFilesFail) throw new Error("git failed");
            return c.changedFiles ?? [];
          },
          catchUp: c.catchUp ?? false,
        },
        { models },
      );
      return { brief, asked };
    }
    default:
      throw new Error(`unknown op ${c.op}`);
  }
}

(async () => {
  const cases = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const out = [];
  for (const spec of cases) {
    try {
      out.push(await run(spec));
    } catch {
      out.push({ error: true });
    }
  }
  process.stdout.write(JSON.stringify(out));
})();
