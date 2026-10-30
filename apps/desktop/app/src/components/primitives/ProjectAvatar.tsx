import type { ReactNode } from "react";
import { WorkspaceIcon } from "../WorkspaceIcon";
import { projectInitial } from "../../lib/project-list";

const SIZES = {
  16: "size-4 rounded-inline text-10",
  20: "size-5 rounded-chip text-10",
  24: "size-6 rounded-chip text-10",
  40: "size-10 rounded-card text-15",
} as const;

/**
 * A Project's (or Link's) avatar: its image, or its initial in on-ink on an ink square. Decorative, so show the name
 * beside it. `children` draws over it (the Link glyph on a Link's first Project); `className` adds a ring in a stack.
 */
export function ProjectAvatar({
  name,
  src,
  initial,
  size = 20,
  className = "",
  children,
}: {
  name: string;
  src?: string | null;
  /** In place of the initial taken from `name`. */
  initial?: string;
  size?: keyof typeof SIZES;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <span
      aria-hidden
      className={`relative flex shrink-0 items-center justify-center overflow-hidden bg-ink font-semibold text-on-ink ${SIZES[size]} ${className}`}
    >
      <WorkspaceIcon src={src} fallback={initial ?? projectInitial(name)} />
      {children}
    </span>
  );
}
