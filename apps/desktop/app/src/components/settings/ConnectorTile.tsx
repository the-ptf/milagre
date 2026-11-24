import { Globe02Icon } from "@hugeicons/core-free-icons";
import { Icon } from "../primitives/Icon";

export function ConnectorTile({ iconPath, warn = false }: { iconPath?: string; warn?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`flex size-8 shrink-0 items-center justify-center rounded-control ${warn ? "bg-orange-tint text-orange-ink" : "bg-field text-ink"}`}
    >
      {iconPath ? (
        <svg viewBox="0 0 24 24" width={18} height={18} fill="currentColor" focusable="false">
          <path d={iconPath} />
        </svg>
      ) : (
        <Icon icon={Globe02Icon} size={16} />
      )}
    </span>
  );
}
