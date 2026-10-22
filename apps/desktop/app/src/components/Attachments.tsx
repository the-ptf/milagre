import { canCopyImage } from "../lib/media";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { File01Icon } from "@hugeicons/core-free-icons";
import type { ImageAttachment } from "../model";
import { mediaKind, mediaUrl } from "../lib/media";
import type { LightboxItem } from "./motion/MediaLightbox";
import { lazyView } from "../lib/lazy-view";
import { MediaLightbox } from "./motion/LazyMediaLightbox";
import { isRemoteKey, useScope } from "../lib/computer-bridge";
import { useRemoteMedia } from "../lib/remote-media";

const AttachmentPreview = lazyView(() => import("./AttachmentPreview").then((module) => module.AttachmentPreview));

/** `leading` goes first in the row, which isn't a file the user attached. */
export function Attachments({
  images = [],
  files = [],
  localFiles,
  removeImage,
  removeFile,
  leading,
}: {
  images?: ImageAttachment[];
  files?: string[];
  localFiles?: Map<string, File>;
  removeImage?: (id: string) => void;
  removeFile?: (path: string) => void;
  leading?: ReactNode;
}) {
  // The open item's index among the media; its thumbnail hides while the viewer shows it.
  const [open, setOpen] = useState<number | null>(null);
  const thumbs = useRef(new Map<string, HTMLButtonElement>());
  // A remote chat's images come from its computer; its other files have no preview here.
  const scope = useScope();
  const remote = isRemoteKey(scope);
  const { sources: remoteSources, failed: remoteFailed } = useRemoteMedia(remote ? scope : null, [
    ...images.flatMap((image) => (image.dataUrl || !image.path ? [] : [image.path])),
    ...files.filter((path) => mediaKind(path) === "image"),
  ]);
  const sourceOf = (path: string) => (remote ? (remoteSources[path] ?? "") : mediaUrl(path));
  const items = [
    ...images.map((image, index) => ({
      id: image.id,
      index: index + 1,
      path: image.dataUrl ? undefined : image.path,
      name: image.name,
      src: image.dataUrl ?? sourceOf(image.path ?? ""),
      kind: "image" as const,
      file: remote && image.path ? (remoteSources[image.path] ?? image.dataUrl) : (image.path ?? image.dataUrl),
      remove: image.path && removeFile ? () => removeFile(image.path!) : removeImage ? () => removeImage(image.id) : undefined,
    })),
    ...files
      .filter((path) => !images.some((image) => (image.sourcePath ?? image.path) === path))
      .map((path) => ({
        id: path,
        index: undefined,
        path,
        name: path.split("/").at(-1) || path,
        src: sourceOf(path),
        kind: remote && mediaKind(path) !== "image" ? null : mediaKind(path),
        file: mediaKind(path) !== "image" ? undefined : remote ? remoteSources[path] : path,
        remove: removeFile ? () => removeFile(path) : undefined,
      })),
  ];
  // The viewer pages only through what has an image to show: one still loading, or one that failed, has none.
  const media = items.filter((item): item is typeof item & LightboxItem => !!item.kind && !!item.src);
  const failedRemote = (item: (typeof items)[number]) => remote && item.kind === "image" && !item.src && !!item.path && !!remoteFailed[item.path];
  const close = useCallback(() => setOpen(null), []);
  const thumbFor = useCallback((id: string) => thumbs.current.get(id), []);
  const showing = (id: string) => open !== null && media[open]?.id === id;
  if (!items.length && !leading) return null;
  return (
    <div className="mb-2 flex flex-wrap items-start gap-2" aria-label="Attachments">
      {leading}
      {items.map((item) => (
        <div key={item.id} className="relative max-w-full rounded-lg border border-line bg-inset p-1">
          {failedRemote(item) ? (
            <FileTile path={item.id} name={item.name} unavailable />
          ) : item.kind ? (
            <button
              ref={(el) => {
                if (el) thumbs.current.set(item.id, el);
                else thumbs.current.delete(item.id);
              }}
              type="button"
              aria-label={`Preview ${item.name}`}
              onClick={item.src ? () => setOpen(media.findIndex((entry) => entry.id === item.id)) : undefined}
              onContextMenu={
                canCopyImage(item.file)
                  ? (event) => {
                      event.preventDefault();
                      void window.milagre.showImageMenu(item.file!, item.name);
                    }
                  : undefined
              }
              className="block rounded focus-visible:outline-2 focus-visible:outline-accent-ink"
            >
              {item.kind === "image" && !item.src ? (
                <span aria-hidden className="block size-20 animate-pulse rounded bg-hover" />
              ) : item.kind === "image" ? (
                <img src={item.src} alt={item.name} className={`size-20 rounded object-contain ${showing(item.id) ? "opacity-0" : ""}`} />
              ) : (
                <span className={`relative block ${showing(item.id) ? "opacity-0" : ""}`}>
                  <video src={item.src} muted preload="metadata" className="h-20 w-28 rounded object-contain" />
                  <span className="absolute bottom-0 left-0 rounded bg-surface/90 px-1 text-[10px]">Play video</span>
                </span>
              )}
              <span className="block max-w-28 truncate px-1 text-[10px] text-ink-2">{item.name}</span>
            </button>
          ) : (
            <FileTile path={item.id} name={item.name} file={localFiles?.get(item.id)} />
          )}
          {item.index !== undefined && (
            <span
              data-image-badge={item.index}
              className="pointer-events-none absolute top-1.5 left-1.5 rounded bg-surface/90 px-1 py-px text-[10px] font-semibold leading-tight text-ink shadow-xs"
            >
              #{item.index}
            </span>
          )}
          {item.remove && (
            <button
              type="button"
              aria-label={`Remove ${item.name}`}
              onClick={item.remove}
              className="absolute -top-1 -right-1 flex size-5 items-center justify-center rounded-full border border-line bg-surface text-xs text-ink"
            >
              ×
            </button>
          )}
        </div>
      ))}
      {open !== null && media[open] && <MediaLightbox items={media} start={open} thumbFor={thumbFor} onIndexChange={setOpen} close={close} />}
    </div>
  );
}

/** A file that isn't an image or video (a .txt, a .md): a square tile the size of a media thumbnail, with its extension. */
function FileTile({ path, name, file, unavailable }: { path: string; name: string; file?: File; unavailable?: boolean }) {
  const [open, setOpen] = useState(false);
  const extension = /\.([^./]+)$/.exec(name)?.[1];
  if (unavailable)
    return (
      <span data-attachment-unavailable title={`${name} couldn't be loaded from its computer`} className="block rounded">
        <span className="flex size-20 flex-col items-center justify-center gap-1 rounded bg-surface text-ink-3">
          <HugeiconsIcon icon={File01Icon} size={22} strokeWidth={1.6} color="currentColor" aria-hidden />
          <span className="text-[10px]">Unavailable</span>
        </span>
        <span className="block max-w-20 truncate px-1 text-center text-[10px] text-ink-2">{name}</span>
      </span>
    );
  return (
    <>
      <button
        type="button"
        aria-label={`Preview ${name}`}
        onClick={(event) => {
          event.currentTarget.focus();
          setOpen(true);
        }}
        title={path}
        className="block rounded hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent-ink"
      >
        <span className="flex size-20 flex-col items-center justify-center gap-1 rounded bg-surface text-ink-2">
          <HugeiconsIcon icon={File01Icon} size={22} strokeWidth={1.6} color="currentColor" aria-hidden />
          {extension && <span className="max-w-16 truncate text-[10px] font-medium uppercase tracking-wide">{extension}</span>}
        </span>
        <span className="block max-w-20 truncate px-1 text-center text-[10px] text-ink-2">{name}</span>
      </button>
      {open && <AttachmentPreview file={file} path={path} name={name} close={() => setOpen(false)} />}
    </>
  );
}
