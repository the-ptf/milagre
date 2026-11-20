import { useRef, useState } from "react";
import { Delete02Icon, FolderTransferIcon, MoreHorizontalIcon, PencilEdit02Icon, ViewIcon } from "@hugeicons/core-free-icons";
import { isInteractiveDesign, libraryCardLine, type DesignLibraryEntry } from "@milagre/shared/artifact";
import { IconButton } from "../primitives/Button";
import { MenuRow, MenuSeparator, Popover } from "../primitives/Popover";
import { ScaledPreview } from "../agents/ArtifactCard";
import { pageFiles } from "../agents/ArtifactCanvas";
import { useArtifact } from "../agents/artifact-read";
import type { LibraryAction } from "./LibraryDialogs";

/**
 * A design on the Design library page: its latest version drawn small, as a Chat's design card draws it, its title,
 * size, page (on All) and who saved it when. The card opens it; the ⋯ menu renames, moves or deletes it.
 */
export function LibraryCard({
  projectKey,
  design,
  pageName,
  now,
  onOpen,
  onAction,
}: {
  projectKey: string;
  design: DesignLibraryEntry;
  pageName?: string;
  now: number;
  onOpen: () => void;
  onAction: (action: LibraryAction) => void;
}) {
  const { artifact, error } = useArtifact(projectKey, design.id, design.version);
  const more = useRef<HTMLSpanElement>(null);
  const [menu, setMenu] = useState(false);
  const act = (kind: "rename" | "move" | "delete") => {
    setMenu(false);
    onAction({ kind, design });
  };
  return (
    <li data-slot="library-card" data-design={design.id} className="group/card relative overflow-hidden rounded-card border border-line bg-surface">
      <button type="button" aria-label={`Open ${design.title}`} onClick={onOpen} className="block w-full text-left transition-colors hover:bg-hover">
        <div className="relative h-44 overflow-hidden border-b border-line bg-paper">
          {artifact ? (
            <ScaledPreview
              html={artifact.html}
              format={artifact.format}
              code={isInteractiveDesign(artifact)}
              title={`Preview of ${design.title}`}
              width={artifact.width}
              height={artifact.height}
              files={pageFiles(projectKey, artifact)}
            />
          ) : (
            <div className="grid size-full place-items-center px-6 text-center text-12 text-ink-3">{error ?? "Loading design…"}</div>
          )}
          <span aria-hidden className="absolute inset-0" />
        </div>
        <div className="flex flex-col gap-0.5 px-3 py-2.5">
          <span className="truncate text-13 font-medium text-ink" data-slot="library-card-title">
            {design.title}
          </span>
          <span className="truncate text-12 text-ink-3 tabular-nums">
            {[pageName, `${design.width} × ${design.height}`, isInteractiveDesign(design) ? "Interactive" : ""].filter(Boolean).join(" · ")}
          </span>
          <span className="truncate text-12 text-ink-3" data-slot="library-card-line">
            {libraryCardLine(design, now)}
          </span>
        </div>
      </button>
      <span ref={more} className="absolute top-2 right-2 flex">
        <IconButton
          data-slot="library-card-more"
          label={`More actions for ${design.title}`}
          icon={MoreHorizontalIcon}
          size={28}
          aria-haspopup="menu"
          aria-expanded={menu}
          onClick={() => setMenu(!menu)}
          className={`bg-surface shadow-btn ${menu ? "" : "opacity-0 group-hover/card:opacity-100 focus-visible:opacity-100"}`}
        />
      </span>
      {menu && (
        <Popover anchor={more} label={`${design.title} actions`} onClose={() => setMenu(false)}>
          <MenuRow
            icon={ViewIcon}
            title="Open"
            onClick={() => {
              setMenu(false);
              onOpen();
            }}
          />
          <MenuRow data-slot="library-rename-design" icon={PencilEdit02Icon} title="Rename…" onClick={() => act("rename")} />
          <MenuRow data-slot="library-move-design" icon={FolderTransferIcon} title="Move to page…" onClick={() => act("move")} />
          <MenuSeparator />
          <MenuRow data-slot="library-delete-design" icon={Delete02Icon} title="Delete…" danger onClick={() => act("delete")} />
        </Popover>
      )}
    </li>
  );
}
