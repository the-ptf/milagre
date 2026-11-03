const ATTACHMENT = /^https:\/\/github\.com\/(?:user-attachments\/assets|[\w.-]+\/[\w.-]+\/assets\/\d+)\/[0-9a-f-]{36}$/;
const TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  heic: "image/heic",
  heif: "image/heif",
};

/** Only GitHub uploads and repository images are read with the computer's GitHub credentials. */
export function githubImageSource(source) {
  if (typeof source !== "string") return null;
  if (ATTACHMENT.test(source)) return { kind: "attachment", url: source };
  // Match the original path before URL parsing can normalize away traversal segments.
  const match = /^https:\/\/(github\.com|raw\.githubusercontent\.com)\/([^?#]+)(?:\?raw=true)?$/.exec(source);
  if (!match) return null;
  try {
    const parts = match[2].split("/").map(decodeURIComponent);
    if (parts.some((part) => !part || part === "." || part === ".." || /[\\/]/.test(part) || [...part].some((char) => char < " " || char === "\x7f")))
      return null;
    const [owner, repo] = parts.splice(0, 2);
    if (!/^[\w.-]+$/.test(owner ?? "") || !/^[\w.-]+$/.test(repo ?? "")) return null;
    if (match[1] === "github.com" && !["blob", "raw"].includes(parts.shift())) return null;
    const ref = parts.shift();
    const extension = parts.at(-1)?.split(".").at(-1)?.toLowerCase();
    const mime = Object.hasOwn(TYPES, extension) ? TYPES[extension] : null;
    if (!ref || !parts.length || !mime) return null;
    const path = parts.map(encodeURIComponent).join("/");
    return { kind: "repository", url: `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`, mime };
  } catch {
    return null;
  }
}
