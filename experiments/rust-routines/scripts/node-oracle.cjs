const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const root = path.resolve(__dirname, "../../..");
const manifest = require("../oracle-manifest.json");
for (const [file, hash] of Object.entries(manifest.sources)) {
  if (
    crypto
      .createHash("sha256")
      .update(fs.readFileSync(path.join(root, file)))
      .digest("hex") !== hash
  )
    throw Error(`Production source drift: ${file}`);
}
if (process.version !== manifest.node || process.versions.icu !== manifest.icu || process.versions.tz !== manifest.tz)
  throw Error("Node/ICU/TZDB oracle version drift");
const cron = require(path.join(root, "packages/core/src/routines/cron.cjs"));
const values = JSON.parse(fs.readFileSync(0, "utf8"));
if (!Array.isArray(values) || values.length > 20000) throw Error("Oracle request bound");
const output = values.map((value) => {
  try {
    let result;
    if (value.op === "parse") result = Object.fromEntries(Object.entries(cron.parseCron(value.expr)).map(([name, set]) => [name, [...set]]));
    else if (value.op === "every") result = cron.everyToCron(value.every);
    else if (value.op === "next") result = cron.nextRun(value.expr, value.zone, value.after);
    else throw Error("Unknown fixture operation");
    return { ok: result };
  } catch (error) {
    return { error: error.message };
  }
});
console.log(JSON.stringify(output));
