const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { isLinkScopeKey, scopeFromKey } = require("@milagre/shared/chat-scopes");

const { MAX_ATTACHMENT_BYTES: MAX_MEDIA } = require("@milagre/shared/limits");
const MEDIA_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heic",
};
const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"]);
const CODES = { 400: "BAD_REQUEST", 403: "NOT_SERVED", 404: "NOT_FOUND", 413: "TOO_LARGE", 415: "NOT_AN_IMAGE" };
const inside = (root, target) => target === root || target.startsWith(root + path.sep);
const PHONE_REFUSAL = "This file is not available to the mobile app";
const failure = (status, message) => Object.assign(new Error(message), { status, code: CODES[status] });
const validScope = (owner) => typeof owner === "string" && (isLinkScopeKey(owner) || path.isAbsolute(owner));
const realOrNull = async (file) => {
  try {
    return await fs.realpath(file);
  } catch {
    return null;
  }
};
// Decide by content too, so a renamed non-image never leaves the Mac as an image.
function sniffsAs(type, head) {
  if (type === "image/png") return head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (type === "image/jpeg") return head[0] === 255 && head[1] === 216 && head[2] === 255;
  if (type === "image/gif") return /^GIF8[79]a$/.test(head.subarray(0, 6).toString("latin1"));
  if (type === "image/webp") return head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP";
  return head.subarray(4, 8).toString("latin1") === "ftyp" && HEIC_BRANDS.has(head.subarray(8, 12).toString("latin1"));
}

/** A scope's Worktree folders, through any daemon call (`call(method, args)`): a Project's, or a Link's members'. Unknown scopes give none. */
const scopeRootsVia =
  ({ dataDir, call }) =>
  async (scope) => {
    try {
      if (!isLinkScopeKey(scope)) return await call("project:worktree-paths", [scope]);
      const link = await call("link:snapshot", [scopeFromKey(scope).linkId]);
      return [
        path.join(dataDir, "links", link.link.id, ".milagre", "images"),
        ...Object.values(link.state.sessions).flatMap((chat) => [chat.workspacePath, ...chat.worktrees.map((member) => member.worktreePath)]),
      ];
    } catch {
      return [];
    }
  };

/**
 * An image a scope's chat shows, opened for reading, under the rules the phone's /media always had (moved here from
 * mobile-bridge.cjs so the phone and a paired desktop are served the same files): the scope's Worktrees, its persisted
 * attachments (<Project>/.milagre/images), files uploaded from the phone, the folders agents save generated images in,
 * or an image an assistant reply shared (`chatImage`, project:chat-image). Checked after realpath, so a symlink can't
 * lead out, by extension and by content; at most MAX_MEDIA. `check(scope, requested)` runs first (the phone's
 * confinement). The caller closes the returned handle.
 */
async function openMedia({ scope, requested }, { dataDir, scopeRoots, chatImage, check }) {
  if (!validScope(scope) || typeof requested !== "string" || !path.isAbsolute(requested))
    throw failure(400, "Choose a valid Project or Link and absolute image path");
  await check?.(scope, requested);
  const type = MEDIA_TYPES[path.extname(requested).toLowerCase()];
  if (!type) throw failure(415, "Only png, jpeg, gif, webp and heic images are served");
  // Only the worktree folders: a big Project's whole state would be read in pages for every image.
  const worktreePaths = await scopeRoots(scope);
  const candidates = [
    ...(Array.isArray(worktreePaths) ? worktreePaths : []),
    ...(isLinkScopeKey(scope) ? [] : [path.join(scope, ".milagre", "images")]),
    path.join(dataDir, "mobile-attachments"),
    path.join(os.tmpdir(), "milagre-generated-images"),
    path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "generated_images"),
  ].filter((candidate) => typeof candidate === "string" && path.isAbsolute(candidate));
  const roots = (await Promise.all(candidates.map(realOrNull))).filter(Boolean);
  let real = await realOrNull(requested);
  if (!real || !roots.some((root) => inside(root, real))) {
    // A screenshot in /tmp must be explicitly shared in this scope's assistant reply.
    // The runtime validates that reference and returns a durable Project attachment, never arbitrary bytes.
    const stored = await Promise.resolve(chatImage(scope, requested)).catch(() => null);
    if (stored) real = await realOrNull(stored);
  }
  if (!real) {
    // Missing files are only reported as missing inside an allowed folder, so paths elsewhere are not probed.
    const lexical = path.resolve(requested);
    throw roots.some((root) => inside(root, lexical)) || candidates.some((root) => inside(path.resolve(root), lexical))
      ? failure(404, "Image not found")
      : failure(403, PHONE_REFUSAL);
  }
  if (!roots.some((root) => inside(root, real))) throw failure(403, PHONE_REFUSAL);
  if (MEDIA_TYPES[path.extname(real).toLowerCase()] !== type) throw failure(415, "Only png, jpeg, gif, webp and heic images are served");
  const handle = await fs.open(real, "r").catch((error) => {
    throw failure(error.code === "ENOENT" ? 404 : 403, error.code === "ENOENT" ? "Image not found" : PHONE_REFUSAL);
  });
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw failure(403, PHONE_REFUSAL);
    if (info.size > MAX_MEDIA) throw failure(413, "Images must be 50 MiB or smaller");
    const head = Buffer.alloc(12);
    const { bytesRead } = await handle.read(head, 0, 12, 0);
    if (!sniffsAs(type, head.subarray(0, bytesRead))) throw failure(415, "The file is not a supported image");
    return { handle, type, size: info.size };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

/** media:read for a paired desktop: the same image, whole, as base64 (a large one travels in result pages). */
async function readMedia(request, options) {
  const { handle, type, size } = await openMedia({ scope: request?.scope, requested: request?.path }, options).catch((error) => {
    // The phone's wording names the mobile app; a desktop is told the same refusal without it.
    if (error?.message === PHONE_REFUSAL) error.message = "This file is not available";
    throw error;
  });
  try {
    const bytes = Buffer.alloc(size);
    let read = 0;
    // A read can return fewer bytes than asked; a file that shrank since stat ends early rather than padding zeros.
    while (read < size) {
      const { bytesRead } = await handle.read(bytes, read, size - read, read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    return { type, size: read, base64: bytes.subarray(0, read).toString("base64") };
  } finally {
    await handle.close().catch(() => {});
  }
}

module.exports = { MAX_MEDIA, MEDIA_TYPES, openMedia, readMedia, scopeRootsVia, sniffsAs };
