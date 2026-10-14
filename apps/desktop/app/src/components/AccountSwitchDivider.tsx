import { HugeiconsIcon } from "@hugeicons/react";
import { UserSwitchIcon } from "@hugeicons/core-free-icons";
import { accountSwitchText } from "@milagre/shared/usage-limit";
import type { AccountSwitchContext } from "../model";

/**
 * Where a Chat continued on another account after the usage limit: a hairline with "Switched to  me@work.com" centred
 * on it, as the compaction divider is drawn.
 */
export function AccountSwitchDivider({ context }: { context: AccountSwitchContext }) {
  return (
    <div
      data-account-switch-divider
      className="flex w-full items-center gap-3 py-1 text-[12px] text-ink-3"
      role="group"
      aria-label={accountSwitchText(context)}
    >
      <span className="h-px flex-1 bg-line" />
      <span className="flex min-w-0 items-center gap-1.5 px-2 py-0.5">
        <HugeiconsIcon icon={UserSwitchIcon} size={13} strokeWidth={1.8} color="currentColor" className="shrink-0" />
        <span className="shrink-0">Switched to</span>
        <span className="truncate font-medium text-ink-2">{context.label}</span>
      </span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}
