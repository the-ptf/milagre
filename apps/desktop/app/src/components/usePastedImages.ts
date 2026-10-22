import { MAX_ATTACHMENT_BYTES, IMAGE_TYPES, IMAGE_ERRORS } from "@milagre/shared/limits";
import { useEffect, useRef, useState } from "react";
import type { ClipboardEvent } from "react";
import type { ImageAttachment } from "../model";
import { isRemoteKey } from "../lib/computer-bridge";
import { uploadFile } from "../lib/attachment-uploads";
import { remapImageMentions } from "@milagre/shared/prompt-mentions";

const TYPES = new Set(IMAGE_TYPES);

function isAttachableImage(file: File): boolean {
  return TYPES.has(file.type) && file.size <= MAX_ATTACHMENT_BYTES;
}

function readImage(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve({ id: crypto.randomUUID(), name: file.name || "Pasted image", dataUrl: String(reader.result) }));
    reader.addEventListener("error", () => reject(new Error("Could not read the pasted image. Try again.")));
    reader.readAsDataURL(file);
  });
}

/** Selected files travel as bytes to the owning computer; project mentions already name files on that computer. */
export function usePastedImages(scope: string, owner?: string) {
  const remote = isRemoteKey(owner);
  const [images, commitImages] = useState<ImageAttachment[]>([]);
  const currentImages = useRef(images);
  function setImages(update: ImageAttachment[] | ((current: ImageAttachment[]) => ImageAttachment[])) {
    const next = typeof update === "function" ? update(currentImages.current) : update;
    currentImages.current = next;
    commitImages(next);
  }
  const localFiles = useRef(new Map<string, File>());
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const reading = useRef(false);

  function clear() {
    generation.current++;
    reading.current = false;
    setImages([]);
    setFiles([]);
    setLoading(false);
    setError("");
  }

  useEffect(() => {
    clear();
    localFiles.current.clear();
    return () => {
      generation.current++;
    };
  }, [scope]);

  async function addFiles(files: File[]): Promise<number[]> {
    if (!files.length) return [];
    setError("");
    if (reading.current) {
      setError("Wait for the current image to finish loading, then try again.");
      return [];
    }
    if (files.some((file) => !TYPES.has(file.type))) {
      setError(IMAGE_ERRORS.type);
      return [];
    }
    if (files.some((file) => file.size > MAX_ATTACHMENT_BYTES)) {
      setError(IMAGE_ERRORS.size);
      return [];
    }
    const current = generation.current;
    reading.current = true;
    setLoading(true);
    try {
      const next = await Promise.all(files.map(readImage));
      if (current !== generation.current) return [];
      const base = currentImages.current.length;
      setImages((existing) => [...existing, ...next]);
      return next.map((_, i) => base + i + 1);
    } catch (error) {
      if (current === generation.current) setError(error instanceof Error ? error.message : "Could not read image.");
      return [];
    } finally {
      if (current === generation.current) {
        reading.current = false;
        setLoading(false);
      }
    }
  }

  async function onPaste(event: ClipboardEvent<HTMLElement>): Promise<number[]> {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (!files.length) return [];
    event.preventDefault();
    return addFiles(files);
  }

  async function pasteImage(): Promise<number[]> {
    const current = generation.current;
    try {
      const items = await navigator.clipboard.read();
      const files: File[] = [];
      for (const item of items) {
        const type = item.types.find((type) => TYPES.has(type));
        if (type) files.push(new File([await item.getType(type)], `Pasted image.${type.split("/")[1]}`, { type }));
      }
      if (current !== generation.current) return [];
      if (!files.length) {
        setError("Copy an image first, then try Paste image again.");
        return [];
      }
      return await addFiles(files);
    } catch {
      if (current === generation.current) setError("Could not read the clipboard. Allow clipboard access or paste with the keyboard shortcut.");
      return [];
    }
  }

  async function attachFiles(selected: File[]): Promise<number[]> {
    if (reading.current) {
      setError("Wait for the current attachment to finish loading, then try again.");
      return [];
    }
    const current = generation.current;
    reading.current = true;
    setLoading(true);
    setError("");
    const nextImages: ImageAttachment[] = [];
    const paths: string[] = [];
    let failed = "";
    for (const file of selected) {
      if (current !== generation.current) return [];
      try {
        let path: string;
        if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`${file.name} is larger than 50 MiB.`);
        if (remote) {
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.addEventListener("load", () => resolve(String(reader.result)));
            reader.addEventListener("error", () => reject(new Error(`Could not read ${file.name}. Choose it again with Add files.`)));
            reader.readAsDataURL(file);
          });
          if (current !== generation.current) return [];
          const result = await uploadFile(owner!, file.name, dataUrl.slice(dataUrl.indexOf(",") + 1), () => current === generation.current);
          path = result.path;
        } else {
          path = window.milagre.getPathForFile(file);
        }
        if (current !== generation.current) return [];
        if (!path) {
          failed = "Could not get a local path for one or more files. Choose them again with Add files.";
          continue;
        }
        paths.push(path);
        localFiles.current.set(path, file);
        if (isAttachableImage(file)) {
          try {
            nextImages.push({ ...(await readImage(file)), path });
          } catch {
            /* The disk attachment still works. */
          }
        }
      } catch (error) {
        failed = error instanceof Error ? error.message : "Could not attach the file. Try again.";
      }
    }
    if (current !== generation.current) return [];
    const added = nextImages.filter((image) => !currentImages.current.some((item) => item.path === image.path));
    const base = currentImages.current.length;
    setFiles((existing) => [...new Set([...existing, ...paths])]);
    setImages((existing) => [...existing, ...nextImages.filter((image) => !existing.some((item) => item.path === image.path))]);
    if (failed) setError(failed);
    reading.current = false;
    setLoading(false);
    return added.map((_, i) => base + i + 1);
  }

  function attachPath(path: string) {
    setFiles((current) => (current.includes(path) ? current : [...current, path]));
    setError("");
  }

  function removeFile(path: string) {
    setFiles((current) => current.filter((file) => file !== path));
    setImages((current) => current.filter((image) => image.path !== path));
  }

  function restore(sentImages: ImageAttachment[], sentFiles: string[], draft = "") {
    const current = currentImages.current;
    const merged = [...sentImages, ...current.filter((image) => !sentImages.some((sent) => sent.id === image.id))];
    const remapped = remapImageMentions(
      draft,
      current.map((image) => merged.findIndex((item) => item.id === image.id) + 1),
    );
    setImages(merged);
    setFiles((current) => [...new Set([...sentFiles, ...current])]);
    return remapped;
  }

  return {
    /** The Chat (or new-chat screen) these attachments belong to; a new scope starts empty. */
    scope,
    remote,
    images,
    files,
    localFiles: localFiles.current,
    loading,
    error,
    onPaste,
    pasteImage,
    addFiles,
    attachFiles,
    attachPath,
    removeFile,
    clear,
    restore,
    remove: (id: string) => setImages((current) => current.filter((image) => image.id !== id)),
  };
}

export type ImageDraft = ReturnType<typeof usePastedImages>;
