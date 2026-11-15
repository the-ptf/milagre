// A node:test reporter beside the usual one: a FAILED-TEST line (test-runner.cjs failureLine) per failing test, which
// `npm test` prints again in its summary. A suite whose subtests failed is left out; its subtests have their own line.
const path = require("node:path");
const { failureLine } = require("./test-runner.cjs");

module.exports = async function* failedTests(source) {
  for await (const event of source) {
    if (event.type !== "test:fail") continue;
    const { name, file, details } = event.data;
    const error = details?.error;
    if (details?.type === "suite" || error?.failureType === "subtestsFailed") continue;
    const cause = error?.cause ?? error;
    const reason = String(cause?.message ?? cause ?? "").split("\n")[0];
    yield `${failureLine(file ? path.relative(process.cwd(), file).split(path.sep).join("/") : "unknown file", name, reason)}\n`;
  }
};
