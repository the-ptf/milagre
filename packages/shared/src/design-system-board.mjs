import { DESIGN_MAX_SCREEN } from "./design-schemas.mjs";

const WIDTH = 720;
const MARGIN = 32;
const INNER = WIDTH - MARGIN * 2;
const BOTTOM = DESIGN_MAX_SCREEN - MARGIN;
const INK = "#1c222b";
const MUTED = "#60656d";
const RULE = "#edeeee";
const SAMPLE = "Every screen follows it";

/** Lays blocks top to bottom, starting a new board whenever the next block would pass the screen limit. */
function boards(kit) {
  const done = [];
  let nodes = [];
  let y = MARGIN;
  const close = () => {
    if (nodes.length) done.push({ schemaVersion: 1, width: WIDTH, height: Math.ceil(y + MARGIN), background: "#ffffff", kit, nodes });
    nodes = [];
    y = MARGIN;
  };
  const room = (height) => {
    if (y + height > BOTTOM && nodes.length) close();
  };
  const add = (node) => nodes.push(node);
  const text = (id, value, top, { x = MARGIN, width = INNER, height = 18, size = 12, weight = 400, fill = MUTED, ...rest } = {}) =>
    add({ id, type: "text", x, y: top, width, height, text: value, fontSize: size, fontWeight: weight, fill, ...rest });
  const heading = (id, value, first) => {
    room(42 + first);
    text(id, value, y + 8, { height: 22, size: 15, weight: 600, fill: INK });
    y += 42;
  };
  return { add, text, heading, room, at: () => y, move: (by) => (y += by), finish: () => (close(), done) };
}

function colors(b, kit) {
  const names = Object.keys(kit.colors);
  if (!names.length) return;
  const columns = 4;
  const gap = 16;
  const cell = (INNER - gap * (columns - 1)) / columns;
  b.heading("colors-heading", "Colors", 92);
  for (let row = 0; row < names.length; row += columns) {
    b.room(92);
    names.slice(row, row + columns).forEach((name, column) => {
      const x = MARGIN + column * (cell + gap);
      const top = b.at();
      const value = kit.colors[name];
      const modes =
        typeof value === "string"
          ? value
          : [value.light, value.dark && `dark ${value.dark}`, value.contrast && `contrast ${value.contrast}`].filter(Boolean).join(" · ");
      b.add({ id: `color-${name}`, type: "rectangle", x, y: top, width: cell, height: 44, radius: 8, fill: `$${name}`, stroke: "#0000001a", strokeWidth: 1 });
      b.text(`color-${name}-name`, name, top + 50, { x, width: cell, height: 16, size: 12, weight: 600, fill: INK });
      b.text(`color-${name}-value`, modes, top + 66, { x, width: cell, height: 16, size: 11 });
    });
    b.move(92);
  }
  b.move(8);
}

function type(b, kit) {
  const names = Object.keys(kit.textStyles);
  if (!names.length) return;
  const heightOf = (style) => Math.ceil(style.fontSize * (style.lineHeight ?? 1.35));
  b.heading("type-heading", "Type", heightOf(kit.textStyles[names[0]]) + 17);
  for (const name of names) {
    const style = kit.textStyles[name];
    const height = heightOf(style);
    b.room(height + 17);
    b.text(`type-${name}-name`, `${name} ${style.fontSize}/${style.fontWeight ?? 400}`, b.at() + Math.max(0, height - 16), {
      width: 140,
      height: 16,
      size: 11,
    });
    b.text(`type-${name}-sample`, SAMPLE, b.at(), { x: MARGIN + 156, width: INNER - 156, height, textStyle: name, fill: INK });
    b.move(height + 8);
    b.add({ id: `type-${name}-rule`, type: "rectangle", x: MARGIN, y: b.at(), width: INNER, height: 1, fill: RULE });
    b.move(9);
  }
}

function measures(b, kit) {
  const items = [
    ...Object.entries(kit.spacing).map(([name, value]) => ({ id: `spacing-${name}`, name, value, size: Math.max(2, Math.min(value, 48)), radius: undefined })),
    ...Object.entries(kit.radii).map(([name, value]) => ({ id: `radius-${name}`, name, value, size: 48, radius: Math.min(value, 24) })),
  ];
  if (!items.length) return;
  b.heading("measures-heading", "Spacing and radii", 84);
  let x = MARGIN;
  b.room(84);
  for (const item of items) {
    const width = Math.max(item.size, 64);
    if (x + width > WIDTH - MARGIN) {
      b.move(84);
      b.room(84);
      x = MARGIN;
    }
    const top = b.at();
    b.add({
      id: item.id,
      type: "rectangle",
      x,
      y: top + 48 - item.size,
      width: item.size,
      height: item.size,
      fill: item.radius === undefined ? "#007df333" : "#e8edf2",
      ...(item.radius === undefined ? {} : { radius: item.radius }),
    });
    b.text(`${item.id}-label`, `${item.name} ${item.value}`, top + 54, { x, width, height: 16, size: 11 });
    x += width + 12;
  }
  b.move(84);
}

function components(b, kit) {
  const entries = Object.entries(kit.components ?? {});
  if (!entries.length) return;
  const heightOf = (layers, name) => (layers.find((node) => node.id === name)?.height ?? 40) + 42;
  b.heading("components-heading", "Components", Math.min(heightOf(entries[0][1], entries[0][0]), BOTTOM - MARGIN - 42));
  for (const [name, layers] of entries) {
    const height = heightOf(layers, name);
    const fits = MARGIN + height <= BOTTOM;
    b.room(fits ? height : 42);
    b.text(`components-caption-${name}`, fits ? name : `${name}: too tall to preview here`, b.at(), { height: 16, size: 11 });
    b.move(22);
    if (!fits) continue;
    const prefix = `component-${name}-`;
    for (const { component: _component, componentProperties: _properties, ...node } of layers)
      b.add({ ...node, id: prefix + node.id, ...(node.parentId ? { parentId: prefix + node.parentId } : { x: MARGIN, y: b.at() }) });
    b.move(height - 22);
  }
}

/**
 * The Project's design system drawn as layer designs: colors, type, spacing and radii, then its components, on as many
 * boards as the screen limit needs, the title on the first.
 */
export function designSystemBoards(kit, { title = `${kit.title} design system`, subtitle = `Version ${kit.version}` } = {}) {
  const b = boards(kit);
  b.text("board-title", title, b.at(), { height: 28, size: 22, weight: 600, fill: INK, letterSpacing: -0.44 });
  b.move(30);
  b.text("board-subtitle", subtitle, b.at());
  b.move(28);
  colors(b, kit);
  type(b, kit);
  measures(b, kit);
  components(b, kit);
  return b.finish();
}
