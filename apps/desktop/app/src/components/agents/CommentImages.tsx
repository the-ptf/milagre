import { useRef, useState } from "react";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { IMAGE_ERRORS, IMAGE_TYPES, MAX_ATTACHMENT_BYTES } from "@milagre/shared/limits";
import type { ImageAttachment } from "../../model";
import { Icon } from "../primitives/Icon";
import { readImage } from "../usePastedImages";
import { isRemoteKey, useScope } from "../../lib/computer-bridge";
import { mediaUrl } from "../../lib/media";
import { useRemoteMedia } from "../../lib/remote-media";

const TYPES = new Set<string>(IMAGE_TYPES);
const MAX_COMMENT_IMAGES = 4;
const NONE: ImageAttachment[] = [];

export const imageFilesOf = (data: DataTransfer | null) => (data ? [...data.files].filter((file) => file.type.startsWith("image/")) : []);

/** A draft comment's images: pasted into its text or dropped on its bubble. */
export function useCommentImages(images: ImageAttachment[] = NONE, onImages?: (images: ImageAttachment[]) => void) {
  const [error, setError] = useState("");
  const latest = useRef(images);
  latest.current = images;
  const add = async (files: File[]) => {
    if (!onImages || !files.length) return;
    if (files.some((file) => !TYPES.has(file.type))) return setError(IMAGE_ERRORS.type);
    if (files.some((file) => file.size > MAX_ATTACHMENT_BYTES)) return setError(IMAGE_ERRORS.size);
    const room = MAX_COMMENT_IMAGES - latest.current.length;
    if (room < files.length) setError(`A comment takes up to ${MAX_COMMENT_IMAGES} images.`);
    else setError("");
    if (room <= 0) return;
    try {
      const read = await Promise.all(files.slice(0, room).map(readImage));
      onImages([...latest.current, ...read].slice(0, MAX_COMMENT_IMAGES));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not read the image.");
    }
  };
  const remove = (id: string) => {
    setError("");
    onImages?.(latest.current.filter((image) => image.id !== id));
  };
  return { images, add, remove, error, enabled: !!onImages };
}

export function CommentImageStrip({ images, onRemove }: { images: ImageAttachment[]; onRemove?: (id: string) => void }) {
  if (!images.length) return null;
  return (
    <div data-slot="artifact-comment-images" className="flex flex-wrap gap-1.5 px-1">
      {images.map((image) => (
        <span key={image.id} className="group/thumb relative size-12 overflow-hidden rounded-chip border border-line bg-paper">
          <img src={image.dataUrl} alt={image.name} className="size-full object-cover" />
          {onRemove && (
            <button
              type="button"
              aria-label={`Remove ${image.name}`}
              onClick={() => onRemove(image.id)}
              className="absolute top-0.5 right-0.5 grid size-4 place-items-center rounded-full bg-ink/70 text-on-ink opacity-0 transition-opacity group-hover/thumb:opacity-100 focus-visible:opacity-100"
            >
              <Icon icon={Cancel01Icon} size={12} />
            </button>
          )}
        </span>
      ))}
    </div>
  );
}

/** An image a sent message carries: inline before it is saved, then from its saved path here or on a paired computer. */
export function useSentImageSource(image?: ImageAttachment) {
  const scope = useScope();
  const remote = isRemoteKey(scope);
  const { sources } = useRemoteMedia(remote && !image?.dataUrl && image?.path ? scope : null, image?.path ? [image.path] : []);
  return image?.dataUrl ?? (image?.path ? (remote ? sources[image.path] : mediaUrl(image.path)) : undefined);
}

function SentImage({ image }: { image: ImageAttachment }) {
  const src = useSentImageSource(image);
  return (
    <span className="block size-10 overflow-hidden rounded-chip border border-line bg-paper">
      {src ? <img src={src} alt={image.name} className="size-full object-cover" /> : null}
    </span>
  );
}

export function SentCommentImages({ images }: { images: ImageAttachment[] }) {
  if (!images.length) return null;
  return (
    <span data-slot="design-feedback-images" className="mt-1 flex flex-wrap gap-1">
      {images.map((image) => (
        <SentImage key={image.id} image={image} />
      ))}
    </span>
  );
}
