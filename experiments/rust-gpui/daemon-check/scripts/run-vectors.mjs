// Differential traces for the GPUI run fold: applies each case's agent events with the repository's own
// `applyRunEvent` (packages/shared/src/agent-runs.mjs, imported in place, never edited), the way production feeds
// it (`applyAgentEvent` passes `lastUserModel(state, sessionId)`), with `Date.now` injected per event.
//
//   node scripts/run-vectors.mjs tests/vectors/run-cases.json > tests/vectors/run-traces.json
//
// Output is normalized so it compares with the Rust types: strings are made well-formed (`toWellFormed`: a lone
// surrogate from `capOutput`'s slice becomes U+FFFD, which is all a Rust string can hold), and the run flags `split`
// and `waitingForSubagents` are dropped when false (Rust's `bool` has no "absent").
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const { applyRunEvent, lastUserModel } = await import(resolve(here, "../../../../packages/shared/src/agent-runs.mjs"));

const normalize = (value) =>
  JSON.parse(
    JSON.stringify(value, (key, item) => {
      if (typeof item === "string") return item.toWellFormed();
      if ((key === "split" || key === "waitingForSubagents") && item === false) return undefined;
      return item;
    }),
  );

const cases = JSON.parse(readFileSync(process.argv[2], "utf8"));
const realNow = Date.now;
const traces = cases.map(({ name, chatId, lastModel, events }) => {
  const state = { messages: [], sessions: { 1: { summary: lastModel === undefined ? { count: 0 } : { count: 0, lastModel } } } };
  let runs = {};
  const after = events.map(({ at, event }) => {
    Date.now = () => at;
    runs = applyRunEvent(runs, chatId, event, lastUserModel(state, 1));
    return normalize(runs);
  });
  return { name, after };
});
Date.now = realNow;
process.stdout.write(JSON.stringify(traces, null, 1) + "\n");
