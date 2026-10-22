import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { ComponentProps } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Copy01Icon, Download04Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import type { ChatStep } from "../../model";
import { canCopyImage, mediaUrl } from "../../lib/media";
import { isRemoteKey, useScope } from "../../lib/computer-bridge";
import { useRemoteMedia } from "../../lib/remote-media";
import { ImageGeneration } from "./ImageGeneration";
import type { ImageGenerationStatus } from "./ImageGeneration";
import { StepRow } from "./StepRow";
import { MediaLightbox } from "../motion/LazyMediaLightbox";
import Tooltip from "../primitives/Tooltip";

type IconData = ComponentProps<typeof HugeiconsIcon>["icon"];

function ImageAction({ label, icon, onClick }: { label: string; icon: IconData; onClick: () => void }) {
  return (
    <Tooltip label={label} align="end">
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className="grid size-7 place-items-center rounded-[8px] bg-surface/80 text-ink-2 shadow-[var(--shadow-hairline)] backdrop-blur-chip transition-colors hover:bg-surface hover:text-ink focus-visible:outline-2 focus-visible:outline-ink-3"
      >
        <HugeiconsIcon icon={icon} size={14} strokeWidth={1.8} color="currentColor" aria-hidden />
      </button>
    </Tooltip>
  );
}

/**
 * An image the agent generated, from its image step. Codex reports no progress between start and
 * finish, so the surface stays in "generating" until the saved file has loaded. A generation that
 * failed has no image to hold a place for, so it is a failed step row like any other. The image
 * opens full size on click, and copies or saves from its buttons or its right-click menu.
 */
export const GeneratedImage = memo(function GeneratedImage({ step }: { step: ChatStep }) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [broken, setBroken] = useState(false);
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const thumb = useRef<HTMLButtonElement>(null);
  const thumbFor = useCallback(() => thumb.current, []);
  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const scope = useScope();
  const remote = isRemoteKey(scope);
  const { sources: remoteSources, failed: remoteFailed } = useRemoteMedia(remote && step.file ? scope : null, step.file ? [step.file] : []);
  // On another Mac the image comes through media:read; copy, save and the menu then act on its bytes.
  const file = step.file ? (remote ? remoteSources[step.file] : step.file) : undefined;
  const src = file && !broken ? (remote ? file : mediaUrl(file)) : null;
  // A remote image's bytes may still be on their way; only a failed read (or a broken file) is a failed row.
  const pending = remote && !!step.file && !file && !remoteFailed[step.file];
  if (step.status === "failed" || (step.status === "done" && !src && !pending))
    return <StepRow step={step.status === "failed" ? step : { ...step, status: "failed", title: "Couldn't show the generated image" }} />;
  const status: ImageGenerationStatus = step.status === "done" && size ? "complete" : "generating";
  const canCopy = canCopyImage(file);
  const copy = () => {
    if (!file) return;
    void window.milagre
      .copyImage(file)
      .then(() => setCopied(true))
      .catch(() => {});
  };
  const save = () => {
    if (file) void window.milagre.saveImage(file).catch(() => {});
  };
  return (
    <div
      data-slot="generated-image"
      className="my-2"
      onContextMenu={
        status === "complete"
          ? (event) => {
              event.preventDefault();
              if (canCopy) void window.milagre.showImageMenu(file);
            }
          : undefined
      }
    >
      <ImageGeneration
        size="fluid"
        className="max-w-80"
        status={status}
        // The dither field already says it is working and the image says it is ready; the prompt is only its label.
        showStatus={false}
        label={step.detail ? `Generated image: ${step.detail}` : "Generated image"}
        aspectRatio={size ? `${size.width} / ${size.height}` : "1 / 1"}
        actions={
          canCopy ? (
            <>
              <ImageAction label={copied ? "Copied" : "Copy image"} icon={copied ? Tick02Icon : Copy01Icon} onClick={copy} />
              <ImageAction label="Download image" icon={Download04Icon} onClick={save} />
            </>
          ) : undefined
        }
      >
        {src ? (
          <button
            ref={thumb}
            type="button"
            aria-label="Preview generated image"
            disabled={status !== "complete"}
            onClick={() => setOpen(true)}
            className="block cursor-zoom-in focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink-3 disabled:cursor-default"
          >
            {/* Hidden while the viewer shows it, so the image morphs out of and back into its place. */}
            <img
              src={src}
              alt=""
              draggable={false}
              className={open ? "opacity-0" : undefined}
              onLoad={(event) => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
              onError={() => setBroken(true)}
            />
          </button>
        ) : null}
      </ImageGeneration>
      {open && src && (
        <MediaLightbox
          items={[{ id: step.id, name: (step.file ?? "").split("/").at(-1) || "Generated image", src, kind: "image", file: canCopy ? file : undefined }]}
          start={0}
          thumbFor={thumbFor}
          close={close}
        />
      )}
    </div>
  );
});
