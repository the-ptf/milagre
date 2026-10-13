import { designSvg, validateDesignDocument } from "./design.mjs";

export const MAX_DESIGN_PAGE_BYTES = 8 * 1024 * 1024;
export const MAX_DESIGN_PAGE_HTML_BYTES = 8 * 1024 * 1024;
// Narrow text can emit one SVG tspan per character. Bound amplification before layout.
export const MAX_DESIGN_PAGE_TEXT_CHARACTERS = 50000;
const validatedSnapshots = new WeakSet();
const limitError = (message) => Object.assign(new Error(message), { status: 413 });
function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export const DESIGN_PAGE_PUBLIC_NOTICE =
  "This publishes every saved design on this page. Anyone with the link can view, copy or redistribute it. Copies may remain online permanently.";
const bytes = (value) => new TextEncoder().encode(value).byteLength;
const title = (value) => {
  if (typeof value !== "string" || !value.trim() || value.length > 120) throw Error("A public page title must have 1 to 120 characters.");
  return value.trim();
};

/** Only design content crosses this boundary. Unknown envelope fields are never retained. */
export function validateDesignPageSnapshot(value) {
  if (value?.kind === "artifacts") return validateArtifactPageSnapshot(value);
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.designs) || !value.designs.length || value.designs.length > 20)
    throw Error("A shared page must contain between 1 and 20 designs.");
  if (bytes(JSON.stringify(value)) > MAX_DESIGN_PAGE_BYTES) throw limitError("This Designs page exceeds the 8 MB sharing limit.");
  let nodeCount = 0;
  let textCharacters = 0;
  const snapshot = {
    schemaVersion: 1,
    title: title(value.title),
    designs: value.designs.map((design) => {
      const document = validateDesignDocument(design?.document);
      nodeCount += document.nodes.length;
      if (nodeCount > 5000) throw limitError("This Designs page exceeds the 5,000 layer sharing limit.");
      for (const node of document.nodes) {
        if (node.type === "text") textCharacters += (node.text ?? "").length;
        if (textCharacters > MAX_DESIGN_PAGE_TEXT_CHARACTERS) throw limitError("This Designs page exceeds the 50,000 text character sharing limit.");
        if (node.type === "image" && node.src && !isSnapshotRaster(node.src)) throw Error("Shared page images must be embedded PNG, JPEG, GIF or WebP files.");
      }
      return { title: title(design?.title), document };
    }),
  };
  if (bytes(JSON.stringify(snapshot)) > MAX_DESIGN_PAGE_BYTES) throw limitError("This Designs page exceeds the 8 MB sharing limit.");
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

/** Public output contains generated SVG images and a fixed controller, never source JSON or Chat metadata. */
export function renderDesignPage(input) {
  const page = validatedSnapshots.has(input) ? input : validateDesignPageSnapshot(input);
  if (page.kind === "artifacts") return renderArtifactPage(page);
  const width = page.designs.reduce((sum, item) => sum + item.document.width, 0) + 64 * (page.designs.length - 1);
  const height = Math.max(...page.designs.map((item) => item.document.height)) + 42;
  // Embedded Inter is about 330 KB per design; a page of many designs may only fit with the viewer's own fonts.
  const renderFrames = (embedFonts) => {
    let frameBytes = 0;
    return page.designs
      .map(({ title: name, document }) => {
        const frame = `<figure style="width:${document.width}px"><figcaption>${escape(name)}</figcaption><img draggable="false" width="${document.width}" height="${document.height}" alt="${escape(name)}" src="data:image/svg+xml,${encodeURIComponent(designSvg(document, { embedFonts }))}"></figure>`;
        frameBytes += bytes(frame);
        if (frameBytes > MAX_DESIGN_PAGE_HTML_BYTES) throw limitError("Rendered Designs page exceeds the 8 MB sharing limit.");
        return frame;
      })
      .join("");
  };
  const render = (embedFonts) => {
    const frames = renderFrames(embedFonts);
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escape(page.title)} | Milagre Designs</title><style>
*{box-sizing:border-box}html,body{margin:0;height:100%;font-family:system-ui,sans-serif;background:#111922;color:#e5edf3}body{display:flex;flex-direction:column}header{min-height:72px;padding:14px 20px;display:flex;align-items:center;gap:16px;border-bottom:1px solid #2a3643;background:#182330}header>div{min-width:0;flex:1}h1{font-size:16px;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}small{display:block;color:#9eafbd;font-size:12px;margin-top:4px}nav{margin-left:auto;display:flex;gap:8px;align-items:center;flex-shrink:0}button{border:1px solid #415367;border-radius:8px;padding:8px 12px;background:#202e3e;color:inherit;font:inherit;cursor:pointer}button:focus-visible,#viewport:focus-visible{outline:2px solid #91bdff;outline-offset:-2px}#zoom{font-size:12px;min-width:44px;text-align:center}#viewport{position:relative;overflow:hidden;flex:1;touch-action:none;cursor:grab;background-image:radial-gradient(#304052 1px,transparent 1px);background-size:20px 20px}#canvas{position:absolute;display:flex;gap:64px;transform-origin:0 0;width:${width}px;height:${height}px}figure{margin:0;flex-shrink:0}figcaption{height:42px;padding:10px 0;font-size:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}img{display:block;pointer-events:none;box-shadow:0 4px 24px #0005;background:white}footer{font-size:11px;color:#9eafbd;padding:9px 20px;background:#182330;border-top:1px solid #2a3643}@media(max-width:600px){header{padding:12px;gap:8px}h1{max-width:45vw}nav{gap:4px}button{padding:8px}footer{padding:8px 12px}}
</style></head><body><header><div><h1>${escape(page.title)}</h1><small>${page.designs.length} ${page.designs.length === 1 ? "design" : "designs"} · Published snapshot</small></div><nav aria-label="Canvas zoom"><button id="out" aria-label="Zoom out">−</button><output id="zoom" aria-live="polite"></output><button id="in" aria-label="Zoom in">+</button><button id="fit">Fit</button></nav></header><main id="viewport" tabindex="0" aria-label="Designs canvas. Drag to pan; use plus and minus to zoom."><div id="canvas">${frames}</div></main><footer>Made with Milagre · Read-only snapshot. Later edits do not change this page.</footer><script>
(()=>{const port=document.getElementById('viewport'),canvas=document.getElementById('canvas'),label=document.getElementById('zoom');let x=0,y=0,scale=1;const points=new Map();const paint=()=>{canvas.style.transform='translate('+x+'px,'+y+'px) scale('+scale+')';label.textContent=(scale<.01?Math.round(scale*1000)/10:Math.round(scale*100))+'%'};const zoom=(factor,px=port.clientWidth/2,py=port.clientHeight/2)=>{const next=Math.max(.0001,Math.min(4,scale*factor));x=px-(px-x)*next/scale;y=py-(py-y)*next/scale;scale=next;paint()};const fit=()=>{scale=Math.min(1,Math.max(.0001,Math.min((port.clientWidth-48)/${width},(port.clientHeight-48)/${height})));x=(port.clientWidth-${width}*scale)/2;y=(port.clientHeight-${height}*scale)/2;paint()};document.getElementById('in').onclick=()=>zoom(1.25);document.getElementById('out').onclick=()=>zoom(.8);document.getElementById('fit').onclick=fit;port.addEventListener('wheel',e=>{e.preventDefault();if(e.ctrlKey||e.metaKey){const r=port.getBoundingClientRect();zoom(Math.exp(-e.deltaY*.01),e.clientX-r.left,e.clientY-r.top)}else{x-=e.deltaX;y-=e.deltaY;paint()}},{passive:false});port.onpointerdown=e=>{if(e.button!==0)return;port.setPointerCapture(e.pointerId);points.set(e.pointerId,{x:e.clientX,y:e.clientY})};port.onpointermove=e=>{const old=points.get(e.pointerId);if(!old)return;if(points.size===1){x+=e.clientX-old.x;y+=e.clientY-old.y;paint()}else{const other=[...points.entries()].find(([id])=>id!==e.pointerId)[1];const before=Math.hypot(old.x-other.x,old.y-other.y),after=Math.hypot(e.clientX-other.x,e.clientY-other.y),r=port.getBoundingClientRect();if(before>0){zoom(after/before,(old.x+other.x)/2-r.left,(old.y+other.y)/2-r.top);x+=(e.clientX-old.x)/2;y+=(e.clientY-old.y)/2;paint()}}points.set(e.pointerId,{x:e.clientX,y:e.clientY})};port.onpointerup=port.onpointercancel=port.onlostpointercapture=e=>points.delete(e.pointerId);port.onkeydown=e=>{if(e.key==='+'||e.key==='='){e.preventDefault();zoom(1.25)}if(e.key==='-'){e.preventDefault();zoom(.8)}if(e.key==='0'){e.preventDefault();fit()}};new ResizeObserver(fit).observe(port);fit()})();
</script></body></html>`;
    if (bytes(html) > MAX_DESIGN_PAGE_HTML_BYTES) throw limitError("Rendered Designs page exceeds the 8 MB sharing limit.");
    return html;
  };
  try {
    return render(true);
  } catch (error) {
    if (error?.status !== 413) throw error;
    return render(false);
  }
}

/** An Artifact is one current HTML page. Publishing freezes that content in an opaque sandbox. */
function validateArtifactPageSnapshot(value) {
  if (value.schemaVersion !== 1 || !Array.isArray(value.artifacts) || value.artifacts.length !== 1)
    throw Error("An Artifact snapshot contains exactly one page.");
  if (bytes(JSON.stringify(value)) > MAX_DESIGN_PAGE_BYTES) throw limitError("This Artifact exceeds the 8 MB sharing limit.");
  const item = value.artifacts[0];
  if (typeof item?.html !== "string" || !item.html.trim()) throw Error("An Artifact snapshot needs its HTML.");
  if (item.html.length > 1000000) throw limitError("Artifact HTML is limited to 1000000 characters.");
  const dimension = (number) => {
    if (!Number.isInteger(number) || number < 240 || number > 3840) throw Error("Invalid Artifact page dimensions.");
    return number;
  };
  const snapshot = {
    schemaVersion: 1,
    kind: "artifacts",
    title: title(value.title),
    artifacts: [{ title: title(item.title), html: item.html, width: dimension(item.width), height: dimension(item.height) }],
  };
  freeze(snapshot);
  validatedSnapshots.add(snapshot);
  return snapshot;
}

function renderArtifactPage(page) {
  const artifact = page.artifacts[0];
  // The HTTP policy is inherited by srcdoc, including blocked network and frame navigation.
  // The sandbox deliberately omits same-origin, forms, popups, downloads and top navigation.
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escape(page.title)} | Milagre Artifact</title><style>*{box-sizing:border-box}html,body{margin:0;height:100%;font-family:system-ui,sans-serif;background:#111922;color:#e5edf3}body{display:flex;flex-direction:column}header{padding:14px 20px;background:#182330;border-bottom:1px solid #2a3643}h1{font-size:16px;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}small{display:block;color:#9eafbd;font-size:12px;margin-top:4px}main{flex:1;min-height:0;background:white}iframe{display:block;width:100%;height:100%;border:0}footer{font-size:11px;color:#9eafbd;padding:9px 20px;background:#182330;border-top:1px solid #2a3643}</style></head><body><header><h1>${escape(page.title)}</h1><small>Artifact · Published snapshot</small></header><main><iframe title="${escape(artifact.title)}" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${escape(artifact.html)}"></iframe></main><footer>Made with Milagre · A frozen copy. Later edits stay private. External resources are blocked.</footer></body></html>`;
  if (bytes(html) > MAX_DESIGN_PAGE_HTML_BYTES) throw limitError("Rendered Artifact exceeds the 8 MB sharing limit.");
  return html;
}
