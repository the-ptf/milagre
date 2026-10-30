import { designSvg, validateDesignDocument } from "./design.mjs";
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
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.designs) || !value.designs.length)
    throw Error("A shared page must contain at least one design.");
  const snapshot = {
    schemaVersion: 1,
    title: title(value.title),
    designs: value.designs.map((design) => {
      const document = validateDesignDocument(design?.document);
      for (const node of document.nodes) {
        if (node.type === "image" && node.src && !isSnapshotRaster(node.src)) throw Error("Shared page images must be embedded PNG, JPEG, GIF or WebP files.");
      }
      const group = typeof design?.group === "string" ? design.group.trim().slice(0, 60) : "";
      return { title: title(design?.title), ...(group ? { group } : {}), document };
    }),
  };
  freeze(snapshot);
  validatedSnapshots.add(snapshot);
  return snapshot;
}

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

/** Link previews read this. Drop a leading repeat of the title and cut at a word near the limit. */
function summary(text, pageTitle) {
  let value = text.replace(/\s+/g, " ").trim();
  if (pageTitle && value.toLowerCase().startsWith(pageTitle.toLowerCase())) value = value.slice(pageTitle.length).replace(/^[\s:·|.,-]+/, "");
  if (value.length <= DESIGN_PAGE_DESCRIPTION_CHARACTERS) return value;
  const cut = value.slice(0, DESIGN_PAGE_DESCRIPTION_CHARACTERS - 1);
  const space = cut.lastIndexOf(" ");
  return (space > DESIGN_PAGE_DESCRIPTION_CHARACTERS / 2 ? cut.slice(0, space) : cut).replace(/[\s:·|.,-]+$/, "") + "…";
}

/** The page's own description wins; otherwise its visible text. Scripts, styles and markup never reach the preview. */
function artifactDescription(artifact, pageTitle) {
  const meta = /<meta\s[^>]*(?:name|property)\s*=\s*["'](?:description|og:description)["'][^>]*>/i.exec(artifact.html);
  const content = meta && /\scontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(meta[0]);
  const declared = content ? summary(decodeEntities(content[1] ?? content[2]), "") : "";
  if (declared) return declared;
  const text = artifact.html
    .replace(/<(script|style|template|noscript|title|svg|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ");
  return summary(decodeEntities(text), pageTitle);
}

/** Several designs are named; one design is described by its own text layers, in document order. */
function designsDescription(page) {
  if (page.designs.length > 1) {
    const names = page.designs.map((design) => design.title);
    return summary(`${names.length} designs: ${names.slice(0, -1).join(", ")} and ${names.at(-1)}.`, "");
  }
  const [design] = page.designs;
  const byId = new Map(design.document.nodes.map((node) => [node.id, node]));
  const visible = (node, depth = 0) =>
    !node.hidden && (!node.parentId || depth > 64 || !byId.has(node.parentId) || visible(byId.get(node.parentId), depth + 1));
  const layers = design.document.nodes.filter((node) => node.type === "text" && node.text?.trim() && visible(node)).map((node) => node.text.trim());
  const named = design.title.toLowerCase() === page.title.toLowerCase() ? [] : [design.title];
  return summary([...named, ...layers].join(" · "), page.title);
}

// The desktop Canvas's spacing: between frames and blocks, a block's padding around its frames (canvas pixels), a
// group's name above its block (screen pixels) and the title row above each frame.
const GAP = 80;
const GROUP_PADDING = 48;
const GROUP_LABEL = 30;
const CAPTION = 42;
// A block's name keeps its screen size through --inv (the inverse zoom the controller sets), like the desktop Canvas.
const GROUP_STYLE =
  `section{display:flex;flex-direction:column;align-items:flex-start}.name{position:relative;flex-shrink:0;height:calc(${GROUP_LABEL}px * var(--inv,1))}` +
  ".name>div{position:absolute;bottom:0;left:0;display:flex;align-items:baseline;gap:8px;padding-bottom:8px;white-space:nowrap;font:500 13px/1.35 system-ui,sans-serif;color:#e5edf3;transform:scale(var(--inv,1));transform-origin:bottom left}" +
  ".name .none{color:#9199a4}.name b{font-weight:400;color:#9199a4;font-variant-numeric:tabular-nums}" +
  `.block{display:flex;align-items:flex-start;gap:${GAP}px;padding:${GROUP_PADDING}px;border-radius:40px;background:rgb(255 255 255/.05)}`;
/** One row per group, in the order they first appear; designs without a group share a row where the first of them is. */
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

// Public pages carry no header or footer: the content fills the window, the zoom bar floats bottom-left as on the
// desktop Canvas and the Milagre logo bottom-right. Colors are desktop's dark theme tokens (surface, ink, ink-2, line, shadow-card). CSP forbids external
// resources, so the icons (Hugeicons minus, plus, fit-to-screen) and the Milagre mark are inline SVG.
const icon = (size, paths) =>
  `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths.map((d) => `<path d="${d}"/>`).join("")}</svg>`;
const MILAGRE_MARK =
  '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 146 145" fill="currentColor"><path d="M69.528 1.96636C71.0759 -0.655453 74.869 -0.655453 76.4169 1.96636L91.0103 26.6837C91.3538 27.2656 91.8392 27.751 92.4211 28.0945L117.138 42.6879C119.76 44.2358 119.76 48.0289 117.138 49.5768L92.4211 64.1702C91.8392 64.5137 91.3538 64.9991 91.0103 65.581L76.4169 90.2983C74.869 92.9201 71.0759 92.9201 69.528 90.2983L54.9347 65.581C54.5911 64.9991 54.1057 64.5137 53.5238 64.1702L28.8065 49.5768C26.1847 48.0289 26.1847 44.2358 28.8065 42.6879L53.5238 28.0945C54.1057 27.751 54.5911 27.2656 54.9347 26.6837L69.528 1.96636Z"/><path d="M49.6983 66.5562L21.6836 116.174C19.802 119.507 22.2098 123.632 26.0372 123.632H39.9727L54.9727 100.132L66.9727 119.632L51.9727 144.132H26.0372C6.24066 144.132 -6.29344 122.89 3.27837 105.561L30.9405 55.4819L49.6983 66.5562Z"/><path d="M142.666 105.561C152.238 122.89 139.704 144.132 119.907 144.132H93.9728L78.9728 119.632L90.9728 100.132L105.973 123.632H119.907C123.735 123.632 126.143 119.507 124.261 116.174L96.2462 66.5562L115.004 55.4819L142.666 105.561Z"/></svg>';
const CHROME_STYLE =
  ".sr{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}" +
  ".dock{position:fixed;left:16px;right:16px;bottom:16px;z-index:1;display:flex;align-items:center;gap:8px;pointer-events:none}.dock>*{pointer-events:auto}" +
  ".bar,.logo{height:32px;border-radius:8px;background:#172232;box-shadow:0 0 0 1px rgb(255 255 255/.11),0 1px 2px rgb(0 0 0/.2),0 2px 6px rgb(0 0 0/.2)}" +
  ".bar{display:flex;align-items:center}.bar button{height:32px;display:flex;align-items:center;justify-content:center;border:0;padding:0;background:none;color:#e9eff7;font:500 12px/1 system-ui,sans-serif;cursor:pointer;transition:color .15s}" +
  ".bar .step{width:32px;color:#9199a4}.bar .step:hover{color:#e9eff7}#zoom{width:44px;font-variant-numeric:tabular-nums}.bar i{width:1px;height:16px;background:#273242}#fit{gap:6px;padding:0 10px}#fit:hover{color:#9199a4}" +
  ".logo{width:32px;margin-left:auto;display:flex;align-items:center;justify-content:center;color:#9199a4;transition:color .15s,background-color .15s}.logo:hover{color:#e9eff7;background:#202b3b}" +
  ".dock svg{display:block}.dock :focus-visible{outline:2px solid #91bdff;outline-offset:2px}";
const LOGO_LINK = `<a class="logo" href="https://milagre.cloud" target="_blank" rel="noopener noreferrer" aria-label="Made with Milagre">${MILAGRE_MARK}</a>`;
const ZOOM_BAR = `<nav class="bar" aria-label="Canvas zoom"><button id="out" class="step" aria-label="Zoom out">${icon(14, ["M20 12L4 12"])}</button><button id="zoom" aria-label="Zoom to 100%"></button><button id="in" class="step" aria-label="Zoom in">${icon(14, ["M12 4V20M20 12H4"])}</button><i aria-hidden="true"></i><button id="fit" aria-label="Fit everything">${icon(13, ["M3 4V20", "M21 4V20", "M15.6216 9L16.5002 9.87868C17.5002 10.8787 18.0002 11.3787 18.0002 12C18.0002 12.6213 17.5002 13.1213 16.5002 14.1213L15.6216 15M8.37892 9L7.50024 9.87868C6.50024 10.8787 6.00024 11.3787 6.00024 12C6.00024 12.6213 6.50024 13.1213 7.50024 14.1213L8.37892 15M6.37892 12H17.6216"])}Fit</button></nav>`;

/** Public output contains generated SVG images and a fixed controller, never source JSON or Chat metadata. */
/** `files` gives the public URL of an Artifact page's file; without it, its `assets/<name>` references stay as written. */
export function renderDesignPage(input, { files } = {}) {
  const page = validatedSnapshots.has(input) ? input : validateDesignPageSnapshot(input);
  if (page.kind === "artifacts") return renderArtifactPage(page, files);
  // Laid out as the desktop Canvas does: one row of frames, or once any design names a group, one block per group
  // (the groups and the designs in each in the order they first appear, designs without a group in a row of their own)
  // with the group's name above it. The name keeps its screen size, so the fit allows for it at the zoom it lands on.
  const rows = designRows(page.designs);
  const grouped = rows.some((row) => row.group);
  const pad = grouped ? GROUP_PADDING : 0;
  const rowWidth = (row) => row.designs.reduce((sum, item) => sum + item.document.width, 0) + GAP * (row.designs.length - 1) + 2 * pad;
  const rowHeight = (row) => row.designs.reduce((maximum, item) => Math.max(maximum, item.document.height), 0) + CAPTION + 2 * pad;
  const width = Math.max(...rows.map(rowWidth));
  const height = rows.reduce((sum, row) => sum + rowHeight(row), 0) + GAP * (rows.length - 1);
  const labels = grouped ? rows.length : 0;
  const renderFrames = (embedFonts) => {
    const frame = ({ title: name, document }) =>
      `<figure style="width:${document.width}px"><figcaption>${escape(name)}</figcaption><img draggable="false" width="${document.width}" height="${document.height}" alt="${escape(name)}" src="data:image/svg+xml,${encodeURIComponent(designSvg(document, { embedFonts, renderByteLimit: Infinity }))}"></figure>`;
    if (!grouped) return page.designs.map(frame).join("");
    return rows
      .map(
        (row) =>
          `<section aria-label="${escape(row.group ?? "Ungrouped")}"><div class="name"><div><span${row.group ? "" : ' class="none"'}>${escape(row.group ?? "Ungrouped")}</span><b>${row.designs.length}</b></div></div><div class="block">${row.designs.map(frame).join("")}</div></section>`,
      )
      .join("");
  };
  const description = descriptionMeta(designsDescription(page));
  const render = (embedFonts) => {
    const frames = renderFrames(embedFonts);
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>${escape(page.title)} | Milagre Designs</title>${description}<style>
*{box-sizing:border-box}html,body{margin:0;height:100%;font-family:system-ui,sans-serif;background:#111922;color:#e5edf3}body{display:flex;flex-direction:column}#viewport:focus-visible{outline:2px solid #91bdff;outline-offset:-2px}#viewport{position:relative;overflow:hidden;flex:1;touch-action:none;cursor:grab;background-image:radial-gradient(#304052 1px,transparent 1px);background-size:20px 20px}#canvas{position:absolute;display:flex;${grouped ? "flex-direction:column;align-items:flex-start;" : ""}gap:${GAP}px;transform-origin:0 0;width:${width}px;min-height:${height}px}${grouped ? GROUP_STYLE : ""}figure{margin:0;flex-shrink:0}figcaption{height:42px;padding:10px 0;font-size:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}img{display:block;pointer-events:none;box-shadow:0 4px 24px #0005;background:white}${CHROME_STYLE}
</style></head><body><h1 class="sr">${escape(page.title)}</h1><main id="viewport" tabindex="0" aria-label="Designs canvas. Drag to pan; use plus and minus to zoom."><div id="canvas">${frames}</div></main><div class="dock">${ZOOM_BAR}${LOGO_LINK}</div><script>
(()=>{const port=document.getElementById('viewport'),canvas=document.getElementById('canvas'),label=document.getElementById('zoom');let x=0,y=0,scale=1;const points=new Map();const paint=()=>{canvas.style.transform='translate('+x+'px,'+y+'px) scale('+scale+')';canvas.style.setProperty('--inv',1/scale);label.textContent=(scale<.01?Math.round(scale*1000)/10:Math.round(scale*100))+'%'};const zoom=(factor,px=port.clientWidth/2,py=port.clientHeight/2)=>{const next=Math.max(.0001,Math.min(4,scale*factor));x=px-(px-x)*next/scale;y=py-(py-y)*next/scale;scale=next;paint()};const fit=()=>{let h=${height};scale=Math.min(1,Math.max(.0001,Math.min((port.clientWidth-48)/${width},(port.clientHeight-112)/h)));h+=${labels * GROUP_LABEL}*(1/scale-1);scale=Math.min(scale,Math.max(.0001,(port.clientHeight-112)/h));h=${height}+${labels * GROUP_LABEL}*(1/scale-1);x=(port.clientWidth-${width}*scale)/2;y=(port.clientHeight-h*scale)/2;paint()};document.getElementById('in').onclick=()=>zoom(1.25);document.getElementById('out').onclick=()=>zoom(.8);document.getElementById('fit').onclick=fit;label.onclick=()=>zoom(1/scale);port.addEventListener('wheel',e=>{e.preventDefault();if(e.ctrlKey||e.metaKey){const r=port.getBoundingClientRect();zoom(Math.exp(-e.deltaY*.01),e.clientX-r.left,e.clientY-r.top)}else{x-=e.deltaX;y-=e.deltaY;paint()}},{passive:false});port.onpointerdown=e=>{if(e.button!==0)return;port.setPointerCapture(e.pointerId);points.set(e.pointerId,{x:e.clientX,y:e.clientY})};port.onpointermove=e=>{const old=points.get(e.pointerId);if(!old)return;if(points.size===1){x+=e.clientX-old.x;y+=e.clientY-old.y;paint()}else{const other=[...points.entries()].find(([id])=>id!==e.pointerId)[1];const before=Math.hypot(old.x-other.x,old.y-other.y),after=Math.hypot(e.clientX-other.x,e.clientY-other.y),r=port.getBoundingClientRect();if(before>0){zoom(after/before,(old.x+other.x)/2-r.left,(old.y+other.y)/2-r.top);x+=(e.clientX-old.x)/2;y+=(e.clientY-old.y)/2;paint()}}points.set(e.pointerId,{x:e.clientX,y:e.clientY})};port.onpointerup=port.onpointercancel=port.onlostpointercapture=e=>points.delete(e.pointerId);port.onkeydown=e=>{if(e.key==='+'||e.key==='='){e.preventDefault();zoom(1.25)}if(e.key==='-'){e.preventDefault();zoom(.8)}if(e.key==='0'){e.preventDefault();fit()}};new ResizeObserver(fit).observe(port);fit()})();
</script></body></html>`;
    return html;
  };
  return render(true);
}

/** An Artifact is one current HTML page. Publishing freezes that content in an opaque sandbox. */
function validateArtifactPageSnapshot(value) {
  if (value.schemaVersion !== 1 || !Array.isArray(value.artifacts) || value.artifacts.length !== 1)
    throw Error("An Artifact snapshot contains exactly one page.");
  const item = value.artifacts[0];
  if (typeof item?.html !== "string" || !item.html.trim()) throw Error("An Artifact snapshot needs its HTML.");
  const dimension = (number) => {
    if (!Number.isInteger(number) || number < 240 || number > 3840) throw Error("Invalid Artifact page dimensions.");
    return number;
  };
  // The page's files travel separately (uploaded by hash before the snapshot); the snapshot names them.
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
  const snapshot = {
    schemaVersion: 1,
    kind: "artifacts",
    title: title(value.title),
    artifacts: [
      {
        title: title(item.title),
        html: item.html,
        width: dimension(item.width),
        height: dimension(item.height),
        // Left out when there are none, so a page without files keeps the snapshot it always had.
        ...(files.length ? { assets: files } : {}),
      },
    ],
  };
  freeze(snapshot);
  validatedSnapshots.add(snapshot);
  return snapshot;
}

function renderArtifactPage(page, files) {
  const [first] = page.artifacts;
  const artifact = files ? { ...first, html: rewriteAssetUrls(first.html, first.assets, files) } : first;
  // The HTTP policy is inherited by srcdoc, including blocked network and frame navigation.
  // The sandbox deliberately omits same-origin, forms, popups, downloads and top navigation.
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>${escape(page.title)} | Milagre Artifact</title>${descriptionMeta(artifactDescription(artifact, page.title))}<style>*{box-sizing:border-box}html,body{margin:0;height:100%;font-family:system-ui,sans-serif;background:#111922;color:#e5edf3}body{display:flex;flex-direction:column}main{flex:1;min-height:0;background:white}iframe{display:block;width:100%;height:100%;border:0}${CHROME_STYLE}</style></head><body><h1 class="sr">${escape(page.title)}</h1><main><iframe title="${escape(artifact.title)}" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${escape(artifact.html)}"></iframe></main><div class="dock">${LOGO_LINK}</div></body></html>`;
  return html;
}
