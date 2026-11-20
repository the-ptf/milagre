import { useRef, useState } from "react";
import { Download04Icon, LibraryIcon, MoreHorizontalIcon, Share08Icon } from "@hugeicons/core-free-icons";
import { isInteractiveDesign, type DesignArtifact } from "@milagre/shared/artifact";
import type { ArtifactRef } from "../../model";
import Tooltip from "../primitives/Tooltip";
import { IconButton } from "../primitives/Button";
import { MenuRow, Popover } from "../primitives/Popover";
import { DesignExportDialog } from "./DesignExportDialog";

function downloadHtml(html: string, filename: string) {
  const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  const link = window.document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A design frame's ⋯ menu on the canvas: export it, share it on its own link, and add it to the Project library. */
export function DesignFrameMenu({
  artifact,
  shown,
  open,
  onOpen,
  onShare,
  onAddToLibrary,
}: {
  artifact: DesignArtifact;
  shown: ArtifactRef;
  open: boolean;
  onOpen: (open: boolean) => void;
  onShare?: (design: ArtifactRef) => void;
  onAddToLibrary?: (design: ArtifactRef) => void;
}) {
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
