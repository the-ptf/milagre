import { CommandLineIcon, Globe02Icon, Mail01Icon } from "@hugeicons/core-free-icons";
import { Icon } from "../primitives/Icon";

/** A connector's 32px mark: its brand path, else a mail or command glyph, else the first letter of `letter`, else a globe. */
export function ConnectorTile({
  iconPath,
  command = false,
  mail = false,
  letter,
  warn = false,
  size = "md",
}: {
  iconPath?: string;
  command?: boolean;
  mail?: boolean;
  letter?: string;
  warn?: boolean;
  size?: "md" | "lg";
}) {
  const box = size === "lg" ? "size-10 rounded-card" : "size-8 rounded-control";
  const glyph = size === "lg" ? 20 : 18;
  return (
    <span aria-hidden="true" className={`flex ${box} shrink-0 items-center justify-center ${warn ? "bg-orange-tint text-orange-ink" : "bg-field text-ink"}`}>
      {iconPath ? (
        <svg viewBox="0 0 24 24" width={glyph} height={glyph} fill="currentColor" focusable="false">
          <path d={iconPath} />
        </svg>
      ) : mail || command || !letter ? (
        <Icon icon={mail ? Mail01Icon : command ? CommandLineIcon : Globe02Icon} size={size === "lg" ? 18 : 16} />
      ) : (
        <span className={`${size === "lg" ? "text-17" : "text-15"} leading-none font-semibold`}>{letter.trim().charAt(0).toUpperCase()}</span>
      )}
    </span>
  );
}
