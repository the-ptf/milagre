import { test } from "node:test";
import assert from "node:assert/strict";
import { applyHiddenProjects, boundedHidden, createHiddenProjectsStore } from "./hidden-projects-store.ts";

function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItemAsync: async (key: string) => values.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

test("applyHiddenProjects ignores the computer's hidden flag and applies the phone's hidden set", () => {
  const result = applyHiddenProjects(new Set(["/code/b", "milagre-link:checkout"]), [
    { path: "/code/a", name: "a", hidden: true },
    { path: "/code/b", name: "b" },
    { path: "milagre-link:checkout", name: "Checkout" },
  ]);
  assert.deepEqual(result, [
    { path: "/code/a", name: "a" },
    { path: "/code/b", name: "b", hidden: true },
    { path: "milagre-link:checkout", name: "Checkout", hidden: true },
  ]);
});

test("hidden projects survive a relaunch, per computer, without affecting other computers", async () => {
  const disk = storage();
  const first = createHiddenProjectsStore(disk);
  await first.setHidden("relay://mac", "/code/a", true);
  await first.setHidden("relay://mac", "/code/b", true);
  await first.setHidden("relay://mac", "/code/b", false);
  await first.setHidden("https://studio", "/code/c", true);
  assert.deepEqual([...first.hidden("relay://mac")], ["/code/a"]);
  const launch = createHiddenProjectsStore(disk);
  assert.deepEqual(
    await launch.apply("relay://mac", [
      { path: "/code/a", name: "a" },
      { path: "/code/b", name: "b", hidden: true },
    ]),
    [
      { path: "/code/a", name: "a", hidden: true },
      { path: "/code/b", name: "b" },
    ],
  );
  assert.deepEqual(await launch.apply("https://studio", [{ path: "/code/c", name: "c" }]), [{ path: "/code/c", name: "c", hidden: true }]);
  assert.deepEqual(await launch.apply("https://other", [{ path: "/code/a", name: "a", hidden: true }]), [{ path: "/code/a", name: "a" }]);
});

test("the saved set keeps the most recently hidden paths under the size limit", () => {
  const many = Array.from({ length: 200 }, (_, index) => `/Users/someone/Code/project-number-${index}`);
  const kept = boundedHidden("relay://mac", many);
  assert.ok(kept.length > 0 && kept.length < many.length);
  assert.equal(kept.at(-1), many.at(-1));
  assert.ok(new TextEncoder().encode(JSON.stringify({ h: "relay://mac", p: kept })).length <= 1900);
});
