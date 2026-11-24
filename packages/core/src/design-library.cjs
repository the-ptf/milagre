const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { z } = require("zod");
const { createChatArtifacts } = require("./chat-artifacts.cjs");

const LIBRARY = "library:";
const BARE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const LIBRARY_REF = /^library:[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_PAGES = 50;
const MAX_DESIGNS = 200;
const MAX_EDITS = 50;
const NOT_IN_LIBRARY = "This design isn't in the Project library. List it with design_library_list.";

const isLibraryRef = (id) => typeof id === "string" && id.startsWith(LIBRARY);
function bareId(id) {
  const bare = isLibraryRef(id) ? id.slice(LIBRARY.length) : "";
  if (!BARE.test(bare)) throw Error("A Project library design is library:<id>. List them with design_library_list.");
  return bare;
}
function pageName(name) {
  const text = typeof name === "string" ? name.replace(/\s+/g, " ").trim().slice(0, 60) : "";
  if (!text) throw Error("Name the library page, such as iPhone, Watch or Kit.");
  return text;
}
const sameName = (a, b) => a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;
const slug = (text, max) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "") || "page";
const emptyIndex = () => ({ pages: [], designs: {} });

async function titled(index, chatInfo) {
  const missing = new Set(
    Object.values(index.designs).flatMap((record) => (record.edits ?? []).filter((item) => item.chatId && !item.chat).map((item) => item.chatId)),
  );
  const titles = new Map();
  for (const chatId of missing) {
    const title = (await chatInfo(chatId).catch(() => ({})))?.title;
    if (typeof title === "string" && title) titles.set(chatId, title.slice(0, 120));
  }
  if (!titles.size) return index;
  const designs = Object.fromEntries(
    Object.entries(index.designs).map(([id, record]) => [
      id,
      { ...record, edits: (record.edits ?? []).map((item) => (!item.chat && titles.has(item.chatId) ? { ...item, chat: titles.get(item.chatId) } : item)) },
    ]),
  );
  return { ...index, designs };
}

function createDesignLibrary({ directory, projectForChat, projectForPath, chatInfo = async () => ({}), artifacts, readKit, onChange }) {
  const store = createChatArtifacts({
    directory: path.join(directory, "designs"),
    validateChat: async () => {},
    ...(readKit ? { readKit: ({ chatId: project, id, version }) => readKit({ project, id, version }) } : {}),
  });
  let queue = Promise.resolve();
  const serial = (fn) => {
    const result = queue.then(fn);
    queue = result.catch(() => {});
    return result;
  };
  const indexFile = (project) => path.join(directory, "index", `${createHash("sha256").update(project).digest("hex")}.json`);
  async function readIndex(project) {
    try {
      const saved = JSON.parse(await fs.readFile(indexFile(project), "utf8"));
      if (!Array.isArray(saved?.pages) || !saved.designs || typeof saved.designs !== "object") throw Error("The Project library's index is damaged.");
      return saved;
    } catch (error) {
      if (error.code === "ENOENT") return emptyIndex();
      throw error;
    }
  }
  async function writeIndex(project, index, assertActive) {
    const used = new Set(Object.values(index.designs).map((record) => record.page));
    const kept = { pages: index.pages.filter((page) => used.has(page.id)), designs: index.designs };
    const file = indexFile(project);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(kept), { mode: 0o600 });
      await assertActive?.();
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  async function scope(request) {
    const byPath = typeof request?.projectPath === "string";
    const project = byPath ? await projectForPath?.(request.projectPath) : await projectForChat(request?.chatId);
    if (typeof project !== "string" || !project) throw Error(byPath ? "Open this project in Milagre first." : "This Chat has no Project library.");
    return { project, index: await readIndex(project) };
  }
  function placePage(index, name) {
    const wanted = pageName(name);
    const found = index.pages.find((page) => sameName(page.name, wanted));
    if (found) return found;
    if (index.pages.length >= MAX_PAGES) throw Error(`The Project library holds at most ${MAX_PAGES} pages. Move designs onto an existing page.`);
    const base = slug(wanted, 40);
    let id = base;
    for (let n = 2; index.pages.some((page) => page.id === id); n++) id = `${base}-${n}`;
    const page = { id, name: wanted };
    index.pages.push(page);
    return page;
  }
  function findPage(index, page) {
    const wanted = pageName(page);
    const found = index.pages.find((item) => item.id === wanted || sameName(item.name, wanted));
    if (!found) throw Error(`The Project library has no page "${wanted}". Its pages: ${index.pages.map((item) => item.name).join(", ") || "none yet"}.`);
    return found;
  }
  function recordOf(index, bare) {
    const record = Object.hasOwn(index.designs, bare) ? index.designs[bare] : null;
    if (!record) throw Error(NOT_IN_LIBRARY);
    return record;
  }
  async function edit(chatId, version) {
    if (typeof chatId !== "string") return { version, at: Date.now() };
    const info = await chatInfo(chatId).catch(() => ({}));
    return {
      version,
      chatId,
      ...(typeof info?.title === "string" && info.title ? { chat: info.title.slice(0, 120) } : {}),
      ...(typeof info?.agent === "string" && info.agent ? { agent: info.agent.slice(0, 60) } : {}),
      at: Date.now(),
    };
  }
  async function recordEdit(record, chatId, version) {
    record.edits = [...(record.edits ?? []), await edit(chatId, version)].slice(-MAX_EDITS);
  }
  const entryOf = (saved, record) => ({ ...saved, id: LIBRARY + saved.id, page: record.page, edits: record.edits ?? [] });
  const changed = (project) =>
    Promise.resolve()
      .then(() => onChange?.({ project }))
      .catch(() => {});
  async function save(project, index, assertActive) {
    await writeIndex(project, index, assertActive);
    changed(project);
  }

  function sourceRequest(source, tab) {
    const group = source.group ? { group: source.group } : {};
    if (source.format === "html") {
      if (source.assets?.length)
        throw Error("This page shows files (assets/…). The Project library takes pages without files for now; add the page's designs instead.");
      const chosen = source.tabs ? (tab ? source.tabs.find((item) => item.id === tab) : source.tabs[0]) : null;
      if (tab && source.tabs && !chosen) throw Error(`This page has no tab ${tab}. Its tabs: ${source.tabs.map((item) => item.id).join(", ")}.`);
      const title = source.tabs && source.tabs.length > 1 && chosen ? `${source.title} · ${chosen.title}` : source.title;
      return { title, html: chosen?.html ?? source.html, width: source.width, height: source.height };
    }
    if (source.interactive) return { title: source.title, ...group, html: source.html, width: source.width, height: source.height };
    return { title: source.title, ...group, document: source.document };
  }
  async function addCopy(project, index, request, assertActive) {
    const taken = new Set([...Object.keys(index.designs), ...(await store.list({ chatId: project, format: "design" })).map((item) => item.id)]);
    const preferred = slug(request.preferred, 56);
    const fresh = () => `${preferred}-${randomUUID().slice(0, 6)}`;
    const first = taken.has(preferred) ? fresh() : preferred;
    try {
      return await store.showDesign({ ...request.payload, chatId: project, id: first }, { assertActive });
    } catch (error) {
      if (!/was deleted/.test(error.message)) throw error;
      return store.showDesign({ ...request.payload, chatId: project, id: fresh() }, { assertActive });
    }
  }

  return {
    list: (request = {}) =>
      serial(async () => {
        const { project, index: stored } = await scope(request);
        const index = await titled(stored, chatInfo);
        const saved = new Map((await store.list({ chatId: project, format: "design" })).map((item) => [item.id, item]));
        return {
          pages: index.pages
            .map((page) => ({
              id: page.id,
              name: page.name,
              designs: Object.entries(index.designs)
                .filter(([id, record]) => record.page === page.id && saved.has(id))
                .map(([id, record]) => entryOf(saved.get(id), record)),
            }))
            .filter((page) => page.designs.length),
        };
      }),
    add: (request, { assertActive } = {}) =>
      serial(async () => {
        await assertActive?.();
        const { designId, page, tab } = request ?? {};
        if (isLibraryRef(designId)) throw Error("This design is already in the Project library.");
        const name = pageName(page);
        const { project, index } = await scope({ chatId: request?.chatId });
        if (Object.keys(index.designs).length >= MAX_DESIGNS) throw Error(`The Project library holds at most ${MAX_DESIGNS} designs.`);
        const source = await artifacts.get({ chatId: request.chatId, id: designId });
        const payload = sourceRequest(source, tab);
        const preferred = source.format === "html" && source.tabs && tab ? `${source.id}-${tab}` : source.id;
        const saved = await addCopy(project, index, { preferred, payload }, assertActive);
        const record = { page: placePage(index, name).id, edits: [], from: { chatId: request.chatId, id: source.id, version: source.version } };
        await recordEdit(record, request.chatId, saved.version);
        index.designs[saved.id] = record;
        await save(project, index, assertActive);
        return entryOf(saved, record);
      }),
    get: (request) =>
      serial(async () => {
        const { project, index } = await scope(request);
        const bare = bareId(request.id);
        const record = recordOf(index, bare);
        return entryOf(await store.get({ ...request, chatId: project, id: bare }), record);
      }),
    showDesign: (request, { assertActive } = {}) =>
      serial(async () => {
        await assertActive?.();
        const { project, index } = await scope({ chatId: request?.chatId });
        const bare = bareId(request.id);
        let from;
        if (request.from !== undefined) {
          if (!isLibraryRef(request.from?.id)) throw Error("A library design varies only another library design. Use library:<id> in from.");
          from = { ...request.from, id: bareId(request.from.id) };
        }
        const existing = Object.hasOwn(index.designs, bare) ? index.designs[bare] : null;
        if (!existing && !from)
          throw Error("Add a design to the Project library with design_library_add; design_show revises a library design or makes a variant of one (from).");
        const record = existing ?? { page: recordOf(index, from.id).page, edits: [], from: { library: from.id } };
        if (!existing && Object.keys(index.designs).length >= MAX_DESIGNS) throw Error(`The Project library holds at most ${MAX_DESIGNS} designs.`);
        const saved = await store.showDesign({ ...request, chatId: project, id: bare, ...(from ? { from } : {}) }, { assertActive });
        await recordEdit(record, request.chatId, saved.version);
        index.designs[bare] = record;
        await save(project, index, assertActive);
        return entryOf(saved, record);
      }),
    apply: (request, { assertActive } = {}) =>
      serial(async () => {
        await assertActive?.();
        const { project, index } = await scope({ chatId: request?.chatId });
        const bare = bareId(request.id);
        const record = recordOf(index, bare);
        const saved = await store.apply({ ...request, chatId: project, id: bare }, { assertActive });
        await recordEdit(record, request.chatId, saved.version);
        await save(project, index, assertActive);
        return entryOf(saved, record);
      }),
    exportDesign: (request) =>
      serial(async () => {
        const { project, index } = await scope(request);
        const bare = bareId(request.id);
        recordOf(index, bare);
        return { ...(await store.exportDesign({ ...request, chatId: project, id: bare })), id: LIBRARY + bare };
      }),
    remove: (request, { assertActive } = {}) =>
      serial(async () => {
        await assertActive?.();
        const { project, index } = await scope(request);
        const bare = bareId(request.id);
        recordOf(index, bare);
        await store.deleteDesign({ chatId: project, id: bare }, { assertActive });
        delete index.designs[bare];
        await save(project, index, assertActive);
        return { id: LIBRARY + bare };
      }),
    update: (request, { assertActive } = {}) =>
      serial(async () => {
        await assertActive?.();
        const { project, index } = await scope(request);
        const bare = bareId(request.id);
        const record = recordOf(index, bare);
        if (request.title === undefined && request.page === undefined) throw Error("Send a new title, a page, or both.");
        let saved = await store.get({ chatId: project, id: bare, format: "design" });
        if (request.title !== undefined) {
          saved = await store.showDesign(
            { chatId: project, id: bare, title: request.title, from: { id: bare }, expectedVersion: saved.version },
            { assertActive },
          );
          await recordEdit(record, request.chatId, saved.version);
        }
        if (request.page !== undefined) record.page = placePage(index, request.page).id;
        await save(project, index, assertActive);
        const { html: _html, document: _document, ...summary } = saved;
        return entryOf(summary, record);
      }),
    renamePage: (request, { assertActive } = {}) =>
      serial(async () => {
        await assertActive?.();
        const { project, index } = await scope(request);
        const page = findPage(index, request.page);
        const name = pageName(request.name);
        if (index.pages.some((item) => item.id !== page.id && sameName(item.name, name)))
          throw Error(`The library already has a page named ${name}. Move designs onto it with design_library_update instead.`);
        page.name = name;
        await save(project, index, assertActive);
        return { id: page.id, name };
      }),
    close: () => Promise.all([queue, store.close()]),
  };
}

/** The design api the tools and host commands use: `library:<id>` designs go to the Project library, the rest to the Chat. */
function withDesignLibrary(artifacts, library) {
  const route =
    (name, other = name) =>
    async (request, options) =>
      isLibraryRef(request?.id) ? library[other](request, options) : artifacts[name](request, options);
  return {
    ...artifacts,
    get: route("get"),
    apply: route("apply"),
    exportDesign: route("exportDesign"),
    deleteDesign: route("deleteDesign", "remove"),
    showDesign: async (request, options) => {
      if (isLibraryRef(request?.id)) return library.showDesign(request, options);
      if (isLibraryRef(request?.from?.id))
        throw Error("A Chat design can't start from a library design. Read it with design_read and show it here as a new design.");
      return artifacts.showDesign(request, options);
    },
  };
}

const pageInput = z.string().min(1).max(60);
function designLibraryToolDefinitions(chatId, library) {
  return [
    {
      name: "design_library_list",
      description:
        "List this Project's design library: its pages (such as iPhone, Watch or Kit) and the designs on each, with their library:<id>, latest version and which Chat and agent made each version. Every Chat of the Project shares it, and it outlives the Chats. Read and revise a library design with the design tools by its library:<id>.",
      input: {},
      readOnly: true,
      run: async () => JSON.stringify(await library.list({ chatId })),
    },
    {
      name: "design_library_add",
      description:
        "Copy one of this Chat's designs, or its HTML page (designId is the page's id; tab picks one tab), into the Project library on a page. page is an existing page's name or a new one. The library keeps its own copy with versions; this Chat's design stays as is. Use it when the user wants a design kept for the Project or worked on from other Chats. Returns its library:<id>.",
      input: { designId: z.string().regex(BARE), page: pageInput, tab: z.string().regex(BARE).optional() },
      readOnly: false,
      run: async (args) => JSON.stringify(await library.add({ chatId, ...args })),
    },
    {
      name: "design_library_update",
      description:
        "Rename a Project library design (a new version with the same content) or move it to another page by name (a new name makes the page). A page with no designs left disappears.",
      input: { id: z.string().regex(LIBRARY_REF), title: z.string().min(1).max(120).optional(), page: pageInput.optional() },
      readOnly: false,
      run: async (args) => JSON.stringify(await library.update({ chatId, ...args })),
    },
    {
      name: "design_library_rename_page",
      description: "Rename a page of the Project library. page is its current name or id.",
      input: { page: pageInput, name: pageInput },
      readOnly: false,
      run: async (args) => JSON.stringify(await library.renamePage({ chatId, ...args })),
    },
  ];
}

module.exports = { createDesignLibrary, withDesignLibrary, designLibraryToolDefinitions };
