import { HugeiconsIcon } from "@hugeicons/react";
import { RefreshIcon } from "@hugeicons/core-free-icons";
import { RELOAD_TEXT } from "@milagre/shared/chat-reload";

/** Where the user reloaded the Chat's agent: a hairline with "Chat reloaded" centred on it, as the account switch is drawn. */
export function ChatReloadDivider() {
  return (
    <div data-chat-reload-divider className="flex w-full items-center gap-3 py-1 text-[12px] text-ink-3" role="group" aria-label={RELOAD_TEXT}>
      <span className="h-px flex-1 bg-line" />
      <span className="flex min-w-0 items-center gap-1.5 px-2 py-0.5">
        <HugeiconsIcon icon={RefreshIcon} size={13} strokeWidth={1.8} color="currentColor" className="shrink-0" />
        <span className="shrink-0">{RELOAD_TEXT}</span>
      </span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}
