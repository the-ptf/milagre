#!/usr/bin/env node
// Runs TLC on both models and compares each run with what it should find: the code as it is passes, each known-open
// window breaks only its strict rule, and each broken variant (the models' `Break` constant) breaks the rule it guards.
// Usage: node .agents/skills/verify-snooze-and-computer-link/check.mjs [snooze|computer-link]
// TLC: $TLA2TOOLS (a tla2tools.jar), else v1.7.4 downloaded once to ~/.cache/milagre-tlc and checked by its SHA-256.
// Java: $JAVA, else `java` on PATH (Java 11 or later).
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const TLC_URL = "https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar";
const TLC_SHA256 = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88";

// Each case: the model, its config, the Break value, and the rules it must break (none: it must pass).
const CASES = [
  { model: "snooze", spec: "Snooze", cfg: "Snooze.cfg", breaks: [] },
  { model: "snooze", spec: "Snooze", cfg: "Snooze-known-open.cfg", breaks: ["NeedsYouShowsStrict", "SnoozedFinishIsQuietStrict"] },
  { model: "snooze", spec: "Snooze", cfg: "Snooze.cfg", variant: "noSaveWake", breaks: ["NeedsYouShows"] },
  { model: "snooze", spec: "Snooze", cfg: "Snooze.cfg", variant: "dropFailedPush", breaks: ["FailureReachesPhone"] },
  { model: "snooze", spec: "Snooze", cfg: "Snooze.cfg", variant: "markWaitsForRows", breaks: ["NeedsYouShows", "SidebarAgrees"] },
  { model: "snooze", spec: "Snooze", cfg: "Snooze.cfg", variant: "pushIgnoresSnooze", breaks: ["SnoozedFinishIsQuiet"] },
  { model: "computer-link", spec: "ComputerLink", cfg: "ComputerLink.cfg", breaks: [] },
  {
    model: "computer-link",
    spec: "ComputerLink",
    cfg: "ComputerLink.cfg",
    variant: "moveDuringFirstCalls",
    breaks: ["OnlineCallGoesThrough", "OnlineMeansConnected"],
  },
  { model: "computer-link", spec: "ComputerLink", cfg: "ComputerLink.cfg", variant: "noBlipWait", breaks: ["CallWaitsWhileComingBack"] },
  { model: "computer-link", spec: "ComputerLink", cfg: "ComputerLink.cfg", variant: "onlineKeepsHold", breaks: ["SwitchHoldEnds"] },
  { model: "computer-link", spec: "ComputerLink", cfg: "ComputerLink.cfg", variant: "refuseKeepsDialing", breaks: ["RefusedIsQuiet"] },
  { model: "computer-link", spec: "ComputerLink", cfg: "ComputerLink.cfg", variant: "offKeepsDialing", breaks: ["OffIsQuiet"] },
];

function tlcJar() {
  if (process.env.TLA2TOOLS) return process.env.TLA2TOOLS;
  const jar = join(homedir(), ".cache", "milagre-tlc", "tla2tools-1.7.4.jar");
  if (!existsSync(jar)) {
    mkdirSync(dirname(jar), { recursive: true });
    console.log(`Downloading TLC 1.7.4 to ${jar}`);
    execFileSync("curl", ["-fsSL", "-o", `${jar}.part`, TLC_URL]);
    const sha = createHash("sha256")
      .update(readFileSync(`${jar}.part`))
      .digest("hex");
    if (sha !== TLC_SHA256) throw new Error(`tla2tools.jar has SHA-256 ${sha}, not ${TLC_SHA256}`);
    execFileSync("mv", [`${jar}.part`, jar]);
  }
  return jar;
}

function run(jar, item) {
  const dir = join(here, item.model);
  const scratch = mkdtempSync(join(tmpdir(), "milagre-tlc-"));
  try {
    let cfg = join(dir, item.cfg);
    if (item.variant) {
      const text = readFileSync(cfg, "utf8").replace(/^CONSTANT Break = .*$/m, `CONSTANT Break = "${item.variant}"`);
      cfg = join(scratch, item.cfg);
      writeFileSync(cfg, text);
    }
    const result = spawnSync(
      process.env.JAVA || "java",
      ["-XX:+UseParallelGC", "-cp", jar, "tlc2.TLC", "-continue", "-workers", "1", "-metadir", join(scratch, "states"), "-config", cfg, `${item.spec}.tla`],
      { cwd: dir, encoding: "utf8" },
    );
    const out = `${result.stdout}${result.stderr}`;
    const broken = [...new Set([...out.matchAll(/Invariant (\w+) is violated/g)].map((match) => match[1]))].toSorted();
    const deadlock = /Deadlock reached/.test(out);
    // A run that ends in a parse, semantic or evaluation error checked nothing.
    const finished =
      /Finished in/.test(out) && !/(Parse|Semantic) errors|Attempted to|TLC threw an unexpected exception|error occurred when TLC was evaluating/.test(out);
    const states = out.match(/([\d,]+) distinct states found/)?.[1] ?? "?";
    return { broken, deadlock, finished, states, out };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const only = process.argv[2];
const jar = tlcJar();
let failures = 0;
for (const item of CASES.filter((entry) => !only || entry.model === only)) {
  const { broken, deadlock, finished, states, out } = run(jar, item);
  const want = [...item.breaks].toSorted();
  const ok = finished && !deadlock && JSON.stringify(broken) === JSON.stringify(want);
  const name = `${item.model} ${item.cfg}${item.variant ? ` Break=${item.variant}` : ""}`;
  const found = deadlock ? "a deadlock" : broken.length ? `breaks ${broken.join(", ")}` : "holds";
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${found} (${states} states)${ok ? "" : `; expected ${want.length ? `breaks ${want.join(", ")}` : "holds"}`}`);
  if (!ok) {
    failures++;
    if (!finished || deadlock) console.log(out.split("\n").slice(-40).join("\n"));
  }
}
if (failures) {
  console.log(`\n${failures} case(s) differ. Read each with /statechart before deciding whether the model or the code is wrong.`);
  process.exit(1);
}
