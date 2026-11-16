#!/usr/bin/env node
const fs = require("node:fs");

const BUDGET = "apps/site/lighthouse-budget.json";
const LABEL = "lighthouse-budget-approved";

function floors(budget, prefix = "") {
  const out = {};
  for (const [key, value] of Object.entries(budget ?? {})) {
    if (key.startsWith("$")) continue;
    const at = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "number") out[at] = value;
    else if (value && typeof value === "object" && !Array.isArray(value)) Object.assign(out, floors(value, at));
  }
  return out;
}

/**
 * @param {object | null} base @param {object | null} head
 */
function loosened(base, head) {
  if (!base) return [];
  if (!head) return [`${BUDGET} was removed`];
  const problems = [];
  const after = floors(head);
  for (const [at, floor] of Object.entries(floors(base))) {
    if (!(at in after)) problems.push(`${at} was removed (was ${floor})`);
    else if (after[at] < floor) problems.push(`${at} went down from ${floor} to ${after[at]}`);
  }
  const skipped = new Set(base.skipAudits ?? []);
  for (const audit of head.skipAudits ?? []) if (!skipped.has(audit)) problems.push(`skipAudits gained "${audit}"`);
  return problems;
}

function check({ base, head, labels }) {
  const problems = loosened(base, head);
  if (!problems.length) return { ok: true, message: "The Lighthouse budget did not get looser." };
  const list = problems.map((problem) => `  - ${problem}`).join("\n");
  if (labels.includes(LABEL)) return { ok: true, message: `The Lighthouse budget got looser, approved by the ${LABEL} label:\n${list}` };
  return {
    ok: false,
    message:
      `This PR loosens ${BUDGET}:\n${list}\n` +
      "Lighthouse scores for apps/site never go down (AGENTS.md): find what made the page slower instead of lowering a floor, " +
      "and add to skipAudits only with the user's say-so. " +
      `If the user approved this change, add the ${LABEL} label.`,
  };
}

function readJson(file) {
  if (!file || !fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, "utf8").trim();
  return text ? JSON.parse(text) : null;
}

if (require.main === module) {
  const [baseFile, headFile] = process.argv.slice(2);
  const result = check({ base: readJson(baseFile), head: readJson(headFile), labels: JSON.parse(process.env.LABELS || "[]") });
  if (result.ok) console.log(result.message);
  else console.error(process.env.GITHUB_ACTIONS ? `::error::${result.message.replace(/\n/g, "%0A")}` : result.message);
  process.exit(result.ok ? 0 : 1);
}

module.exports = { check, loosened, floors, LABEL, BUDGET };
