import type { NamedLinkDeleteCheck } from "@milagre/shared/model";
import { deleteLinkText, linkRunningText } from "@milagre/shared/worktree-link";
import { confirm } from "./confirm-store.ts";

type Call = <T>(method: string, args?: unknown[]) => Promise<T>;

/**
 * Asks before a Link is deleted, as desktop's Delete Link dialog does: the computer says how many Chats it archives,
 * and a running one holds the delete (it throws, naming the Chat). Resolves true once the user confirms.
 */
export async function confirmLinkDelete(call: Call, linkId: string, name: string, ask = confirm) {
  const check = await call<NamedLinkDeleteCheck>("link:delete-check", [linkId]);
  if (check.running.length) throw new Error(linkRunningText(check.running));
  const text = deleteLinkText(name, check.chats);
  return ask(text.title, text.message, text.action);
}

/** A failed delete as the phone says it. A Mac too old to delete Links from a phone is asked to update. */
export function linkDeleteError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /not available from mobile/i.test(message) ? "Update Milagre on your Mac to delete Links from your phone." : message;
}
