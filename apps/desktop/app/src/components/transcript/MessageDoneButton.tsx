import { Tick02Icon } from "@hugeicons/core-free-icons";
import { Icon } from "../primitives/Icon";
import Tooltip from "../primitives/Tooltip";

export function MessageDoneButton({ onDone }: { onDone: () => void }) {
  return (
    <Tooltip label="Mark Done">
      <button
        type="button"
        data-message-done
        aria-label="Mark Done"
        onClick={onDone}
        className="flex h-7 items-center gap-1 rounded-control px-1.5 text-[12px] font-medium text-ink-3 transition-colors hover:bg-hover hover:text-ink"
      >
        <Icon icon={Tick02Icon} size={14} />
        Done
      </button>
    </Tooltip>
  );
}
