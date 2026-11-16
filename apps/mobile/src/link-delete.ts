import type { NamedLinkDeleteCheck } from "@milagre/shared/model";
import { deleteLinkText, linkDeleteFailure, linkRunningText } from "@milagre/shared/worktree-link";
import { confirm } from "./confirm-store.ts";

type Call = <T>(method: string, args?: unknown[]) => Promise<T>;

export async function confirmLinkDelete(call: Call, linkId: string, name: string, ask = confirm) {
  const check = await call<NamedLinkDeleteCheck>("link:delete-check", [linkId]);
  if (check.running.length) throw new Error(linkRunningText(check.running));
  const text = deleteLinkText(name, check.chats);
  return ask(text.title, text.message, text.action);
}

export function linkDeleteError(error: unknown) {
  return linkDeleteFailure(error instanceof Error ? error.message : String(error));
}
