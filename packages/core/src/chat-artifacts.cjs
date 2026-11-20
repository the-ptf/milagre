const { isDeepStrictEqual } = require("node:util");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { z } = require("zod");
const { designDocumentInputSchema, designOperationInputSchema, designEditIntentSchema } = require("@milagre/shared/design-schemas");
const { withDesignHost } = require("./design-host-fonts.cjs");
const designImplementation = () => withDesignHost(require("@milagre/shared/design"));
const { artifactDocument, hasDiagrams, checkDesignCode } = require("@milagre/shared/artifact-document");
const { ASSET_NAME, ASSET_HASH, MAX_ASSET_BYTES, MAX_PAGE_ASSETS, MAX_PAGE_ASSET_BYTES, assetType, mentionsAsset } = require("@milagre/shared/artifact-assets");
const { openAttachment } = require("./attachment-preview.cjs");
const { diagramScript } = require("@milagre/shared/diagram-script");
const { renderDesignPng } = require("./design-raster.cjs");
const { screenshotDesign } = require("./html-render.cjs");
const { designFeedback, interactiveFeedback, inspectLayerDesign, INTERACTIVE_GUIDE, DESIGN_MODE_INPUT } = require("./design-feedback.cjs");
const { BUNDLED_SKILLS_DIRECTORY } = require("./bundled-skills.cjs");
const DESIGN_SKILL = path.join(BUNDLED_SKILLS_DIRECTORY, "design", "SKILL.md");

const MAX_VERSIONS = 50;
const MAX_HTML = 1_000_000;
const VIEWPORT = { width: 1280, height: 800 };
const formatOf = (entry) => (entry?.format === "design" ? "design" : "html");
const interactiveOf = (entry) => entry?.format === "design" && entry.interactive === true;
const KIND_MISMATCH =
  "A design stays layers or interactive HTML for all its versions. Use a new id for the other kind, such as an interactive version of a layer design.";
function checkDesignHtml(html) {
  if (typeof html !== "string" || !html.trim()) throw Error("An interactive design needs its HTML.");
  if (html.length > MAX_HTML) throw Error(`An interactive design's HTML is limited to ${MAX_HTML} characters.`);
  const problems = checkDesignCode(html);
  if (problems.length) throw Error(problems.join(" "));
  return html;
}
function editDesignHtml(html, edits) {
  if (!Array.isArray(edits) || !edits.length) throw Error("Send at least one edit.");
  let next = html;
  edits.forEach((edit, index) => {
    const find = edit?.find;
    if (typeof find !== "string" || !find) throw Error(`Edit ${index + 1} needs the text to find.`);
    if (typeof edit.replace !== "string") throw Error(`Edit ${index + 1} needs the text to replace it with.`);
    const count = next.split(find).length - 1;
    if (!count) throw Error(`Edit ${index + 1}: its text isn't in the design (after the edits before it). Read the design again with design_read.`);
    if (count > 1 && !edit.all)
      throw Error(`Edit ${index + 1}: its text occurs ${count} times. Include more of the text around it, or set all to replace every one.`);
    next = edit.all ? next.split(find).join(edit.replace) : next.replace(find, () => edit.replace);
  });
  return next;
}
function sharedHtml(html) {
  if (!hasDiagrams(html)) return html;
  const page = artifactDocument(html, { page: true, diagrams: diagramScript() });
  return page.length <= MAX_HTML ? page : html;
}
const MAX_TABS = 20;
const escapeHtml = (text) => text.replace(/[&<>"]/g, (character) => `&#${character.charCodeAt(0)};`);
function tabbedPage(tabs) {
  const pages = JSON.stringify(tabs.map((tab) => tab.html)).replace(/</g, "\\u003c");
  const buttons = tabs.map((tab) => `<button type="button" role="tab">${escapeHtml(tab.title)}</button>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;height:100%}body{display:flex;flex-direction:column;font:13px/1 system-ui,sans-serif;background:#fff}nav{display:flex;flex-shrink:0;gap:2px;overflow-x:auto;padding:6px 8px;border-bottom:1px solid #e6e6e6;background:#fafafa}button{flex-shrink:0;border:0;border-radius:6px;padding:7px 12px;background:none;color:#555;font:inherit;white-space:nowrap;cursor:pointer}button:hover{color:#111}button[aria-selected=true]{background:#ececec;color:#111;font-weight:600}button:focus-visible{outline:2px solid #007df3;outline-offset:-2px}iframe{flex:1;min-height:0;width:100%;border:0}</style></head><body><nav role="tablist" aria-label="Tabs">${buttons}</nav><iframe sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe><script type="application/json" id="pages">${pages}</script><script>(()=>{const pages=JSON.parse(document.getElementById('pages').textContent),frame=document.querySelector('iframe'),tabs=[...document.querySelectorAll('[role=tab]')];const show=(index)=>{tabs.forEach((tab,at)=>{tab.setAttribute('aria-selected',String(at===index));tab.tabIndex=at===index?0:-1});frame.title=tabs[index].textContent;frame.srcdoc=pages[index]};tabs.forEach((tab,index)=>{tab.onclick=()=>show(index)});document.querySelector('nav').onkeydown=(event)=>{const at=tabs.indexOf(document.activeElement),step=event.key==='ArrowRight'?1:event.key==='ArrowLeft'?-1:0;if(!step||at<0)return;event.preventDefault();const next=(at+step+tabs.length)%tabs.length;tabs[next].focus();show(next)};show(0)})();</script></body></html>`;
}
function sharedPage(current) {
  if (!current.tabs) return sharedHtml(current.html);
  const page = tabbedPage(current.tabs.map((tab) => ({ title: tab.title, html: sharedHtml(tab.html) })));
  if (page.length <= MAX_HTML) return page;
  const plain = tabbedPage(current.tabs);
  if (plain.length <= MAX_HTML) return plain;
  throw Error(`This page's tabs are over ${MAX_HTML} characters together, too large to publish.`);
}
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
const ASSET_CHUNK = 256 * 1024;
const megabytes = (bytes) => `${Math.ceil(bytes / (1024 * 1024))} MB`;
const size = (value, fallback) => (Number.isInteger(value) && value >= 240 && value <= 3840 ? value : fallback);
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const COMMENTS = "comments";
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
  ...(interactiveOf(entry) ? { interactive: true } : {}),
  ...(entry.inline ? { inline: true } : {}),
  ...(entry.group ? { group: entry.group } : {}),
  ...(entry.kit ? { kit: entry.kit } : {}),
  ...(entry.consistency ? { consistency: entry.consistency } : {}),
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

function createChatArtifacts({ directory, validateChat, readKit }) {
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
  async function verifyKit(chatId, document) {
    if (!document.kit || !readKit) return;
    const kit = await readKit({ chatId, id: document.kit.id, version: document.kit.version });
    if (!isDeepStrictEqual(kit, document.kit))
      throw Error("The pinned kit differs from this Project's saved version. Read it with design_kit_read and use that snapshot.");
  }
  const designFolder = (folder, id) => path.join(folder, checkId(id));
  const htmlFile = (folder, id, version) => path.join(designFolder(folder, id), `v${version}.html`);
  const documentFile = (folder, id, version) => path.join(designFolder(folder, id), `v${version}.design.json`);
  const tabsFile = (folder, id, version) => path.join(designFolder(folder, id), `v${version}.tabs.json`);
  const assetsFolder = (folder, id) => path.join(designFolder(folder, id), "assets");
  const assetFile = (folder, id, hash) => path.join(assetsFolder(folder, id), hash);
  const incoming = path.join(directory, ".incoming");
  const discard = (imported) => Promise.all(imported.map((asset) => fs.rm(asset.staged, { force: true }).catch(() => {})));
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
  async function writeMeta(folder, meta, assertActive) {
    await fs.mkdir(designFolder(folder, meta.id), { recursive: true, mode: 0o700 });
    await atomicWrite(path.join(designFolder(folder, meta.id), "meta.json"), JSON.stringify(meta), assertActive);
  }
  async function load(folder, id, { deleted = false } = {}) {
    const file = path.join(designFolder(folder, id), "meta.json");
    try {
      const meta = JSON.parse(await fs.readFile(file, "utf8"));
      return !meta.deletedAt === !deleted ? meta : null;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (deleted) return null;
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
  async function writeVersion(folder, id, previous, entry, html, document, assertActive, tabs = null) {
    const artifact = { id, versions: [...previous, entry].slice(formatOf(entry) === "html" ? -1 : -MAX_VERSIONS) };
    const extra = document ? documentFile(folder, id, entry.version) : tabs ? tabsFile(folder, id, entry.version) : null;
    const files = [htmlFile(folder, id, entry.version), ...(extra ? [extra] : [])];
    await fs.mkdir(designFolder(folder, id), { recursive: true, mode: 0o700 });
    try {
      await atomicWrite(files[0], html);
      if (extra) await atomicWrite(extra, JSON.stringify(document ?? tabs));
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
      if (formatOf(item) === "design" && !interactiveOf(item)) expired.push(documentFile(folder, id, item.version));
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
    const document =
      formatOf(entry) === "design" && !interactiveOf(entry) ? JSON.parse(await readVersionFile(documentFile(folder, artifact.id, entry.version))) : undefined;
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
    const visible = entries.filter(
      (entry) => entry?.versions.length && !entry.versions.at(-1).inline && (!format || formatOf(entry.versions.at(-1)) === format),
    );
    const html = visible
      .filter((entry) => formatOf(entry.versions.at(-1)) === "html")
      .toSorted((a, b) => (b.versions.at(-1).createdAt ?? 0) - (a.versions.at(-1).createdAt ?? 0) || a.id.localeCompare(b.id))[0];
    return visible
      .filter((entry) => formatOf(entry.versions.at(-1)) === "design" || entry === html)
      .toSorted((a, b) => (a.versions[0].createdAt ?? 0) - (b.versions[0].createdAt ?? 0));
  }

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
        if (named?.versions.at(-1)?.inline) throw Error("HTML replies are immutable. Publish a new reply with html_render.");
        editable(named, "html");
      }
      const current = (await activeArtifacts(folder, "html"))[0];
      const reusable = request.id && !(await load(folder, request.id, { deleted: true }));
      const id = current?.id ?? (reusable ? request.id : randomUUID().slice(0, 8));
      const existing = current ?? null;
      editable(existing, "html");
      checkVersion(request, existing);
      const previous = existing?.versions ?? [];
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
    render: (request, { assertActive } = {}) =>
      serial(async () => {
        await assertActive?.();
        const folder = await chat(request?.chatId);
        const { html, title, height = 400 } = request;
        if (typeof html !== "string" || !html.trim() || html.length > MAX_HTML) throw Error(`Send HTML between 1 and ${MAX_HTML} characters.`);
        if (typeof title !== "string" || !title.trim() || title.length > 120) throw Error("Use a title between 1 and 120 characters.");
        if (!Number.isInteger(height) || height < 24 || height > 2000) throw Error("Height must be between 24 and 2000 pixels.");
        const id = randomUUID();
        const entry = { version: 1, title: title.trim(), format: "html", inline: true, width: 720, height, createdAt: Date.now() };
        const artifact = await writeVersion(folder, id, [], entry, html, undefined, assertActive);
        return summary(artifact, entry);
      }),
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
          const group = latest.group ? { group: latest.group } : {};
          if (interactiveOf(latest)) {
            const html = await readVersionFile(htmlFile(folder, entry.id, latest.version));
            designs.push({ title: latest.title, ...group, interactive: { html, width: latest.width, height: latest.height } });
            continue;
          }
          const source = await readVersionFile(documentFile(folder, entry.id, latest.version));
          designs.push({ title: latest.title, ...group, document: JSON.parse(source) });
        }
        return { schemaVersion: 1, title: request.title, designs };
      }),
    show: async (request, { assertActive, roots } = {}) => {
      const imported = await importAssets(request?.assets, roots);
      try {
        return await showPage(request, imported, assertActive);
      } finally {
        await discard(imported);
      }
    },
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
    assetPath: (request) =>
      serial(async () => {
        const folder = await chat(request?.chatId);
        const current = (await activeArtifacts(folder, "html"))[0];
        if (typeof request?.hash !== "string" || !ASSET_HASH.test(request.hash) || !current?.versions.at(-1).assets?.some((item) => item.hash === request.hash))
          throw Error("This file is no longer on the page.");
        return assetFile(folder, current.id, request.hash);
      }),
    validateDesign: async ({ chatId, document }) => {
      await chat(chatId);
      await verifyKit(chatId, document);
      designImplementation().validateDesignConsistency(document);
      return document;
    },
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
        let source = null;
        if (request.from !== undefined) {
          if (request.document !== undefined || request.html !== undefined) throw Error("Send document, html OR from, not two of them.");
          const from = await load(folder, request.from?.id);
          if (!from) throw Error(`The design ${request.from?.id} to start from is no longer available.`);
          editable(from);
          source = await readVersion(folder, from, request.from.version);
        } else if (request.operations !== undefined || request.edits !== undefined)
          throw Error("operations and edits go with from; to revise a design in place, use design_apply.");
        if (request.html !== undefined && request.document !== undefined) throw Error("Send document OR html, not both.");
        const interactive = request.html !== undefined || source?.interactive === true;
        if (existing && interactiveOf(existing.versions.at(-1)) !== interactive) throw Error(KIND_MISMATCH);
        const previous = existing?.versions ?? [];
        const group = typeof request.group === "string" ? request.group.trim().slice(0, 60) : (previous.at(-1)?.group ?? source?.group);
        if (interactive) {
          if (source && request.operations !== undefined) throw Error("This design is interactive HTML: change the copy with edits, not layer operations.");
          const html = checkDesignHtml(source ? (request.edits?.length ? editDesignHtml(source.html, request.edits) : source.html) : request.html);
          const screen = previous.at(-1) ?? source;
          if (!screen && (request.width === undefined || request.height === undefined))
            throw Error("An interactive design needs its screen width and height, such as 390 by 844 for a phone.");
          const entry = {
            version: (previous.at(-1)?.version ?? 0) + 1,
            title: request.title.trim().slice(0, 120),
            ...(group ? { group } : {}),
            width: size(request.width, screen?.width ?? VIEWPORT.width),
            height: size(request.height, screen?.height ?? VIEWPORT.height),
            format: "design",
            interactive: true,
            createdAt: Date.now(),
          };
          const artifact = await writeVersion(folder, id, previous, entry, html, undefined, assertActive);
          return summary(artifact, entry);
        }
        if (request.edits !== undefined) throw Error("This design is made of layers: change the copy with operations. edits are for interactive designs.");
        const inheritedConsistency = existing ? (await readVersion(folder, existing)).document?.consistency : undefined;
        const document = source
          ? request.operations?.length
            ? designImplementation().applyDesignOperations(source.document, request.operations)
            : designImplementation().validateDesignDocument(source.document)
          : designImplementation().validateDesignDocument({
              ...request.document,
              ...(!request.document?.consistency && inheritedConsistency ? { consistency: inheritedConsistency } : {}),
            });
        await verifyKit(request.chatId, document);
        designImplementation().validateDesignConsistency(document);
        const entry = {
          version: (previous.at(-1)?.version ?? 0) + 1,
          title: request.title.trim().slice(0, 120),
          ...(group ? { group } : {}),
          ...(document.kit ? { kit: { id: document.kit.id, version: document.kit.version, title: document.kit.title } } : {}),
          ...(document.consistency ? { consistency: { mode: document.consistency.mode } } : {}),
          width: document.width,
          height: document.height,
          format: "design",
          createdAt: Date.now(),
        };
        await designImplementation().loadDesignFonts(document);
        const artifact = await writeVersion(folder, id, previous, entry, designImplementation().designHtml(document), document, assertActive);
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
        if (current.interactive) {
          if (request.operations !== undefined || request.intent !== undefined)
            throw Error("This design is interactive HTML: change it with edits (the text to find and its replacement), not layer operations.");
          const html = checkDesignHtml(editDesignHtml(current.html, request.edits));
          const entry = {
            version: current.version + 1,
            title: current.title,
            ...(current.group ? { group: current.group } : {}),
            width: current.width,
            height: current.height,
            format: "design",
            interactive: true,
            createdAt: Date.now(),
          };
          const artifact = await writeVersion(folder, existing.id, existing.versions, entry, html, undefined, assertActive);
          return { ...summary(artifact, entry), latest: entry.version, html };
        }
        if (request.edits !== undefined) throw Error("This design is made of layers: change it with operations. edits are for interactive designs.");
        const document = designImplementation().applyDesignOperations(current.document, request.operations, request.intent);
        await verifyKit(request.chatId, document);
        designImplementation().validateDesignConsistency(document);
        const entry = {
          version: current.version + 1,
          title: current.title,
          ...(current.group ? { group: current.group } : {}),
          ...(document.kit ? { kit: { id: document.kit.id, version: document.kit.version, title: document.kit.title } } : {}),
          ...(document.consistency ? { consistency: { mode: document.consistency.mode } } : {}),
          width: document.width,
          height: document.height,
          format: "design",
          createdAt: Date.now(),
        };
        await designImplementation().loadDesignFonts(document);
        const html = designImplementation().designHtml(document);
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
        if (isHtml && !artifact.versions.at(-1).inline) artifact = (await activeArtifacts(folder, "html"))[0] ?? artifact;
        const current = await readVersion(folder, artifact, isHtml ? undefined : request.version);
        if (!Array.isArray(request.fonts?.have) || current.format !== "design") return current;
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
        if (request.format === "html")
          return { id: current.id, version: current.version, filename: `${current.id}-v${current.version}.html`, mimeType: "text/html", content: current.html };
        if (current.interactive) throw Error("An interactive design exports as html.");
        if (request.format !== "json" && request.format !== "svg") throw Error("Choose json, svg or html for the design export.");
        const svg = request.format === "svg";
        return {
          id: current.id,
          version: current.version,
          filename: `${current.id}-v${current.version}.${request.format}`,
          mimeType: svg ? "image/svg+xml" : "application/json",
          content: svg ? designImplementation().designSvg(current.document, { embedFonts: false }) : JSON.stringify(current.document, null, 2),
        };
      }),
    list: (request) =>
      serial(async () => {
        const folder = await chat(request?.chatId);
        checkFormat(request.format);
        return (await activeArtifacts(folder, request.format)).map((artifact) => summary(artifact, artifact.versions.at(-1)));
      }),
    deleteDesign: (request, { assertActive } = {}) =>
      serial(async () => {
        await assertActive?.();
        const folder = await chat(request?.chatId);
        const existing = await load(folder, request?.id);
        if (!existing) throw Error("This design is no longer available.");
        editable(existing);
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

const editsInput = z
  .array(
    z.object({
      find: z.string().min(1).describe("Exact text in the design's HTML, enough of it to occur once."),
      replace: z.string().describe("The text that takes its place."),
      all: z.boolean().optional().describe("Replace every occurrence instead of exactly one."),
    }),
  )
  .min(1)
  .max(200);

function artifactToolDefinitions(
  chatId,
  api,
  authorization,
  { renderPng = renderDesignPng, warnings = (...args) => designImplementation().designWarnings(...args), screenshot = screenshotDesign } = {},
) {
  const feedback = { renderPng, warnings };
  return [
    {
      name: "design_show",
      description: `For any UI, screen, mockup or visual design in this Chat, subagents included: use this, not HTML or image files, so it lands on the Chat's Designs canvas, where the user watches, reviews, comments and chooses on desktop and phone, and asks for changes through Chat. Only agents change designs. A static design is a document of named layers, with frames, text, shapes, vector paths and rings, icons, images, layout and color tokens; the document sets the screen size (390 by 844 for a phone). ${INTERACTIVE_GUIDE} Read the bundled design skill (${DESIGN_SKILL}) for both formats. A new id creates a design; revising an existing id requires expectedVersion from design_read. Prefer design_apply for small revisions. Use a different id for each variant, in the same group; to revise a design, keep its id. For a variant of a saved design, send from (its id and version) and only the operations (layers) or edits (interactive) that differ, instead of the whole design: Milagre copies it and applies them. When the user names another design tool, use that tool instead. The result includes the rendered design as an image, with layout warnings or console messages; check them before replying.`,
      input: {
        title: z.string().min(1).max(120),
        group: z
          .string()
          .max(60)
          .optional()
          .describe(
            "The part of the app this screen belongs to, such as Onboarding or Settings. The canvas lays out one row per group. A revision keeps its group unless you pass one; an empty string removes it.",
          ),
        document: designDocumentInputSchema.optional().describe("A static design's layers. Send document, html OR from."),
        html: z
          .string()
          .min(1)
          .max(MAX_HTML)
          .optional()
          .describe("An interactive design: one self-contained HTML page. Send document, html OR from; give width and height with a new one."),
        width: z.number().int().min(240).max(3840).optional().describe("An interactive design's screen width, such as 390 for a phone."),
        height: z.number().int().min(240).max(3840).optional().describe("An interactive design's screen height, such as 844 for a phone."),
        from: z
          .object({ id: z.string().regex(ID), version: z.number().int().positive().optional() })
          .optional()
          .describe("A saved design to copy (its latest version unless you name one), for a variant. Send document, html OR from."),
        operations: z
          .array(designOperationInputSchema)
          .max(1000)
          .optional()
          .describe("With from, for a layer design: the design_apply operations that turn the copy into the variant."),
        edits: editsInput.optional().describe("With from, for an interactive design: the edits that turn the copy into the variant."),
        id: z.string().regex(ID).optional(),
        expectedVersion: z.number().int().nonnegative().optional(),
        mode: DESIGN_MODE_INPUT,
      },
      readOnly: false,
      run: async ({ mode, ...args }) => {
        if ([args.document, args.html, args.from].filter((value) => value !== undefined).length !== 1)
          throw Error("Send document (layers), html (interactive) OR from (with operations or edits).");
        const design = await api.showDesign({ chatId, ...args }, authorization);
        if (design.interactive)
          return interactiveFeedback(design, args.html ?? (await api.get({ chatId, id: design.id, version: design.version, format: "design" })).html, {
            screenshot,
          });
        const document =
          args.from || (!args.document.consistency && design.consistency)
            ? (await api.get({ chatId, id: design.id, version: design.version, format: "design" })).document
            : designImplementation().validateDesignDocument(args.document);
        return designFeedback(design, document, { ...feedback, mode });
      },
    },
    {
      name: "design_read",
      description:
        "Read a design, the latest version unless you name one: a layer design's document and layer ids, or an interactive design's html. Read before editing and send its version as expectedVersion to design_apply or design_show.",
      input: { id: z.string().regex(ID), version: z.number().int().positive().optional() },
      readOnly: true,
      run: async (args) => {
        const { html, ...design } = await api.get({ chatId, ...args, format: "design" });
        return JSON.stringify(design.interactive ? { ...design, html } : design);
      },
    },
    {
      name: "design_inspect",
      description:
        "Inspect a saved design without creating a version. Returns its image; for a layer design also computed layer bounds, contrast coverage and preview limitations, for an interactive design its console messages. Use this when taking over from another model or checking a design before you change it. nodeId crops a layer design's image to a visible layer; diagnostics still cover the whole screen.",
      input: {
        id: z.string().regex(ID),
        version: z.number().int().positive().optional(),
        nodeId: z.string().regex(LAYER_ID).optional(),
        mode: DESIGN_MODE_INPUT,
      },
      readOnly: true,
      run: async ({ nodeId, mode, ...args }) => {
        const { html, document, ...saved } = await api.get({ chatId, ...args, format: "design" });
        if (saved.interactive) {
          if (nodeId) throw Error("An interactive design has no layers; inspect it without nodeId.");
          return interactiveFeedback(saved, html, { screenshot });
        }
        return inspectLayerDesign(saved, document, { ...feedback, nodeId, mode });
      },
    },
    {
      name: "design_validate",
      description:
        "Preflight a proposed document, or a batch against a saved design and expectedVersion, without saving. Optional intent is enforced exactly as on design_apply. Returns validation errors with field paths, measured layout shortages, candidate repair operations (validate before applying) and the resulting document. Use before a complex edit. Send document OR id, expectedVersion and operations. For an interactive design, send html with width and height: it returns the first screen drawn and the console messages, without saving.",
      input: {
        document: designDocumentInputSchema.optional(),
        html: z.string().min(1).max(MAX_HTML).optional(),
        width: z.number().int().min(240).max(3840).optional(),
        height: z.number().int().min(240).max(3840).optional(),
        id: z.string().regex(ID).optional(),
        expectedVersion: z.number().int().positive().optional(),
        operations: z.array(designOperationInputSchema).min(1).max(1000).optional(),
        intent: designEditIntentSchema.optional(),
      },
      readOnly: true,
      run: async (args) => {
        if (args.html !== undefined) {
          if (args.document || args.id || args.operations || !args.width || !args.height) throw Error("Send html with width and height, and nothing else.");
          const problems = checkDesignCode(args.html);
          if (problems.length) return JSON.stringify({ valid: false, errors: problems });
          return interactiveFeedback({ valid: true, width: args.width, height: args.height }, args.html, { screenshot });
        }
        let document;
        try {
          if (args.document !== undefined) {
            if (args.id || args.operations || args.expectedVersion || args.intent) throw Error("Send document OR id, expectedVersion and operations.");
            document = designImplementation().validateDesignDocument(args.document);
          } else {
            if (!args.id || !args.expectedVersion || !args.operations) throw Error("Send document OR id, expectedVersion and operations.");
            const current = await api.get({ chatId, id: args.id, format: "design" });
            if (current.version !== args.expectedVersion)
              throw Error(`Design version conflict: expected ${args.expectedVersion}, latest ${current.version}. Read again.`);
            document = designImplementation().applyDesignOperations(current.document, args.operations, args.intent);
          }
          await api.validateDesign?.({ chatId, document });
          await designImplementation().loadDesignFonts(document);
          return JSON.stringify({ valid: true, document, diagnostics: designImplementation().designDiagnostics(document) });
        } catch (error) {
          return JSON.stringify({
            valid: false,
            errors: designImplementation().designErrorIssues(error),
            ...(error.code ? { code: error.code } : {}),
            ...(error.diagnostics ? { diagnostics: error.diagnostics } : {}),
            ...(error.code === "DESIGN_KIT_DRIFT" && document ? { diagnostics: designImplementation().designDiagnostics(document) } : {}),
          });
        }
      },
    },
    {
      name: "design_apply",
      description:
        "Revise a design on this Chat's Designs canvas, keeping its id; any agent or subagent changing a design uses this (or design_show with expectedVersion), never a separate file. Change a layer design with one atomic batch of layer operations: update properties, insert a layer, or delete a layer and its descendants; use stable layer ids. Change an interactive design with edits: each the exact text to find in its HTML (once, unless all) and its replacement, applied in order. To replace the whole design, use design_show with its id and expectedVersion. expectedVersion must match the latest version read; a conflict changes nothing, so read again and reapply the intended edits. Optional intent (layer designs) enforces text-only preservation or fit-text within declared textIds/layoutIds. Rejected intent or an edit that doesn't match saves nothing. One successful batch creates one immutable version and shows its design card.",
      input: {
        id: z.string().regex(ID),
        expectedVersion: z.number().int().positive(),
        operations: z.array(designOperationInputSchema).min(1).max(1000).optional().describe("For a layer design."),
        edits: editsInput.optional().describe("For an interactive design."),
        intent: designEditIntentSchema.optional(),
      },
      readOnly: false,
      run: async (args) => {
        if ((args.operations === undefined) === (args.edits === undefined)) throw Error("Send operations (layer design) OR edits (interactive design).");
        const { html, document, ...design } = await api.apply({ chatId, ...args }, authorization);
        if (design.interactive) return interactiveFeedback(design, html, { screenshot });
        return designFeedback(design, document, { ...feedback, intent: args.intent });
      },
    },
    {
      name: "design_export",
      description:
        "Export a design version: a layer design as its source JSON document, a standalone SVG or its HTML page; an interactive design as its HTML. The SVG names its fonts without embedding them. Returns the filename, MIME type and file content. Save the content to a file when the user requests a downloadable export.",
      input: { id: z.string().regex(ID), version: z.number().int().positive().optional(), format: z.enum(["json", "svg", "html"]) },
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
  ].map((tool) => ({
    ...tool,
    run: async (args) => {
      try {
        return await tool.run(args);
      } catch (error) {
        throw designImplementation().conciseDesignError(error);
      }
    },
  }));
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
        "Mark one of the user's comments on a design or HTML artifact resolved once you have addressed it (usually after showing a revised version), with a short note on what you changed. The pin disappears from the canvas; the comment and your note remain in Chat history. The comment's id is in the user's message, or from artifact_comments.",
      input: { id: z.string().regex(COMMENT_ID), note: z.string().min(1).max(2000) },
      readOnly: false,
      run: async (args) => JSON.stringify(await api.resolveComment({ chatId, ...args }, authorization)),
    },
  ];
}
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
