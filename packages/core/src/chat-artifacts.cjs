const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { z } = require("zod");
const {
  designDocumentInputSchema,
  designOperationInputSchema,
  validateDesignDocument,
  applyDesignOperations,
  designHtml,
  designSvg,
  designWarnings,
  designWarningText,
  designUsesInter,
  designCatalogFont,
  designInterHasGlyph,
  designInstanceRoot,
  loadDesignFonts,
} = require("@milagre/shared/design");
const { artifactDocument, hasDiagrams } = require("@milagre/shared/artifact-document");
const { ASSET_NAME, ASSET_HASH, MAX_ASSET_BYTES, MAX_PAGE_ASSETS, MAX_PAGE_ASSET_BYTES, assetType, mentionsAsset } = require("@milagre/shared/artifact-assets");
const { openAttachment } = require("./attachment-preview.cjs");
const { diagramScript } = require("@milagre/shared/diagram-script");
const { renderDesignPng } = require("./design-raster.cjs");
const { BUNDLED_SKILLS_DIRECTORY } = require("./bundled-skills.cjs");
// The tool descriptions carry what an agent needs to design here, for subagents too: they don't see the parent
// agent's system prompt (events.cjs milagreInstructions), only the tools.
const DESIGN_SKILL = path.join(BUNDLED_SKILLS_DIRECTORY, "design", "SKILL.md");

// Each artifact keeps immutable versions, so a reply's card shows the design as it was then while the docked
// viewer follows the latest. Structured designs and HTML explanatory artifacts keep separate formats.
const MAX_VERSIONS = 50;
const MAX_HTML = 1_000_000;
const VIEWPORT = { width: 1280, height: 800 };
const formatOf = (entry) => (entry?.format === "design" ? "design" : "html");
/**
 * A published page with Mermaid blocks carries Pele and the page helper, so its diagrams draw on the public page as
 * they do here, while it stays within the page limit; past it the blocks show their text.
 */
function sharedHtml(html) {
  if (!hasDiagrams(html)) return html;
  const page = artifactDocument(html, { page: true, diagrams: diagramScript() });
  return page.length <= MAX_HTML ? page : html;
}
const MAX_TABS = 20;
const escapeHtml = (text) => text.replace(/[&<>"]/g, (character) => `&#${character.charCodeAt(0)};`);
/**
 * A page split into tabs, published as one page: a tab bar over a sandboxed frame that shows the chosen tab. The
 * public page has no Milagre chrome around the frame to draw the tabs, so the page draws its own.
 */
function tabbedPage(tabs) {
  const pages = JSON.stringify(tabs.map((tab) => tab.html)).replace(/</g, "\\u003c");
  const buttons = tabs.map((tab) => `<button type="button" role="tab">${escapeHtml(tab.title)}</button>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;height:100%}body{display:flex;flex-direction:column;font:13px/1 system-ui,sans-serif;background:#fff}nav{display:flex;flex-shrink:0;gap:2px;overflow-x:auto;padding:6px 8px;border-bottom:1px solid #e6e6e6;background:#fafafa}button{flex-shrink:0;border:0;border-radius:6px;padding:7px 12px;background:none;color:#555;font:inherit;white-space:nowrap;cursor:pointer}button:hover{color:#111}button[aria-selected=true]{background:#ececec;color:#111;font-weight:600}button:focus-visible{outline:2px solid #007df3;outline-offset:-2px}iframe{flex:1;min-height:0;width:100%;border:0}</style></head><body><nav role="tablist" aria-label="Tabs">${buttons}</nav><iframe sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe><script type="application/json" id="pages">${pages}</script><script>(()=>{const pages=JSON.parse(document.getElementById('pages').textContent),frame=document.querySelector('iframe'),tabs=[...document.querySelectorAll('[role=tab]')];const show=(index)=>{tabs.forEach((tab,at)=>{tab.setAttribute('aria-selected',String(at===index));tab.tabIndex=at===index?0:-1});frame.title=tabs[index].textContent;frame.srcdoc=pages[index]};tabs.forEach((tab,index)=>{tab.onclick=()=>show(index)});document.querySelector('nav').onkeydown=(event)=>{const at=tabs.indexOf(document.activeElement),step=event.key==='ArrowRight'?1:event.key==='ArrowLeft'?-1:0;if(!step||at<0)return;event.preventDefault();const next=(at+step+tabs.length)%tabs.length;tabs[next].focus();show(next)};show(0)})();</script></body></html>`;
}
/** The published page of an Artifact: its HTML, or its tabs drawn as one page, within the page limit. */
function sharedPage(current) {
  if (!current.tabs) return sharedHtml(current.html);
  const page = tabbedPage(current.tabs.map((tab) => ({ title: tab.title, html: sharedHtml(tab.html) })));
  if (page.length <= MAX_HTML) return page;
  // ponytail: without diagrams first, then give up; splitting a too-large page across links waits for a page that needs it.
  const plain = tabbedPage(current.tabs);
  if (plain.length <= MAX_HTML) return plain;
  throw Error(`This page's tabs are over ${MAX_HTML} characters together, too large to publish.`);
}
/**
 * The tabs artifact_show was sent, checked: each names its id and title, and one without HTML keeps the HTML of the
 * page's tab with that id. Null when the page has no tabs.
 */
function checkTabs(tabs, current) {
  if (tabs === undefined) return null;
  if (!Array.isArray(tabs) || !tabs.length || tabs.length > MAX_TABS) throw Error(`A page has between 1 and ${MAX_TABS} tabs.`);
  const seen = new Set();
  const checked = tabs.map((tab) => {
    if (typeof tab?.id !== "string" || !ID.test(tab.id)) throw Error("Tab ids are lowercase letters, digits and dashes.");
    if (seen.has(tab.id)) throw Error(`Two tabs have the id ${tab.id}.`);
    seen.add(tab.id);
    if (typeof tab.title !== "string" || !tab.title.trim()) throw Error(`The tab ${tab.id} needs a title.`);
    const html = tab.html ?? current?.find((item) => item.id === tab.id)?.html;
    if (typeof html !== "string" || !html.trim())
      throw Error(`The tab ${tab.id} needs its HTML: only a tab the page already has keeps its HTML when you leave it out.`);
    return { id: tab.id, title: tab.title.trim().slice(0, 60), html };
  });
  if (checked.reduce((sum, tab) => sum + tab.html.length, 0) > MAX_HTML) throw Error(`A page's tabs are limited to ${MAX_HTML} characters together.`);
  return checked;
}
// A file's bytes cross the bridge in the chunks an attachment download uses, under the relay's frame limit.
const ASSET_CHUNK = 256 * 1024;
const megabytes = (bytes) => `${Math.ceil(bytes / (1024 * 1024))} MB`;
const size = (value, fallback) => (Number.isInteger(value) && value >= 240 && value <= 3840 ? value : fallback);
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
// The comments the user sent on a Chat's designs, one file beside the designs; no .json extension, so the design list
// never reads it as a design. Each: { id, design: { id, version, title }, nodeId?, x?, y?, near?, anchor?, text, createdAt, resolved? }.
const COMMENTS = "comments";
// An Artifact pin's anchor, as ARTIFACT_PAGE_SCRIPT writes it: element steps from <body> (or an id), then the point in it.
const PAGE_ANCHOR =
  /^(?:#[A-Za-z][\w-]{0,63}|[A-Za-z][A-Za-z0-9-]{0,40}:\d{1,5})(?:\/[A-Za-z][A-Za-z0-9-]{0,40}:\d{1,5}){0,40}@(?:0|1|0?\.\d{1,4}),(?:0|1|0?\.\d{1,4})$/;
const MAX_COMMENTS = 2000;
const COMMENT_ID = /^[a-f0-9]{8}$/;
const LAYER_ID = /^[a-zA-Z][a-zA-Z0-9_.-]{0,95}$/;
const FORMAT_MISMATCH = "Artifacts and Designs use separate formats. Create a new id instead of changing formats.";

function checkId(id) {
  if (typeof id !== "string" || !ID.test(id) || id === COMMENTS) throw Error("Artifact ids are lowercase letters, digits and dashes.");
  return id;
}
const summary = (artifact, entry) => ({
  id: artifact.id,
  title: entry.title,
  version: entry.version,
  versions: formatOf(entry) === "html" ? 1 : artifact.versions.length,
  width: entry.width ?? VIEWPORT.width,
  height: entry.height ?? VIEWPORT.height,
  format: formatOf(entry),
  ...(entry.group ? { group: entry.group } : {}),
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

function createChatArtifacts({ directory, validateChat }) {
  let queue = Promise.resolve();
  const serial = (fn) => {
    const result = queue.then(fn);
    queue = result.catch(() => {});
    return result;
  };
  const chatDirectory = (chatId) => path.join(directory, createHash("sha256").update(chatId).digest("hex").slice(0, 32));
  function checkFormat(format) {
    if (format !== undefined && format !== "design" && format !== "html") throw Error("Choose design or html format.");
  }
  async function chat(chatId) {
    if (typeof chatId !== "string" || !chatId || chatId.length > 8192) throw Error("An existing Chat is required.");
    await validateChat(chatId);
    return chatDirectory(chatId);
  }
  const designFolder = (folder, id) => path.join(folder, checkId(id));
  const htmlFile = (folder, id, version) => path.join(designFolder(folder, id), `v${version}.html`);
  const documentFile = (folder, id, version) => path.join(designFolder(folder, id), `v${version}.design.json`);
  const tabsFile = (folder, id, version) => path.join(designFolder(folder, id), `v${version}.tabs.json`);
  // A page's files, each by the SHA-256 of its bytes: a file the agent attaches again is stored once.
  const assetsFolder = (folder, id) => path.join(designFolder(folder, id), "assets");
  const assetFile = (folder, id, hash) => path.join(assetsFolder(folder, id), hash);
  // Files on their way in, beside the Chats' folders (on the same disk, so they move in by rename).
  const incoming = path.join(directory, ".incoming");
  const discard = (imported) => Promise.all(imported.map((asset) => fs.rm(asset.staged, { force: true }).catch(() => {})));
  /**
   * Copies the files the agent attached into the store, hashing them on the way: only a regular file inside one of
   * `roots` (the Chat's Worktrees), so a file elsewhere on the Mac can't ride along onto a page that may be shared.
   * Runs before the store's lock, so a large video doesn't hold up every other page.
   */
  async function importAssets(assets, roots) {
    if (assets === undefined) return [];
    if (!Array.isArray(assets) || assets.length > MAX_PAGE_ASSETS) throw Error(`Attach at most ${MAX_PAGE_ASSETS} files to a page.`);
    const imported = [];
    try {
      for (const asset of assets) {
        const name = asset?.name;
        if (typeof name !== "string" || !ASSET_NAME.test(name))
          throw Error("Name each file with letters, digits, dots, dashes and underscores, and no folders, such as demo.mp4.");
        if (imported.some((item) => item.name === name)) throw Error(`Two files are named ${name}.`);
        let opened;
        try {
          if (!roots?.length) throw Error("No Worktree");
          opened = await openAttachment(asset.path, roots);
        } catch {
          throw Error(`${asset.path} isn't a file in this Chat's Worktree. Save the file in the Worktree and attach it by its absolute path.`);
        }
        const { handle, stat } = opened;
        try {
          if (stat.size > MAX_ASSET_BYTES) throw Error(`${name} is ${megabytes(stat.size)}. A file is limited to ${megabytes(MAX_ASSET_BYTES)}.`);
          await fs.mkdir(incoming, { recursive: true, mode: 0o700 });
          const staged = path.join(incoming, randomUUID());
          const item = { name, staged, size: 0, type: assetType(name) };
          imported.push(item);
          const digest = createHash("sha256");
          const out = await fs.open(staged, "wx", 0o600);
          try {
            const buffer = Buffer.alloc(1024 * 1024);
            for (;;) {
              const { bytesRead } = await handle.read(buffer, 0, buffer.length, item.size);
              if (!bytesRead) break;
              item.size += bytesRead;
              if (item.size > MAX_ASSET_BYTES) throw Error(`${name} is over ${megabytes(MAX_ASSET_BYTES)}, the limit for a file.`);
              digest.update(buffer.subarray(0, bytesRead));
              await out.write(buffer, 0, bytesRead);
            }
          } finally {
            await out.close();
          }
          item.hash = digest.digest("hex");
        } finally {
          await handle.close();
        }
      }
      return imported;
    } catch (error) {
      await discard(imported);
      throw error;
    }
  }
  /** The page's files without those its newest version no longer has. */
  async function pruneAssets(folder, id, assets) {
    const kept = new Set((assets ?? []).map((asset) => asset.hash));
    const names = await fs.readdir(assetsFolder(folder, id)).catch(() => []);
    await Promise.all(names.filter((name) => !kept.has(name)).map((name) => fs.rm(assetFile(folder, id, name), { force: true }).catch(() => {})));
  }
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
  // A deleted design keeps only its metadata, marked deleted: its id is never reused, so the cards still in the Chat
  // never show another design under the versions they name.
  async function load(folder, id, { deleted = false } = {}) {
    const file = path.join(designFolder(folder, id), "meta.json");
    try {
      const meta = JSON.parse(await fs.readFile(file, "utf8"));
      return !meta.deletedAt === !deleted ? meta : null;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (deleted) return null;
    // Migrate original single-file HTML only after all version files exist; metadata commits the migration.
    const legacyFile = path.join(folder, `${checkId(id)}.json`);
    let legacy;
    try {
      legacy = JSON.parse(await fs.readFile(legacyFile, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    await fs.mkdir(designFolder(folder, id), { recursive: true, mode: 0o700 });
    for (const entry of legacy.versions) await atomicWrite(htmlFile(folder, id, entry.version), entry.html);
    const artifact = { id, versions: legacy.versions.map(({ html: _html, ...entry }) => ({ ...entry, format: "html" })) };
    await writeMeta(folder, artifact);
    await fs.rm(legacyFile, { force: true });
    return artifact;
  }
  function editable(artifact, format = "design") {
    if (artifact && formatOf(artifact.versions.at(-1)) !== format) throw Error(FORMAT_MISMATCH);
  }
  // A page split into tabs keeps its first tab as its HTML, for the viewers from before tabs, and every tab beside it.
  async function writeVersion(folder, id, previous, entry, html, document, assertActive, tabs = null) {
    const artifact = { id, versions: [...previous, entry].slice(formatOf(entry) === "html" ? -1 : -MAX_VERSIONS) };
    const extra = document ? documentFile(folder, id, entry.version) : tabs ? tabsFile(folder, id, entry.version) : null;
    const files = [htmlFile(folder, id, entry.version), ...(extra ? [extra] : [])];
    await fs.mkdir(designFolder(folder, id), { recursive: true, mode: 0o700 });
    try {
      await atomicWrite(files[0], html);
      if (extra) await atomicWrite(extra, JSON.stringify(document ?? tabs));
      // Publishing metadata is the commit: readers cannot observe a partial document/preview pair.
      await writeMeta(folder, artifact, assertActive);
    } catch (error) {
      await Promise.all(files.map((file) => fs.rm(file, { force: true }).catch(() => {})));
      throw error;
    }
    const kept = new Set(artifact.versions.map((item) => item.version));
    const expired = [];
    for (const item of previous) {
      if (kept.has(item.version) || (formatOf(item) === "html" && !item.livePage)) continue;
      expired.push(htmlFile(folder, id, item.version));
      if (formatOf(item) === "design") expired.push(documentFile(folder, id, item.version));
      else if (item.tabs) expired.push(tabsFile(folder, id, item.version));
    }
    await Promise.all(expired.map((file) => fs.rm(file, { force: true }).catch(() => {})));
    if (formatOf(entry) === "html") await pruneAssets(folder, id, entry.assets);
    return artifact;
  }
  async function readVersion(folder, artifact, version) {
    const entry = version === undefined ? artifact.versions.at(-1) : artifact.versions.find((item) => item.version === version);
    if (!entry) throw Error(`Version ${version} of this design is no longer kept.`);
    const html = await readVersionFile(htmlFile(folder, artifact.id, entry.version));
    const document = formatOf(entry) === "design" ? JSON.parse(await readVersionFile(documentFile(folder, artifact.id, entry.version))) : undefined;
    const tabs = formatOf(entry) === "html" && entry.tabs ? JSON.parse(await readVersionFile(tabsFile(folder, artifact.id, entry.version))) : undefined;
    const assets = formatOf(entry) === "html" && entry.assets?.length ? entry.assets : undefined;
    return {
      ...summary(artifact, entry),
      latest: artifact.versions.at(-1).version,
      html,
      ...(document ? { document } : {}),
      ...(tabs ? { tabs } : {}),
      ...(assets ? { assets } : {}),
    };
  }
  async function activeArtifacts(folder, format) {
    const names = await fs.readdir(folder).catch((error) => (error.code === "ENOENT" ? [] : Promise.reject(error)));
    const ids = new Set(names.map((name) => (name.endsWith(".json") ? name.slice(0, -5) : name)).filter((name) => ID.test(name) && name !== COMMENTS));
    const entries = await Promise.all([...ids].map((id) => load(folder, id)));
    const visible = entries.filter((entry) => entry?.versions.length && (!format || formatOf(entry.versions.at(-1)) === format));
    const html = visible
      .filter((entry) => formatOf(entry.versions.at(-1)) === "html")
      .toSorted((a, b) => (b.versions.at(-1).createdAt ?? 0) - (a.versions.at(-1).createdAt ?? 0) || a.id.localeCompare(b.id))[0];
    return visible
      .filter((entry) => formatOf(entry.versions.at(-1)) === "design" || entry === html)
      .toSorted((a, b) => (a.versions[0].createdAt ?? 0) - (b.versions[0].createdAt ?? 0));
  }

  /** Writes the Chat's Artifact page for artifact_show, with the files importAssets brought in. */
  function showPage(request, imported, assertActive) {
    return serial(async () => {
      await assertActive?.();
      const folder = await chat(request?.chatId);
      if (typeof request?.title !== "string" || !request.title.trim()) throw Error("An artifact needs a title.");
      if (request.tabs !== undefined && request.html !== undefined) throw Error("Send the page as html or as tabs, not both.");
      if (request.tabs === undefined && (typeof request.html !== "string" || !request.html.trim())) throw Error("An artifact needs its HTML.");
      if (request.html?.length > MAX_HTML) throw Error(`Artifact HTML is limited to ${MAX_HTML} characters.`);
      if (request.id) {
        const named = await load(folder, request.id);
        editable(named, "html");
      }
      const current = (await activeArtifacts(folder, "html"))[0];
      const reusable = request.id && !(await load(folder, request.id, { deleted: true }));
      const id = current?.id ?? (reusable ? request.id : randomUUID().slice(0, 8));
      const existing = current ?? null;
      editable(existing, "html");
      checkVersion(request, existing);
      const previous = existing?.versions ?? [];
      // A tab sent without its HTML keeps the HTML it has on the page now.
      const keeping = request.tabs?.some((tab) => tab?.html === undefined) && previous.at(-1)?.tabs;
      const tabs = checkTabs(request.tabs, keeping ? (await readVersion(folder, existing)).tabs : null);
      const entry = {
        version: (previous.at(-1)?.version ?? 0) + 1,
        title: request.title.trim().slice(0, 120),
        width: size(request.width, previous.at(-1)?.width ?? VIEWPORT.width),
        height: size(request.height, previous.at(-1)?.height ?? VIEWPORT.height),
        format: "html",
        livePage: true,
        ...(tabs ? { tabs: tabs.map((tab) => ({ id: tab.id, title: tab.title })) } : {}),
        createdAt: Date.now(),
      };
      // The page keeps a file while any of its HTML mentions it; one attached now must be mentioned.
      const pageHtml = tabs ? tabs.map((tab) => tab.html).join("\n") : request.html;
      for (const asset of imported)
        if (!mentionsAsset(pageHtml, asset.name))
          throw Error(`The page doesn't use assets/${asset.name}. Refer to it in the HTML as assets/${asset.name}, or leave the file out.`);
      const assets = [
        ...(previous.at(-1)?.assets ?? []).filter((asset) => !imported.some((item) => item.name === asset.name) && mentionsAsset(pageHtml, asset.name)),
        ...imported.map(({ name, hash, size: bytes, type }) => ({ name, hash, size: bytes, type })),
      ];
      if (assets.length > MAX_PAGE_ASSETS) throw Error(`A page has at most ${MAX_PAGE_ASSETS} files.`);
      if (assets.reduce((sum, asset) => sum + asset.size, 0) > MAX_PAGE_ASSET_BYTES)
        throw Error(`A page's files are limited to ${megabytes(MAX_PAGE_ASSET_BYTES)} together.`);
      if (assets.length) entry.assets = assets;
      // Each file moves in under its hash before the metadata names it; one the page already has stays.
      if (imported.length) await fs.mkdir(assetsFolder(folder, id), { recursive: true, mode: 0o700 });
      for (const asset of imported) {
        const target = assetFile(folder, id, asset.hash);
        if (!(await fs.stat(target).catch(() => null))) await fs.rename(asset.staged, target);
      }
      const artifact = await writeVersion(folder, id, previous, entry, tabs ? tabs[0].html : request.html, undefined, assertActive, tabs);
      return summary(artifact, entry);
    });
  }

  return {
    // Capture every latest version under one store lock. No private Chat or comment fields leave the store.
    pageSnapshot: (request) =>
      serial(async () => {
        const folder = await chat(request?.chatId);
        if (request.kind !== undefined && request.kind !== "designs" && request.kind !== "artifacts") throw Error("Choose designs or artifacts to share.");
        const format = request.kind === "artifacts" ? "html" : "design";
        checkFormat(format);
        const entries = await activeArtifacts(folder, format);
        if (format === "html") {
          if (!entries.length) throw Error("This Chat has no artifact page to share.");
          const artifacts = [];
          for (const entry of entries) {
            const current = await readVersion(folder, entry);
            artifacts.push({
              title: current.title,
              html: sharedPage(current),
              width: current.width,
              height: current.height,
              ...(current.assets ? { assets: current.assets } : {}),
            });
          }
          return { schemaVersion: 1, kind: "artifacts", title: request.title, artifacts };
        }
        if (!entries.length) throw Error("A shared page must contain at least one design.");
        const designs = [];
        for (const entry of entries) {
          const latest = entry.versions.at(-1);
          const source = await readVersionFile(documentFile(folder, entry.id, latest.version));
          designs.push({ title: latest.title, ...(latest.group ? { group: latest.group } : {}), document: JSON.parse(source) });
        }
        return { schemaVersion: 1, title: request.title, designs };
      }),
    // The agent's files come in first (importAssets), outside the lock; whatever didn't move into the page is dropped.
    show: async (request, { assertActive, roots } = {}) => {
      const imported = await importAssets(request?.assets, roots);
      try {
        return await showPage(request, imported, assertActive);
      } finally {
        await discard(imported);
      }
    },
    /** A file of the Chat's Artifact page by its name: up to ASSET_CHUNK bytes from `offset`, as base64. */
    asset: (request) =>
      serial(async () => {
        const folder = await chat(request?.chatId);
        const current = (await activeArtifacts(folder, "html"))[0];
        const asset = current?.versions.at(-1).assets?.find((item) => item.name === request?.name);
        if (!asset) throw Error("This file is no longer on the page.");
        const offset = request.offset ?? 0;
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > asset.size) throw Error("Invalid file offset.");
        const wanted = request.length === undefined ? ASSET_CHUNK : request.length;
        if (!Number.isSafeInteger(wanted) || wanted < 0) throw Error("Invalid file length.");
        const bytes = Buffer.alloc(Math.min(ASSET_CHUNK, wanted, asset.size - offset));
        const handle = await fs.open(assetFile(folder, current.id, asset.hash), "r").catch(() => {
          throw Error("This file is no longer on the page.");
        });
        try {
          let count = 0;
          while (count < bytes.length) {
            const { bytesRead } = await handle.read(bytes, count, bytes.length - count, offset + count);
            if (!bytesRead) break;
            count += bytesRead;
          }
          if (count !== bytes.length) throw Error("This file is no longer on the page.");
        } finally {
          await handle.close();
        }
        return { name: asset.name, hash: asset.hash, size: asset.size, type: asset.type, offset, base64: bytes.toString("base64") };
      }),
    /** Where the Chat's Artifact page keeps the file with this hash, for publishing it. */
    assetPath: (request) =>
      serial(async () => {
        const folder = await chat(request?.chatId);
        const current = (await activeArtifacts(folder, "html"))[0];
        if (typeof request?.hash !== "string" || !ASSET_HASH.test(request.hash) || !current?.versions.at(-1).assets?.some((item) => item.hash === request.hash))
          throw Error("This file is no longer on the page.");
        return assetFile(folder, current.id, request.hash);
      }),
    showDesign: (request, { assertActive } = {}) =>
      serial(async () => {
        await assertActive?.();
        const folder = await chat(request?.chatId);
        if (typeof request?.title !== "string" || !request.title.trim()) throw Error("A design needs a title.");
        const id = request.id ?? randomUUID().slice(0, 8);
        const existing = request.id ? await load(folder, id) : null;
        if (!existing && request.id && (await load(folder, id, { deleted: true }))) throw Error(`The design ${id} was deleted. Use a new id.`);
        editable(existing);
        checkVersion(request, existing, true);
        const document = validateDesignDocument(request.document);
        const previous = existing?.versions ?? [];
        // A revision stays in its group unless it names one; an empty group takes it out.
        const group = typeof request.group === "string" ? request.group.trim().slice(0, 60) : previous.at(-1)?.group;
        const entry = {
          version: (previous.at(-1)?.version ?? 0) + 1,
          title: request.title.trim().slice(0, 120),
          ...(group ? { group } : {}),
          width: document.width,
          height: document.height,
          format: "design",
          createdAt: Date.now(),
        };
        // The saved HTML embeds the catalog families the design names, so the desktop and the phone draw them.
        await loadDesignFonts(document);
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
          ...(current.group ? { group: current.group } : {}),
          width: document.width,
          height: document.height,
          format: "design",
          createdAt: Date.now(),
        };
        await loadDesignFonts(document);
        const html = designHtml(document);
        const artifact = await writeVersion(folder, existing.id, existing.versions, entry, html, document, assertActive);
        return { ...summary(artifact, entry), latest: entry.version, html, document };
      }),
    get: (request) =>
      serial(async () => {
        const folder = await chat(request?.chatId);
        let artifact = await load(folder, request?.id);
        if (!artifact) throw Error("This design is no longer available.");
        checkFormat(request.format);
        if (request.format && formatOf(artifact.versions.at(-1)) !== request.format) throw Error(FORMAT_MISMATCH);
        const isHtml = formatOf(artifact.versions.at(-1)) === "html";
        if (isHtml) artifact = (await activeArtifacts(folder, "html"))[0] ?? artifact;
        const current = await readVersion(folder, artifact, isHtml ? undefined : request.version);
        if (!Array.isArray(request.fonts?.have) || current.format !== "design") return current;
        // Only the generated designHtml head has this shape. Legacy/custom HTML stays self-contained.
        const block =
          /^<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=\d+, initial-scale=1"><style>[^<]*<\/style><style>((?:@font-face\{font-family:"[^"<>;{}]+";font-weight:\d+(?: \d+)?;font-style:normal;src:url\(data:font\/ttf;base64,[A-Za-z0-9+/=]+\) format\("truetype"\)\})+)<\/style><\/head><body><main id="design-root">/.exec(
            current.html,
          );
        if (!block) return current;
        const fontCss = block[1];
        const fontKey = createHash("sha256").update(fontCss).digest("hex");
        return {
          ...current,
          html: current.html.replace(`<style>${fontCss}</style>`, ""),
          fontKey,
          ...(request.fonts.have.includes(fontKey) ? {} : { fontCss }),
        };
      }),
    exportDesign: (request) =>
      serial(async () => {
        const folder = await chat(request?.chatId);
        const artifact = await load(folder, request?.id);
        if (!artifact) throw Error("This design is no longer available.");
        editable(artifact);
        const current = await readVersion(folder, artifact, request.version);
        if (request.format !== "json" && request.format !== "svg") throw Error("Choose json or svg for the design export.");
        const svg = request.format === "svg";
        return {
          id: current.id,
          version: current.version,
          filename: `${current.id}-v${current.version}.${request.format}`,
          mimeType: svg ? "image/svg+xml" : "application/json",
          // Agents read this through a tool result, so Inter stays a font-family reference instead of ~250 KB of embedded faces.
          // The desktop download builds its own SVG with the fonts embedded.
          content: svg ? designSvg(current.document, { embedFonts: false }) : JSON.stringify(current.document, null, 2),
        };
      }),
    list: (request) =>
      serial(async () => {
        const folder = await chat(request?.chatId);
        checkFormat(request.format);
        return (await activeArtifacts(folder, request.format)).map((artifact) => summary(artifact, artifact.versions.at(-1)));
      }),
    /** Deletes every version of a design and the comments on it. */
    deleteDesign: (request, { assertActive } = {}) =>
      serial(async () => {
        await assertActive?.();
        const folder = await chat(request?.chatId);
        const existing = await load(folder, request?.id);
        if (!existing) throw Error("This design is no longer available.");
        editable(existing);
        // The marked metadata commits the delete; the version files are only removed after it.
        await writeMeta(folder, { id: existing.id, versions: [], deletedAt: Date.now() }, assertActive);
        const names = await fs.readdir(designFolder(folder, existing.id));
        await Promise.all(
          names
            .filter((name) => name !== "meta.json")
            .map((name) => fs.rm(path.join(designFolder(folder, existing.id), name), { force: true, recursive: true })),
        );
        const comments = await readComments(folder);
        const kept = comments.filter((comment) => comment.design?.id !== existing.id);
        if (kept.length !== comments.length) await writeComments(folder, kept);
        return { id: existing.id };
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
          // On an Artifact page: the text near the pin, and the element path and point the page finds it by again.
          const near =
            typeof comment.near === "string"
              ? comment.near
                  .replace(/["\s]+/g, " ")
                  .trim()
                  .slice(0, 120)
              : "";
          const anchor = typeof comment.anchor === "string" && PAGE_ANCHOR.test(comment.anchor) ? comment.anchor : "";
          const tab =
            typeof comment.tab?.id === "string" && ID.test(comment.tab.id)
              ? {
                  id: comment.tab.id,
                  title:
                    String(comment.tab.title ?? comment.tab.id)
                      .trim()
                      .slice(0, 60) || comment.tab.id,
                }
              : null;
          const at = (value) => (typeof value === "number" && value >= 0 && value <= 1 ? value : undefined);
          return {
            // The app names the comment in the message it sends first, and records it once that went; one it names
            // again (a retried send) is kept once.
            id: typeof comment.id === "string" && COMMENT_ID.test(comment.id) ? comment.id : randomUUID().replace(/-/g, "").slice(0, 8),
            design: { id: design.id, version: design.version, title: String(design.title ?? design.id).slice(0, 120) },
            ...(comment.nodeId === undefined ? {} : { nodeId: comment.nodeId }),
            ...(at(comment.x) === undefined || at(comment.y) === undefined ? {} : { x: at(comment.x), y: at(comment.y) }),
            ...(near ? { near } : {}),
            ...(anchor ? { anchor } : {}),
            ...(tab ? { tab } : {}),
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
        checkFormat(request.format);
        const comments = await readComments(folder);
        const visible = await Promise.all(
          comments.map((comment) =>
            commentDesign(folder, comment, { format: request.format }).then(
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
        await commentDesign(folder, comment, { format: request.format });
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
  async function commentDesign(folder, comment, { retained = false, format } = {}) {
    const artifact = await load(folder, comment.design.id);
    if (!artifact) throw Error("This comment's design is no longer available.");
    checkFormat(format);
    if (format && formatOf(artifact.versions.at(-1)) !== format) throw Error(FORMAT_MISMATCH);
    if (!Number.isSafeInteger(comment.design.version) || comment.design.version < 1 || comment.design.version > artifact.versions.at(-1).version)
      throw Error("This comment's design version is not available.");
    // HTML is one live page: an edit may land while the user is composing feedback.
    // Its previous revision need not remain on disk for that feedback to be recorded.
    if (formatOf(artifact.versions.at(-1)) === "html") return;
    const version = artifact.versions.find((item) => item.version === comment.design.version);
    if (!version && (retained || comment.design.version >= artifact.versions[0].version)) throw Error("This comment's design version is no longer kept.");
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

// The most warnings the summary JSON on line 1 carries; the text block below it lists them the same way.
const MAX_SUMMARY_WARNINGS = 20;
// The renderer has Inter and the catalog families, so text in any other family is drawn in Inter in the agent's image.
// Names those families.
const unbundledFamilies = (document) => {
  const families = new Set();
  for (const node of document.nodes) {
    if (node.type !== "text" || node.hidden || !node.fontFamily || designUsesInter(node.fontFamily) || designCatalogFont(node.fontFamily)) continue;
    const family = node.fontFamily
      .split(",")[0]
      .trim()
      .replace(/^["']|["']$/g, "");
    if (family) families.add(family);
  }
  return [...families];
};

const MAX_NAMED_LAYERS = 5;

/** Visible text layers with characters the bundled Inter subset lacks; the agent's image leaves those blank. */
const undrawableTextLayers = (document) => {
  const byId = new Map(document.nodes.map((node) => [node.id, node]));
  const visible = (node) => {
    for (let depth = 0; node && depth < 64; depth++, node = byId.get(node.parentId)) if (node.hidden) return false;
    return true;
  };
  const ids = new Set();
  for (const node of document.nodes) {
    if (node.type !== "text" || !node.text || !visible(node)) continue;
    if ([...node.text].every(designInterHasGlyph)) continue;
    // Name the editable instance, never one of its generated children.
    ids.add((designInstanceRoot(document, node.id, byId) ?? node).id);
  }
  return [...ids];
};

const namedLayers = (ids) =>
  ids
    .slice(0, MAX_NAMED_LAYERS)
    .map((id) => `"${id}"`)
    .join(", ") + (ids.length > MAX_NAMED_LAYERS ? ` and ${ids.length - MAX_NAMED_LAYERS} more` : "");

// What the agent sees after a design call: the summary (first line, which the Chat card parses), the warnings, and
// the saved version drawn as a PNG. Neither drawing nor checking fails the call; the version is already saved.
async function designFeedback(saved, document, { renderPng, warnings: findWarnings }) {
  const problems = [];
  let warnings = [];
  try {
    warnings = findWarnings(document);
  } catch (error) {
    problems.push(`Layout warnings could not be computed: ${error?.message ?? String(error)}.`);
  }
  const head = { ...saved, warnings: warnings.slice(0, MAX_SUMMARY_WARNINGS) };
  if (warnings.length > MAX_SUMMARY_WARNINGS) head.warningCount = warnings.length;
  const notes = [JSON.stringify(head)];
  let images = [];
  try {
    images = [await renderPng(document)];
    notes.push(
      "Look at the image: check icons, spacing, alignment and density against the brief, fix what looks wrong and every item under Warnings with design_apply, then reply.",
    );
    const fonts = unbundledFamilies(document);
    if (fonts.length) notes.push(`Your image shows ${fonts.join(", ")} in Inter; the user sees the real font.`);
    const blank = undrawableTextLayers(document);
    if (blank.length)
      notes.push(`Your image can't draw some characters in ${namedLayers(blank)}; they are blank and the line may look cut there, but the user sees them.`);
  } catch (error) {
    notes.push(`The preview could not be rendered: ${error?.message ?? String(error)}. Check the warnings below.`);
  }
  notes.push(...problems);
  // Remote images are only placeholders in the agent's image; there is nothing to fix, so they are notes, not warnings.
  const text = designWarningText(warnings.filter((warning) => warning.kind !== "remote-image"));
  if (text) notes.push(`Warnings:\n${text}`);
  const remote = designWarningText(warnings.filter((warning) => warning.kind === "remote-image"));
  if (remote) notes.push(`Notes:\n${remote}`);
  return { text: notes.join("\n"), images };
}

function artifactToolDefinitions(chatId, api, authorization, { renderPng = renderDesignPng, warnings = designWarnings } = {}) {
  const feedback = { renderPng, warnings };
  return [
    {
      name: "design_show",
      description: `For any UI, screen, mockup or visual design in this Chat, subagents included: use this, not HTML or image files, so it lands on the Chat's Designs canvas, where the user watches, reviews and chooses. Create an editable design from a document of named layers, with frames, text, shapes, icons, images, layout and color tokens. The user can edit layers on desktop. On phone they review and choose designs, and request changes through Chat. The document sets the screen size (390 by 844 for a phone). Read the bundled design skill (${DESIGN_SKILL}) for the document format. A new id creates a design; revising an existing id requires expectedVersion from design_read, so the user's changes are preserved. Prefer design_apply for small revisions. Use a different id for each variant, in the same group; to revise a design, keep its id. When the user names another design tool, use that tool instead. The result includes the rendered design as an image and layout warnings; check both before replying.`,
      input: {
        title: z.string().min(1).max(120),
        group: z
          .string()
          .max(60)
          .optional()
          .describe(
            "The part of the app this screen belongs to, such as Onboarding or Settings. The canvas lays out one row per group. A revision keeps its group unless you pass one; an empty string removes it.",
          ),
        document: designDocumentInputSchema,
        id: z.string().regex(ID).optional(),
        expectedVersion: z.number().int().nonnegative().optional(),
      },
      readOnly: false,
      run: async (args) => {
        const design = await api.showDesign({ chatId, ...args }, authorization);
        return designFeedback(design, validateDesignDocument(args.document), feedback);
      },
    },
    {
      name: "design_read",
      description:
        "Read a structured design document and its layer ids, with the latest version unless you name one. Read before editing and send its version as expectedVersion to design_apply or design_show. User edits also create versions.",
      input: { id: z.string().regex(ID), version: z.number().int().positive().optional() },
      readOnly: true,
      run: async (args) => {
        const { html: _html, ...design } = await api.get({ chatId, ...args, format: "design" });
        return JSON.stringify(design);
      },
    },
    {
      name: "design_apply",
      description:
        "Revise a design on this Chat's Designs canvas, keeping its id; any agent or subagent changing a design uses this (or design_show with expectedVersion), never a separate file. Edit it with one atomic batch of layer operations: update properties, insert a layer, or delete a layer and its descendants. To replace the whole document, use design_show with its id and expectedVersion. Use stable layer ids. expectedVersion must match the latest version read; a conflict changes nothing, so read again and reapply the intended edits. One successful batch creates one immutable version and shows its design card.",
      input: {
        id: z.string().regex(ID),
        expectedVersion: z.number().int().positive(),
        operations: z.array(designOperationInputSchema).min(1).max(1000),
      },
      readOnly: false,
      run: async (args) => {
        const { html: _html, document, ...design } = await api.apply({ chatId, ...args }, authorization);
        return designFeedback(design, document, feedback);
      },
    },
    {
      name: "design_export",
      description:
        "Export an editable design version as its source JSON document or a standalone SVG. The SVG names its fonts without embedding them. Returns the filename, MIME type and file content. Save the content to a file when the user requests a downloadable export.",
      input: { id: z.string().regex(ID), version: z.number().int().positive().optional(), format: z.enum(["json", "svg"]) },
      readOnly: true,
      run: async (args) => JSON.stringify(await api.exportDesign({ chatId, ...args })),
    },
    {
      name: "design_delete",
      description:
        "Delete a design and every version of it from this Chat, with the comments on it. Only when the user asks to delete it, for example the variants they did not choose. Its cards in the Chat stay but no longer open it, and its id can't be used again.",
      input: { id: z.string().regex(ID) },
      readOnly: false,
      run: async (args) => JSON.stringify(await api.deleteDesign({ chatId, ...args }, authorization)),
    },
    ...artifactCommentToolDefinitions(chatId, api, authorization),
  ];
}

function artifactCommentToolDefinitions(chatId, api, authorization) {
  return [
    {
      name: "artifact_comments",
      description:
        "List the comments the user left on this Chat's designs and HTML artifacts, the open ones unless you ask for all. Each has an id, its original design version, optional nodeId identifying its layer, where on it the user pinned it (x and y as fractions of the design's screen) and its text. Comments remain available after their old preview is pruned. Read the latest design before editing the named layer; the pin coordinates describe the original version, not the current layout.",
      input: { all: z.boolean().optional() },
      readOnly: true,
      run: async ({ all }) => JSON.stringify((await api.comments({ chatId })).filter((comment) => all || !comment.resolved)),
    },
    {
      name: "artifact_resolve_comment",
      description:
        "Mark one of the user's comments on a design or HTML artifact resolved once you have addressed it (usually after showing a revised version), with a short note on what you changed. The user sees the comment resolved, with your note, in the chat and on the canvas. The comment's id is in the user's message, or from artifact_comments.",
      input: { id: z.string().regex(COMMENT_ID), note: z.string().min(1).max(2000) },
      readOnly: false,
      run: async (args) => JSON.stringify(await api.resolveComment({ chatId, ...args }, authorization)),
    },
  ];
}
/** `roots` resolves to the Chat's Worktrees: the only folders artifact_show attaches files from. */
function htmlArtifactToolDefinitions(chatId, api, authorization, { roots = async () => [] } = {}) {
  return [
    {
      name: "artifact_show",
      description:
        "Create or replace this Chat's one live HTML artifact page explaining a topic, report or interactive page. Edits update that same page in place; there are no variants or browsable versions. Use design_show for UI screens, mockups and visual design work. HTML artifacts stay available when Designs is off. For a diagram, put Mermaid text in <pre class=\"mermaid\">: Milagre draws it, no script needed. Send html for one page, or tabs to split it into tabs Milagre draws above it; a tab sent without html keeps the HTML it has, so you can change one tab and resend only that one. For photos, videos or any other file, save it in the Chat's Worktree, attach it in assets by name and absolute path, and use it in the HTML as assets/<name>; Milagre copies it, and the page keeps it while its HTML mentions it.",
      input: {
        title: z.string().min(1).max(120),
        html: z.string().min(1).max(MAX_HTML).optional().describe("The page, one self-contained HTML document. Leave it out when you send tabs."),
        tabs: z
          .array(
            z.object({
              id: z.string().regex(ID),
              title: z.string().min(1).max(60),
              html: z
                .string()
                .min(1)
                .max(MAX_HTML)
                .optional()
                .describe("This tab's self-contained HTML document. Leave it out to keep the tab's current HTML."),
            }),
          )
          .min(1)
          .max(MAX_TABS)
          .optional()
          .describe("The page's tabs, in order, each its own self-contained HTML document. Leave it out for a page without tabs."),
        assets: z
          .array(
            z.object({
              name: z.string().regex(ASSET_NAME).describe("The file's name on the page, such as demo.mp4; the HTML uses it as assets/demo.mp4."),
              path: z.string().min(1).max(4096).describe("The file's absolute path, inside this Chat's Worktree."),
            }),
          )
          .max(MAX_PAGE_ASSETS)
          .optional()
          .describe(
            `Photos, videos or any files the page shows, up to ${megabytes(MAX_ASSET_BYTES)} each. Attach a file once: the page keeps the ones its HTML still mentions as assets/<name>.`,
          ),
        id: z.string().regex(ID).optional(),
        width: z.number().int().min(240).max(3840).optional(),
        height: z.number().int().min(240).max(3840).optional(),
        expectedVersion: z.number().int().nonnegative().optional(),
      },
      readOnly: false,
      run: async (args) => JSON.stringify(await api.show({ chatId, ...args }, { ...authorization, roots: await roots() })),
    },
    {
      name: "artifact_read",
      description:
        "Read this Chat's current HTML artifact page, or one of its tabs. Old artifact references open the current page. Use design_read for a structured design.",
      input: {
        id: z.string().regex(ID),
        version: z.number().int().positive().optional(),
        tab: z.string().regex(ID).optional().describe("On a page with tabs, the id of the one tab to read; the others come back as their ids and titles."),
      },
      readOnly: true,
      run: async ({ tab, ...args }) => {
        const page = await api.get({ chatId, ...args, format: "html" });
        if (!page.tabs) return JSON.stringify(page);
        // The page's HTML is its first tab again; it is left out.
        const { html: _html, tabs, ...rest } = page;
        if (tab === undefined) return JSON.stringify({ ...rest, tabs });
        const one = tabs.find((item) => item.id === tab);
        if (!one) throw Error(`This page has no tab ${tab}. Its tabs: ${tabs.map((item) => item.id).join(", ")}.`);
        return JSON.stringify({ ...rest, tabs: tabs.map(({ id, title }) => ({ id, title })), tab: one });
      },
    },
    {
      name: "artifact_list",
      description: "Read the summary of this Chat's one live explanatory HTML artifact page. Structured designs use design_list.",
      input: {},
      readOnly: true,
      run: async () => JSON.stringify(await api.list({ chatId, format: "html" })),
    },
  ];
}
module.exports = { createChatArtifacts, artifactToolDefinitions, htmlArtifactToolDefinitions, artifactCommentToolDefinitions };
