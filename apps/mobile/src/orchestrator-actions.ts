import { useEffect, useState } from "react";
import { router } from "expo-router";
import type { AccountsSnapshot } from "@milagre/shared/model";
import type { OrchestratorTask } from "@milagre/shared/orchestrator";
import { allComputers } from "./all-computers";
import type { HostView } from "./all-computers-store";
import type { Session } from "./session";

/** The phone's view of the computer a task's Chat runs on: this one, or a paired one the host sent it to, by name. */
export function taskHost(task: OrchestratorTask, currentHostId: string | undefined, views: readonly HostView[]): string | undefined {
  if (!task.remoteComputerId) return currentHostId;
  return views.find((view) => view.hostId !== currentHostId && view.name === task.computer)?.hostId;
}

export async function openTaskChat(task: OrchestratorTask, session: Session, { fromSheet = false } = {}) {
  const projectPath = task.projectPath;
  const sessionId = task.sessionId;
  if (!projectPath || sessionId === null || !session.client) return;
  const hostId = taskHost(task, session.client.url, allComputers.views());
  if (!hostId) throw new Error(`Pair ${task.computer ?? "that computer"} with this phone to open its Chats.`);
  if (hostId !== session.client.url) {
    const host = allComputers.hostFor(hostId);
    if (!host || !(await session.openNotificationTarget(host, projectPath, sessionId))) throw new Error(`Couldn't reach ${task.computer ?? "that computer"}.`);
  }
  if (fromSheet) router.back();
  router.push({ pathname: "/chat", params: { projectPath, hostId, id: String(sessionId) } });
}

export function taskChatKey(task: OrchestratorTask) {
  return task.projectPath && task.sessionId !== null ? `${task.projectPath}#${task.sessionId}` : null;
}

const names = new WeakMap<object, Map<string, string>>();

export function accountName(known: Map<string, string>, task: OrchestratorTask) {
  return task.provider && task.accountId ? (known.get(`${task.provider}:${task.accountId}`) ?? null) : null;
}

/** The connected computer's saved accounts by provider and id, to name the account a task runs on. */
export function useAccountNames(client: { call: <T>(method: string, args: unknown[]) => Promise<T> } | null) {
  const [known, setKnown] = useState<Map<string, string>>(() => (client ? (names.get(client) ?? new Map()) : new Map()));
  useEffect(() => {
    if (!client) return;
    let live = true;
    void (async () => {
      const snapshot = await client.call<AccountsSnapshot>("accounts:list", [false]).catch(() => null);
      if (!snapshot) return;
      const next = new Map<string, string>();
      for (const provider of snapshot.providers ?? []) for (const account of provider.accounts) next.set(`${provider.provider}:${account.id}`, account.label);
      names.set(client, next);
      if (live) setKnown(next);
    })();
    return () => {
      live = false;
    };
  }, [client]);
  return known;
}
