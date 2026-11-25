import assert from "node:assert/strict";
import test from "node:test";

(globalThis as any).window = { milagre: { on: () => ({}) } };
const { namedOpenFailure, readRemoteProject } = await import("./remote-project.ts");

const KEY = "6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7|/Users/deer/rd-events";
const opened = { path: KEY, name: "rd-events", state: { sessions: {}, worktrees: {} }, version: 1, epoch: "e" };

function host(refusal: string | null) {
  const calls: string[] = [];
  const bridge = {
    readProject: async () => {
      calls.push("project:read");
      if (refusal) throw new Error(refusal);
      return opened;
    },
    openCanvasProject: async () => {
      calls.push("canvas:open-project");
      return opened;
    },
  };
  return { bridge: bridge as any, calls };
}

test("a host before #1155 that reads only its recent Projects opens a registered one through canvas:open-project", async () => {
  const older = host("Error invoking remote method 'computers:invoke': Error: Open this project in Milagre first.");
  assert.deepEqual(await readRemoteProject(older.bridge, KEY), opened);
  assert.deepEqual(older.calls, ["project:read", "canvas:open-project"]);
});

test("a current host is only read, and any other refusal still fails", async () => {
  const current = host(null);
  assert.deepEqual(await readRemoteProject(current.bridge, KEY), opened);
  assert.deepEqual(current.calls, ["project:read"]);
  await assert.rejects(readRemoteProject(host("This computer is offline.").bridge, KEY), /offline/);
});

test("a failed open names the computer that refused it", () => {
  const name = () => "deer";
  assert.equal(namedOpenFailure(KEY, new Error("Open this project in Milagre first."), name), "deer: Open this project in Milagre first.");
  assert.equal(namedOpenFailure("/Users/victor/rd-events", new Error("Gone."), name), "Gone.");
});
