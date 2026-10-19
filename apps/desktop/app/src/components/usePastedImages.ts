import { MAX_IMAGE_BYTES, MAX_IMAGES, IMAGE_TYPES, IMAGE_ERRORS } from "@milagre/shared/limits";
import { useEffect, useRef, useState } from "react";
import type { ClipboardEvent } from "react";
import type { ImageAttachment } from "../model";

const TYPES = new Set(IMAGE_TYPES);

function isAttachableImage(file: File): boolean {
  return TYPES.has(file.type) && file.size <= MAX_IMAGE_BYTES;
}

function readImage(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ id: crypto.randomUUID(), name: file.name || "Pasted image", dataUrl: String(reader.result) });
    reader.onerror = () => reject(new Error("Could not read the pasted image. Try again."));
    reader.readAsDataURL(file);
  });
}

export const REMOTE_FILES_NOTICE = "Files from this Mac can't be attached to a chat on another computer. Paste images instead.";

/** `remote`: the chat is on another Mac, so files from this one are refused (pasted images travel as data and still go). */
export function usePastedImages(scope: string, remote = false) {
  const [images, setImages] = useState<ImageAttachment[]>([]);
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

  async function addFiles(files: File[]) {
    if (!files.length) return;
    setError("");
    if (reading.current) {
      setError("Wait for the current image to finish loading, then try again.");
      return;
    }
    if (files.some((file) => !TYPES.has(file.type))) {
      setError(IMAGE_ERRORS.type);
      return;
    }
    if (files.some((file) => file.size > MAX_IMAGE_BYTES)) {
      setError(IMAGE_ERRORS.size);
      return;
    }
    if (images.length + files.length > MAX_IMAGES) {
      setError(IMAGE_ERRORS.count);
      return;
    }
    const current = generation.current;
    reading.current = true;
    setLoading(true);
    try {
      const next = await Promise.all(files.map(readImage));
      if (current === generation.current) setImages((existing) => [...existing, ...next]);
    } catch (error) {
      if (current === generation.current) setError(error instanceof Error ? error.message : "Could not read image.");
    } finally {
      if (current === generation.current) {
        reading.current = false;
        setLoading(false);
      }
    }
  }

  async function onPaste(event: ClipboardEvent<HTMLElement>) {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (!files.length) return;
    event.preventDefault();
    await addFiles(files);
  }

  async function pasteImage() {
    const current = generation.current;
    try {
      const items = await navigator.clipboard.read();
      const files: File[] = [];
      for (const item of items) {
        const type = item.types.find((type) => TYPES.has(type));
        if (type) files.push(new File([await item.getType(type)], `Pasted image.${type.split("/")[1]}`, { type }));
      }
      if (current !== generation.current) return;
      if (!files.length) {
        setError("Copy an image first, then try Paste image again.");
        return;
      }
      await addFiles(files);
    } catch {
      if (current === generation.current) setError("Could not read the clipboard. Allow clipboard access or paste with the keyboard shortcut.");
    }
  }

  async function attachFiles(selected: File[]) {
    if (remote) {
      if (selected.length) setError(REMOTE_FILES_NOTICE);
      return;
    }
    if (reading.current) {
      setError("Wait for the current attachment to finish loading, then try again.");
      return;
    }
    const current = generation.current;
    reading.current = true;
    setLoading(true);
    setError("");
    const nextImages: ImageAttachment[] = [];
    const paths: string[] = [];
    let failed = false;
    for (const file of selected) {
      try {
        const path = window.milagre.getPathForFile(file);
        if (!path) {
          failed = true;
          continue;
        }
        paths.push(path);
        localFiles.current.set(path, file);
        if (isAttachableImage(file) && images.length + nextImages.length < MAX_IMAGES) {
          try {
            nextImages.push({ ...(await readImage(file)), path });
          } catch {
            /* The disk attachment still works. */
          }
        }
      } catch {
        failed = true;
      }
    }
    if (current !== generation.current) return;
    setFiles((existing) => [...new Set([...existing, ...paths])]);
    setImages((existing) => [...existing, ...nextImages.filter((image) => !existing.some((item) => item.path === image.path))]);
    if (failed) setError("Could not get a local path for one or more files. Choose them again with Add files.");
    reading.current = false;
    setLoading(false);
  }

  function attachPath(path: string) {
    if (remote) {
      setError(REMOTE_FILES_NOTICE);
      return;
    }
    setFiles((current) => (current.includes(path) ? current : [...current, path]));
    setError("");
  }

  function removeFile(path: string) {
    setFiles((current) => current.filter((file) => file !== path));
    setImages((current) => current.filter((image) => image.path !== path));
  }

  function restore(sentImages: ImageAttachment[], sentFiles: string[]) {
    setImages((current) => [...sentImages, ...current.filter((image) => !sentImages.some((sent) => sent.id === image.id))]);
    setFiles((current) => [...new Set([...sentFiles, ...current])]);
  }

  return {
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
