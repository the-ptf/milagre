import { HugeiconsIcon } from "@hugeicons/react";
import { Link04Icon } from "@hugeicons/core-free-icons";
import { linkedContext, linkedHeading } from "@milagre/shared/linked-message";
import type { LinkedContext } from "../model";

export { linkedContext };

/** The sender line over a message another Chat sent: who it's from, and a way to open that Chat. */
export function LinkedMessageHeader({ context, onOpenChat }: { context: LinkedContext; onOpenChat?: (chatKey: string) => void }) {
  const { text, chat } = linkedHeading(context);
  const label = (
    <>
      <HugeiconsIcon icon={Link04Icon} size={12} strokeWidth={2} color="currentColor" className="shrink-0" />
      <span className="min-w-0 truncate">{text}</span>
    </>
  );
  return chat && onOpenChat ? (
    <button
      type="button"
      data-linked-from={chat}
      onClick={() => onOpenChat(chat)}
      className="flex max-w-full items-center gap-1.5 text-[11px] font-medium text-accent-ink hover:underline"
    >
      {label}
    </button>
  ) : (
    <div className="flex max-w-full items-center gap-1.5 text-[11px] font-medium text-ink-3">{label}</div>
  );
}
