export * from "@milagre/shared/usage";
import { CHATS_ACCOUNT_LABEL } from "@milagre/shared/chats-home";
import { PROVIDER_NAMES } from "@milagre/shared/usage";
import type { ModelProvider } from "../../model";

export function accountPickerLabel(provider: ModelProvider, chatsHome = false): string {
  return `${PROVIDER_NAMES[provider]} account for ${chatsHome ? CHATS_ACCOUNT_LABEL : "this Project"}`;
}
