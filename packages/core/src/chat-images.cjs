const fs = require("node:fs/promises");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const { createHash } = require("node:crypto");
const MarkdownIt = require("markdown-it");
const { MAX_ATTACHMENT_BYTES, IMAGE_ERRORS } = require("@milagre/shared/limits");
const { chatInProject, sessionIdFromKey } = require("@milagre/shared/agent-runs");
const { storeImages } = require("./project-content.cjs");
const markdown = new MarkdownIt({ html: false });
const validate = markdown.validateLink.bind(markdown);
markdown.validateLink = (value) => /^file:/i.test(value) || validate(value);
const mimeTypes = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };

function localPath(source, cwd) {
  try {
    if (/^file:/i.test(source)) return fileURLToPath(source);
    if (/^[a-z][a-z\d+.-]*:/i.test(source) || source.startsWith("//")) return null;
    return path.resolve(cwd, decodeURIComponent(source));
  } catch {
    return null;
  }
}
function imagePaths(message, cwd, { includeViewed = true } = {}) {
  const paths = new Set();
  const visit = (tokens) => {
    for (const token of tokens) {
      if (token.type === "image") {
        const file = localPath(token.attrGet("src") || "", cwd);
        if (file && mimeTypes[path.extname(file).toLowerCase()]) paths.add(file);
      }
      if (token.children) visit(token.children);
    }
  };
  visit(markdown.parse(message.body || message.text || "", {}));
  for (const step of message.steps || [])
    if (step.kind === "image" && step.file && (includeViewed || step.imageOrigin !== "viewed")) {
      const file = localPath(step.file, cwd);
      if (file && mimeTypes[path.extname(file).toLowerCase()]) paths.add(file);
    }
  return paths;
}

/** Only images actually shared by an assistant may escape the normal Project image roots. */
class ChatImages {
  constructor({ states, runs, broadcast }) {
    Object.assign(this, { states, runs, broadcast });
    this.copies = new Map();
  }
  cwd(state, message, projectPath) {
    return state.sessions?.[message.session_id]?.workspacePath || state.worktrees?.[state.sessions?.[message.session_id]?.worktree_id]?.path || projectPath;
  }
  async copy(projectPath, file) {
    const key = JSON.stringify([projectPath, file]);
    const info = await fs.stat(file).catch(() => null);
    const stamp = info ? `${info.size}:${info.mtimeMs}:${info.ctimeMs}` : null;
    const cached = this.copies.get(key);
    if (cached && (!info || cached.stamp === stamp)) return cached.promise;
    const copying = (async () => {
      const handle = await fs.open(file, "r");
      let bytes;
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw new Error("Not an image file.");
        if (info.size > MAX_ATTACHMENT_BYTES) throw new Error(IMAGE_ERRORS.size);
        // Bounded even if the file grows after stat.
        const buffer = Buffer.alloc(info.size + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead !== info.size) throw new Error("Image changed while reading. Try again.");
        bytes = buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
      const mime = mimeTypes[path.extname(file).toLowerCase()];
      const id = createHash("sha256").update(bytes).digest("hex");
      return (
        await storeImages(this.states.storageDirectory?.(projectPath) ?? projectPath, [
          { id, name: path.basename(file), path: file, dataUrl: `data:${mime};base64,${bytes.toString("base64")}` },
        ])
      )[0];
    })();
    this.copies.set(key, { stamp, promise: copying });
    copying.catch(() => {
      if (this.copies.get(key)?.promise === copying) this.copies.delete(key);
    });
    // Metadata only, with bounded lifetime. Persisted messages own durable references.
    if (this.copies.size > 256) this.copies.delete(this.copies.keys().next().value);
    return copying;
  }
  async capture(projectPath, state, message) {
    if (message.role !== "assistant") return message;
    const images = [...(message.images || [])];
    const cwd = this.cwd(state, message, projectPath);
    // Keep Markdown and generated images in their original slots; snapshots have their own allowance.
    const legacy = [...imagePaths(message, cwd, { includeViewed: false })].slice(0, 16);
    const viewed = [...imagePaths({ steps: message.steps?.filter((step) => step.imageOrigin === "viewed") }, cwd)].slice(0, 16);
    for (const file of new Set([...legacy, ...viewed])) {
      if (images.some((image) => image.sourcePath === file || image.path === file)) continue;
      try {
        images.push(await this.copy(projectPath, file));
      } catch {
        /* A missing screenshot must not lose the reply. */
      }
    }
    return images.length === (message.images?.length || 0) ? message : { ...message, images };
  }
  async resolve(projectPath, requested) {
    if (!this.states.has(projectPath)) throw new Error("Open the project before reading its images.");
    if (typeof requested !== "string" || !path.isAbsolute(requested) || !mimeTypes[path.extname(requested).toLowerCase()]) return null;
    const state = await this.states.get(projectPath);
    for (const [key, run] of Object.entries(this.runs())) {
      if (!chatInProject(projectPath, key)) continue;
      const message = { ...run, session_id: sessionIdFromKey(key) };
      if (imagePaths(message, this.cwd(state, message, projectPath)).has(requested)) return (await this.copy(projectPath, requested)).path;
    }
    // An unloaded Chat's messages (see message-store.cjs) are looked at only where their saved JSON names the file.
    const name = path.basename(requested);
    const needles = [...new Set([JSON.stringify(name).slice(1, -1), encodeURIComponent(name), encodeURI(name)])];
    const messages = this.states.messagesContaining ? await this.states.messagesContaining(projectPath, needles) : state.messages;
    for (const message of messages.toReversed()) {
      if (message.role !== "assistant") continue;
      const stored = message.images?.find((image) => image.sourcePath === requested);
      if (stored?.path) return stored.path;
      if (!imagePaths(message, this.cwd(state, message, projectPath)).has(requested)) continue;
      const image = await this.copy(projectPath, requested);
      const result = await this.states.update(
        projectPath,
        (latest) => {
          const current = latest.messages.find((item) => item.id === message.id);
          if (!current || !imagePaths(current, this.cwd(latest, current, projectPath)).has(requested)) return latest;
          if (current.images?.some((item) => item.sourcePath === requested)) return latest;
          return { ...latest, messages: latest.messages.map((item) => (item !== current ? item : { ...item, images: [...(item.images || []), image] })) };
        },
        { chats: [message.session_id] },
      );
      if (result.changed) this.broadcast(projectPath, result.state);
      return image.path;
    }
    return null;
  }
}
module.exports = { ChatImages, imagePaths };
