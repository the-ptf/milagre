import { useCallback, useRef, useState } from "react";
import type { ChatStep, ImageAttachment } from "../../model";
import { replyImageFile, viewedImageName } from "@milagre/shared/reply-parts";
import { canCopyImage, mediaUrl } from "../../lib/media";
import { isRemoteKey, useScope } from "../../lib/computer-bridge";
import { useRemoteMedia } from "../../lib/remote-media";
import { ScrollArea } from "../primitives/ScrollArea";
import { MediaLightbox } from "../motion/LazyMediaLightbox";
import type { LightboxItem } from "../motion/MediaLightbox";

/** One bounded strip; the existing Read activity is the only tool row for these snapshots. */
export function ViewedImages({ steps, attachments }: { steps: ChatStep[]; attachments?: ImageAttachment[] }) {
  const scope = useScope();
  const remote = isRemoteKey(scope);
  const files = steps.map((step) => replyImageFile(step, attachments));
  const { sources, failed } = useRemoteMedia(
    remote ? scope : null,
    files.filter((file): file is string => !!file),
  );
  // Key load state by the actual URL, so a durable copy arriving replaces a failed transient load.
  const [loads, setLoads] = useState<Record<string, "ready" | "failed">>({});
  const [opened, setOpened] = useState<string | null>(null);
  const thumbs = useRef(new Map<string, HTMLButtonElement>());
  const thumbFor = useCallback((id: string) => thumbs.current.get(id), []);
  const close = useCallback(() => setOpened(null), [setOpened]);
  const entries = steps.map((step, index) => {
    const path = files[index];
    const file = path ? (remote ? sources[path] : path) : undefined;
    const src = file ? (remote ? file : mediaUrl(file)) : "";
    const unavailable = step.status === "failed" || (!path && step.status === "done") || !!(path && failed[path]) || loads[src] === "failed";
    return { id: step.id, name: viewedImageName(step), src, file, unavailable, ready: !!src && loads[src] === "ready" };
  });
  const items: LightboxItem[] = entries
    .filter((entry) => entry.ready && !entry.unavailable)
    .map(({ id, name, src, file }) => ({ id, name, src, kind: "image", file: canCopyImage(file) ? file : undefined }));
  const start = items.findIndex((item) => item.id === opened);
  if (!steps.length) return null;
  return (
    <>
      <ScrollArea horizontal chainScroll className="my-2 max-w-full pb-2" aria-label="Viewed images" data-slot="viewed-images">
        <div className="flex w-max gap-2">
          {entries.map((entry) => (
            <button
              key={entry.id}
              ref={(element) => {
                if (element) thumbs.current.set(entry.id, element);
                else thumbs.current.delete(entry.id);
              }}
              type="button"
              aria-label={`${entry.name}. ${entry.unavailable ? "Image unavailable" : entry.ready ? "Open full screen" : "Loading image"}`}
              aria-busy={!entry.unavailable && !entry.ready}
              disabled={!entry.ready || entry.unavailable}
              className="relative grid size-20 shrink-0 place-items-center overflow-hidden rounded-control bg-field text-11 text-ink-2"
              onClick={() => setOpened(entry.id)}
              onContextMenu={
                entry.ready && canCopyImage(entry.file)
                  ? (event) => {
                      event.preventDefault();
                      void window.milagre.showImageMenu(entry.file!);
                    }
                  : undefined
              }
            >
              {entry.src && !entry.unavailable && (
                <img
                  key={entry.src}
                  src={entry.src}
                  alt=""
                  draggable={false}
                  className={`absolute size-full object-cover ${opened === entry.id || !entry.ready ? "opacity-0" : ""}`}
                  onLoad={() => setLoads((previous) => ({ ...previous, [entry.src]: "ready" }))}
                  onError={() => setLoads((previous) => ({ ...previous, [entry.src]: "failed" }))}
                />
              )}
              {entry.unavailable ? <span className="px-1">Image unavailable</span> : !entry.ready ? <span className="px-1">Loading image…</span> : null}
            </button>
          ))}
        </div>
      </ScrollArea>
      {start >= 0 && <MediaLightbox items={items} start={start} thumbFor={thumbFor} onIndexChange={(index) => setOpened(items[index]!.id)} close={close} />}
    </>
  );
}
