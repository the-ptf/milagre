const WIDTH = 720;
const MARGIN = 32;
const INNER = WIDTH - MARGIN * 2;
const INK = "#1c222b";
const MUTED = "#60656d";
const RULE = "#edeeee";
const SAMPLE = "Every screen follows it";

function board() {
  const nodes = [];
  let y = MARGIN;
  const text = (id, value, top, { x = MARGIN, width = INNER, height = 18, size = 12, weight = 400, fill = MUTED, ...rest } = {}) =>
    nodes.push({ id, type: "text", x, y: top, width, height, text: value, fontSize: size, fontWeight: weight, fill, ...rest });
  const heading = (id, value) => {
    y += 8;
    text(id, value, y, { height: 22, size: 15, weight: 600, fill: INK });
    y += 34;
  };
  return { nodes, text, heading, at: () => y, move: (by) => (y += by) };
}

function colors(b, kit) {
  const names = Object.keys(kit.colors);
  if (!names.length) return;
  b.heading("colors-heading", "Colors");
  const columns = 4;
  const gap = 16;
  const cell = (INNER - gap * (columns - 1)) / columns;
  names.forEach((name, index) => {
    const x = MARGIN + (index % columns) * (cell + gap);
    const top = b.at() + Math.floor(index / columns) * 92;
    const value = kit.colors[name];
    const modes =
      typeof value === "string"
        ? value
        : [value.light, value.dark && `dark ${value.dark}`, value.contrast && `contrast ${value.contrast}`].filter(Boolean).join(" · ");
    b.nodes.push({
      id: `color-${name}`,
      type: "rectangle",
      x,
      y: top,
      width: cell,
      height: 44,
      radius: 8,
      fill: `$${name}`,
      stroke: "#0000001a",
      strokeWidth: 1,
    });
    b.text(`color-${name}-name`, name, top + 50, { x, width: cell, height: 16, size: 12, weight: 600, fill: INK });
    b.text(`color-${name}-value`, modes, top + 66, { x, width: cell, height: 16, size: 11 });
  });
  b.move(Math.ceil(names.length / columns) * 92 + 8);
}

function type(b, kit) {
  const names = Object.keys(kit.textStyles);
  if (!names.length) return;
  b.heading("type-heading", "Type");
  for (const name of names) {
    const style = kit.textStyles[name];
    const height = Math.ceil(style.fontSize * (style.lineHeight ?? 1.35));
    b.text(`type-${name}-name`, `${name} ${style.fontSize}/${style.fontWeight ?? 400}`, b.at() + Math.max(0, height - 16), {
      width: 140,
      height: 16,
      size: 11,
    });
    b.text(`type-${name}-sample`, SAMPLE, b.at(), { x: MARGIN + 156, width: INNER - 156, height, textStyle: name, fill: INK });
    b.move(height + 8);
    b.nodes.push({ id: `type-${name}-rule`, type: "rectangle", x: MARGIN, y: b.at(), width: INNER, height: 1, fill: RULE });
    b.move(9);
  }
}

function measures(b, kit) {
  const spacing = Object.entries(kit.spacing);
  const radii = Object.entries(kit.radii);
  if (!spacing.length && !radii.length) return;
  b.heading("measures-heading", "Spacing and radii");
  let x = MARGIN;
  const top = b.at();
  for (const [name, value] of spacing) {
    const size = Math.max(2, Math.min(value, 48));
    b.nodes.push({ id: `spacing-${name}`, type: "rectangle", x, y: top + 48 - size, width: size, height: size, fill: "#007df333" });
    b.text(`spacing-${name}-label`, `${name} ${value}`, top + 54, { x, width: Math.max(size, 56), height: 16, size: 11 });
    x += Math.max(size, 56) + 12;
  }
  for (const [name, value] of radii) {
    b.nodes.push({ id: `radius-${name}`, type: "rectangle", x, y: top, width: 48, height: 48, radius: Math.min(value, 24), fill: "#e8edf2" });
    b.text(`radius-${name}-label`, `${name} ${value}`, top + 54, { x, width: 64, height: 16, size: 11 });
    x += 76;
  }
  b.move(84);
}

function components(b, kit) {
  const entries = Object.entries(kit.components ?? {});
  if (!entries.length) return;
  b.heading("components-heading", "Components");
  for (const [name, layers] of entries) {
    const prefix = `component-${name}-`;
    const root = layers.find((node) => node.id === name);
    b.text(`components-caption-${name}`, name, b.at(), { height: 16, size: 11 });
    b.move(22);
    for (const { component: _component, componentProperties: _properties, ...node } of layers)
      b.nodes.push({
        ...node,
        id: prefix + node.id,
        ...(node.parentId ? { parentId: prefix + node.parentId } : { x: MARGIN, y: b.at() }),
      });
    b.move((root?.height ?? 40) + 20);
  }
}

/** The Project's design system drawn as one layer design: colors, type, spacing and radii, then its components. */
export function designSystemBoard(kit, { title = `${kit.title} design system`, subtitle = `Version ${kit.version}` } = {}) {
  const b = board();
  b.text("board-title", title, b.at(), { height: 28, size: 22, weight: 600, fill: INK, letterSpacing: -0.44 });
  b.move(30);
  b.text("board-subtitle", subtitle, b.at());
  b.move(28);
  colors(b, kit);
  type(b, kit);
  measures(b, kit);
  components(b, kit);
  return { schemaVersion: 1, width: WIDTH, height: Math.ceil(b.at() + MARGIN), background: "#ffffff", kit, nodes: b.nodes };
}
