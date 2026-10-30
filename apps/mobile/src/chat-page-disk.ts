import { Directory, File, Paths } from "expo-file-system";
import type { ChatPage } from "./client.ts";
import type { PageDisk } from "./chat-pages.ts";

// Each Chat's last page, kept in the app's documents so a Chat opened before, or copied in the background, paints at once
// while its computer answers (the desktop keeps the same copy of other computers' Chats, computers-ipc.cjs).
const folder = new Directory(Paths.document, "chat-pages");
const MAX_CHATS = 60;
const MAX_MESSAGES = 200;
const MAX_CHARS = 2_000_000;

/** A file name for a Chat key: FNV-1a over the key, so a key's slashes and colons never reach the path. */
function nameOf(key: string) {
  let hash = 0x811c9dc5;
  let high = 0;
  for (let index = 0; index < key.length; index++) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
    high = (Math.imul(high, 31) + key.charCodeAt(index)) >>> 0;
  }
  return `${high.toString(16)}${hash.toString(16)}.json`;
}

/** Keeps the newest MAX_CHATS copies. */
function prune() {
  const files = folder.list().filter((entry): entry is File => entry instanceof File);
  if (files.length <= MAX_CHATS) return;
  files.sort((a, b) => (b.modificationTime ?? 0) - (a.modificationTime ?? 0));
  for (const file of files.slice(MAX_CHATS)) file.delete();
}

export const chatPageDisk: PageDisk = {
  async read(key) {
    try {
      const file = new File(folder, nameOf(key));
      if (!file.exists) return null;
      const kept = JSON.parse(await file.text()) as { key?: string; page?: ChatPage };
      return kept.key === key && Array.isArray(kept.page?.messages) ? kept.page! : null;
    } catch {
      return null;
    }
  },
  async write(key, page) {
    try {
      // The copy stands alone: older turns are read again once the computer answers.
      const text = JSON.stringify({ key, page: { messages: page.messages.slice(-MAX_MESSAGES), hasMore: false, total: page.total } });
      if (text.length > MAX_CHARS) return;
      if (!folder.exists) folder.create({ intermediates: true });
      const file = new File(folder, nameOf(key));
      if (!file.exists) file.create();
      await file.write(text);
      prune();
    } catch {
      // A full disk or a missing folder only costs the copy.
    }
  },
};
