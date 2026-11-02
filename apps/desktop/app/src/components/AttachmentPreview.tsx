import { useEffect, useState, type HTMLAttributes, type SyntheticEvent } from "react";
import { SourceCodeIcon, TextFontIcon } from "@hugeicons/core-free-icons";
import { isMarkdownFile } from "@milagre/shared/file-link";
import { downloadAttachment } from "@milagre/shared/attachment-download";
import { FileCode } from "./FileCode";
import { FilesRoot } from "./editor-links";
import { Markdown } from "./markdown/Markdown";
import { Button } from "./primitives/Button";
import { Dialog } from "./primitives/Dialog";
import { InlineError } from "./primitives/InlineError";
import { Segmented } from "./primitives/Segmented";
import { useBridge } from "../lib/computer-bridge";
import { showToast } from "../lib/toast";

export function AttachmentPreview({ path, name, file, close }: { file?: File; path: string; name: string; close: () => void }) {
  const bridge = useBridge();
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
  const markdownView =
    markdown && result?.text ? (
      <Segmented
        label="Markdown view"
        value={formatted ? "formatted" : "source"}
        options={[
          { value: "formatted", label: "Formatted", icon: TextFontIcon, iconOnly: true },
          { value: "source", label: "Source", icon: SourceCodeIcon, iconOnly: true },
        ]}
        onChange={(value) => setFormatted(value === "formatted")}
      />
    ) : null;
  return (
    // Esc closes only this preview: it's consumed here, so it doesn't reach a preview this one opened from (React
    // bubbles through the component tree) or the window, where it would stop the Chat's turn. A cancel is stopped too.
    <span
      className="contents"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
      {...({ onCancel: (event: SyntheticEvent) => event.stopPropagation() } as HTMLAttributes<HTMLSpanElement>)}
    >
      <Dialog
        title={
          <span className="block truncate" title={path}>
            {name}
          </span>
        }
        width={900}
        onClose={close}
        footer="bar"
        footerStart={markdownView}
        actions={result && !result.binary ? downloadButton : undefined}
        className="pt-3"
      >
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
            <div className="text-13 leading-5">
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
      </Dialog>
    </span>
  );
}
