import { CommandLineIcon, Globe02Icon, Mail01Icon } from "@hugeicons/core-free-icons";
import { Icon } from "../primitives/Icon";

export function ConnectorTile({
  iconPath,
  command = false,
  mail = false,
  warn = false,
}: {
  iconPath?: string;
  command?: boolean;
  mail?: boolean;
  warn?: boolean;
}) {
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
        <Icon icon={mail ? Mail01Icon : command ? CommandLineIcon : Globe02Icon} size={16} />
      )}
    </span>
  );
}
