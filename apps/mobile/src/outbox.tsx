import { useEffect, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { Directory, File, Paths } from "expo-file-system";
import { createOutbox, type OutboxData } from "@milagre/shared/outbox";
import { deliverOutbox } from "@milagre/shared/outbox-delivery";
import { createClient, type Client, type OpenProject } from "./client";
import { relayRuntime } from "./relay-native";
import { useSession } from "./session";
import { SENT_FROM } from "./sent-from";

const folder = new Directory(Paths.document, "outbox-v1");
let hosts: ReturnType<typeof useSession>["hosts"] = [];
const clients = new Map<string, { identity: string; client: Client }>();
export const outbox = createOutbox({
  storage: {
    async read() {
      if (!folder.exists) return null;
      const files = folder.list().filter((entry): entry is File => entry instanceof File && /^\d+\.json$/.test(entry.name));
      files.sort((a, b) => Number.parseInt(b.name) - Number.parseInt(a.name));
      // A damaged latest write blocks delivery; never fall back to a copy that may contain cancelled messages.
      return files.length ? (JSON.parse(await files[0]!.text()) as OutboxData) : null;
    },
    async write(data) {
      if (!folder.exists) folder.create({ intermediates: true });
      const file = new File(folder, `${data.revision}.tmp`);
      const text = JSON.stringify(data);
      await file.write(text);
      if ((await file.text()) !== text) throw new Error("The saved queue could not be verified.");
      await file.move(new File(folder, `${data.revision}.json`));
      // Each write has its own file. Never overwrite the last committed revision.
      try {
        for (const old of folder.list())
          if (old instanceof File && /^\d+\.json$/.test(old.name) && Number.parseInt(old.name) < data.revision - 1) {
            old.delete();
          }
      } catch {
        /* A committed write stays successful even when optional pruning fails. */
      }
    },
  },
  available: (item) => AppState.currentState === "active" && hosts.some((host) => host.id === item.computerId),
  deliver: (item, update) => {
    const host = hosts.find((host) => host.id === item.computerId);
    if (!host) throw new Error("This computer is no longer paired. Your message is still saved on this device.");
    const identity = JSON.stringify(host);
    let entry = clients.get(host.id);
    if (!entry || entry.identity !== identity) {
      entry = { identity, client: createClient(host, fetch, 10000, relayRuntime) };
      clients.set(host.id, entry);
    }
    const client = entry.client;
    return deliverOutbox(item, update, {
      open: async () => (await client.open(item.owner)).project.state,
      receipt: (id) => client.call("chat:send-status", [item.owner, id]),
      create: (request) => client.call<{ project: OpenProject; worktreeId: number }>("worktree:create", [request]),
      upload: (name, base64) => client.upload(item.owner, name, base64),
      send: (request) => client.call("chat:send", [{ ...request, sentFrom: SENT_FROM }]),
      sendLink: (request) => client.call("link:send", [{ ...request, sentFrom: SENT_FROM }]),
    });
  },
});
export const useOutbox = () => useSyncExternalStore(outbox.subscribe, outbox.getSnapshot);
export const hasQueuedChat = (computerId: string, owner: string, sessionId: number | null) =>
  outbox
    .getSnapshot()
    .items.some((item) => item.computerId === computerId && item.owner === owner && item.request.sessionId === sessionId && item.status !== "sent");
export { outboxAttachments } from "./attachments";
export function OutboxService() {
  const session = useSession();
  useEffect(() => {
    hosts = session.hosts;
    for (const id of clients.keys()) if (!hosts.some((host) => host.id === id)) clients.delete(id);
    void outbox.flush().catch(() => {});
  }, [session.hosts]);
  useEffect(() => {
    const flush = () => void outbox.flush().catch(() => {});
    const timer = setInterval(flush, 15000);
    const subscription = AppState.addEventListener("change", flush);
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, []);
  return null;
}
