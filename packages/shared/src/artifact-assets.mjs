export const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
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

export function assetType(name) {
  const extension = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase();
  return (extension && TYPES[extension]) || "application/octet-stream";
}

export function assetInline(type) {
  return /^(?:image\/(?!svg)|video\/|audio\/|font\/|text\/(?:plain|csv|vtt)$|application\/pdf$)/.test(type);
}

const reference = (name) => new RegExp(`(?<![A-Za-z0-9._/-])(?:\\./)?assets/${name.replaceAll(".", "\\.")}(?![A-Za-z0-9._-])`, "g");

export function mentionsAsset(html, name) {
  return reference(name).test(html);
}

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
