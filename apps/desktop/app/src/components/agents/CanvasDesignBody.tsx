import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { isInteractiveDesign, type Artifact } from "@milagre/shared/artifact";
import { designDocumentForMode } from "@milagre/shared/design";
import { designHtmlForMode, type DesignMode } from "@milagre/shared/design-modes";
import { ArtifactFrame, type PageFiles } from "./ArtifactCanvas";
import { isVersionKept } from "./artifact-read";
import { designPreviews, designPreviewScale } from "./design-preview-cache";

export function CanvasDesignBody({
  artifact,
  files,
  title,
  previewKey,
  scale,
  pixelRatio,
  allowLive,
  live,
  mode = "light",
  onPainted,
}: {
  artifact: Artifact;
  /** The color mode to draw: the preview image and the saved page switch together. */
  mode?: DesignMode;
  files?: PageFiles;
  title: string;
  previewKey: string;
  scale: number;
  pixelRatio: number;
  allowLive: boolean;
  live: boolean;
  onPainted: (ready: boolean) => void;
}) {
  type Preview = { key: string; result: NonNullable<ReturnType<typeof designPreviews.get>> };
  const [preview, setPreview] = useState<Preview | null>(null);
  const [readyPreview, setReadyPreview] = useState<{ key: string; src: string } | null>(null);
  const [settledScale, setSettledScale] = useState<number | null>(null);
  const previewScale = readyPreview && settledScale !== null ? settledScale : designPreviewScale(scale);
  useEffect(() => {
    const timer = setTimeout(() => setSettledScale(designPreviewScale(scale)), 150);
    return () => clearTimeout(timer);
  }, [scale]);
  const cacheKey = `${previewKey}\n${pixelRatio}\n${previewScale}\n${mode}`;
  const [imageFailed, setImageFailed] = useState<string | null>(null);
  const [framePainted, setFramePainted] = useState(false);
  const [saved] = useState(() => (artifact.format === "design" ? artifact.document : undefined));
  const document = useMemo(() => (saved && mode !== "light" ? designDocumentForMode(saved, mode) : saved), [saved, mode]);
  const decoded = !!readyPreview;
  const useFrame = (allowLive && (live || !document || (preview && "error" in preview.result) || imageFailed === cacheKey)) || (!decoded && framePainted);
  useLayoutEffect(() => {
    if (!document) return;
    return designPreviews.request(
      cacheKey,
      document,
      (result) => setPreview({ key: cacheKey, result }),
      () => isVersionKept(previewKey),
      pixelRatio,
      previewScale,
      previewKey,
    );
  }, [cacheKey, document, previewKey, pixelRatio, previewScale]);
  const painted = useFrame ? framePainted || decoded : decoded;
  useEffect(() => {
    onPainted(painted);
  }, [painted, onPainted]);
  if (artifact.format === "html")
    return allowLive ? <ArtifactFrame html={artifact.html} title={title} format="html" files={files} onLoad={() => setFramePainted(true)} /> : null;
  return (
    <div className="relative size-full" data-painted={painted || undefined} data-slot="design-renderer">
      {readyPreview && readyPreview.key !== preview?.key && <img src={readyPreview.src} alt="" aria-hidden draggable={false} className="block size-full" />}
      {preview && "src" in preview.result && (
        <DecodedPreviewImage
          key={preview.key}
          resourceKey={preview.key}
          src={preview.result.src}
          title={title}
          hidden={framePainted}
          painted={readyPreview?.key === preview.key}
          onDecoded={setReadyPreview}
          onFailed={setImageFailed}
        />
      )}
      {useFrame && <PaintedFrame key={`${previewKey}\n${mode}`} artifact={artifact} mode={mode} title={title} onPainted={setFramePainted} />}
    </div>
  );
}

const DecodedPreviewImage = memo(function DecodedPreviewImage({
  resourceKey,
  src,
  title,
  hidden,
  painted,
  onDecoded,
  onFailed,
}: {
  resourceKey: string;
  src: string;
  title: string;
  hidden: boolean;
  painted: boolean;
  onDecoded: (value: { key: string; src: string }) => void;
  onFailed: (key: string) => void;
}) {
  const receive = useCallback(
    (image: HTMLImageElement | null) => {
      if (!image) return;
      void image.decode().then(
        () => {
          if (image.isConnected) onDecoded({ key: resourceKey, src });
          return null;
        },
        () => {
          if (image.isConnected) onFailed(resourceKey);
          return null;
        },
      );
    },
    [resourceKey, src, onDecoded, onFailed],
  );
  return (
    <img
      ref={receive}
      src={src}
      alt={title}
      aria-hidden={hidden || undefined}
      draggable={false}
      decoding="async"
      className="absolute inset-0 block size-full"
      style={{ opacity: painted ? 1 : 0 }}
      onError={(event) => {
        if (event.currentTarget.isConnected) onFailed(resourceKey);
      }}
    />
  );
});

/** Unmount on the way back to an image. Every new iframe starts hidden and fades over the decoded preview. */
function PaintedFrame({ artifact, mode, title, onPainted }: { artifact: Artifact; mode: DesignMode; title: string; onPainted: (painted: boolean) => void }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    onPainted(ready);
    return () => onPainted(false);
  }, [ready, onPainted]);
  return (
    <div
      inert={!ready}
      aria-hidden={!ready || undefined}
      className="absolute inset-0 transition-opacity duration-[120ms] motion-reduce:transition-none"
      style={{ opacity: ready ? 1 : 0 }}
    >
      <ArtifactFrame
        html={artifact.format === "design" && !isInteractiveDesign(artifact) ? designHtmlForMode(artifact.html, mode) : artifact.html}
        title={title}
        format={artifact.format}
        code={isInteractiveDesign(artifact)}
        onLoad={() => setReady(true)}
      />
    </div>
  );
}
