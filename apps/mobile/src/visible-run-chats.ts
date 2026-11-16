import { useEffect } from "react";
import type { Client } from "./client.ts";

type Entry = { counts: Map<number, number>; listeners: Set<() => void> };
const clients = new WeakMap<Client, Map<string, Entry>>();
function entryFor(client: Client, projectPath: string): Entry {
  let projects = clients.get(client);
  if (!projects) clients.set(client, (projects = new Map()));
  let entry = projects.get(projectPath);
  if (!entry) projects.set(projectPath, (entry = { counts: new Map(), listeners: new Set() }));
  return entry;
}
function prune(client: Client, projectPath: string, entry: Entry) {
  if (!entry.counts.size && !entry.listeners.size) clients.get(client)?.delete(projectPath);
}
function changed(entry: Entry) {
  for (const listener of Array.from(entry.listeners)) listener();
}

export function registerVisibleRunChat(client: Client, projectPath: string, chatId: number): () => void {
  if (!Number.isSafeInteger(chatId) || chatId <= 0) return () => {};
  const entry = entryFor(client, projectPath);
  const count = entry.counts.get(chatId) ?? 0;
  entry.counts.set(chatId, count + 1);
  if (!count) changed(entry);
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    const count = entry.counts.get(chatId)!;
    if (count > 1) entry.counts.set(chatId, count - 1);
    else {
      entry.counts.delete(chatId);
      changed(entry);
    }
    prune(client, projectPath, entry);
  };
}

export function visibleRunChats(client: Client, projectPath: string): number[] {
  const counts = clients.get(client)?.get(projectPath)?.counts;
  return counts?.size ? [...counts.keys()].sort((a, b) => a - b) : [];
}

export function watchVisibleRunChats(client: Client, projectPath: string, listener: () => void): () => void {
  const entry = entryFor(client, projectPath);
  entry.listeners.add(listener);
  if (entry.counts.size) listener();
  return () => {
    entry.listeners.delete(listener);
    prune(client, projectPath, entry);
  };
}

export function useVisibleRunChat(client: Client | null, projectPath: string | undefined, chatId: number | undefined, visible: boolean): void {
  useEffect(() => {
    if (client && projectPath && chatId !== undefined && visible) return registerVisibleRunChat(client, projectPath, chatId);
  }, [client, projectPath, chatId, visible]);
}

function splitChatKey(key: string): [string, number] | undefined {
  const at = key.lastIndexOf("#");
  const id = Number(key.slice(at + 1));
  return at > 0 && Number.isSafeInteger(id) && id > 0 ? [key.slice(0, at), id] : undefined;
}

export function useVisibleRunChatKeys(client: Client | null, keys: readonly string[], visible = true): void {
  const joined = [...new Set(keys)].sort().join("\n");
  useEffect(() => {
    if (!client || !visible || !joined) return;
    const stops = joined.split("\n").flatMap((key) => {
      const parts = splitChatKey(key);
      return parts ? [registerVisibleRunChat(client, parts[0], parts[1])] : [];
    });
    return () => stops.forEach((stop) => stop());
  }, [client, joined, visible]);
}
