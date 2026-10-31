// Files an Artifact page shows: photos, videos, any file. The agent attaches each by path and a name, the page's HTML
// says `assets/<name>`, and each viewer points those names at where it keeps the file: the desktop's preview
// protocol, the phone's cache, the shared page's storage. Plain JavaScript: the packaged Electron main process and
// the share Worker load it as is.

/** A file's name on the page: no folders, so `assets/<name>` is the whole reference. */
export const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** A file is stored and shared by the SHA-256 of its bytes, in hex. */
export const ASSET_HASH = /^[a-f0-9]{64}$/;
// ponytail: a file stays under Cloudflare's 100 MB request body limit, so a shared page uploads it in one request;
// multipart uploads when a page needs bigger files.
export const MAX_ASSET_BYTES = 95 * 1024 * 1024;
export const MAX_PAGE_ASSETS = 100;
export const MAX_PAGE_ASSET_BYTES = 1024 * 1024 * 1024;

const TYPES = {
  apng: "image/apng",
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
  m4v: "video/mp4",
  mov: "video/quicktime",
  mp4: "video/mp4",
  ogv: "video/ogg",
  webm: "video/webm",
  aac: "audio/aac",
  flac: "audio/flac",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  oga: "audio/ogg",
  ogg: "audio/ogg",
  wav: "audio/wav",
  otf: "font/otf",
  ttf: "font/ttf",
  woff: "font/woff",
  woff2: "font/woff2",
  csv: "text/csv",
  json: "application/json",
  md: "text/markdown",
  pdf: "application/pdf",
  txt: "text/plain",
  vtt: "text/vtt",
  zip: "application/zip",
};

/** The file's media type, from its extension; any other file is plain bytes. */
export function assetType(name) {
  const extension = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase();
  return (extension && TYPES[extension]) || "application/octet-stream";
}

/** Whether a page shows the file inline (an image, a video, audio, a font, text) or only offers it as a download. */
export function assetInline(type) {
  return /^(?:image\/(?!svg)|video\/|audio\/|font\/|text\/(?:plain|csv|vtt)$|application\/pdf$)/.test(type);
}

// `assets/<name>` or `./assets/<name>` as a whole reference: not part of a longer path or name, quoted or not, also
// inside JSON (a page split into tabs carries each tab's HTML as a JSON string).
const reference = (name) => new RegExp(`(?<![A-Za-z0-9._/-])(?:\\./)?assets/${name.replaceAll(".", "\\.")}(?![A-Za-z0-9._-])`, "g");

/** Whether the HTML refers to the file. */
export function mentionsAsset(html, name) {
  return reference(name).test(html);
}

/** The HTML with each file's `assets/<name>` pointing where `urlFor` says the viewer keeps it. */
export function rewriteAssetUrls(html, assets, urlFor) {
  return (assets ?? []).reduce((out, asset) => out.replace(reference(asset.name), () => urlFor(asset)), html);
}

/** One `bytes=` range of a file of `size` bytes, as an offset and a length; null for the whole file. */
export function byteRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? "");
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const length = Math.min(Number(match[2]), size);
    return length ? { offset: size - length, length } : "unsatisfiable";
  }
  const offset = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return offset >= size || end < offset ? "unsatisfiable" : { offset, length: end - offset + 1 };
}
