import { useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { File01Icon, Folder01Icon, Image01Icon, MagicWand01Icon, ReactIcon } from "@hugeicons/core-free-icons";
import { fileKind } from "@milagre/shared/file-kinds";
import { imageLabel, skillLabel } from "@milagre/shared/prompt-parts";
import { TOOLTIP_SHOW_DELAY, TooltipBubble } from "./primitives/Tooltip";

// One box for every chip: the same height, padding and line height. The label alone sets the chip's baseline
// (`LABEL`), so every chip's text sits on the line's baseline and the chip is centred on the line whatever comes first
// (an icon has no baseline, a badge a smaller one); icons and badges are sized in em, centred, and never set the height.
const CHIP =
  "inline-flex max-w-full items-center gap-1 rounded-[6px] border px-1.5 align-baseline text-[length:inherit] leading-[1.35] font-[inherit] whitespace-nowrap";
const LABEL = "truncate self-baseline";
const ICON_SIZE = "0.95em";

/** A file's type: letters for common languages, an icon for the rest, in the type's color (tinted so it reads in light and dark). */
export function FileKindIcon({ path }: { path: string }) {
  const kind = fileKind(path);
  if (kind.badge)
    return (
      <span
        aria-hidden
        data-file-badge={kind.badge}
        className="inline-block shrink-0 rounded-[3px] px-[3px] text-[0.62em] leading-[1.4] font-bold tracking-tight"
        style={{ color: kind.color, background: `color-mix(in srgb, ${kind.color} 16%, transparent)` }}
      >
        {kind.badge}
      </span>
    );
  const icon = kind.icon === "react" ? ReactIcon : kind.icon === "image" ? Image01Icon : kind.icon === "folder" ? Folder01Icon : File01Icon;
  return <HugeiconsIcon icon={icon} size={ICON_SIZE} strokeWidth={1.8} color={kind.color} aria-hidden className="shrink-0" />;
}

/** A skill in a prompt: a wand and the name title-cased, the skill's description in a tooltip on hover. The chip is its
 * own trigger (no wrapper), so it stays the direct child of its host in the prompt field. */
export function SkillChip({ name, description }: { name: string; description?: string }) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const hide = () => {
    window.clearTimeout(timer.current);
    setRect(null);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <span
      data-chip="skill"
      aria-description={description || undefined}
      onPointerEnter={(event) => {
        if (!description) return;
        const chip = event.currentTarget;
        timer.current = window.setTimeout(() => setRect(chip.getBoundingClientRect()), TOOLTIP_SHOW_DELAY);
      }}
      onPointerLeave={hide}
      onPointerDown={hide}
      className={`${CHIP} border-accent/40 bg-accent-tint text-accent-ink`}
    >
      <HugeiconsIcon icon={MagicWand01Icon} size={ICON_SIZE} strokeWidth={1.8} color="currentColor" aria-hidden className="shrink-0" />
      <span className={LABEL}>{skillLabel(name)}</span>
      {rect && description && <TooltipBubble label={description} rect={rect} wrap />}
    </span>
  );
}

/** A file in a prompt: its name, the relative path on hover. A click opens it when `onOpen` is given. */
export function FileChip({ path, onOpen }: { path: string; onOpen?: () => void }) {
  const name = path.split("/").findLast(Boolean) ?? path;
  const className = `${CHIP} border-line-strong bg-hover text-ink`;
  const content = (
    <>
      <FileKindIcon path={path} />
      <span className={LABEL}>{name}</span>
    </>
  );
  if (!onOpen)
    return (
      <span data-chip="file" title={path} className={className}>
        {content}
      </span>
    );
  return (
    <button
      type="button"
      data-chip="file"
      title={path}
      onClick={onOpen}
      className={`${className} cursor-pointer hover:border-ink-3 focus-visible:outline-2 focus-visible:outline-accent-ink`}
    >
      {content}
    </button>
  );
}

/** An inline image position (`[Image #1]`): its 1-based label, with the image's name on hover and preview on click when `onOpen` is given. */
export function ImageChip({ index, name, onOpen }: { index: number; name?: string; onOpen?: () => void }) {
  const label = imageLabel(index);
  const className = `${CHIP} border-line-strong bg-hover text-ink`;
  const content = (
    <>
      <HugeiconsIcon icon={Image01Icon} size={ICON_SIZE} strokeWidth={1.8} color="#26a69a" aria-hidden className="shrink-0" />
      <span className={LABEL}>{label}</span>
    </>
  );
  if (!onOpen)
    return (
      <span data-chip="image" title={name || label} className={className}>
        {content}
      </span>
    );
  return (
    <button
      type="button"
      data-chip="image"
      title={name || label}
      onClick={onOpen}
      className={`${className} cursor-pointer hover:border-ink-3 focus-visible:outline-2 focus-visible:outline-accent-ink`}
    >
      {content}
    </button>
  );
}
