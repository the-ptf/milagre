const fs = require("node:fs/promises");
const { realpathSync } = require("node:fs");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const { MAX_ATTACHMENT_BYTES: MAX_BYTES } = require("@milagre/shared/limits");
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const failure = (status, message) => Object.assign(new Error(message), { status });
const filename = (name) =>
  path
    .basename(name.replaceAll("\\", "/"))
    // oxlint-disable-next-line no-control-regex -- names must not contain control characters
    .replace(/[\x00-\x1f\x7f]/g, "_")
    .slice(0, 180);

/** The runtime owns uploads, claims and expiration in one queue. Legacy uploads are never enrolled. */
function createMobileUploads({ dataDir, now = Date.now }) {
  const root = path.join(realpathSync(dataDir), "mobile-attachments", "managed");
  const index = path.join(dataDir, "mobile-uploads.json");
  let queue = Promise.resolve();
  const serial = (work) => {
    const turn = queue.then(work);
    queue = turn.catch(() => {});
    return turn;
  };
  const destination = (entry) => path.join(root, entry.id, entry.name);
  const valid = (entry) =>
    entry &&
    UUID.test(entry.id) &&
    typeof entry.name === "string" &&
    filename(entry.name) === entry.name &&
    entry.name !== "." &&
    entry.name !== ".." &&
    entry.name.length > 0 &&
    typeof entry.projectPath === "string" &&
    /^[a-f0-9]{64}$/.test(entry.digest) &&
    Number.isSafeInteger(entry.size) &&
    entry.size > 0 &&
    entry.size <= MAX_BYTES &&
    Number.isFinite(entry.usedAt) &&
    typeof entry.claimed === "boolean";
  async function read() {
    try {
      const entries = JSON.parse(await fs.readFile(index, "utf8"));
      if (!Array.isArray(entries) || !entries.every(valid) || new Set(entries.map((entry) => entry.id)).size !== entries.length)
        throw new Error("Invalid upload records");
      return entries;
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw new Error("Saved attachment uploads could not be read. No files were removed.", { cause: error });
    }
  }
  async function write(entries) {
    const temporary = `${index}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(entries), { mode: 0o600, flag: "wx" });
      await fs.rename(temporary, index);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  async function directory(folder) {
    await fs.mkdir(folder, { mode: 0o700 }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    if (!(await fs.lstat(folder)).isDirectory()) throw new Error("Attachment storage must be a directory, not a symbolic link.");
  }
  // No following symlinks, including the managed root and the per-upload directory.
  async function intact(entry) {
    try {
      for (const folder of [path.dirname(root), root, path.dirname(destination(entry))]) if (!(await fs.lstat(folder)).isDirectory()) return false;
      const file = destination(entry);
      const stat = await fs.lstat(file);
      return stat.isFile() && stat.size === entry.size && digest(await fs.readFile(file)) === entry.digest;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }
  async function sweepEntries(entries) {
    const kept = [];
    for (const entry of entries) {
      if (!entry.claimed && now() - entry.usedAt >= RETENTION_MS && (await intact(entry))) {
        const folder = path.dirname(destination(entry));
        const contents = await fs.readdir(folder);
        if (contents.length === 1 && contents[0] === entry.name) {
          // Never recursively remove a directory: an unexpected file makes rmdir fail closed.
          await fs.unlink(destination(entry));
          await fs.rmdir(folder);
          continue;
        }
      }
      kept.push(entry);
    }
    return kept;
  }
  return {
    upload: (request) =>
      serial(async () => {
        const { projectPath, reuse, quota } = request;
        if (typeof projectPath !== "string" || !projectPath) throw failure(400, "Invalid attachment scope");
        const entries = await read();
        let entry;
        let bytes;
        let name;
        if (reuse !== undefined) {
          if (typeof reuse !== "string" || !UUID.test(reuse)) throw failure(400, "Invalid attachment receipt");
          entry = entries.find((item) => item.id === reuse && item.projectPath === projectPath);
          if (!entry || !(await intact(entry))) return null;
        } else {
          if (typeof request.name !== "string" || typeof request.base64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(request.base64))
            throw failure(400, "Invalid attachment");
          bytes = Buffer.from(request.base64, "base64");
          if (bytes.length > MAX_BYTES) throw failure(413, "Each file must be 50 MiB or smaller");
          if (!bytes.length || bytes.toString("base64") !== request.base64) throw failure(400, "Invalid attachment data");
          name = filename(request.name);
          if (!name || name === "." || name === "..") throw failure(400, "Choose a file with a name");
          const hash = digest(bytes);
          for (const candidate of entries)
            if (candidate.projectPath === projectPath && candidate.name === name && candidate.digest === hash && (await intact(candidate))) {
              entry = candidate;
              break;
            }
          if (!entry) {
            if (quota !== undefined) {
              if (!Number.isSafeInteger(quota) || quota < 0) throw failure(400, "Invalid attachment quota");
              const { folderBytes } = require("./upload-bytes.cjs");
              if ((await folderBytes(path.dirname(root))) + bytes.length > quota) throw failure(507, "This demo computer is full.");
            }
            entry = { id: randomUUID(), projectPath, name, digest: hash, size: bytes.length, usedAt: now(), claimed: false };
            await directory(path.dirname(root));
            await directory(root);
            await fs.mkdir(path.dirname(destination(entry)), { mode: 0o700 });
            try {
              await fs.writeFile(destination(entry), bytes, { mode: 0o600, flag: "wx" });
              entries.push(entry);
              await write(entries);
            } catch (error) {
              // This operation alone created the UUID directory. Never recursively delete unexpected contents.
              await fs.unlink(destination(entry)).catch(() => {});
              await fs.rmdir(path.dirname(destination(entry))).catch(() => {});
              throw error;
            }
            return { id: entry.id, path: destination(entry), name: entry.name };
          }
        }
        entry.usedAt = now();
        await write(entries);
        return { id: entry.id, path: destination(entry), name: entry.name };
      }),
    resolveImages: (projectPath, images = []) =>
      serial(async () => {
        if (!Array.isArray(images)) throw failure(400, "Images must be an array.");
        const entries = images.some((image) => !image.dataUrl) ? await read() : [];
        const resolved = [];
        for (const image of images) {
          if (image.dataUrl) {
            resolved.push(image);
            continue;
          }
          const entry = entries.find((item) => item.projectPath === projectPath && destination(item) === image.path);
          if (!entry || !(await intact(entry))) throw failure(400, "An uploaded image is missing or changed. Attach it again.");
          const bytes = await fs.readFile(destination(entry));
          const mime = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            ? "image/png"
            : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
              ? "image/jpeg"
              : /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())
                ? "image/gif"
                : "image/webp";
          resolved.push({ ...image, dataUrl: `data:${mime};base64,${bytes.toString("base64")}` });
        }
        return resolved;
      }),
    claim: (request) =>
      serial(async () => {
        const files = await Promise.all(
          [...(Array.isArray(request.files) ? request.files : []), ...(request.images ?? []).flatMap((image) => (image.path ? [image.path] : []))]
            .filter((file) => typeof file === "string")
            .map(async (file) => {
              if (!path.isAbsolute(file)) return file;
              return fs.realpath(file).catch((error) => {
                if (error.code === "ENOENT") return path.normalize(file);
                throw error;
              });
            }),
        );
        const texts = [request.body, request.prompt].filter((value) => typeof value === "string");
        if (![...files, ...texts].some((value) => typeof value === "string" && value.includes(root + path.sep))) return;
        const entries = await read();
        let changed = false;
        for (const entry of entries) {
          const file = destination(entry);
          if (files.includes(file) || texts.some((text) => text.includes(file))) {
            if (!(await intact(entry))) throw new Error("An uploaded attachment is missing or changed. Attach the file again.");
            if (!entry.claimed) {
              entry.claimed = true;
              changed = true;
            }
          }
        }
        for (const file of files)
          if (typeof file === "string" && file.startsWith(root + path.sep) && !entries.some((entry) => destination(entry) === file))
            throw new Error("An uploaded attachment is no longer available. Attach the file again.");
        if (changed) await write(entries);
      }),
    sweep: () =>
      serial(async () => {
        const entries = await read();
        const kept = await sweepEntries(entries);
        if (kept.length !== entries.length) await write(kept);
      }),
  };
}
module.exports = { createMobileUploads, RETENTION_MS };
