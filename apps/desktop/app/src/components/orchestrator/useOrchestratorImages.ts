import { useState, type ClipboardEvent, type DragEvent } from "react";
import { IMAGE_ERRORS, IMAGE_TYPES, MAX_ATTACHMENT_BYTES } from "@milagre/shared/limits";
import { ORCHESTRATOR_MAX_IMAGES } from "@milagre/shared/orchestrator";
import type { ImageAttachment } from "../../model";
import { readImage } from "../usePastedImages";

export type OrchestratorImage = Required<Pick<ImageAttachment, "id" | "name" | "dataUrl">>;

const TOO_MANY = `Attach at most ${ORCHESTRATOR_MAX_IMAGES} images.`;

function problemWith(file: File) {
  if (!IMAGE_TYPES.includes(file.type)) return IMAGE_ERRORS.type;
  if (file.size > MAX_ATTACHMENT_BYTES) return IMAGE_ERRORS.size;
  return null;
}

const hasFiles = (transfer: DataTransfer) => Array.from(transfer.types).includes("Files");

export function useOrchestratorImages() {
  const [images, setImages] = useState<OrchestratorImage[]>([]);
  const [error, setError] = useState("");

  async function add(files: File[]) {
    if (!files.length) return;
    const problem = files.map(problemWith).find(Boolean);
    const usable = files.filter((file) => !problemWith(file));
    const room = ORCHESTRATOR_MAX_IMAGES - images.length;
    setError(problem ?? (usable.length > room ? TOO_MANY : ""));
    if (room <= 0 || !usable.length) return;
    try {
      const read = (await Promise.all(usable.slice(0, room).map(readImage))) as OrchestratorImage[];
      setImages((current) => [...current, ...read].slice(0, ORCHESTRATOR_MAX_IMAGES));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return {
    images,
    error,
    remove: (id: string) => {
      setImages((current) => current.filter((image) => image.id !== id));
      setError("");
    },
    clear: () => {
      setImages([]);
      setError("");
    },
    onPaste(event: ClipboardEvent<HTMLElement>) {
      const files = Array.from(event.clipboardData.items)
        .filter((item) => item.kind === "file")
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null);
      if (!files.length) return;
      event.preventDefault();
      void add(files);
    },
    onDragOver(event: DragEvent<HTMLElement>) {
      if (!hasFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    onDrop(event: DragEvent<HTMLElement>) {
      if (!hasFiles(event.dataTransfer)) return;
      event.preventDefault();
      void add(Array.from(event.dataTransfer.files));
    },
  };
}
