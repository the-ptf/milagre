import { designIcons } from "./design-icons.mjs";

const SYMBOL = /^sf:([a-z0-9]+(?:\.[a-z0-9]+)*)$/;
const FILLABLE = new Set(["heart", "star", "circle", "square", "triangle", "bookmark", "droplet", "zap", "play", "pause", "flame", "moon", "cloud"]);
const FALLBACK = "circle-dashed";

/** The closest Lucide icon to each SF Symbol, for shared pages and computers that can't draw SF Symbols. Variants (.fill, .circle) fall back to their base. */
export const DESIGN_SF_SYMBOL_LUCIDE = {
  heart: "heart",
  star: "star",
  bell: "bell",
  gear: "settings",
  gearshape: "settings",
  house: "house",
  magnifyingglass: "search",
  plus: "plus",
  minus: "minus",
  xmark: "x",
  checkmark: "check",
  "chevron.left": "chevron-left",
  "chevron.right": "chevron-right",
  "chevron.up": "chevron-up",
  "chevron.down": "chevron-down",
  "chevron.backward": "chevron-left",
  "chevron.forward": "chevron-right",
  "arrow.left": "arrow-left",
  "arrow.right": "arrow-right",
  "arrow.up": "arrow-up",
  "arrow.down": "arrow-down",
  "arrow.up.right": "arrow-up-right",
  "arrow.clockwise": "rotate-cw",
  "arrow.counterclockwise": "rotate-ccw",
  "arrow.triangle.2.circlepath": "refresh-cw",
  "arrow.up.arrow.down": "arrow-up-down",
  "arrow.left.arrow.right": "arrow-left-right",
  person: "user",
  "person.2": "users",
  "person.crop.circle": "circle-user",
  "person.badge.plus": "user-plus",
  envelope: "mail",
  phone: "phone",
  message: "message-circle",
  "bubble.left": "message-circle",
  "bubble.left.and.bubble.right": "messages-square",
  trash: "trash",
  "square.and.arrow.up": "share",
  "square.and.arrow.down": "download",
  paperplane: "send",
  camera: "camera",
  photo: "image",
  "photo.on.rectangle": "images",
  video: "video",
  calendar: "calendar",
  clock: "clock",
  bookmark: "bookmark",
  folder: "folder",
  doc: "file",
  "doc.text": "file-text",
  "doc.on.doc": "copy",
  pencil: "pencil",
  "square.and.pencil": "square-pen",
  mic: "mic",
  "mic.slash": "mic-off",
  play: "play",
  pause: "pause",
  stop: "square",
  forward: "fast-forward",
  backward: "rewind",
  "forward.end": "skip-forward",
  "backward.end": "skip-back",
  "speaker.wave.2": "volume-2",
  "speaker.slash": "volume-x",
  "music.note": "music",
  headphones: "headphones",
  wifi: "wifi",
  "antenna.radiowaves.left.and.right": "radio",
  cellularbars: "signal",
  "battery.100": "battery-full",
  "battery.50": "battery-medium",
  "battery.25": "battery-low",
  "battery.0": "battery",
  bolt: "zap",
  location: "navigation",
  "location.north": "navigation-2",
  mappin: "map-pin",
  "mappin.and.ellipse": "map-pin",
  map: "map",
  cart: "shopping-cart",
  bag: "shopping-bag",
  creditcard: "credit-card",
  gift: "gift",
  tag: "tag",
  lock: "lock",
  "lock.open": "lock-open",
  key: "key",
  eye: "eye",
  "eye.slash": "eye-off",
  shield: "shield",
  flame: "flame",
  drop: "droplet",
  leaf: "leaf",
  "sun.max": "sun",
  moon: "moon",
  cloud: "cloud",
  "cloud.rain": "cloud-rain",
  snowflake: "snowflake",
  wind: "wind",
  thermometer: "thermometer",
  umbrella: "umbrella",
  "figure.walk": "footprints",
  "figure.run": "activity",
  "figure.strengthtraining.traditional": "dumbbell",
  dumbbell: "dumbbell",
  "heart.text.square": "heart-pulse",
  "waveform.path.ecg": "activity",
  "bed.double": "bed",
  "fork.knife": "utensils",
  "cup.and.saucer": "coffee",
  applewatch: "watch",
  iphone: "smartphone",
  ipad: "tablet",
  laptopcomputer: "laptop",
  desktopcomputer: "monitor",
  tv: "tv",
  timer: "timer",
  stopwatch: "timer",
  alarm: "alarm-clock",
  hourglass: "hourglass",
  "list.bullet": "list",
  "list.number": "list-ordered",
  checklist: "list-checks",
  "line.3.horizontal": "menu",
  "line.3.horizontal.decrease": "list-filter",
  ellipsis: "ellipsis",
  "ellipsis.circle": "circle-ellipsis",
  "info.circle": "info",
  "exclamationmark.triangle": "triangle-alert",
  "exclamationmark.circle": "circle-alert",
  "questionmark.circle": "circle-question-mark",
  "plus.circle": "circle-plus",
  "minus.circle": "circle-minus",
  "xmark.circle": "circle-x",
  "checkmark.circle": "circle-check",
  "checkmark.seal": "badge-check",
  link: "link",
  globe: "globe",
  "slider.horizontal.3": "sliders-horizontal",
  "chart.bar": "chart-column",
  "chart.line.uptrend.xyaxis": "chart-line",
  "chart.pie": "chart-pie",
  "square.grid.2x2": "layout-grid",
  "rectangle.grid.1x2": "rows-2",
  "sidebar.left": "panel-left",
  flag: "flag",
  pin: "pin",
  paperclip: "paperclip",
  scissors: "scissors",
  printer: "printer",
  trophy: "trophy",
  crown: "crown",
  sparkles: "sparkles",
  "wand.and.stars": "wand-sparkles",
  "hand.thumbsup": "thumbs-up",
  "hand.thumbsdown": "thumbs-down",
  airplane: "plane",
  car: "car",
  bicycle: "bike",
  bus: "bus",
  tram: "tram-front",
  "building.2": "building",
  qrcode: "qr-code",
  barcode: "barcode",
  faceid: "scan-face",
  touchid: "fingerprint-pattern",
  power: "power",
  "square.and.arrow.up.on.square": "share-2",
  "arrow.up.circle": "circle-arrow-up",
  "arrow.down.circle": "circle-arrow-down",
  circle: "circle",
  square: "square",
  triangle: "triangle",
  app: "app-window",
  "circle.grid.3x3": "grip",
  keyboard: "keyboard",
  command: "command",
  return: "corner-down-left",
  "delete.left": "delete",
  textformat: "type",
  bold: "bold",
  italic: "italic",
  underline: "underline",
  "photo.artframe": "frame",
};

/** The SF Symbol an icon layer names with the `sf:` prefix, such as "heart.fill" for `sf:heart.fill`, or null. */
export function designSymbolName(icon) {
  return typeof icon === "string" ? (SYMBOL.exec(icon)?.[1] ?? null) : null;
}

export const designSymbolSyntax = (icon) => typeof icon === "string" && icon.startsWith("sf:") && SYMBOL.test(icon);

/** The Lucide icon drawn for an SF Symbol where it can't render, and whether the symbol is a filled one. */
export function designSymbolLucide(name) {
  const fill = /\.fill(?:\.|$)/.test(name);
  const whole = name.replace(/\.fill(?=\.|$)/g, "");
  for (let base = whole; base; base = base.includes(".") ? base.slice(0, base.lastIndexOf(".")) : "") {
    const icon = Object.hasOwn(DESIGN_SF_SYMBOL_LUCIDE, base)
      ? DESIGN_SF_SYMBOL_LUCIDE[base]
      : Object.hasOwn(designIcons, base.replaceAll(".", "-"))
        ? base.replaceAll(".", "-")
        : null;
    if (icon) return { icon, filled: fill && FILLABLE.has(icon), exact: base === whole };
  }
  return { icon: FALLBACK, filled: false, exact: false };
}

const WEIGHTS = [
  [150, -0.8],
  [250, -0.6],
  [350, -0.4],
  [450, 0],
  [550, 0.23],
  [650, 0.3],
  [750, 0.4],
  [850, 0.56],
];
/** AppKit's symbol weight (NSFontWeight) for a CSS weight. */
export const designSymbolWeight = (fontWeight = 400) => WEIGHTS.find(([below]) => fontWeight < below)?.[1] ?? 0.62;

/** A Lucide line weight close to a symbol's weight, when a layer gives no strokeWidth. */
export const designSymbolStroke = (fontWeight = 400) => Math.round((1 + (fontWeight - 100) / 400) * 100) / 100;

let source = null;
const images = new Map();

/**
 * The host's SF Symbols (a Mac): `load(requests)` resolves `{key, png, width, height}` for `{key, name, weight}`
 * requests, a white PNG on transparency drawn by AppKit, or null for a symbol this Mac doesn't have. Without a source,
 * and on shared pages, an SF Symbol draws as its closest Lucide icon.
 */
export function setDesignSymbols(next) {
  source = next;
  images.clear();
}

const requestOf = (node) => {
  const name = designSymbolName(node.icon);
  return name ? { key: `${name}\u0000${node.fontWeight ?? 400}`, name, weight: designSymbolWeight(node.fontWeight) } : null;
};

/** The rendered symbol image for an icon layer, or null when it draws as Lucide. */
export function designSymbolImage(node) {
  const request = requestOf(node);
  return request ? (images.get(request.key) ?? null) : null;
}

/** Whether the host can draw SF Symbols at all. */
export const designSymbolsAvailable = () => !!source;

export async function loadDesignSymbols(document) {
  if (!source) return;
  const wanted = new Map();
  for (const node of document.nodes) {
    const request = node.type === "icon" && !node.hidden ? requestOf(node) : null;
    if (request && !images.has(request.key)) wanted.set(request.key, request);
  }
  if (!wanted.size) return;
  const loaded = await source.load([...wanted.values()]).catch(() => []);
  for (const request of wanted.values()) {
    const image = loaded.find((item) => item?.key === request.key);
    images.set(request.key, image?.png ? image : null);
  }
}

/** Lucide geometry and paint for an icon layer: its own Lucide icon, or an SF Symbol's closest one. */
export function designLucideIcon(node) {
  const name = designSymbolName(node.icon);
  if (!name) return { markup: designIcons[node.icon], filled: false, strokeWidth: node.strokeWidth ?? 2 };
  const { icon, filled } = designSymbolLucide(name);
  return { markup: designIcons[icon], filled, strokeWidth: node.strokeWidth ?? designSymbolStroke(node.fontWeight) };
}
