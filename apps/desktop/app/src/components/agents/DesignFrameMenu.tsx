import { createContext, useContext, useRef, useState } from "react";
import {
  Download04Icon,
  FolderTransferIcon,
  LibraryIcon,
  MoreHorizontalIcon,
  PencilEdit02Icon,
  Presentation01Icon,
  Share08Icon,
} from "@hugeicons/core-free-icons";
import { isInteractiveDesign, type DesignArtifact } from "@milagre/shared/artifact";
import { DESIGN_MODE_LABELS, type DesignMode } from "@milagre/shared/design-modes";
import type { ArtifactRef } from "../../model";
import Tooltip from "../primitives/Tooltip";
import { IconButton } from "../primitives/Button";
import { MenuRow, Popover } from "../primitives/Popover";
import { DesignExportDialog } from "./DesignExportDialog";
import { useSelection } from "./canvas-selection";

function downloadHtml(html: string, filename: string) {
  const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  const link = window.document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Renames a Project library design, or moves it to another library page, from its frame on the Design library page. */
export type LibraryEdit = (design: ArtifactRef, kind: "rename" | "move") => void;
/** Set by the Design library page around its canvas, so its frames' menus rename and move. */
export const LibraryEditContext = createContext<LibraryEdit | null>(null);

/**
 * A design frame's ⋯ menu on the canvas: pick its color mode, export it, share it on its own link, add it to the
 * presentation being picked, add it to the Project library, and, on the Design library page, rename it or move it.
 */
export function DesignFrameMenu({
  artifact,
  shown,
  open,
  onOpen,
  modes,
  mode,
  onMode,
  onShare,
  onAddToLibrary,
}: {
  artifact: DesignArtifact;
  shown: ArtifactRef;
  open: boolean;
  onOpen: (open: boolean) => void;
  modes: readonly DesignMode[];
  mode: DesignMode;
  onMode: (mode: DesignMode) => void;
  onShare?: (design: ArtifactRef) => void;
  onAddToLibrary?: (design: ArtifactRef) => void;
}) {
  const onLibraryEdit = useContext(LibraryEditContext);
  const selection = useSelection();
  const anchor = useRef<HTMLSpanElement>(null);
  const [exporting, setExporting] = useState(false);
  return (
    <span ref={anchor} className="inline-flex">
      <Tooltip label="More" asChild>
        <IconButton
          data-slot="artifact-more"
          label={`More actions for ${shown.title}`}
          icon={MoreHorizontalIcon}
          size={24}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => onOpen(!open)}
        />
      </Tooltip>
      {open && (
        <Popover anchor={anchor} label={`${shown.title} actions`} onClose={() => onOpen(false)}>
          {modes.length > 1 &&
            modes.map((item) => (
              <MenuRow
                key={item}
                data-slot="artifact-mode"
                role="menuitemradio"
                checked={item === mode}
                title={DESIGN_MODE_LABELS[item]}
                onClick={() => {
                  onOpen(false);
                  onMode(item);
                }}
              />
            ))}
          <MenuRow
            data-slot="artifact-export"
            icon={Download04Icon}
            title={isInteractiveDesign(artifact) ? "Download HTML" : "Export…"}
            onClick={() => {
              onOpen(false);
              if (isInteractiveDesign(artifact)) downloadHtml(artifact.html, `${artifact.id}-v${artifact.version}.html`);
              else setExporting(true);
            }}
          />
          {onShare && (
            <MenuRow
              data-slot="artifact-share-design"
              icon={Share08Icon}
              title="Share this design…"
              onClick={() => {
                onOpen(false);
                onShare(shown);
              }}
            />
          )}
          {selection && (
            <MenuRow
              data-slot="artifact-select-design"
              icon={Presentation01Icon}
              title={selection.ids.includes(shown.id) ? "Remove from presentation" : "Add to presentation"}
              onClick={() => {
                onOpen(false);
                selection.toggle(shown.id);
              }}
            />
          )}
          {onLibraryEdit && (
            <>
              <MenuRow
                data-slot="library-rename-design"
                icon={PencilEdit02Icon}
                title="Rename…"
                onClick={() => {
                  onOpen(false);
                  onLibraryEdit(shown, "rename");
                }}
              />
              <MenuRow
                data-slot="library-move-design"
                icon={FolderTransferIcon}
                title="Move to page…"
                onClick={() => {
                  onOpen(false);
                  onLibraryEdit(shown, "move");
                }}
              />
            </>
          )}
          {onAddToLibrary && (
            <MenuRow
              data-slot="artifact-add-library"
              icon={LibraryIcon}
              title="Add to Project library…"
              onClick={() => {
                onOpen(false);
                onAddToLibrary(shown);
              }}
            />
          )}
        </Popover>
      )}
      {exporting && !isInteractiveDesign(artifact) && artifact.document && (
        <DesignExportDialog designs={[{ id: artifact.id, title: artifact.title, document: artifact.document }]} onClose={() => setExporting(false)} />
      )}
    </span>
  );
}
