const STEP_MIN_MS = 60;
const STEP_MAX_MS = 150;
const BUILD_MS = 1800;
const LAYER_ID = /^[a-zA-Z][a-zA-Z0-9_.-]{0,95}$/;

export function designBuildLayers(before, after) {
  const old = new Map((before?.nodes ?? []).map((node) => [node.id, JSON.stringify(node)]));
  return after.nodes.filter((node) => LAYER_ID.test(node.id) && old.get(node.id) !== JSON.stringify(node)).map((node) => node.id);
}

export function designBuildHtml(html, layers, accent = "#0a84ff") {
  const ids = layers.filter((id) => LAYER_ID.test(id));
  if (!ids.length || !html.includes("</head>")) return html;
  const color = /^#[0-9a-fA-F]{3,8}$/.test(accent) ? accent : "#0a84ff";
  const each = Math.min(STEP_MAX_MS, Math.max(STEP_MIN_MS, BUILD_MS / ids.length));
  const rules = ids.map((id, index) => `[data-design-node="${id}"]{animation-delay:${Math.round(index * each)}ms}`).join("");
  const style = `<style id="milagre-build">@keyframes milagre-build{from{opacity:0}to{opacity:1}}@keyframes milagre-mark{from{outline-color:${color}}to{outline-color:transparent}}${ids.map((id) => `[data-design-node="${id}"]`).join(",")}{outline:2px solid transparent;outline-offset:-1px;animation:milagre-build .22s ease-out both,milagre-mark .7s ease-out both}${rules}@media (prefers-reduced-motion:reduce){[data-design-node]{animation:none!important}}</style>`;
  return html.replace("</head>", `${style}</head>`);
}
