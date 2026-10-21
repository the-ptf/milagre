const BADGES = {
  ts: ["TS", "#3178c6"],
  js: ["JS", "#c9a400"],
  py: ["PY", "#3776ab"],
  go: ["GO", "#00a7c7"],
  rs: ["RS", "#c4562a"],
  md: ["MD", "#6b7280"],
  json: ["JSON", "#b8860b"],
  css: ["CSS", "#2965f1"],
  html: ["HTML", "#e34f26"],
  sh: ["SH", "#4e9a06"],
  swift: ["SWIFT", "#f05138"],
  kt: ["KT", "#7f52ff"],
};
const REACT = new Set(["tsx", "jsx"]);
const IMAGES = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);

/** Badge letters or an icon name for a path, with the tint to draw it in. */
export function fileKind(path) {
  if (path.endsWith("/")) return { badge: null, icon: "folder", color: "#8a8f98" };
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (REACT.has(ext)) return { badge: null, icon: "react", color: "#00a6c8" };
  if (IMAGES.has(ext)) return { badge: null, icon: "image", color: "#8250df" };
  const badge = Object.hasOwn(BADGES, ext) ? BADGES[ext] : null;
  if (badge) return { badge: badge[0], icon: null, color: badge[1] };
  return { badge: null, icon: "file", color: "#8a8f98" };
}
