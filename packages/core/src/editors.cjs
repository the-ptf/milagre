const { execCommand } = require("./agents/command.cjs");
const { editorInvocation } = require("./editor-command.cjs");
const { createGit } = require("./git/client.cjs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { resolveExecutable } = require("./agents/environment.cjs");

// Code editors Milagre can open files in, in the order the first one found becomes the default.
// `goto` is how the CLI takes a line: "flag" is `-g file:line`, "suffix" is `file:line`.
const EDITORS = [
  { id: "cursor", bundleCli: "Contents/Resources/app/bin/cursor", name: "Cursor", app: "Cursor.app", cli: "cursor", goto: "flag" },
  { id: "vscode", bundleCli: "Contents/Resources/app/bin/code", name: "Visual Studio Code", app: "Visual Studio Code.app", cli: "code", goto: "flag" },
  { id: "zed", bundleCli: "Contents/MacOS/cli", name: "Zed", app: "Zed.app", cli: "zed", goto: "suffix" },
  { id: "windsurf", bundleCli: "Contents/Resources/app/bin/windsurf", name: "Windsurf", app: "Windsurf.app", cli: "windsurf", goto: "flag" },
  { id: "vscodium", bundleCli: "Contents/Resources/app/bin/codium", name: "VSCodium", app: "VSCodium.app", cli: "codium", goto: "flag" },
  { id: "sublime", bundleCli: "Contents/SharedSupport/bin/subl", name: "Sublime Text", app: "Sublime Text.app", cli: "subl", goto: "suffix" },
];

const GOTO_FLAG = new Set(EDITORS.filter((editor) => editor.goto === "flag").map((editor) => editor.id));

async function exists(fs, target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

// The installed editors: an .app in /Applications or ~/Applications, or its CLI on PATH.
// Each is { id, name, appPath, cli }, with null for what's missing.
async function detectEditors({ fs = fsp, which = resolveExecutable, home = os.homedir(), platform = process.platform } = {}) {
  const found = await Promise.all(
    EDITORS.map(async (editor) => {
      let appPath = null;
      for (const dir of platform === "darwin" ? ["/Applications", path.join(home, "Applications")] : []) {
        const candidate = path.join(dir, editor.app);
        if (!appPath && (await exists(fs, candidate))) appPath = candidate;
      }
      let cli = (await which(editor.cli)) || null;
      // Launched from Finder, PATH may lack the CLI; the app bundle carries its own.
      if (!cli && appPath && (await exists(fs, path.join(appPath, editor.bundleCli)))) cli = path.join(appPath, editor.bundleCli);
      return appPath || cli ? { id: editor.id, name: editor.name, appPath, cli } : null;
    }),
  );
  return found.filter(Boolean);
}

// The program and arguments that open `target` in `editor`. A file with a line goes through the CLI's
// goto form; everything else goes through `open -a`, or through the CLI alone when the app isn't found.
function openCommand(editor, { target, line, isDirectory = false }) {
  const useLine = Number.isInteger(line) && line > 0 && !isDirectory;
  if (editor.cli && useLine) {
    return { file: editor.cli, args: GOTO_FLAG.has(editor.id) ? ["-g", `${target}:${line}`] : [`${target}:${line}`] };
  }
  if (editor.appPath) return { file: "/usr/bin/open", args: ["-a", editor.appPath, target] };
  return { file: editor.cli, args: [target] };
}

const outside = () => new Error("That path is outside the project");
const notFound = () => new Error("File not found");

// `requested` (relative to root, or absolute) as a real path inside root, or an error. A symlink that
// leaves root is refused after realpath; with no `requested` the root folder itself is the target.
async function resolveInside(root, requested, additionalRoots = []) {
  let realRoot;
  try {
    realRoot = await fsp.realpath(root);
  } catch {
    throw notFound();
  }
  if (requested === undefined || requested === null || requested === "") return { target: realRoot, isDirectory: true };
  if (typeof requested !== "string" || requested.includes("\0")) throw notFound();
  const lexical = path.resolve(realRoot, requested);
  let real;
  try {
    real = await fsp.realpath(lexical);
  } catch {
    // A missing file whose path also walks outside is reported as outside, not as missing.
    if (path.relative(realRoot, lexical).split(path.sep)[0] === "..") throw outside();
    throw notFound();
  }
  const relative = path.relative(realRoot, real);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    const permitted = await Promise.all(
      additionalRoots.map(async (owned) => {
        const resolved = await fsp.realpath(owned);
        const within = path.relative(resolved, real);
        return within !== ".." && !within.startsWith(`..${path.sep}`) && !path.isAbsolute(within);
      }),
    );
    if (!permitted.some(Boolean)) throw outside();
  }
  return { target: real, isDirectory: (await fsp.stat(real)).isDirectory() };
}

// Only a checkout's top folder is a root the renderer may open files under, so it can't point
// editor:open at "/" or any other folder.
async function requireWorktreeRoot(root, { topLevel = gitTopLevel } = {}) {
  try {
    if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("relative");
    const real = await fsp.realpath(root);
    if ((await fsp.realpath(await topLevel(real))) !== real) throw new Error("not the top");
  } catch {
    throw new Error("That folder isn't a project");
  }
}

async function gitTopLevel(directory) {
  return (await createGit().read.text(directory, ["rev-parse", "--show-toplevel"])).trim();
}

function runProgram(file, args) {
  return new Promise((resolve, reject) => {
    const invocation = editorInvocation(file, args);
    execCommand(
      invocation?.file ?? file,
      invocation?.args ?? args,
      { timeout: 10_000, windowsHide: true, ...(invocation && { env: { ...process.env, ...invocation.env } }) },
      (error) => (error ? reject(error) : resolve()),
    );
  });
}

// editor:open. Returns null on success, or a short message for the renderer's notice.
async function openInEditor({ root, path: requested, line, editor: editorId }, { editors, run = runProgram, checkRoot = requireWorktreeRoot }) {
  const editor = editors.find((item) => item.id === editorId) ?? editors[0];
  if (!editor) return "No editor found";
  let resolved;
  try {
    const ownedRoots = await checkRoot(root);
    resolved = await resolveInside(root, requested, Array.isArray(ownedRoots) ? ownedRoots : []);
  } catch (error) {
    return error.message;
  }
  const { file, args } = openCommand(editor, { ...resolved, line: typeof line === "number" ? line : undefined });
  try {
    await run(file, args);
    return null;
  } catch {
    return `Couldn't open ${editor.name}`;
  }
}

module.exports = { requireWorktreeRoot, gitTopLevel, EDITORS, detectEditors, openCommand, openInEditor, resolveInside };
