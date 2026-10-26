import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, SourceCodeIcon, TextFontIcon } from "@hugeicons/core-free-icons";
import { isMarkdownFile } from "@milagre/shared/file-link";
import { downloadAttachment } from "@milagre/shared/attachment-download";
import { FileCode } from "./FileCode";
import { FilesRoot } from "./editor-links";
import { Markdown } from "./markdown/Markdown";
import { ScrollArea } from "./primitives/ScrollArea";
import { useBridge } from "../lib/computer-bridge";
import { showToast } from "../lib/toast";

export function AttachmentPreview({ path, name, file, close }: { file?: File; path: string; name: string; close: () => void }) {
  const bridge = useBridge();
  const dialog = useRef<HTMLDialogElement>(null);
  const [result, setResult] = useState<{ text: string; binary: boolean; truncated: boolean } | null>(null);
  const [error, setError] = useState("");
  const markdown = isMarkdownFile(name);
  const [formatted, setFormatted] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadError, setDownloadError] = useState("");
  const download = async () => {
    if (downloading) return;
    setDownloading(true);
    setDownloadProgress(0);
    setDownloadError("");
    try {
      let blob: Blob;
      if (file) blob = file;
      else {
        const chunks: Uint8Array<ArrayBuffer>[] = [];
        await downloadAttachment(
          (offset, version) => bridge.readAttachmentChunk(path, offset, version),
          (bytes) => {
            chunks.push(bytes);
          },
          (received, total) => setDownloadProgress(total ? Math.round((received / total) * 100) : 100),
        );
        blob = new Blob(chunks, { type: "application/octet-stream" });
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Give Electron time to start reading the blob before releasing it.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      showToast("Download started.");
    } catch (reason) {
      setDownloadError(reason instanceof Error ? reason.message : "Could not download this file. Try again.");
    } finally {
      setDownloading(false);
    }
  };
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    element?.showModal();
    return () => {
      element?.close();
      previous?.focus();
    };
  }, []);
  useEffect(() => {
    let current = true;
    const read = file
      ? file
          .slice(0, 256 * 1024)
          .arrayBuffer()
          .then((buffer) => {
            const bytes = new Uint8Array(buffer);
            if (bytes.includes(0)) return { text: "", binary: true, truncated: false };
            try {
              return {
                text: new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: file.size > bytes.length }),
                binary: false,
                truncated: file.size > bytes.length,
              };
            } catch {
              return { text: "", binary: true, truncated: false };
            }
          })
      : bridge.readAttachment(path);
    read.then(
      (value) => {
        if (current) setResult(value);
      },
      (reason) => {
        if (current) setError(reason.message || "Could not read this file.");
      },
    );
    return () => {
      current = false;
    };
  }, [path, file, bridge]);
  const downloadButton = (
    <button
      type="button"
      disabled={downloading}
      onClick={() => void download()}
      className="rounded-control px-3 py-1.5 text-xs font-medium text-ink-2 hover:bg-hover disabled:opacity-50"
    >
      {downloading ? `Downloading… ${downloadProgress}%` : "Download"}
    </button>
  );
  return createPortal(
    <dialog
      ref={dialog}
      aria-label={`Preview ${name}`}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
      className="fixed inset-0 m-auto max-h-[80vh] w-[min(90vw,900px)] rounded-xl border border-line bg-surface p-0 text-ink shadow-card backdrop:bg-black/30 backdrop:backdrop-blur-overlay"
    >
      <div className="flex max-h-[80vh] flex-col">
        <header className="flex items-center gap-3 border-b border-line px-4 py-3">
          <h2 className="min-w-0 flex-1 truncate text-sm font-medium" title={path}>
            {name}
          </h2>
          {result && !result.binary && downloadButton}
          {markdown && result?.text && (
            <div role="group" aria-label="Markdown view" className="flex rounded-control bg-field p-0.5">
              {[
                { label: "Formatted", icon: TextFontIcon, value: true },
                { label: "Source", icon: SourceCodeIcon, value: false },
              ].map((option) => (
                // Native titles: the shared Tooltip portals to body, under this modal dialog's top layer.
                <button
                  key={option.label}
                  type="button"
                  aria-label={option.label}
                  title={option.label}
                  aria-pressed={formatted === option.value}
                  onClick={() => setFormatted(option.value)}
                  className={`flex size-6 items-center justify-center rounded-[5px] transition-colors focus-visible:outline-accent-ink ${formatted === option.value ? "bg-surface text-ink shadow-card" : "text-ink-3 hover:text-ink"}`}
                >
                  <HugeiconsIcon icon={option.icon} size={14} strokeWidth={1.8} />
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            aria-label="Close file preview"
            title="Close"
            onClick={close}
            className="flex size-7 items-center justify-center rounded-control text-ink-3 transition-colors hover:bg-hover hover:text-ink focus-visible:outline-accent-ink"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={16} strokeWidth={1.8} />
          </button>
        </header>
        <ScrollArea className="min-h-0 flex-1 p-4">
          {!!downloadError && (
            <p role="alert" className="mb-3 text-sm">
              {downloadError}
            </p>
          )}
          {error ? (
            <p role="alert" className="text-sm">
              {error}
            </p>
          ) : !result ? (
            <p role="status" className="text-sm text-ink-2">
              Reading file…
            </p>
          ) : result.binary ? (
            <div className="flex flex-col items-start gap-3">
              <p className="text-sm text-ink-2">This file does not have a text preview.</p>
              {downloadButton}
            </div>
          ) : result.text && markdown && formatted ? (
            <FilesRoot root={path.slice(0, path.lastIndexOf("/")) || "/"}>
              <div className="text-[13px] leading-[1.55]">
                <Markdown text={result.text} />
              </div>
            </FilesRoot>
          ) : result.text ? (
            <FileCode text={result.text} name={name} />
          ) : (
            <p className="text-sm text-ink-2">This file is empty.</p>
          )}
          {result?.truncated && (
            <p role="status" className="mt-4 text-xs text-ink-2">
              Showing the first 256 KB.
            </p>
          )}
        </ScrollArea>
      </div>
    </dialog>,
    document.body,
  );
}
