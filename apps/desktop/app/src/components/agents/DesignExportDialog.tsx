import { useEffect, useRef, useState } from "react";
import { designPageExportBlob, designPageExportSize, type DesignExportItem, type DesignExportFormat } from "./design-export";
import { Button } from "../primitives/Button";
import { Dialog } from "../primitives/Dialog";
import { InlineError } from "../primitives/InlineError";
import { RadioGroup, RadioGroupItem } from "../primitives/RadioGroup";
import { SectionLabel } from "../primitives/SectionLabel";

/** Export a snapshot of the current draft, without saving it to the Chat. */
export function DesignExportDialog({ designs, onClose }: { designs: DesignExportItem[]; onClose: () => void }) {
  const alive = useRef(false);
  const working = useRef(false);
  const [format, setFormat] = useState<DesignExportFormat>("png");
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const filename = format === "json" ? "designs.milagre-design-page.json" : `designs.${format}`;
  const size = designPageExportSize(designs);
  const formats = [
    { value: "png", label: "PNG", description: `Image at ${size.pngWidth} × ${size.pngHeight} pixels` },
    { value: "svg", label: "SVG", description: "Vector image that stays sharp at any size" },
    { value: "json", label: "JSON", description: "Milagre page with every editable layer" },
  ] as const;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const close = () => {
    if (!working.current) onClose();
  };
  const download = async () => {
    if (working.current) return;
    working.current = true;
    setExporting(true);
    setError("");
    try {
      const blob = await designPageExportBlob(designs, format);
      if (!alive.current) return;
      const url = URL.createObjectURL(blob);
      const link = window.document.createElement("a");
      link.href = url;
      link.download = filename;
      try {
        link.click();
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      onClose();
    } catch (cause) {
      if (alive.current) setError(`${format.toUpperCase()} export failed. ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      working.current = false;
      if (alive.current) setExporting(false);
    }
  };

  return (
    // The dialog is portalled, but its events still bubble through React to the canvas behind it.
    <div
      role="presentation"
      className="contents"
      onKeyDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <Dialog
        data-slot="design-export-dialog"
        title="Export Designs page"
        description={`All ${designs.length} ${designs.length === 1 ? "design" : "designs"}, including unsaved edits.`}
        onClose={close}
        width={400}
        actions={
          <>
            <Button variant="ghost" aria-label="Cancel export" disabled={exporting} onClick={close}>
              Cancel
            </Button>
            <Button data-slot="design-export-download" disabled={exporting} onClick={() => void download()}>
              {exporting ? "Exporting…" : `Export ${format.toUpperCase()}`}
            </Button>
          </>
        }
      >
        <fieldset disabled={exporting} className="mt-5">
          <SectionLabel as="legend" className="mb-2">
            File format
          </SectionLabel>
          <RadioGroup
            value={format}
            onValueChange={(value) => {
              setFormat(value as DesignExportFormat);
              setError("");
            }}
          >
            <div className="space-y-2">
              {formats.map((option) => (
                // Selection is ink: the filled radio and an ink edge.
                <label
                  key={option.value}
                  className={`flex items-center gap-3 rounded-control border p-3 transition-colors ${format === option.value ? "border-ink" : "border-line hover:bg-hover"} ${exporting ? "opacity-40" : "cursor-pointer"}`}
                >
                  <RadioGroupItem value={option.value} aria-label={option.label} />
                  <span>
                    <span className="block text-13 font-medium">{option.label}</span>
                    <span className="mt-0.5 block text-12 text-ink-3">{option.description}</span>
                  </span>
                </label>
              ))}
            </div>
          </RadioGroup>
        </fieldset>
        <p className="mt-4 break-all text-11 text-ink-3">{filename}</p>
        <InlineError size={12} className="mt-3">
          {error}
        </InlineError>
      </Dialog>
    </div>
  );
}
