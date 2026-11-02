import { RefreshIcon } from "@hugeicons/core-free-icons";
import { RELOAD_TEXT } from "@milagre/shared/chat-reload";
import { TranscriptDivider } from "./ui";

/** Where the user reloaded the Chat's agent, as on desktop. */
export function ChatReloadDivider() {
  return <TranscriptDivider label={RELOAD_TEXT} icon={RefreshIcon} />;
}
