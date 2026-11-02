const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

// A home created without Git keeps this mode across restarts and later Git installs. Each Chat still gets its own folder.
const MARKER = ".milagre-folder-chats";
const FOLDERS = ".chat-folders";
async function isFolderChatsHome(root) {
  try {
    return (await fs.lstat(path.join(root, MARKER))).isFile();
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  }
}
async function createFolderChatsHome(root) {
  await fs.writeFile(path.join(root, MARKER), "1\n", { flag: "wx" });
}
async function folderChatWorktrees(root) {
  const result = [{ path: root, name: "main", plain: true }];
  let entries;
  try {
    entries = await fs.readdir(path.join(root, FOLDERS), { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return result;
    throw error;
  }
  for (const entry of entries)
    if (entry.isDirectory() && /^chat-[0-9a-f-]{36}$/.test(entry.name))
      result.push({ path: path.join(root, FOLDERS, entry.name), name: entry.name, plain: true });
  return result;
}
async function createFolderChat(root) {
  if (!(await isFolderChatsHome(root))) throw new Error("That is not a folder-only Chats home.");
  const folder = path.join(root, FOLDERS, `chat-${randomUUID()}`);
  await fs.mkdir(folder, { recursive: true });
  return folder;
}
module.exports = { isFolderChatsHome, createFolderChatsHome, folderChatWorktrees, createFolderChat };
