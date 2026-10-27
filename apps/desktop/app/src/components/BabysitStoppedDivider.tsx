import { HugeiconsIcon } from "@hugeicons/react";
import { Pulse01Icon } from "@hugeicons/core-free-icons";
import { babysitStoppedText } from "@milagre/shared/babysit";
import type { BabysitStoppedContext } from "@milagre/shared/model";

/** Where the Heartbeat babysitting the Chat's PR ended: a hairline with "Stopped babysitting PR #1: merged." on it. */
export function BabysitStoppedDivider({ context }: { context: BabysitStoppedContext }) {
  const text = babysitStoppedText(context);
  return (
    <div data-babysit-stopped-divider className="flex w-full items-center gap-3 py-1 text-[12px] text-ink-3" role="group" aria-label={text}>
      <span className="h-px flex-1 bg-line" />
      <span className="flex min-w-0 items-center gap-1.5 px-2 py-0.5">
        <HugeiconsIcon icon={Pulse01Icon} size={13} strokeWidth={1.8} color="currentColor" className="shrink-0" />
        <span className="min-w-0 truncate">{text}</span>
      </span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}
