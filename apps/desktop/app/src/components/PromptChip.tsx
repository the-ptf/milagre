import { useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  BubbleChatIcon,
  ComputerIcon,
  File01Icon,
  Folder01Icon,
  Globe02Icon,
  Image01Icon,
  KanbanIcon,
  MagicWand01Icon,
  PaintBoardIcon,
  ReactIcon,
} from "@hugeicons/core-free-icons";
import { fileKind, IMAGE_COLOR } from "@milagre/shared/file-kinds";
import { imageLabel, skillLabel } from "@milagre/shared/prompt-parts";
import { TOOLTIP_SHOW_DELAY, TooltipBubble } from "./primitives/Tooltip";

export const CHIP =
  "relative -top-[0.04em] inline-flex max-w-full items-center gap-1 rounded-chip border px-1.5 align-baseline text-[0.875em] leading-[1.35] font-[inherit] whitespace-nowrap";
const LABEL = "truncate self-baseline";
export const ICON_SIZE = "0.95em";
// A chip that opens something: the pointer cursor, its border unchanged on hover (a chip is part of the text, not a
// button that lights up); focus is the base accent outline. File and image chips keep a native title: it reveals the full
const OPENABLE = "cursor-pointer";

export function FileKindIcon({ path, badge = true }: { path: string; badge?: boolean }) {
  const kind = fileKind(path);
  if (kind.badge && badge)
    return (
      <span
        aria-hidden
        data-file-badge={kind.badge}
        className="inline-block shrink-0 rounded-inline px-0.5 text-[0.62em] leading-[1.4] font-semibold"
        style={{
          color: kind.color,
          background: `color-mix(in srgb, ${kind.color} 16%, transparent)`,
        }}
      >
        {kind.badge}
      </span>
    );
  const icon = kind.icon === "react" ? ReactIcon : kind.icon === "image" ? Image01Icon : kind.icon === "folder" ? Folder01Icon : File01Icon;
  return <HugeiconsIcon icon={icon} size={ICON_SIZE} strokeWidth={1.8} color={kind.color} aria-hidden className="shrink-0" />;
}

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
    <button type="button" data-chip="file" title={path} onClick={onOpen} className={`${className} ${OPENABLE}`}>
      {content}
    </button>
  );
}

export function ImageChip({ index, name, onOpen }: { index: number; name?: string; onOpen?: () => void }) {
  const label = imageLabel(index);
  const className = `${CHIP} border-line-strong bg-hover text-ink`;
  const content = (
    <>
      <HugeiconsIcon icon={Image01Icon} size={ICON_SIZE} strokeWidth={1.8} color={IMAGE_COLOR} aria-hidden className="shrink-0" />
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
    <button type="button" data-chip="image" title={name || label} onClick={onOpen} className={`${className} ${OPENABLE}`}>
      {content}
    </button>
  );
}

export function ChatChip({ title, onOpen }: { title: string; onOpen?: () => void }) {
  const className = `${CHIP} border-line-strong bg-hover text-ink`;
  const content = (
    <>
      <HugeiconsIcon icon={BubbleChatIcon} size={ICON_SIZE} strokeWidth={1.8} aria-hidden />
      <span className={LABEL}>{title}</span>
    </>
  );
  return onOpen ? (
    <button
      type="button"
      data-chip="chat"
      className={`${className} ${OPENABLE}`}
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
    >
      {content}
    </button>
  ) : (
    <span data-chip="chat" className={className}>
      {content}
    </span>
  );
}

export function ComputerChip({ name, online = true }: { name: string; online?: boolean }) {
  return (
    <span
      data-chip="computer"
      className={`${CHIP} border-line-strong bg-hover ${online ? "text-ink" : "text-ink-3"}`}
      title={online ? name : `${name} is offline`}
    >
      <HugeiconsIcon icon={ComputerIcon} size={ICON_SIZE} strokeWidth={1.8} aria-hidden />
      <span className={LABEL}>{name}</span>
    </span>
  );
}

const MILAGRE_ICONS: Record<string, typeof BubbleChatIcon> = { orchestrator: KanbanIcon, paradise: PaintBoardIcon, browser: Globe02Icon };

/** What an @ menu row names, at a glance: the file's kind, a Chat, a computer or a part of Milagre. */
export function MentionRowIcon({ row }: { row: { key: string; path?: string; chatId?: number; computer?: string } }) {
  const icon = row.chatId !== undefined ? BubbleChatIcon : row.computer ? ComputerIcon : MILAGRE_ICONS[row.key];
  const kind = row.path ? "file" : row.chatId !== undefined ? "chat" : row.computer ? "computer" : row.key;
  return (
    <span aria-hidden data-mention-icon={kind} className="flex size-4 shrink-0 items-center justify-center text-15 text-ink-3">
      {row.path ? <FileKindIcon path={row.path} badge={false} /> : icon && <HugeiconsIcon icon={icon} size={ICON_SIZE} strokeWidth={1.8} />}
    </span>
  );
}
