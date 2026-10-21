import assert from "node:assert/strict";
import test from "node:test";

const stored = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => stored.set(key, value),
  removeItem: (key: string) => stored.delete(key),
};
const dispatched: string[] = [];
(globalThis as any).window = { milagre: {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: (event: Event) => dispatched.push(event.type) };
const { bySection, computerScopes, computerSections, mergeScopes, withLocalVisibility, withoutLocal } = await import("./computer-scopes.ts");
const { readHiddenComputers, setComputerHidden } = await import("./hidden-projects.ts");

const A = "c-arketa";
const S = "c-studio";
test("a computer's Projects and Links use this Mac's visibility, ignoring the remote computer's own hidden flags", () => {
  const local = withLocalVisibility(
    [
      { path: `${A}|/a/web`, name: "arketa-web", openedAt: "", hidden: true },
      { path: `${A}|/a/old`, name: "old", openedAt: "" },
    ],
    [{ id: `${A}|f1713d69-569d-405b-a0b2-19bfdf565a76`, name: "Checkout", projectIds: [], createdAt: "", hidden: true } as any],
    new Set([`${A}|/a/old`]),
  );
  assert.equal(local.recent[0]?.hidden, undefined, "hidden on the other computer does not hide it on this Mac");
  assert.equal(local.recent[1]?.hidden, true, "hidden on this Mac marks the remote Project hidden here");
  assert.equal(local.links[0]?.hidden, undefined, "Link hidden on the other computer stays shown on this Mac");
  const scopes = computerScopes(A, local.recent, local.links);
  assert.deepEqual(
    scopes.map((scope) => [scope.key, scope.name, scope.computerId, Boolean(scope.link)]),
    [
      [`${A}|/a/web`, "arketa-web", A, false],
      [`milagre-link:${A}|f1713d69-569d-405b-a0b2-19bfdf565a76`, "Checkout", A, true],
    ],
  );
});

test("every computer's scopes in one list: Projects by name, then Links; on a tie, This Mac first, then the computers in order", () => {
  const scope = (key: string, name: string, computerId: string, link = false) => ({ key, name, computerId, link: link ? {} : null });
  const merged = mergeScopes(
    [
      scope("/work/milagre-ade", "milagre-ade", "local"),
      scope(`${S}|/s/homelab`, "homelab", S),
      scope(`${A}|/a/web`, "arketa-web", A),
      scope(`${S}|/s/app`, "app", S),
      scope("/work/app", "App", "local"),
      scope("milagre-link:x", "Checkout", "local", true),
      scope(`${A}|/a/app`, "app", A),
    ],
    [A, S],
  );
  assert.deepEqual(
    merged.map((item) => item.key),
    ["/work/app", `${A}|/a/app`, `${S}|/s/app`, `${A}|/a/web`, `${S}|/s/homelab`, "/work/milagre-ade", "milagre-link:x"],
  );
});

test("the open Project of another computer is kept once, as the local list holds it", () => {
  const remote = [{ key: `${A}|/a/web` }, { key: `${A}|/a/app` }];
  assert.deepEqual(withoutLocal(remote, [{ key: `${A}|/a/web` }, { key: "/work/x" }]), [{ key: `${A}|/a/app` }]);
});

test("the project chooser's sections: This Mac first, then the computers by name", () => {
  const sections = computerSections("victor", [
    { id: S, name: "studio" },
    { id: A, name: "Arketa" },
    { id: "c-deer", name: "Deer" },
  ]);
  assert.deepEqual(sections, [
    { id: "local", name: "victor", local: true },
    { id: A, name: "Arketa", local: false },
    { id: "c-deer", name: "Deer", local: false },
    { id: S, name: "studio", local: false },
  ]);
  const rows = [
    { path: `${S}|/s/app`, computerId: S },
    { path: "/work/app", computerId: "local" },
    { path: `${A}|/a/web`, computerId: A },
    { path: "/work/zed", computerId: "local" },
  ];
  assert.deepEqual(
    bySection(rows, sections).map((section) => [section.id, section.rows.map((row) => row.path)]),
    [
      ["local", ["/work/app", "/work/zed"]],
      [A, [`${A}|/a/web`]],
      [S, [`${S}|/s/app`]],
    ],
    "rows keep their order inside a section, and Deer, with none, is left out",
  );
});

test("a hidden computer is saved on this Mac, and the same set comes back until the list changes", () => {
  assert.equal(readHiddenComputers().size, 0);
  setComputerHidden(A, true);
  setComputerHidden("local", true);
  const first = readHiddenComputers();
  assert.deepEqual([...first], [A, "local"]);
  assert.equal(readHiddenComputers(), first, "one object per saved list, for useSyncExternalStore");
  assert.ok(dispatched.length >= 2, "each change is announced");
  setComputerHidden(A, false);
  setComputerHidden("local", false);
  assert.equal(stored.has("milagre.hiddenComputers"), false, "nothing hidden leaves nothing saved");
  stored.set("milagre.hiddenComputers", "not json");
  assert.equal(readHiddenComputers().size, 0, "a broken list hides nothing");
});
