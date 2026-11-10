// Fixed editor invocations avoid executing Windows batch files through a shell.
const fs = require("node:fs");
const path = require("node:path");

// The editor and its CLI script, as the launcher names them relative to itself. Each editor lays its install out its
// own way: VS Code runs "%~dp0..\Code.exe" "%~dp0..\<commit>\resources\app\out\cli.js", Cursor (whose bin folder sits
// in resources\app) runs "%~dp0..\..\..\Cursor.exe" "%~dp0..\out\cli.js". Null when the launcher has no such line.
function launcherTargets(file) {
  let script;
  try {
    script = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const match = /^\s*"%~dp0([^"\r\n]+\.exe)"\s+"%~dp0([^"\r\n]+\.js)"\s+%\*\s*$/im.exec(script);
  if (!match) return null;
  const folder = path.dirname(file);
  return { binary: path.resolve(folder, match[1].replace(/\\/g, path.sep)), cli: path.resolve(folder, match[2].replace(/\\/g, path.sep)) };
}

function editorInvocation(file, args, { platform = process.platform } = {}) {
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(file)) return null;
  const names = { "code.cmd": "Code.exe", "cursor.cmd": "Cursor.exe", "windsurf.cmd": "Windsurf.exe", "codium.cmd": "VSCodium.exe" };
  const executable = names[path.basename(file).toLowerCase()];
  if (!executable || path.basename(path.dirname(file)).toLowerCase() !== "bin") return null;
  const root = path.dirname(path.dirname(file));
  let { binary, cli } = launcherTargets(file) ?? { binary: path.join(root, executable), cli: path.join(root, "resources", "app", "out", "cli.js") };
  // Only the editor this launcher is for, and a script inside its own install folder.
  const install = path.dirname(binary);
  const inside = path.relative(install, cli);
  if (path.basename(binary).toLowerCase() !== executable.toLowerCase() || inside.startsWith("..") || path.isAbsolute(inside))
    throw new Error("The installed editor CLI is incomplete");
  for (const target of [binary, cli]) if (!fs.statSync(target).isFile()) throw new Error("The installed editor CLI is incomplete");
  return { file: binary, args: [cli, ...args], env: { ELECTRON_RUN_AS_NODE: "1", VSCODE_DEV: "" } };
}
module.exports = { editorInvocation };
