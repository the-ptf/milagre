import { designSvg, type DesignDocument } from "@milagre/shared/design";
import { designPreviewDocument } from "@milagre/shared/design-preview";

const LIVE_AT = 0.25;
const IMAGE_BELOW = 0.22;
const MAX_ENCODINGS = 12;
// RGBA backing storage across conversions: at most 16 MiB, including large documents and high-DPI displays.
const MAX_CANVAS_PIXELS = 4 * 1024 * 1024;
const SYNC_ENCODE_PIXELS = 256 * 256;

/** Rasterize only the renderer's small preview. SVG exports and live frames keep their original size and fonts. */
function previewDimensions(document: DesignDocument, pixelRatio: number, previewScale: number) {
  // Invalid legacy documents must reach the renderer error path rather than stall pixel admission with NaN.
  if (!Number.isFinite(document.width) || !Number.isFinite(document.height) || document.width <= 0 || document.height <= 0) return { width: 1, height: 1 };
  const factor = Math.min(previewScale * pixelRatio, 1024 / Math.max(document.width, document.height));
  return { width: Math.max(1, Math.ceil(document.width * factor)), height: Math.max(1, Math.ceil(document.height * factor)) };
}
export function canvasPreviewSource(document: DesignDocument, pixelRatio: number, previewScale: number) {
  const { width, height } = previewDimensions(document, pixelRatio, previewScale);
  const svg = designSvg(designPreviewDocument(document), { embedFonts: false }).replace(
    `width="${document.width}" height="${document.height}"`,
    `width="${width}" height="${height}"`,
  );
  // Integer bitmap edges may round the aspect ratio; stretching only this intermediate SVG prevents letterboxing.
  return { svg: svg.replace("<svg ", '<svg preserveAspectRatio="none" '), width, height };
}
async function rasterPreview(document: DesignDocument, pixelRatio: number, releaseSlot: () => void, previewScale: number, releasePixels: () => void) {
  const { svg, width, height } = canvasPreviewSource(document, pixelRatio, previewScale);
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  const image = new Image();
  const listeners = new AbortController();
  const readerListeners = new AbortController();
  const canvas = window.document.createElement("canvas");
  try {
    await new Promise<void>((resolve, reject) => {
      image.addEventListener("load", () => resolve(), { once: true, signal: listeners.signal });
      image.addEventListener("error", () => reject(Error("The design preview could not load.")), { once: true, signal: listeners.signal });
      image.src = url;
    });
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw Error("The design preview could not draw.");
    context.drawImage(image, 0, 0, width, height);
    listeners.abort();
    image.src = "";
    URL.revokeObjectURL(url);
    releaseSlot();
    // Tiny Fit previews encode quickly. Async canvas encoding waits for document idle during the dock animation.
    if (width * height <= SYNC_ENCODE_PIXELS) {
      const src = canvas.toDataURL("image/png");
      if (!src.startsWith("data:image/png")) throw Error("The design preview could not encode.");
      canvas.width = canvas.height = 0;
      releasePixels();
      return src;
    }
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((value) => (value ? resolve(value) : reject(Error("The design preview could not encode."))), "image/png"),
    );
    canvas.width = canvas.height = 0;
    releasePixels();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => resolve(String(reader.result)), { once: true, signal: readerListeners.signal });
      reader.addEventListener("error", () => reject(Error("The design preview could not be read.")), { once: true, signal: readerListeners.signal });
      reader.readAsDataURL(blob);
    });
  } finally {
    readerListeners.abort();
    listeners.abort();
    image.src = "";
    URL.revokeObjectURL(url);
    canvas.width = canvas.height = 0;
  }
}

type Result = { src: string } | { error: true };
type Consumer = (result: Result) => void;
type Job = {
  document: DesignDocument;
  pixelRatio: number;
  consumers: Set<Consumer>;
  retain: () => boolean;
  started: boolean;
  occupies: boolean;
  previewScale: number;
  versionKey: string;
  pixelCost: number;
  pixelsHeld: boolean;
};

/** Shared queue: at most two temporary SVGs, with 8 ms cooperative slices for starting whole-design builds. */
export function createDesignPreviewCache(
  limit = 48,
  render: (
    document: DesignDocument,
    pixelRatio: number,
    releaseSlot: () => void,
    previewScale: number,
    releasePixels: () => void,
  ) => string | Promise<string> = rasterPreview,
  schedule = (run: () => void) => setTimeout(run, 0),
  now = () => performance.now(),
) {
  const values = new Map<string, Result>();
  const versions = new Map<string, Set<string>>();
  const jobs = new Map<string, Job>();
  let scheduled = false;
  let active = 0;
  let inflight = 0;
  let pixels = 0;
  function enqueue() {
    if (scheduled || active >= 2 || inflight >= MAX_ENCODINGS || ![...jobs.values()].some((job) => !job.started && pixels + job.pixelCost <= MAX_CANVAS_PIXELS))
      return;
    scheduled = true;
    schedule(drain);
  }
  function finish(key: string, job: Job, result: Result) {
    inflight--;
    releaseSlot(job);
    releasePixels(job);
    if (jobs.get(key) === job) {
      jobs.delete(key);
      if (job.consumers.size) {
        if (job.retain()) {
          values.set(key, result);
          let variants = versions.get(job.versionKey);
          if (!variants) {
            variants = new Set();
            versions.set(job.versionKey, variants);
          }
          variants.add(key);
          // Three zoom buckets on each of the two most recent display densities, bounded per immutable version.
          while (variants.size > 6) {
            const old = variants.values().next().value!;
            variants.delete(old);
            values.delete(old);
          }
          while (versions.size > limit) {
            const old = versions.keys().next().value!;
            for (const variant of versions.get(old)!) values.delete(variant);
            versions.delete(old);
          }
        }
        for (const consumer of job.consumers) consumer(result);
      }
    }
    enqueue();
  }
  function releaseSlot(job: Job) {
    if (job.occupies) {
      job.occupies = false;
      active--;
    }
    enqueue();
  }
  function releasePixels(job: Job) {
    if (job.pixelsHeld) {
      job.pixelsHeld = false;
      pixels -= job.pixelCost;
    }
    enqueue();
  }
  function drain() {
    scheduled = false;
    const start = now();
    for (const [key, job] of jobs) {
      if (active >= 2 || inflight >= MAX_ENCODINGS) break;
      if (job.started || pixels + job.pixelCost > MAX_CANVAS_PIXELS) continue;
      job.started = true;
      job.occupies = true;
      job.pixelsHeld = true;
      pixels += job.pixelCost;
      active++;
      inflight++;
      try {
        const result = render(
          job.document,
          job.pixelRatio,
          () => releaseSlot(job),
          job.previewScale,
          () => releasePixels(job),
        );
        if (typeof result === "string") finish(key, job, { src: result });
        else
          void result.then(
            (src) => finish(key, job, { src }),
            () => finish(key, job, { error: true }),
          );
      } catch {
        finish(key, job, { error: true });
      }
      if (active >= 2 || now() - start >= 8) break;
    }
    enqueue();
  }
  return {
    get: (key: string) => values.get(key),
    delete(key: string) {
      // All zoom/density variants leave with their artifact version.
      for (const version of versions.keys()) if (version === key || version.startsWith(key + "\n")) versions.delete(version);
      for (const stored of values.keys()) if (stored === key || stored.startsWith(key + "\n")) values.delete(stored);
      for (const [stored, job] of jobs) if (stored === key || stored.startsWith(key + "\n")) job.retain = () => false;
    },
    request(key: string, document: DesignDocument, consumer: Consumer, retain = () => true, pixelRatio = 1, previewScale = LIVE_AT, versionKey = key) {
      const cached = values.get(key);
      if (cached) {
        consumer(cached);
        return () => {};
      }
      let job = jobs.get(key);
      if (!job) {
        const size = previewDimensions(document, pixelRatio, previewScale);
        job = {
          document,
          pixelRatio,
          consumers: new Set(),
          retain,
          started: false,
          occupies: false,
          previewScale,
          versionKey,
          pixelCost: size.width * size.height,
          pixelsHeld: false,
        };
        jobs.set(key, job);
      }
      job.consumers.add(consumer);
      enqueue();
      const pending = job;
      return () => {
        pending.consumers.delete(consumer);
        if (!pending.consumers.size && jobs.get(key) === pending) jobs.delete(key);
      };
    },
  };
}

export const designPreviews = createDesignPreviewCache();
export const designPreviewKey = (chatId: string, id: string, version: number) => `${chatId}\n${id}\n${version}`;
export function designLiveZoom(previous: boolean, scale: number) {
  return scale >= LIVE_AT || (previous && scale >= IMAGE_BELOW);
}

/** Decode only as many pixels as the current preview zoom needs, with three reusable resolution buckets. */
export function designPreviewScale(scale: number) {
  return scale <= 0.0625 ? 0.0625 : scale <= 0.125 ? 0.125 : LIVE_AT;
}
