import { Refresh01Icon } from "@hugeicons/core-free-icons";
import { RELOAD_TEXT } from "@milagre/shared/chat-reload";
import { TranscriptDivider } from "./primitives/TranscriptDivider";

export function ChatReloadDivider() {
  return <TranscriptDivider data-chat-reload-divider icon={Refresh01Icon} label={RELOAD_TEXT} />;
}
