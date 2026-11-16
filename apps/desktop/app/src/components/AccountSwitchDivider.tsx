import { UserSwitchIcon } from "@hugeicons/core-free-icons";
import { accountSwitchText } from "@milagre/shared/usage-limit";
import type { AccountSwitchContext } from "../model";
import { TranscriptDivider } from "./primitives/TranscriptDivider";

export function AccountSwitchDivider({ context }: { context: AccountSwitchContext }) {
  return (
    <TranscriptDivider data-account-switch-divider icon={UserSwitchIcon} label={accountSwitchText(context)}>
      <span className="shrink-0">Switched to</span>
      <span className="truncate font-medium text-ink-2">{context.label}</span>
    </TranscriptDivider>
  );
}
