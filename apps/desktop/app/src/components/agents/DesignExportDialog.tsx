import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { designPageExportBlob, designPageExportSize, type DesignExportItem, type DesignExportFormat } from "./design-export";

/** Export a snapshot of the current draft, without saving it to the Chat. */
export function DesignExportDialog({ designs, onClose }: { designs: DesignExportItem[]; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const formatName = useId();
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
    const element = dialog.current;
    const previousFocus = window.document.activeElement as HTMLElement | null;
    element?.showModal();
    return () => {
      alive.current = false;
      element?.close();
      previousFocus?.focus();
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

  return createPortal(
    <dialog
      ref={dialog}
      data-slot="design-export-dialog"
      aria-labelledby={titleId}
      onKeyDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) close();
      }}
      className="m-auto w-[400px] max-w-[calc(100vw-32px)] overflow-hidden rounded-window border border-line bg-surface p-0 text-ink shadow-overlay backdrop:bg-black/30 backdrop:backdrop-blur-overlay"
    >
      <div className="p-5">
        <h2 id={titleId} className="text-[16px] font-semibold">
          Export Designs page
        </h2>
        <p className="mt-1 text-[12px] text-ink-3">
          All {designs.length} {designs.length === 1 ? "design" : "designs"}, including unsaved edits.
        </p>
        <fieldset disabled={exporting} className="mt-5 space-y-2">
          <legend className="mb-2 text-[12px] font-medium text-ink-2">File format</legend>
          {formats.map((option) => (
            <label
              key={option.value}
              className={`flex items-center gap-3 rounded-control border px-3 py-3 ${format === option.value ? "border-accent bg-accent/10" : "border-line hover:bg-hover"} ${exporting ? "opacity-50" : "cursor-pointer"}`}
            >
              <input
                type="radio"
                name={formatName}
                value={option.value}
                aria-label={option.label}
                checked={format === option.value}
                onChange={() => {
                  setFormat(option.value);
                  setError("");
                }}
                className="size-3.5 shrink-0 accent-accent"
              />
              <span>
                <span className="block text-[13px] font-medium">{option.label}</span>
                <span className="mt-0.5 block text-[12px] text-ink-3">{option.description}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <p className="mt-4 break-all text-[11px] text-ink-3">{filename}</p>
        {error && (
          <p role="alert" className="mt-3 text-[12px] leading-relaxed text-red">
            {error}
          </p>
        )}
      </div>
      <footer className="flex items-center justify-end gap-2 border-t border-line px-5 py-4">
        <button
          type="button"
          aria-label="Cancel export"
          className="rounded-control border border-line px-3 py-1.5 text-[12px] hover:bg-hover disabled:opacity-40"
          disabled={exporting}
          onClick={close}
        >
          Cancel
        </button>
        <button
          type="button"
          data-slot="design-export-download"
          className="rounded-control bg-accent px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-40"
          disabled={exporting}
          onClick={() => void download()}
        >
          {exporting ? "Exporting..." : `Export ${format.toUpperCase()}`}
        </button>
      </footer>
    </dialog>,
    window.document.body,
  );
}
