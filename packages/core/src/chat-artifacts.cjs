const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { z } = require("zod");
const { designDocumentSchema, designOperationSchema, validateDesignDocument, applyDesignOperations, designHtml, designSvg } = require("@milagre/shared/design");

// Each artifact keeps immutable versions, so a reply's card shows the design as it was then while the docked
// viewer follows the latest. JSON is the only authoring format; HTML is a generated internal preview.
const MAX_VERSIONS = 50;
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
// The comments the user sent on a Chat's designs, one file beside the designs; no .json extension, so the design list
// never reads it as a design. Each: { id, design: { id, version, title }, nodeId?, x?, y?, text, createdAt, resolved? }.
const COMMENTS = "comments";
const MAX_COMMENTS = 2000;
const COMMENT_ID = /^[a-f0-9]{8}$/;
const LAYER_ID = /^[a-zA-Z][a-zA-Z0-9_.-]{0,95}$/;
const RETIRED = "This saved design uses the retired HTML format. Create a new structured design with a different id.";

function checkId(id) {
  if (typeof id !== "string" || !ID.test(id) || id === COMMENTS) throw Error("Artifact ids are lowercase letters, digits and dashes.");
  return id;
}
const summary = (artifact, entry) => ({
  id: artifact.id,
  title: entry.title,
  version: entry.version,
  versions: artifact.versions.filter((item) => item.format === "design").length,
  width: entry.width,
  height: entry.height,
  format: "design",
});

function checkVersion(request, existing, required = false) {
  const actual = existing?.versions.at(-1)?.version ?? 0;
  if (request.expectedVersion === undefined) {
    if (required && actual) throw Error(`Read this design before revising it, then send expectedVersion ${actual}.`);
    return;
  }
  if (!Number.isSafeInteger(request.expectedVersion) || request.expectedVersion < 0) throw Error("expectedVersion must be a non-negative integer.");
  if (request.expectedVersion !== actual) {
    const error = Error(
      `Design version conflict: expected version ${request.expectedVersion}, but the latest is ${actual}. Read the design again before applying your changes.`,
    );
    error.code = "DESIGN_VERSION_CONFLICT";
    throw error;
  }
}

const readVersionFile = (file) =>
  fs.readFile(file, "utf8").catch((error) => {
    if (error.code === "ENOENT") throw Error("This design is no longer available.");
    throw error;
  });

function createChatArtifacts({ directory, validateChat, settingsFile = path.join(directory, ".designs-enabled.json") }) {
  const settings = require("./design-settings.cjs").createDesignSettings(settingsFile);
  let queue = Promise.resolve();
  const serial = (fn) => {
    const result = queue.then(fn);
    queue = result.catch(() => {});
    return result;
  };
  const chatDirectory = (chatId) => path.join(directory, createHash("sha256").update(chatId).digest("hex").slice(0, 32));
  async function chat(chatId) {
    if (!settings.enabled()) throw Error("Designs are off in Settings > Experimental. Turn Designs on before using design tools.");
    if (typeof chatId !== "string" || !chatId || chatId.length > 8192) throw Error("An existing Chat is required.");
    await validateChat(chatId);
    return chatDirectory(chatId);
  }
  const designFolder = (folder, id) => path.join(folder, checkId(id));
  const htmlFile = (folder, id, version) => path.join(designFolder(folder, id), `v${version}.html`);
  const documentFile = (folder, id, version) => path.join(designFolder(folder, id), `v${version}.design.json`);
  async function atomicWrite(file, content, assertActive) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, content, { mode: 0o600 });
      await assertActive?.();
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  // Metadata excludes the document and preview, so listing a Chat's designs stays cheap.
  async function writeMeta(folder, meta, assertActive) {
    await fs.mkdir(designFolder(folder, meta.id), { recursive: true, mode: 0o700 });
    await atomicWrite(path.join(designFolder(folder, meta.id), "meta.json"), JSON.stringify(meta), assertActive);
  }
  async function load(folder, id) {
    const file = path.join(designFolder(folder, id), "meta.json");
    try {
      return JSON.parse(await fs.readFile(file, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    // Recognize the original single-file format without reading, migrating or modifying its contents.
    const legacy = await fs.stat(path.join(folder, `${id}.json`)).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    return legacy ? { id, versions: [], retired: true } : null;
  }
  function editable(artifact) {
    if (artifact && artifact.versions.at(-1)?.format !== "design") throw Error(RETIRED);
  }
  async function writeVersion(folder, id, previous, entry, html, document, assertActive) {
    const artifact = { id, versions: [...previous, entry].slice(-MAX_VERSIONS) };
    const files = [htmlFile(folder, id, entry.version), documentFile(folder, id, entry.version)];
    await fs.mkdir(designFolder(folder, id), { recursive: true, mode: 0o700 });
    try {
      await atomicWrite(files[0], html);
      await atomicWrite(files[1], JSON.stringify(document));
      // Publishing metadata is the commit: readers cannot observe a partial document/preview pair.
      await writeMeta(folder, artifact, assertActive);
    } catch (error) {
      await Promise.all(files.map((file) => fs.rm(file, { force: true }).catch(() => {})));
      throw error;
    }
    const kept = new Set(artifact.versions.map((item) => item.version));
    const expired = [];
    for (const item of previous) {
      if (kept.has(item.version) || item.format !== "design") continue;
      expired.push(htmlFile(folder, id, item.version));
      expired.push(documentFile(folder, id, item.version));
    }
    await Promise.all(expired.map((file) => fs.rm(file, { force: true }).catch(() => {})));
    return artifact;
  }
  async function readVersion(folder, artifact, version) {
    editable(artifact);
    const entry = version === undefined ? artifact.versions.at(-1) : artifact.versions.find((item) => item.version === version);
    if (!entry) throw Error(`Version ${version} of this design is no longer kept.`);
    if (entry.format !== "design") throw Error(RETIRED);
    const html = await readVersionFile(htmlFile(folder, artifact.id, entry.version));
    const document = JSON.parse(await readVersionFile(documentFile(folder, artifact.id, entry.version)));
    return { ...summary(artifact, entry), latest: artifact.versions.at(-1).version, html, document };
  }
  async function activeDesigns(folder) {
    const names = await fs.readdir(folder).catch((error) => (error.code === "ENOENT" ? [] : Promise.reject(error)));
    const ids = new Set(names.map((name) => (name.endsWith(".json") ? name.slice(0, -5) : name)).filter((name) => ID.test(name) && name !== COMMENTS));
    const entries = await Promise.all([...ids].map((id) => load(folder, id)));
    return entries.filter((entry) => entry?.versions.at(-1)?.format === "design").toSorted((a, b) => a.versions[0].createdAt - b.versions[0].createdAt);
  }
  return {
    enabled: settings.enabled,
    // This shares the artifact queue: OFF cannot race an accepted revision or comment write.
    setEnabled: (value) => serial(() => settings.save(value)),
    // Capture every latest version under one store lock. No private Chat or comment fields leave the store.
    pageSnapshot: (request) =>
      serial(async () => {
        const folder = await chat(request?.chatId);
        const entries = await activeDesigns(folder);
        if (!entries.length || entries.length > 20) throw Error("A shared page must contain between 1 and 20 designs.");
        const designs = [];
        let size = 0;
        for (const entry of entries) {
          const latest = entry.versions.at(-1);
          const source = await readVersionFile(documentFile(folder, entry.id, latest.version));
          size += Buffer.byteLength(source);
          if (size > 8 * 1024 * 1024) throw Error("This Designs page exceeds the 8 MB sharing limit.");
          designs.push({ title: latest.title, document: JSON.parse(source) });
        }
        return { schemaVersion: 1, title: request.title, designs };
      }),
    showDesign: (request, { assertActive } = {}) =>
      serial(async () => {
        await assertActive?.();
        const folder = await chat(request?.chatId);
        if (typeof request?.title !== "string" || !request.title.trim()) throw Error("A design needs a title.");
        const id = request.id ?? randomUUID().slice(0, 8);
        const existing = request.id ? await load(folder, id) : null;
        editable(existing);
        checkVersion(request, existing, true);
        const document = validateDesignDocument(request.document);
        const previous = existing?.versions ?? [];
        const entry = {
          version: (previous.at(-1)?.version ?? 0) + 1,
          title: request.title.trim().slice(0, 120),
          width: document.width,
          height: document.height,
          format: "design",
          createdAt: Date.now(),
        };
        const artifact = await writeVersion(folder, id, previous, entry, designHtml(document), document, assertActive);
        return summary(artifact, entry);
      }),
    apply: (request, { assertActive } = {}) =>
      serial(async () => {
        await assertActive?.();
        const folder = await chat(request?.chatId);
        const existing = await load(folder, request?.id);
        if (!existing) throw Error("This design is no longer available.");
        editable(existing);
        checkVersion(request, existing, true);
        const current = await readVersion(folder, existing);
        const document = applyDesignOperations(current.document, request.operations);
        const entry = {
          version: current.version + 1,
          title: current.title,
          width: document.width,
          height: document.height,
          format: "design",
          createdAt: Date.now(),
        };
        const html = designHtml(document);
        const artifact = await writeVersion(folder, existing.id, existing.versions, entry, html, document, assertActive);
        return { ...summary(artifact, entry), latest: entry.version, html, document };
      }),
    get: (request) =>
      serial(async () => {
        const folder = await chat(request?.chatId);
        const artifact = await load(folder, request?.id);
        if (!artifact) throw Error("This design is no longer available.");
        return readVersion(folder, artifact, request.version);
      }),
    exportDesign: (request) =>
      serial(async () => {
        const folder = await chat(request?.chatId);
        const artifact = await load(folder, request?.id);
        if (!artifact) throw Error("This design is no longer available.");
        const current = await readVersion(folder, artifact, request.version);
        if (request.format !== "json" && request.format !== "svg") throw Error("Choose json or svg for the design export.");
        const svg = request.format === "svg";
        return {
          id: current.id,
          version: current.version,
          filename: `${current.id}-v${current.version}.${request.format}`,
          mimeType: svg ? "image/svg+xml" : "application/json",
          content: svg ? designSvg(current.document) : JSON.stringify(current.document, null, 2),
        };
      }),
    list: (request) =>
      serial(async () => {
        const folder = await chat(request?.chatId);
        return (await activeDesigns(folder)).map((artifact) => summary(artifact, artifact.versions.at(-1)));
      }),
    /** Records the comments the user is sending, and returns them with their ids for the message to name. */
    addComments: (request) =>
      serial(async () => {
        const folder = await chat(request?.chatId);
        const incoming = Array.isArray(request?.comments) ? request.comments : [];
        if (!incoming.length || incoming.length > 50) throw Error("Send between 1 and 50 comments at once.");
        const added = incoming.map((comment) => {
          const design = comment?.design;
          if (!design || typeof design.id !== "string" || !ID.test(design.id) || !Number.isInteger(design.version)) throw Error("A comment names its design.");
          const text = typeof comment.text === "string" ? comment.text.trim().slice(0, 4000) : "";
          if (!text) throw Error("A comment needs its text.");
          if (comment.nodeId !== undefined && (typeof comment.nodeId !== "string" || !LAYER_ID.test(comment.nodeId)))
            throw Error("A comment's layer id must use letters, numbers, dots, underscores or dashes and start with a letter.");
          const at = (value) => (typeof value === "number" && value >= 0 && value <= 1 ? value : undefined);
          return {
            // The app names the comment in the message it sends first, and records it once that went; one it names
            // again (a retried send) is kept once.
            id: typeof comment.id === "string" && COMMENT_ID.test(comment.id) ? comment.id : randomUUID().replace(/-/g, "").slice(0, 8),
            design: { id: design.id, version: design.version, title: String(design.title ?? design.id).slice(0, 120) },
            ...(comment.nodeId === undefined ? {} : { nodeId: comment.nodeId }),
            ...(at(comment.x) === undefined || at(comment.y) === undefined ? {} : { x: at(comment.x), y: at(comment.y) }),
            text,
            createdAt: Date.now(),
          };
        });
        for (const comment of added) await commentDesign(folder, comment, { retained: true });
        const kept = await readComments(folder);
        const seen = new Set(kept.map((comment) => comment.id));
        const fresh = added.filter((comment) => {
          if (seen.has(comment.id)) return false;
          seen.add(comment.id);
          return true;
        });
        await writeComments(folder, [...kept, ...fresh].slice(-MAX_COMMENTS));
        return added;
      }),
    comments: (request) =>
      serial(async () => {
        const folder = await chat(request?.chatId);
        const comments = await readComments(folder);
        const visible = await Promise.all(
          comments.map((comment) =>
            commentDesign(folder, comment).then(
              () => true,
              () => false,
            ),
          ),
        );
        return comments.filter((_comment, index) => visible[index]);
      }),
    /** Marks a comment resolved, with the agent's note on what it did about it. */
    resolveComment: (request, { assertActive } = {}) =>
      serial(async () => {
        await assertActive?.();
        const folder = await chat(request?.chatId);
        const note = typeof request?.note === "string" ? request.note.trim().slice(0, 2000) : "";
        if (!note) throw Error("Say how the comment was resolved.");
        const all = await readComments(folder);
        const comment = all.find((item) => item.id === request?.id);
        if (!comment) throw Error(`No comment ${request?.id} in this Chat. List them with artifact_comments.`);
        await commentDesign(folder, comment);
        comment.resolved = { note, at: Date.now() };
        await writeComments(folder, all, assertActive);
        return comment;
      }),
    /** Deletes every design and comment of a Chat that is gone. */
    removeChat: (chatId) =>
      serial(async () => {
        if (typeof chatId !== "string" || !chatId || chatId.length > 8192) return;
        await fs.rm(chatDirectory(chatId), { recursive: true, force: true });
      }),
    close: () => queue,
  };
  async function commentDesign(folder, comment, { retained = false } = {}) {
    const artifact = await load(folder, comment.design.id);
    if (!artifact) throw Error("This comment's design is no longer available.");
    editable(artifact);
    if (!Number.isSafeInteger(comment.design.version) || comment.design.version < 1 || comment.design.version > artifact.versions.at(-1).version)
      throw Error("This comment's design version is not available.");
    const version = artifact.versions.find((item) => item.version === comment.design.version);
    if (!version && (retained || comment.design.version >= artifact.versions[0].version)) throw Error("This comment's design version is no longer kept.");
    if (version && version.format !== "design") throw Error(RETIRED);
  }
  async function readComments(folder) {
    try {
      const saved = JSON.parse(await fs.readFile(path.join(folder, COMMENTS), "utf8"));
      return Array.isArray(saved) ? saved : [];
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }
  async function writeComments(folder, comments, assertActive) {
    await fs.mkdir(folder, { recursive: true, mode: 0o700 });
    const file = path.join(folder, COMMENTS);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(comments), { mode: 0o600 });
      await assertActive?.();
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
}

function artifactToolDefinitions(chatId, api, authorization) {
  if (!api.enabled()) return [];
  return [
    {
      name: "design_show",
      description:
        "Create an editable design in this Chat from a document of named layers, with frames, text, shapes, images, layout and color tokens. The user can edit layers on desktop. On phone they review and choose designs, and request changes through Chat. The document sets the screen size (390 by 844 for a phone). Read the bundled design skill for the document format. A new id creates a design; revising an existing id requires expectedVersion from design_read, so the user's changes are preserved. Prefer design_apply for small revisions. Use a different id for each variant. When the user names another design tool, use that tool instead.",
      input: {
        title: z.string().min(1).max(120),
        document: designDocumentSchema,
        id: z.string().regex(ID).optional(),
        expectedVersion: z.number().int().nonnegative().optional(),
      },
      readOnly: false,
      run: async (args) => JSON.stringify(await api.showDesign({ chatId, ...args }, authorization)),
    },
    {
      name: "design_read",
      description:
        "Read a structured design document and its layer ids, with the latest version unless you name one. Read before editing and send its version as expectedVersion to design_apply or design_show. User edits also create versions.",
      input: { id: z.string().regex(ID), version: z.number().int().positive().optional() },
      readOnly: true,
      run: async (args) => {
        const { html: _html, ...design } = await api.get({ chatId, ...args });
        return JSON.stringify(design);
      },
    },
    {
      name: "design_apply",
      description:
        "Edit an existing design with one atomic batch of layer operations: update properties, insert a layer, delete a layer and its descendants, or replace the document. Use stable layer ids. expectedVersion must match the latest version read; a conflict changes nothing, so read again and reapply the intended edits. One successful batch creates one immutable version and shows its design card.",
      input: {
        id: z.string().regex(ID),
        expectedVersion: z.number().int().positive(),
        operations: z.array(designOperationSchema).min(1).max(1000),
      },
      readOnly: false,
      run: async (args) => {
        const { html: _html, document: _document, ...design } = await api.apply({ chatId, ...args }, authorization);
        return JSON.stringify(design);
      },
    },
    {
      name: "design_export",
      description:
        "Export an editable design version as its source JSON document or a standalone SVG. Returns the filename, MIME type and file content. Save the content to a file when the user requests a downloadable export.",
      input: { id: z.string().regex(ID), version: z.number().int().positive().optional(), format: z.enum(["json", "svg"]) },
      readOnly: true,
      run: async (args) => JSON.stringify(await api.exportDesign({ chatId, ...args })),
    },
    {
      name: "artifact_comments",
      description:
        "List the comments the user left on this Chat's designs, the open ones unless you ask for all. Each has an id, its original design version, optional nodeId identifying its layer, where on it the user pinned it (x and y as fractions of the design's screen) and its text. Comments remain available after their old preview is pruned. Read the latest design before editing the named layer; the pin coordinates describe the original version, not the current layout.",
      input: { all: z.boolean().optional() },
      readOnly: true,
      run: async ({ all }) => JSON.stringify((await api.comments({ chatId })).filter((comment) => all || !comment.resolved)),
    },
    {
      name: "artifact_resolve_comment",
      description:
        "Mark one of the user's comments on a design resolved once you have addressed it (usually after showing a revised version), with a short note on what you changed. The user sees the comment resolved, with your note, in the chat and on the canvas. The comment's id is in the user's message, or from artifact_comments.",
      input: { id: z.string().regex(COMMENT_ID), note: z.string().min(1).max(2000) },
      readOnly: false,
      run: async (args) => JSON.stringify(await api.resolveComment({ chatId, ...args }, authorization)),
    },
  ];
}

module.exports = { createChatArtifacts, artifactToolDefinitions };
