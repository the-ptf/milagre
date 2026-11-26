import { Tick02Icon } from "@hugeicons/core-free-icons";
import { DESIGN_MODE_LABELS, type DesignMode } from "@milagre/shared/design-modes";
import { libraryEditLabel, type Artifact } from "@milagre/shared/artifact";
import { Icon } from "../primitives/Icon";

/** The chips beside a canvas design's title: interactive, color mode, version and chosen. */
export function DesignFrameChips({
  interactive,
  active,
  tight,
  mode,
  version,
  last,
  chosen,
}: {
  interactive: boolean;
  active: boolean;
  tight: boolean;
  mode: DesignMode;
  version: number;
  last: number;
  chosen: "pending" | "sent" | null;
}) {
  return (
    <>
      {interactive && (
        <span
          data-slot="artifact-interactive"
          title={active ? "Live: clicks go to the design. Click outside it to let go." : "Interactive: click the design to try it"}
          aria-label={active ? "Live" : "Interactive"}
          className={`flex h-5 shrink-0 items-center gap-1 rounded-chip bg-field text-11 font-medium text-ink-2 ${tight ? "w-5 justify-center" : "px-1.5"}`}
        >
          <span aria-hidden className={`size-1.5 rounded-full ${active ? "bg-green" : "bg-ink-4"}`} />
          {!tight && (active ? "Live" : "Interactive")}
        </span>
      )}
      {mode !== "light" && (
        <span data-slot="artifact-mode-chip" className="flex h-5 shrink-0 items-center rounded-chip bg-field px-1.5 text-11 font-medium text-ink-2">
          {DESIGN_MODE_LABELS[mode]}
        </span>
      )}
      {last > 1 && (
        <span
          data-slot="artifact-version-chip"
          title={`Version ${version} of ${last}`}
          className="flex h-5 shrink-0 items-center rounded-chip bg-field px-1.5 text-11 font-medium text-ink-2 tabular-nums"
        >
          v{version}
        </span>
      )}
      {chosen && (
        <span
          data-slot={chosen === "sent" ? "artifact-chosen" : undefined}
          title={chosen === "sent" ? undefined : "Chosen here; Send tells the agent"}
          className={`flex h-5 shrink-0 items-center gap-1 rounded-chip px-1.5 text-11 font-semibold ${chosen === "sent" ? "bg-ink text-on-ink" : "text-ink ring-1 ring-ink ring-inset"}`}
        >
          <Icon icon={Tick02Icon} size={12} />
          Chosen
        </span>
      )}
    </>
  );
}

/** Who saved a Project library design's shown version, beside its version on the Design library page. */
export function LibraryEditNote({ artifact, version, chatId }: { artifact: Artifact | null; version: number; chatId: string | null | undefined }) {
  const label = libraryEditLabel(artifact, version, chatId);
  return label ? (
    <span className="ml-2" data-slot="artifact-library-edit">
      {label}
    </span>
  ) : null;
}
