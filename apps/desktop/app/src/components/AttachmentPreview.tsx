import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Cancel01Icon, SourceCodeIcon, TextFontIcon } from "@hugeicons/core-free-icons";
import { isMarkdownFile } from "@milagre/shared/file-link";
import { downloadAttachment } from "@milagre/shared/attachment-download";
import { FileCode } from "./FileCode";
import { FilesRoot } from "./editor-links";
import { Markdown } from "./markdown/Markdown";
import { Button, IconButton } from "./primitives/Button";
import { Icon } from "./primitives/Icon";
import { InlineError } from "./primitives/InlineError";
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
    <Button variant="ghost" size={28} disabled={downloading} onClick={() => void download()}>
      {downloading ? `Downloading… ${downloadProgress}%` : "Download"}
    </Button>
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
      className="fixed inset-0 m-auto max-h-[80vh] w-[min(90vw,900px)] rounded-window bg-surface p-0 text-ink shadow-overlay backdrop:bg-scrim backdrop:backdrop-blur-overlay"
    >
      <div className="flex max-h-[80vh] flex-col">
        <header className="flex items-center gap-3 border-b border-line px-4 py-3">
          <h2 className="min-w-0 flex-1 truncate text-15 font-semibold" title={path}>
            {name}
          </h2>
          {result && !result.binary && downloadButton}
          {markdown && result?.text && (
            <div role="group" aria-label="Markdown view" className="flex rounded-control bg-field p-0.5">
              {[
                { label: "Formatted", icon: TextFontIcon, value: true },
                { label: "Source", icon: SourceCodeIcon, value: false },
              ].map((option) => (
                // Native titles here and on Close: the shared Tooltip portals to body, under this modal dialog's top layer.
                <button
                  key={option.label}
                  type="button"
                  aria-label={option.label}
                  title={option.label}
                  aria-pressed={formatted === option.value}
                  onClick={() => setFormatted(option.value)}
                  className={`flex size-6 items-center justify-center rounded-chip transition-colors duration-fast ${formatted === option.value ? "bg-surface text-ink shadow-card" : "text-ink-3 hover:text-ink"}`}
                >
                  <Icon icon={option.icon} size={14} />
                </button>
              ))}
            </div>
          )}
          <IconButton label="Close file preview" title="Close" icon={Cancel01Icon} onClick={close} />
        </header>
        <ScrollArea className="min-h-0 flex-1 p-4">
          <InlineError className="mb-3">{downloadError}</InlineError>
          {error ? (
            <InlineError>{error}</InlineError>
          ) : !result ? (
            <p role="status" className="text-13 text-ink-2">
              Reading file…
            </p>
          ) : result.binary ? (
            <div className="flex flex-col items-start gap-3">
              <p className="text-13 text-ink-2">This file does not have a text preview.</p>
              {downloadButton}
            </div>
          ) : result.text && markdown && formatted ? (
            <FilesRoot root={path.slice(0, path.lastIndexOf("/")) || "/"}>
              <div className="text-13 leading-[1.55]">
                <Markdown text={result.text} />
              </div>
            </FilesRoot>
          ) : result.text ? (
            <FileCode text={result.text} name={name} />
          ) : (
            <p className="text-13 text-ink-2">This file is empty.</p>
          )}
          {result?.truncated && (
            <p role="status" className="mt-4 text-12 text-ink-2">
              Showing the first 256 KB.
            </p>
          )}
        </ScrollArea>
      </div>
    </dialog>,
    document.body,
  );
}
