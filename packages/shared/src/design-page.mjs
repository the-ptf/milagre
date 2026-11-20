import { designSvg, validateDesignDocument } from "./design.mjs";
import { artifactDocument, checkDesignCode } from "./artifact-document.mjs";
import { ASSET_HASH, ASSET_NAME, MAX_ASSET_BYTES, MAX_PAGE_ASSETS, MAX_PAGE_ASSET_BYTES, rewriteAssetUrls } from "./artifact-assets.mjs";

const validatedSnapshots = new WeakSet();
function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const title = (value) => {
  if (typeof value !== "string" || !value.trim() || value.length > 120) throw Error("A public page title must have 1 to 120 characters.");
  return value.trim();
};

/** Only design content crosses this boundary. Unknown envelope fields are never retained. */
export function validateDesignPageSnapshot(value) {
  if (value?.kind === "artifacts") return validateArtifactPageSnapshot(value);
  if (value?.kind === "workspace") return validateWorkspaceSnapshot(value);
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.designs) || !value.designs.length)
    throw Error("A shared page must contain at least one design.");
  return seal({ schemaVersion: 1, title: title(value.title), designs: validateDesigns(value.designs) });
}

function seal(snapshot) {
  freeze(snapshot);
  validatedSnapshots.add(snapshot);
  return snapshot;
}

function validateDesigns(designs) {
  return designs.map((design) => {
    const group = typeof design?.group === "string" ? design.group.trim().slice(0, 60) : "";
    if (design?.interactive !== undefined)
      return { title: title(design?.title), ...(group ? { group } : {}), interactive: interactiveDesign(design.interactive) };
    const document = validateDesignDocument(design?.document);
    for (const node of document.nodes) {
      if (node.type === "image" && node.src && !isSnapshotRaster(node.src)) throw Error("Shared page images must be embedded PNG, JPEG, GIF or WebP files.");
    }
    return { title: title(design?.title), ...(group ? { group } : {}), document };
  });
}

function validateWorkspaceSnapshot(value) {
  if (value.schemaVersion !== 1 || !Array.isArray(value.designs)) throw Error("A shared workspace lists its designs.");
  if (!value.designs.length && !value.page) throw Error("A shared workspace must contain a design or its page.");
  return seal({
    schemaVersion: 1,
    kind: "workspace",
    title: title(value.title),
    designs: validateDesigns(value.designs),
    ...(value.page ? { page: validatePage(value.page) } : {}),
  });
}

/** The files a published page names, which the host uploads before the snapshot and the service serves beside it. */
export const pageAssets = (snapshot) =>
  (snapshot?.kind === "artifacts" ? snapshot.artifacts?.[0]?.assets : snapshot?.kind === "workspace" ? snapshot.page?.assets : null) ?? [];

function interactiveDesign(value) {
  const dimension = (number) => {
    if (!Number.isInteger(number) || number < 240 || number > 3840) throw Error("Invalid interactive design dimensions.");
    return number;
  };
  if (typeof value?.html !== "string" || !value.html.trim() || value.html.length > 1_000_000) throw Error("An interactive design needs its HTML.");
  const problems = checkDesignCode(value.html);
  if (problems.length) throw Error(problems.join(" "));
  return { html: value.html, width: dimension(value.width), height: dimension(value.height) };
}

export const designPageRunsCode = (snapshot) => snapshot?.kind !== "artifacts" && !!snapshot?.designs?.some((design) => design.interactive);

/** Check the decoded signature as well as the declared MIME type; SVG never enters a public snapshot. */
export function isSnapshotRaster(source) {
  const match = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(source);
  if (!match || match[2].length % 4 !== 0) return false;
  let prefix;
  try {
    prefix = atob(match[2].slice(0, 32));
  } catch {
    return false;
  }
  if (match[1] === "png") return prefix.startsWith("\x89PNG\r\n\x1a\n");
  if (match[1] === "jpeg") return prefix.startsWith("\xff\xd8\xff");
  if (match[1] === "gif") return prefix.startsWith("GIF87a") || prefix.startsWith("GIF89a");
  return prefix.startsWith("RIFF") && prefix.slice(8, 12) === "WEBP";
}

const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

export const DESIGN_PAGE_DESCRIPTION_CHARACTERS = 200;
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decodeEntities = (value) =>
  value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] !== "#") return ENTITIES[entity.toLowerCase()] ?? match;
    const code = entity[1] === "x" || entity[1] === "X" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });

function summary(text, pageTitle, limit = DESIGN_PAGE_DESCRIPTION_CHARACTERS) {
  let value = text.replace(/\s+/g, " ").trim();
  if (pageTitle && value.toLowerCase().startsWith(pageTitle.toLowerCase())) value = value.slice(pageTitle.length).replace(/^[\s:·|.,-]+/, "");
  if (value.length <= limit) return value;
  const cut = value.slice(0, limit - 1);
  const space = cut.lastIndexOf(" ");
  return (space > limit / 2 ? cut.slice(0, space) : cut).replace(/[\s:·|.,-]+$/, "") + "…";
}

function workspaceDescription(page) {
  const names = page.designs.map((design) => design.title);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
  const designs = names.length ? summary(`${names.length} design${names.length > 1 ? "s" : ""}: ${list}.`, "") : "";
  const room = DESIGN_PAGE_DESCRIPTION_CHARACTERS - designs.length - 1;
  const text = page.page && room > 40 ? artifactDescription(page.page, page.page.title, room) : "";
  return [text, designs].filter(Boolean).join(" ");
}

function artifactDescription(artifact, pageTitle, limit) {
  const meta = /<meta\s[^>]*(?:name|property)\s*=\s*["'](?:description|og:description)["'][^>]*>/i.exec(artifact.html);
  const content = meta && /\scontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(meta[0]);
  const declared = content ? summary(decodeEntities(content[1] ?? content[2]), "", limit) : "";
  if (declared) return declared;
  const text = artifact.html
    .replace(/<(script|style|template|noscript|title|svg|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ");
  return summary(decodeEntities(text), pageTitle, limit);
}

function designsDescription(page) {
  if (page.designs.length > 1) {
    const names = page.designs.map((design) => design.title);
    return summary(`${names.length} designs: ${names.slice(0, -1).join(", ")} and ${names.at(-1)}.`, "");
  }
  const [design] = page.designs;
  if (!design.document) return summary(design.title.toLowerCase() === page.title.toLowerCase() ? "" : design.title, page.title);
  const byId = new Map(design.document.nodes.map((node) => [node.id, node]));
  const visible = (node, depth = 0) =>
    !node.hidden && (!node.parentId || depth > 64 || !byId.has(node.parentId) || visible(byId.get(node.parentId), depth + 1));
  const layers = design.document.nodes.filter((node) => node.type === "text" && node.text?.trim() && visible(node)).map((node) => node.text.trim());
  const named = design.title.toLowerCase() === page.title.toLowerCase() ? [] : [design.title];
  return summary([...named, ...layers].join(" · "), page.title);
}

const GAP = 80;
const GROUP_PADDING = 48;
const GROUP_LABEL = 30;
const GROUP_STYLE =
  `section{display:flex;flex-direction:column;align-items:flex-start}.name{position:relative;flex-shrink:0;height:calc(${GROUP_LABEL}px * var(--inv,1))}` +
  ".name>div{position:absolute;bottom:0;left:0;display:flex;align-items:baseline;gap:8px;padding-bottom:8px;white-space:nowrap;font:500 13px/1.35 system-ui,sans-serif;color:#e5edf3;transform:scale(var(--inv,1));transform-origin:bottom left}" +
  ".name .none{color:#9199a4}.name b{font-weight:400;color:#9199a4;font-variant-numeric:tabular-nums}" +
  `.block{display:flex;align-items:flex-start;gap:${GAP}px;padding:${GROUP_PADDING}px;border-radius:40px;background:rgb(255 255 255/.05)}`;
function designRows(designs) {
  const rows = new Map();
  for (const design of designs) {
    const group = design.group ?? null;
    const row = rows.get(group);
    if (row) row.push(design);
    else rows.set(group, [design]);
  }
  return [...rows].map(([group, members]) => ({ group, designs: members }));
}

const descriptionMeta = (description) => (description ? `<meta name="description" content="${escape(description)}">` : "");

/**
 * Public output contains generated SVG images and sandboxed frames, never source JSON or Chat metadata. It has no
 * script: the sharing service adds the viewer when the page is read. `files` gives the public URL of an Artifact
 * page's file; without it, its `assets/<name>` references stay as written.
 */
export function renderDesignPage(input, { files } = {}) {
  const page = validatedSnapshots.has(input) ? input : validateDesignPageSnapshot(input);
  if (page.kind === "artifacts") return renderArtifactPage(page, files);
  const sheet = page.page && {
    title: page.page.title,
    page: files ? { ...page.page, html: rewriteAssetUrls(page.page.html, page.page.assets, files) } : page.page,
  };
  const items = sheet ? [sheet, ...page.designs] : page.designs;
  const groups = designRows(page.designs);
  const grouped = groups.some((row) => row.group);
  const rows = grouped ? [...(sheet ? [{ group: sheet.title, designs: [sheet] }] : []), ...groups] : [{ group: null, designs: items }];
  const pad = grouped ? GROUP_PADDING : 0;
  const screen = (item) => item.document ?? item.interactive ?? item.page;
  const rowWidth = (row) => row.designs.reduce((sum, item) => sum + screen(item).width, 0) + GAP * (row.designs.length - 1) + 2 * pad;
  const width = Math.max(...rows.map(rowWidth));
  const renderFrames = () => {
    const live = (name, { width: w, height: h }, srcdoc) =>
      `<figure style="width:${w}px"><figcaption>${escape(name)}</figcaption><iframe class="live" title="${escape(name)}" width="${w}" height="${h}" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${escape(srcdoc)}"></iframe></figure>`;
    const frame = ({ title: name, document, interactive, page: sheetPage }) =>
      sheetPage
        ? live(name, sheetPage, sheetPage.html)
        : interactive
          ? live(name, interactive, artifactDocument(interactive.html, { code: true }))
          : `<figure style="width:${document.width}px"><figcaption>${escape(name)}</figcaption><img draggable="false" width="${document.width}" height="${document.height}" alt="${escape(name)}" src="data:image/svg+xml,${encodeURIComponent(designSvg(document, { embedFonts: true, renderByteLimit: Infinity }))}"></figure>`;
    if (!grouped) return items.map(frame).join("");
    return rows
      .map(
        (row) =>
          `<section aria-label="${escape(row.group ?? "Ungrouped")}"><div class="name"><div><span${row.group ? "" : ' class="none"'}>${escape(row.group ?? "Ungrouped")}</span><b>${row.designs.length}</b></div></div><div class="block">${row.designs.map(frame).join("")}</div></section>`,
      )
      .join("");
  };
  const description = descriptionMeta(page.kind === "workspace" ? workspaceDescription(page) : designsDescription(page));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>${escape(page.title)} | Milagre Designs</title>${description}<style>
*{box-sizing:border-box}html,body{margin:0;font-family:system-ui,sans-serif;background:#111922;color:#e5edf3}#viewport{display:block;overflow:auto;padding:48px}#canvas{display:flex;${grouped ? "flex-direction:column;align-items:flex-start;" : ""}gap:${GAP}px;width:${width}px}${grouped ? GROUP_STYLE : ""}figure{margin:0;flex-shrink:0}figcaption{height:42px;padding:10px 0;font-size:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}img,iframe.live{display:block;border:0;box-shadow:0 4px 24px #0005;background:white}.sr{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
</style></head><body><h1 class="sr">${escape(page.title)}</h1><main id="viewport" aria-label="Designs canvas"><div id="canvas">${renderFrames()}</div></main></body></html>`;
}

function validateArtifactPageSnapshot(value) {
  if (value.schemaVersion !== 1 || !Array.isArray(value.artifacts) || value.artifacts.length !== 1)
    throw Error("An Artifact snapshot contains exactly one page.");
  return seal({ schemaVersion: 1, kind: "artifacts", title: title(value.title), artifacts: [validatePage(value.artifacts[0])] });
}

function validatePage(item) {
  if (typeof item?.html !== "string" || !item.html.trim()) throw Error("An Artifact snapshot needs its HTML.");
  const dimension = (number) => {
    if (!Number.isInteger(number) || number < 240 || number > 3840) throw Error("Invalid Artifact page dimensions.");
    return number;
  };
  const assets = item.assets === undefined ? [] : item.assets;
  if (!Array.isArray(assets) || assets.length > MAX_PAGE_ASSETS) throw Error("An Artifact page has too many files.");
  const names = new Set();
  let total = 0;
  const files = assets.map((asset) => {
    const { name, hash, size, type } = asset ?? {};
    if (typeof name !== "string" || !ASSET_NAME.test(name) || names.has(name)) throw Error("Invalid Artifact file name.");
    if (typeof hash !== "string" || !ASSET_HASH.test(hash)) throw Error("Invalid Artifact file hash.");
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ASSET_BYTES) throw Error("Invalid Artifact file size.");
    if (typeof type !== "string" || !/^[a-z]+\/[a-z0-9.+-]{1,80}$/.test(type)) throw Error("Invalid Artifact file type.");
    names.add(name);
    total += size;
    return { name, hash, size, type };
  });
  if (total > MAX_PAGE_ASSET_BYTES) throw Error("An Artifact page's files are too large.");
  return {
    title: title(item.title),
    html: item.html,
    width: dimension(item.width),
    height: dimension(item.height),
    ...(files.length ? { assets: files } : {}),
  };
}

function renderArtifactPage(page, files) {
  const [first] = page.artifacts;
  const artifact = files ? { ...first, html: rewriteAssetUrls(first.html, first.assets, files) } : first;
  // srcdoc inherits the HTTP policy, including blocked network and frame navigation.
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>${escape(page.title)} | Milagre Artifact</title>${descriptionMeta(artifactDescription(artifact, page.title))}<style>*{box-sizing:border-box}html,body{margin:0;height:100%;font-family:system-ui,sans-serif;background:#111922;color:#e5edf3}body{display:flex;flex-direction:column}main{flex:1;min-height:0;background:white}iframe{display:block;width:100%;height:100%;border:0}.sr{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}</style></head><body><h1 class="sr">${escape(page.title)}</h1><main><iframe title="${escape(artifact.title)}" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${escape(artifact.html)}"></iframe></main></body></html>`;
  return html;
}
