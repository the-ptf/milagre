import { Refresh01Icon } from "@hugeicons/core-free-icons";
import { RELOAD_TEXT } from "@milagre/shared/chat-reload";
import { TranscriptDivider } from "./primitives/TranscriptDivider";

/** Where the user reloaded the Chat's agent: a hairline with "Chat reloaded" centred on it, as the account switch is drawn. */
export function ChatReloadDivider() {
  return <TranscriptDivider data-chat-reload-divider icon={Refresh01Icon} label={RELOAD_TEXT} />;
}
