const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAutoUpdate, hostActivity } = require("./app-auto-update.cjs");

test("the switch starts off, survives a reload, keeps other fields and tells every listener", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-auto-update-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "nested", "app-update.json");
  const events = [];
  const autoUpdate = createAutoUpdate({ file, emit: (channel, payload) => events.push([channel, payload]) });
  assert.deepEqual(autoUpdate.read(), { autoUpdate: false });
  assert.deepEqual(autoUpdate.save(true), { autoUpdate: true });
  assert.deepEqual(events, [["app-update:auto", { autoUpdate: true }]]);
  assert.deepEqual(createAutoUpdate({ file }).read(), { autoUpdate: true });
  fs.writeFileSync(file, JSON.stringify({ autoUpdate: true, later: 1 }));
  assert.deepEqual(autoUpdate.save("yes"), { autoUpdate: false }, "only true turns it on");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { autoUpdate: false, later: 1 });
  fs.writeFileSync(file, "{");
  assert.deepEqual(autoUpdate.read(), { autoUpdate: false }, "an unreadable file reads as off");
});

test("activity counts busy Chats once, background work the sidebar shows, and Routine Runs", () => {
  const active = { id: "agent", background: true, status: "running", startedAt: 1 };
  const scopes = [
    {
      key: "/app",
      state: {
        sessions: {
          1: { id: 1, provider: "claude" },
          2: { id: 2, provider: "claude", subagents: [active] },
          3: { id: 3, provider: "claude", backgroundTasks: [{ id: "dev", kind: "local_bash", startedAt: 2 }] },
          4: { id: 4, provider: "claude", archived: true, subagents: [active] },
          5: { id: 5, provider: "claude", subagents: [{ ...active, status: "completed" }] },
        },
      },
    },
    { key: "/web", state: undefined },
  ];
  assert.deepEqual(hostActivity({ busy: ["/app#1", "/app#2"], scopes, routines: 2 }), { chats: 3, routines: 2 });
  assert.deepEqual(hostActivity({ busy: [], scopes: [], routines: 0 }), { chats: 0, routines: 0 });
});
