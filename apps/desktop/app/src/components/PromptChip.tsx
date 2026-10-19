import { HugeiconsIcon } from "@hugeicons/react";
import { CubeIcon, File01Icon, Folder01Icon, Image01Icon, ReactIcon } from "@hugeicons/core-free-icons";
import { fileKind } from "@milagre/shared/file-kinds";
import { skillLabel } from "@milagre/shared/prompt-parts";

const CHIP = "inline-flex max-w-full items-center gap-1 rounded-[6px] border px-1.5 align-[-0.15em] leading-[1.35] whitespace-nowrap";
const ICON_SIZE = "0.95em";

/** A file's type: letters for common languages, an icon for the rest, in the type's color (tinted so it reads in light and dark). */
export function FileKindIcon({ path }: { path: string }) {
  const kind = fileKind(path);
  if (kind.badge)
    return (
      <span
        aria-hidden
        data-file-badge={kind.badge}
        className="inline-block shrink-0 rounded-[3px] px-[3px] text-[0.62em] leading-[1.5] font-bold tracking-tight"
        style={{ color: kind.color, background: `color-mix(in srgb, ${kind.color} 16%, transparent)` }}
      >
        {kind.badge}
      </span>
    );
  const icon = kind.icon === "react" ? ReactIcon : kind.icon === "image" ? Image01Icon : kind.icon === "folder" ? Folder01Icon : File01Icon;
  return <HugeiconsIcon icon={icon} size={ICON_SIZE} strokeWidth={1.8} color={kind.color} aria-hidden className="shrink-0" />;
}

/** A skill in a prompt: the name title-cased, the skill's description on hover. */
export function SkillChip({ name, description }: { name: string; description?: string }) {
  return (
    <span data-chip="skill" title={description || undefined} className={`${CHIP} border-accent/40 bg-accent-tint text-accent-ink`}>
      <HugeiconsIcon icon={CubeIcon} size={ICON_SIZE} strokeWidth={1.8} color="currentColor" aria-hidden className="shrink-0" />
      <span className="truncate">{skillLabel(name)}</span>
    </span>
  );
}

/** A file in a prompt: its name, the relative path on hover. A click opens it when `onOpen` is given. */
export function FileChip({ path, onOpen }: { path: string; onOpen?: () => void }) {
  const name = path.split("/").filter(Boolean).at(-1) ?? path;
  const className = `${CHIP} border-line-strong bg-hover text-ink`;
  const content = (
    <>
      <FileKindIcon path={path} />
      <span className="truncate">{name}</span>
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
