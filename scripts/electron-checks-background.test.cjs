const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { discoverElectronChecks } = require("./test-runner.cjs");

// Every desktop copy a check starts on a Mac someone is using runs with MILAGRE_BACKGROUND=1: no window, Dock icon,
// focus change, notification or dialog (AGENTS.md, Ways to hurt yourself). Only the real app (apps/desktop/electron/main.cjs)
// reads it; checks that open their own hidden BrowserWindow on a Vite fixture don't start the app and aren't covered.
const root = path.resolve(__dirname, "..");
// It requires main.cjs, or hands Electron the app folder as its first argument: [path.join(root, "apps/desktop"), ...].
const LAUNCHES_APP = /apps\/desktop\/electron\/main\.cjs|\[\s*path\.(?:join|resolve)\([^)]*["'`](?:\.\.\/)?apps\/desktop["'`]\s*\)/;

const ALLOWED = {
  "scripts/test-floating-inbox-native.cjs": "checks native panel activation and focus, which background mode turns off",
};

/** The file's text plus that of every local helper it requires, so a shared launcher can set the variable. */
function withHelpers(file, seen = new Set()) {
  if (seen.has(file) || !fs.existsSync(file)) return "";
  seen.add(file);
  const text = fs.readFileSync(file, "utf8");
  const helpers = [...text.matchAll(/require\(\s*["'`](\.{1,2}\/[^"'`]+)["'`]\s*\)/g)].map((match) => path.resolve(path.dirname(file), match[1]));
  return [text, ...helpers.filter((helper) => helper.startsWith(path.join(root, "scripts"))).map((helper) => withHelpers(helper, seen))].join("\n");
}

test("every check that launches the desktop app sets MILAGRE_BACKGROUND", () => {
  const launching = discoverElectronChecks(root).filter((file) => LAUNCHES_APP.test(fs.readFileSync(path.join(root, file), "utf8")));
  assert.ok(
    launching.includes("scripts/test-desktop.cjs") && launching.includes("scripts/test-project-links.cjs"),
    "the detection still finds the known launchers",
  );
  const missing = launching.filter((file) => !(file in ALLOWED) && !/MILAGRE_BACKGROUND/.test(withHelpers(path.join(root, file))));
  assert.deepEqual(
    missing,
    [],
    'Start the app with MILAGRE_BACKGROUND: "1" in its env (env.MILAGRE_BACKGROUND ??= "1" keeps MILAGRE_BACKGROUND=0 working), as test-desktop.cjs does',
  );
  assert.deepEqual(
    Object.keys(ALLOWED).filter((file) => !launching.includes(file)),
    [],
    "These allowed checks no longer launch the app: delete their entries from ALLOWED",
  );
});
