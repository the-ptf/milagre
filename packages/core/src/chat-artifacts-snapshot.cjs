const { artifactDocument, hasDiagrams } = require("@milagre/shared/artifact-document");
const { diagramScript } = require("@milagre/shared/diagram-script");

const MAX_HTML = 1_000_000;
const KINDS = new Set(["workspace", "design", "designs", "artifacts"]);
function sharedHtml(html) {
  if (!hasDiagrams(html)) return html;
  const page = artifactDocument(html, { page: true, diagrams: diagramScript() });
  return page.length <= MAX_HTML ? page : html;
}
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
const pagePart = (current) => ({
  title: current.title,
  html: sharedPage(current),
  width: current.width,
  height: current.height,
  ...(current.assets ? { assets: current.assets } : {}),
});

/**
 * What a published page holds, read through the Chat's store: `workspace` is every design and the HTML page, `design`
 * one design named by `designId` and published as a one-design page, `designs` every design, `artifacts` the page.
 */
async function pageSnapshot({ kind = "designs", title, designId }, { designs, page, readDesign }) {
  if (!KINDS.has(kind)) throw Error("Choose the workspace, one design or the page to share.");
  if (kind === "artifacts") {
    const current = await page();
    if (!current) throw Error("This Chat has no artifact page to share.");
    return { schemaVersion: 1, kind, title, artifacts: [pagePart(current)] };
  }
  const entries = (await designs()).filter((entry) => kind !== "design" || entry.id === designId);
  if (kind === "design") {
    if (!entries.length) throw Object.assign(Error("This design was deleted."), { code: "DESIGN_DELETED" });
    const design = await readDesign(entries[0]);
    return { schemaVersion: 1, title: design.title, designs: [design] };
  }
  const read = [];
  for (const entry of entries) read.push(await readDesign(entry));
  if (kind === "designs") {
    if (!read.length) throw Error("A shared page must contain at least one design.");
    return { schemaVersion: 1, title, designs: read };
  }
  const current = await page();
  if (!read.length && !current) throw Error("This Chat has no designs or page to share.");
  return { schemaVersion: 1, kind, title, designs: read, ...(current ? { page: pagePart(current) } : {}) };
}

module.exports = { pageSnapshot };
