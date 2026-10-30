import { useSyncExternalStore } from "react";
import { createOutbox, type OutboxData, type OutboxAttachment, type OutboxItem } from "@milagre/shared/outbox";
import { deliverOutbox } from "@milagre/shared/outbox-delivery";
import { computerOfKey, LOCAL_COMPUTER } from "@milagre/shared/chat-scopes";
import { bridgeForKey } from "./computer-bridge";
import { computersSnapshot, subscribeComputers } from "./computers-store";
import { uploadFile } from "./attachment-uploads";
import type { ImageAttachment } from "../model";

let database: Promise<IDBDatabase> | undefined;
function db() {
  return (database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("milagre-outbox-v1", 1);
    request.addEventListener("upgradeneeded", () => request.result.createObjectStore("queue"));
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  }));
}
export const outbox = createOutbox({
  storage: {
    async read() {
      const database = await db();
      return new Promise<OutboxData | null>((resolve, reject) => {
        const request = database.transaction("queue").objectStore("queue").get("state");
        request.addEventListener("success", () => resolve(request.result ?? null));
        request.addEventListener("error", () => reject(request.error));
      });
    },
    async write(data, previousRevision) {
      const database = await db();
      return new Promise<void>((resolve, reject) => {
        const tx = database.transaction("queue", "readwrite", { durability: "strict" });
        const store = tx.objectStore("queue");
        const request = store.get("state");
        request.addEventListener("success", () => {
          if ((request.result?.revision ?? 0) !== previousRevision) {
            tx.abort();
            return;
          }
          store.put(data, "state");
        });
        tx.addEventListener("complete", () => resolve());
        const fail = () => reject(tx.error ?? new Error("The queue changed in another window. Reopen this window."));
        tx.addEventListener("abort", fail);
        tx.addEventListener("error", fail);
      });
    },
  },
  available: (item) =>
    item.computerId === LOCAL_COMPUTER || computersSnapshot().computers.some((computer) => computer.id === item.computerId && computer.state === "online"),
  deliver: (item, update) => {
    const bridge = bridgeForKey(item.owner);
    return deliverOutbox(item, update, {
      open: async () => (item.link ? await bridge.openNamedLink(item.link.linkId) : await bridge.readProject(item.owner)).state,
      receipt: (id) => bridge.sendStatus(item.owner, id),
      create: (request) => bridge.createWorktree(request),
      upload: (name, base64) => uploadFile(item.owner, name, base64),
      send: (request) => bridge.sendMessage(request),
      sendLink: (request) => bridge.sendLinkMessage(request),
    });
  },
});
export const useOutbox = () => useSyncExternalStore(outbox.subscribe, outbox.getSnapshot);
export const queueForComputer = (owner: string) =>
  computerOfKey(owner) !== LOCAL_COMPUTER && computersSnapshot().computers.find((computer) => computer.id === computerOfKey(owner))?.state !== "online";
export const hasQueuedChat = (owner: string, sessionId: number | null) =>
  outbox.getSnapshot().items.some((item) => item.owner === owner && item.request.sessionId === sessionId && item.status !== "sent");
/** The Chat a message lives in: the one it was written in, or the one its New Chat became; null while that Chat doesn't exist yet. */
export const outboxChat = (item: OutboxItem) => item.sessionId ?? item.request.sessionId ?? null;
/** How many messages wait on this Mac for a Chat (its sidebar row's "· 2 waiting"), by chat key. */
export function useOutboxWaiting(chatId: string): number {
  return useSyncExternalStore(outbox.subscribe, () =>
    outbox.getSnapshot().items.reduce((count, item) => {
      const id = outboxChat(item);
      return count + (item.status !== "sent" && id !== null && `${item.owner}#${id}` === chatId ? 1 : 0);
    }, 0),
  );
}

/** Copy picked bytes now; a remote Project path is a reference on that computer, never a local path to upload. */
export async function outboxAttachments(images: ImageAttachment[], files: string[], localFiles: Map<string, File>): Promise<OutboxAttachment[]> {
  const result: OutboxAttachment[] = [];
  for (const image of images) {
    if (!image.dataUrl && (!image.path || image.path.startsWith("/.milagre-offline-attachments/")))
      throw new Error(`Attachment data is missing for ${image.name}. Attach it again.`);
    result.push({
      name: image.name,
      imageId: image.id,
      ...(image.dataUrl ? { base64: image.dataUrl.slice(image.dataUrl.indexOf(",") + 1) } : { path: image.path }),
    });
  }
  for (const path of files) {
    if (images.some((image) => image.path === path)) continue;
    const file = localFiles.get(path);
    if (!file) {
      if (path.startsWith("/.milagre-offline-attachments/")) throw new Error("Attachment data is missing. Attach the file again.");
      result.push({ name: path.split(/[\\/]/).pop() || path, path });
      continue;
    }
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => resolve(String(reader.result).split(",")[1]!));
      reader.addEventListener("error", () => reject(new Error(`Could not save ${file.name}. Attach it again.`)));
      reader.readAsDataURL(file);
    });
    result.push({ name: file.name, base64 });
  }
  return result;
}

let started = false;
export function startOutbox() {
  if (started) return;
  started = true;
  const flush = () => void outbox.flush().catch(() => {});
  subscribeComputers(flush);
  setInterval(flush, 15000);
  flush();
  // Delivered messages are in their transcripts: copies left from an earlier run go.
  void outbox.ready
    .then(() => Promise.allSettled(outbox.getSnapshot().items.flatMap((item) => (item.status === "sent" ? [outbox.remove(item.id)] : []))))
    .catch(() => {});
}
