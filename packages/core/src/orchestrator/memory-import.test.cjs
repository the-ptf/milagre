const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { importMemory } = require("./memory-import.cjs");

function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-memory-import-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, ".claude", "rules"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".claude", "projects", "app", "memory"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude", "CLAUDE.md"), "# Me\n- Always lead replies with the result\n- Never add AI attribution to commits\n");
  fs.writeFileSync(path.join(dir, ".claude", "rules", "sims.md"), "Boot simulators slim.");
  fs.writeFileSync(path.join(dir, ".claude", "projects", "app", "memory", "a.md"), "app memory");
  fs.writeFileSync(path.join(dir, ".codex", "AGENTS.md"), "Codex rules");
  return dir;
}

test("reads each agent's files, reports every source and keeps the model's notes", async (t) => {
  const dir = home(t);
  const seen = [];
  let asked = "";
  const result = await importMemory({
    home: dir,
    env: {},
    call: async ({ prompt }) => {
      asked = prompt;
      return JSON.stringify({ notes: [{ text: "You want replies to lead with the result", group: "work", source: "Claude Code" }] });
    },
    onSource: (source) => seen.push(source),
  });
  assert.deepEqual(
    seen.map((source) => [source.name, source.count, source.found]),
    [
      ["Claude Code", 3, true],
      ["Codex", 1, true],
      ["Antigravity", 0, false],
      ["Kiro", 0, false],
    ],
  );
  assert.match(asked, /Never add AI attribution/);
  assert.equal(result.notes[0].text, "You want replies to lead with the result");
  assert.equal(result.notes[0].enabled, true);
});

test("without a model it keeps the owner's hard rules from bullet lists", async (t) => {
  const dir = home(t);
  const result = await importMemory({ home: dir, env: {}, call: null });
  assert.deepEqual(
    result.notes.map((note) => note.text),
    ["Always lead replies with the result", "Never add AI attribution to commits"],
  );
});
