import { AlarmClockIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { snoozeDurationLabel } from "@milagre/shared/snooze";
import { useSettings } from "../../lib/settings";
import { Icon } from "../primitives/Icon";
import Tooltip from "../primitives/Tooltip";

const BUTTON = "flex size-7 items-center justify-center rounded-control text-ink-3 transition-colors hover:bg-hover hover:text-ink";

export function MessageSettleButtons({ onSettle }: { onSettle: (snoozeUntil?: number) => void }) {
  const { snoozeMinutes } = useSettings();
  const snooze = `Snooze for ${snoozeDurationLabel(snoozeMinutes)}`;
  return (
    <>
      <Tooltip label="Mark Done">
        <button type="button" data-message-done aria-label="Mark Done" onClick={() => onSettle()} className={BUTTON}>
          <Icon icon={Tick02Icon} size={14} />
        </button>
      </Tooltip>
      <Tooltip label={snooze}>
        <button type="button" data-message-snooze aria-label={snooze} onClick={() => onSettle(Date.now() + snoozeMinutes * 60_000)} className={BUTTON}>
          <Icon icon={AlarmClockIcon} size={14} />
        </button>
      </Tooltip>
    </>
  );
}
