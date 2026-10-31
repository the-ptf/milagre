const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const ts = require("typescript");

const REMOTE = "6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7";
const OTHER = "7f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7";
const ROOT = "/same/project";
const settle = () => new Promise((resolve) => setImmediate(resolve));
const catalog = (name) => ({ skills: [{ name }], shadowed: [{ name: `${name}-shadowed` }], warnings: [name] });
function endpoint() {
  const requests = [];
  const request = (...args) => new Promise((resolve, reject) => requests.push({ args, resolve, reject }));
  return { requests, listSkills: request, call: request };
}

// Execute the production hooks and bridge selection. Only React scheduling and transport are controlled.
function fixture() {
  const slots = [],
    effects = [];
  let cursor = 0;
  const react = {
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = initial;
      return [
        slots[i],
        (value) => {
          slots[i] = typeof value === "function" ? value(slots[i]) : value;
        },
      ];
    },
    useEffect(effect, deps) {
      const i = cursor++,
        previous = slots[i];
      if (!previous || deps.some((value, index) => !Object.is(value, previous.deps[index]))) {
        slots[i] = { deps, cleanup: previous?.cleanup };
        effects.push(() => {
          slots[i].cleanup?.();
          slots[i].cleanup = effect();
        });
      }
    },
    createContext: (value) => ({ value }),
    useContext: (context) => context.value,
  };
  const local = endpoint(),
    remote = endpoint(),
    other = endpoint();
  local.on = (id) => ({ [REMOTE]: remote, [OTHER]: other })[id];
  function load(file, modules = {}) {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    const exports = {};
    vm.runInNewContext(compiled, {
      exports,
      window: { milagre: local },
      require: (id) => (id === "react" ? react : (modules[id] ?? require(id))),
    });
    return exports;
  }
  const bridges = load("apps/desktop/app/src/lib/computer-bridge.ts");
  const { useSkills } = load("apps/desktop/app/src/components/useSkills.ts", { "../lib/computer-bridge": bridges });
  const { useRpc } = load("apps/mobile/src/use-rpc.ts");
  const session = { client: remote, snapshot: { project: { path: ROOT } } };
  const { useSkillCatalog } = load("apps/mobile/src/use-skills.ts", {
    "./use-rpc": { useRpc },
    "./session": { useSession: () => session },
    "./theme": {},
  });
  return {
    local,
    remote,
    other,
    bridges,
    session,
    useSkills,
    useRpc,
    useSkillCatalog,
    render(hook) {
      cursor = 0;
      const result = hook();
      for (const effect of effects.splice(0)) effect();
      return result;
    },
    cleanup() {
      for (const slot of slots) slot?.cleanup?.();
    },
  };
}

for (const [name, scope, projectPath, expected] of [
  ["remote Chat Worktree", "worktree", ROOT, "remote"],
  ["local Settings while a remote Project stays open", "project", ROOT, "local"],
  ["remote Settings on a different computer", "project", `${OTHER}|${ROOT}`, "other"],
  ["qualified remote Chat", "worktree", `${OTHER}|${ROOT}`, "other"],
])
  test(`desktop skills route ${name} to its owner`, async (t) => {
    const f = fixture();
    t.after(f.cleanup);
    f.bridges.BridgeContext.value = f.remote;
    const render = () => f.render(() => f.useSkills(projectPath, true, 0, scope));
    render();
    assert.equal(f[expected].requests.length, 1);
    assert.equal(f.local.requests.length + f.remote.requests.length + f.other.requests.length, 1);
    assert.equal(f[expected].requests[0].args[0], projectPath);
    f[expected].requests[0].resolve(catalog(expected));
    await settle();
    assert.equal(render().skills[0].name, expected);
  });

test("desktop hides another computer's catalog at an identical path and ignores cancelled reads and errors", async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  let revision = 0,
    open = true;
  const render = () => f.render(() => f.useSkills(ROOT, open, revision));
  f.bridges.BridgeContext.value = f.remote;
  render();
  f.remote.requests[0].resolve(catalog("remote"));
  await settle();
  assert.equal(render().skills[0].name, "remote");
  revision++;
  render(); // Keep a remote reload pending during the computer switch.
  f.bridges.BridgeContext.value = f.local;
  const switched = render();
  assert.equal(switched.skills.length, 0);
  assert.equal(switched.shadowed.length, 0);
  assert.equal(switched.warnings.length, 0);
  f.remote.requests[1].reject(new Error("late remote failure"));
  await settle();
  assert.equal(render().warnings.length, 0);
  assert.equal(render().loading, true);
  f.local.requests[0].resolve(catalog("local"));
  await settle();
  assert.equal(render().skills[0].name, "local");
  revision++;
  render();
  open = false;
  render();
  f.local.requests[1].resolve(catalog("cancelled"));
  await settle();
  assert.equal(render().skills[0].name, "local");
  open = true;
  render();
  f.local.requests[2].resolve(catalog("reopened"));
  await settle();
  assert.equal(render().skills[0].name, "reopened");
});

for (const surface of ["Settings", "Chat"])
  test(`mobile ${surface} skills follow the selected client at identical paths and cancel old reads`, async (t) => {
    const f = fixture();
    t.after(f.cleanup);
    const render = () => f.render(() => (surface === "Settings" ? f.useSkillCatalog() : f.useRpc(f.session.client, "skills:list", [ROOT])));
    render();
    assert.equal(JSON.stringify(f.remote.requests[0].args), JSON.stringify(["skills:list", [ROOT]]));
    f.remote.requests[0].resolve(catalog("remote"));
    await settle();
    assert.equal(render().data.skills[0].name, "remote");
    render().refresh();
    render();
    f.session.client = f.local;
    assert.equal(render().data, null);
    f.remote.requests[1].reject(new Error("late remote failure"));
    await settle();
    assert.equal(render().error, "");
    assert.equal(render().loading, true);
    f.local.requests[0].resolve(catalog("local"));
    await settle();
    assert.equal(render().data.skills[0].name, "local");
    render().refresh();
    render();
    f.session.client = f.other;
    assert.equal(render().data, null);
    f.local.requests[1].resolve(catalog("cancelled"));
    await settle();
    assert.equal(render().data, null);
    f.other.requests[0].resolve(catalog("other"));
    await settle();
    assert.equal(render().data.skills[0].name, "other");
  });
