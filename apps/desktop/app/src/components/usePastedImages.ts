import { MAX_ATTACHMENT_BYTES, IMAGE_TYPES, IMAGE_ERRORS } from "@milagre/shared/limits";
import { useEffect, useRef, useState } from "react";
import type { ClipboardEvent } from "react";
import type { ImageAttachment } from "../model";
import { isRemoteKey } from "../lib/computer-bridge";
import { uploadFile } from "../lib/attachment-uploads";
import { remapImageMentions } from "@milagre/shared/prompt-mentions";

const TYPES = new Set(IMAGE_TYPES);
const NONE: ImageAttachment[] = [];
const NO_FILES: string[] = [];

/** A file on its way to another computer, shown as a tile until its batch is attached: how many of its bytes arrived. */
export type AttachmentUpload = { id: string; name: string; sentBytes: number; totalBytes: number };

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
export function usePastedImages(scope: string, owner?: string, deferUploads = false) {
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
  // Attachment keys (a file's path, a pasted image's id) in the order they were added, so the row lists them that way.
  const [order, setOrder] = useState<string[]>([]);
  const append = (keys: string[]) => setOrder((current) => [...current.filter((key) => !keys.includes(key)), ...keys]);
  const [loading, setLoading] = useState(false);
  const [uploads, setUploads] = useState<AttachmentUpload[]>([]);
  const cancelled = useRef(new Set<string>());
  const progressOf = (id: string, sentBytes: number) =>
    setUploads((current) => current.map((upload) => (upload.id === id ? { ...upload, sentBytes } : upload)));
  const [error, setError] = useState("");
  const generation = useRef(0);
  const reading = useRef(false);

  // Clearing what is empty already keeps the same arrays, so a switch between Chats without attachments renders nothing more.
  function clear() {
    generation.current++;
    reading.current = false;
    if (currentImages.current.length) setImages(NONE);
    setFiles((current) => (current.length ? NO_FILES : current));
    setOrder((current) => (current.length ? NO_FILES : current));
    setLoading(false);
    setUploads((current) => (current.length ? [] : current));
    setError("");
  }

  // Each Chat keeps its attachments while the user is in another, like its draft text does.
  const stash = useRef(new Map<string, { images: ImageAttachment[]; files: string[]; order: string[] }>());
  const latest = useRef({ files, order });
  latest.current = { files, order };
  useEffect(() => {
    const stashed = stash.current;
    const saved = stashed.get(scope);
    stashed.delete(scope);
    clear();
    if (saved) {
      setImages(saved.images);
      setFiles(saved.files);
      setOrder(saved.order);
    }
    return () => {
      generation.current++;
      // oxlint-disable-next-line react-hooks/exhaustive-deps -- read on the way out: the leaving Chat's latest attachments.
      const leaving = { images: currentImages.current, ...latest.current };
      if (leaving.images.length || leaving.files.length) stashed.set(scope, leaving);
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
      append(next.map((image) => image.id));
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
    let nextImages: ImageAttachment[] = [];
    let paths: string[] = [];
    // Which tile each uploaded path came from, so a tile cancelled after its bytes arrived still leaves the batch.
    const uploadOf = new Map<string, string>();
    let failed = "";
    // A remote batch shows every file as a tile at once; each fills as its bytes reach the other computer.
    const batch = selected.map((file) => ({ file, id: crypto.randomUUID() as string }));
    const ids = batch.map(({ id }) => id);
    if (remote)
      setUploads((existing) => [
        ...existing,
        ...batch.flatMap(({ file, id }) => (file.size > MAX_ATTACHMENT_BYTES ? [] : [{ id, name: file.name, sentBytes: 0, totalBytes: file.size }])),
      ]);
    for (const { file, id } of batch) {
      if (current !== generation.current) return [];
      if (cancelled.current.has(id)) continue;
      try {
        let path: string;
        if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`${file.name} is larger than 50 MiB.`);
        if (remote && deferUploads) {
          path = `/.milagre-offline-attachments/${id}/${file.name}`;
        } else if (remote) {
          const live = () => current === generation.current && !cancelled.current.has(id);
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.addEventListener("load", () => resolve(String(reader.result)));
            reader.addEventListener("error", () => reject(new Error(`Could not read ${file.name}. Choose it again with Add files.`)));
            reader.readAsDataURL(file);
          });
          if (current !== generation.current) return [];
          if (!live()) continue;
          const result = await uploadFile(owner!, file.name, dataUrl.slice(dataUrl.indexOf(",") + 1), live, (sent) => {
            if (live()) progressOf(id, sent);
          });
          if (!live()) continue;
          path = result.path;
          uploadOf.set(path, id);
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
        if (!cancelled.current.has(id)) failed = error instanceof Error ? error.message : "Could not attach the file. Try again.";
      }
    }
    const kept = (path?: string) => !path || !cancelled.current.has(uploadOf.get(path) ?? "");
    paths = paths.filter(kept);
    nextImages = nextImages.filter((image) => kept(image.path));
    for (const id of ids) cancelled.current.delete(id);
    if (current !== generation.current) return [];
    const added = nextImages.filter((image) => !currentImages.current.some((item) => item.path === image.path));
    const base = currentImages.current.length;
    setFiles((existing) => [...new Set([...existing, ...paths])]);
    append(paths);
    setImages((existing) => [...existing, ...nextImages.filter((image) => !existing.some((item) => item.path === image.path))]);
    if (failed) setError(failed);
    reading.current = false;
    setLoading(false);
    setUploads((existing) => existing.filter((upload) => !ids.includes(upload.id)));
    return added.map((_, i) => base + i + 1);
  }

  function attachPath(path: string) {
    setFiles((current) => (current.includes(path) ? current : [...current, path]));
    setOrder((current) => (current.includes(path) ? current : [...current, path]));
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
    setOrder((current) => [...new Set([...sentImages.map((image) => image.path ?? image.id), ...sentFiles, ...current])]);
    return remapped;
  }

  return {
    /** The Chat (or new-chat screen) these attachments belong to; a new scope starts empty. */
    scope,
    remote,
    images,
    files,
    order,
    localFiles: localFiles.current,
    loading,
    /** Files still on their way to the Chat's computer, in the order they were chosen. */
    uploads,
    /** Stops one file's upload; the rest of its batch carries on. */
    cancelUpload: (id: string) => {
      cancelled.current.add(id);
      setUploads((current) => current.filter((upload) => upload.id !== id));
    },
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
