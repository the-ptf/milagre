const fs = require("node:fs/promises");
const path = require("node:path");
const { requireWorktreeRoot } = require("@milagre/core/editors");

async function revealFolder(folder, { open, checkRoot = requireWorktreeRoot }) {
  await checkRoot(folder);
  const error = await open(folder);
  if (error) throw new Error(error);
}

async function revealFile(request, { show, checkRoot = requireWorktreeRoot }) {
  const { root, path: file } = request ?? {};
  if (typeof root !== "string" || typeof file !== "string") throw new Error("That file isn't in this Chat's folders.");
  await checkRoot(root);
  const target = path.resolve(root, file);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("That file isn't in this Chat's folders.");
  await fs.stat(target).catch(() => {
    throw new Error("That file is no longer there.");
  });
  show(target);
}

/**
 * @param {Pick<Electron.IpcMain, "handle">} ipcMain
 * @param {{ shell: Pick<Electron.Shell, "openPath" | "showItemInFolder">; checkRoot: (root: string) => Promise<void> }} options
 */
function handleReveal(ipcMain, { shell, checkRoot }) {
  ipcMain.handle("project:reveal", (_event, folder) => revealFolder(folder, { checkRoot, open: (target) => shell.openPath(target) }));
  ipcMain.handle("file:reveal", (_event, request) => revealFile(request, { checkRoot, show: (target) => shell.showItemInFolder(target) }));
}

module.exports = { handleReveal, revealFolder, revealFile };
