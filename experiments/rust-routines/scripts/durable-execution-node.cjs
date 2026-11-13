// Actual production store, generated test data only. No scheduler/provider/runtime.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRoutineStore } = require("../../../packages/core/src/routines/store.cjs");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-routine-execution-node-"));
const file = path.join(root, "routines.json");
const allowed = new Set(["create", "update", "get", "list", "runs", "claimDue", "startRun", "finishRun", "recoverInterrupted", "expireDue", "complete", "attachChat"]);
let now = input.now, calls = 0, effects = [];
const make = () => createRoutineStore({ file, now: () => now, id: () => {
  if (calls >= input.ids.length) throw new Error("Test ID source exhausted");
  return input.ids[calls++];
}, onPurged: value => effects.push({kind:"purged",value}), onRunsDropped: value => effects.push({kind:"dropped",value}), onEnded: value => effects.push({kind:"ended",value}) });
const observations = [];
try {
  let store = make();
  for (const operation of input.operations) {
    now = operation.now; effects = [];
    let result;
    try {
      if (operation.method === "reopen") { store = make(); result = {ok:null}; }
      else {
        if (!allowed.has(operation.method)) throw new Error("Unsupported oracle operation");
        const value = store[operation.method](...operation.args);
        result = {ok:value === undefined ? null : value};
      }
    } catch (error) { result = {error:error.message}; }
    observations.push({result,effects,file:fs.existsSync(file) ? fs.readFileSync(file,"utf8") : null});
  }
} finally { fs.rmSync(root,{recursive:true,force:true}); }
console.log(JSON.stringify({observations,idCalls:calls,rootRemoved:!fs.existsSync(root)}));
