const tag = (view, offset) => String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
const fixed = (view, offset) => view.getInt32(offset) / 65536;

/** The table directory of one face in a TrueType/OpenType file or collection: tag → {offset, length}. */
export function designFontTables(bytes, index = 0) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let start = 0;
  if (tag(view, 0) === "ttcf") {
    const count = view.getUint32(8);
    if (index >= count) throw Error("The font collection has no such face.");
    start = view.getUint32(12 + index * 4);
  }
  const flavor = view.getUint32(start);
  if (![0x00010000, 0x4f54544f, 0x74727565].includes(flavor)) throw Error("Not a TrueType or OpenType font.");
  const tables = new Map();
  const count = view.getUint16(start + 4);
  for (let i = 0; i < count; i++) {
    const record = start + 12 + i * 16;
    tables.set(tag(view, record), { offset: view.getUint32(record + 8), length: view.getUint32(record + 12) });
  }
  return { view, tables };
}

/** How many faces a file holds: 1 for a plain font, n for a collection. */
export function designFontFaceCount(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return tag(view, 0) === "ttcf" ? view.getUint32(8) : 1;
}

function readNames(view, table) {
  if (!table) return new Map();
  const count = view.getUint16(table.offset + 2);
  const strings = table.offset + view.getUint16(table.offset + 4);
  const names = new Map();
  for (let i = 0; i < count; i++) {
    const record = table.offset + 6 + i * 12;
    const platform = view.getUint16(record);
    const language = view.getUint16(record + 4);
    const id = view.getUint16(record + 6);
    const length = view.getUint16(record + 8);
    const offset = strings + view.getUint16(record + 10);
    const english = (platform === 3 && language === 0x409) || (platform === 1 && language === 0) || platform === 0;
    if (!english || (names.has(id) && platform !== 3)) continue;
    let text = "";
    if (platform === 1) for (let j = 0; j < length; j++) text += String.fromCharCode(view.getUint8(offset + j));
    else for (let j = 0; j + 1 < length; j += 2) text += String.fromCharCode(view.getUint16(offset + j));
    names.set(id, text);
  }
  return names;
}

function readAxes(view, table, names) {
  if (!table) return { axes: [], instances: [] };
  const base = table.offset;
  const axesOffset = base + view.getUint16(base + 4);
  const axisCount = view.getUint16(base + 8);
  const axisSize = view.getUint16(base + 10);
  const instanceCount = view.getUint16(base + 12);
  const instanceSize = view.getUint16(base + 14);
  const axes = [];
  for (let i = 0; i < axisCount; i++) {
    const at = axesOffset + i * axisSize;
    axes.push({
      tag: tag(view, at),
      min: fixed(view, at + 4),
      default: fixed(view, at + 8),
      max: fixed(view, at + 12),
      name: names.get(view.getUint16(at + 18)),
    });
  }
  const instances = [];
  const instancesOffset = axesOffset + axisCount * axisSize;
  for (let i = 0; i < instanceCount; i++) {
    const at = instancesOffset + i * instanceSize;
    const coordinates = Object.fromEntries(axes.map((axis, index) => [axis.tag, fixed(view, at + 4 + index * 4)]));
    instances.push({ name: names.get(view.getUint16(at)) ?? "", coordinates });
  }
  return { axes, instances };
}

/** Names, style, vertical metrics, variation axes and named instances of one face, as the font itself reports them. */
export function designFontFileInfo(bytes, index = 0) {
  const { view, tables } = designFontTables(bytes, index);
  const names = readNames(view, tables.get("name"));
  const head = tables.get("head");
  const os2 = tables.get("OS/2");
  const hhea = tables.get("hhea");
  const unitsPerEm = head ? view.getUint16(head.offset + 18) : 1000;
  const version = os2 ? view.getUint16(os2.offset) : 0;
  const { axes, instances } = readAxes(view, tables.get("fvar"), names);
  return {
    family: names.get(16) ?? names.get(1) ?? "",
    subfamily: names.get(17) ?? names.get(2) ?? "",
    fullName: names.get(4) ?? "",
    postscriptName: names.get(6) ?? "",
    unitsPerEm,
    weightClass: os2 ? view.getUint16(os2.offset + 4) : 400,
    italic: os2 ? (view.getUint16(os2.offset + 62) & 1) === 1 : /italic|oblique/i.test(names.get(2) ?? ""),
    ascender: os2 ? view.getInt16(os2.offset + 68) : hhea ? view.getInt16(hhea.offset + 4) : 0,
    descender: os2 ? view.getInt16(os2.offset + 70) : hhea ? view.getInt16(hhea.offset + 6) : 0,
    lineGap: os2 ? view.getInt16(os2.offset + 72) : hhea ? view.getInt16(hhea.offset + 8) : 0,
    xHeight: os2 && version >= 2 ? view.getInt16(os2.offset + 86) : 0,
    capHeight: os2 && version >= 2 ? view.getInt16(os2.offset + 88) : 0,
    axes,
    instances,
  };
}

function glyphLookup(view, table) {
  if (!table) return () => 0;
  const count = view.getUint16(table.offset + 2);
  let best = null;
  for (let i = 0; i < count; i++) {
    const record = table.offset + 4 + i * 8;
    const platform = view.getUint16(record);
    const encoding = view.getUint16(record + 2);
    const offset = table.offset + view.getUint32(record + 4);
    const format = view.getUint16(offset);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode || (format !== 4 && format !== 12)) continue;
    if (!best || format === 12) best = { offset, format };
  }
  if (!best) return () => 0;
  const { offset, format } = best;
  if (format === 12) {
    const groups = view.getUint32(offset + 12);
    return (point) => {
      for (let low = 0, high = groups - 1; low <= high;) {
        const middle = (low + high) >> 1;
        const at = offset + 16 + middle * 12;
        const start = view.getUint32(at);
        if (point < start) high = middle - 1;
        else if (point > view.getUint32(at + 4)) low = middle + 1;
        else return view.getUint32(at + 8) + point - start;
      }
      return 0;
    };
  }
  const segments = view.getUint16(offset + 6) / 2;
  const ends = offset + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const ranges = deltas + segments * 2;
  return (point) => {
    if (point > 0xffff) return 0;
    for (let i = 0; i < segments; i++) {
      if (point > view.getUint16(ends + i * 2)) continue;
      const start = view.getUint16(starts + i * 2);
      if (point < start) return 0;
      const delta = view.getInt16(deltas + i * 2);
      const range = view.getUint16(ranges + i * 2);
      if (!range) return (point + delta) & 0xffff;
      const glyph = view.getUint16(ranges + i * 2 + range + (point - start) * 2);
      return glyph ? (glyph + delta) & 0xffff : 0;
    }
    return 0;
  };
}

/** Advance widths in em for the given code points; null where the face has no glyph. */
export function designFontAdvances(bytes, points, index = 0) {
  const { view, tables } = designFontTables(bytes, index);
  const head = tables.get("head");
  const hhea = tables.get("hhea");
  const hmtx = tables.get("hmtx");
  if (!head || !hhea || !hmtx) throw Error("The font has no horizontal metrics.");
  const unitsPerEm = view.getUint16(head.offset + 18);
  const metrics = view.getUint16(hhea.offset + 34);
  const glyph = glyphLookup(view, tables.get("cmap"));
  return points.map((point) => {
    const id = glyph(point);
    if (!id && point !== 32) return null;
    const at = hmtx.offset + Math.min(id, metrics - 1) * 4;
    return Math.round((view.getUint16(at) / unitsPerEm) * 1000) / 1000;
  });
}

const checksum = (bytes) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let sum = 0;
  for (let i = 0; i + 4 <= bytes.length; i += 4) sum = (sum + view.getUint32(i)) >>> 0;
  return sum;
};

function nameTable(family, subfamily) {
  const records = [
    [1, family],
    [2, subfamily],
    [4, `${family} ${subfamily}`],
    [6, `${family}-${subfamily}`.replace(/[^A-Za-z0-9-]/g, "")],
    [16, family],
    [17, subfamily],
  ];
  const strings = records.map(([, text]) => Array.from(text, (character) => character.charCodeAt(0) & 0xffff));
  const size = 6 + records.length * 12;
  const out = new Uint8Array(size + strings.reduce((sum, text) => sum + text.length * 2, 0));
  const view = new DataView(out.buffer);
  view.setUint16(2, records.length);
  view.setUint16(4, size);
  let offset = 0;
  records.forEach(([id], i) => {
    const at = 6 + i * 12;
    view.setUint16(at, 3);
    view.setUint16(at + 2, 1);
    view.setUint16(at + 4, 0x409);
    view.setUint16(at + 6, id);
    view.setUint16(at + 8, strings[i].length * 2);
    view.setUint16(at + 10, offset);
    strings[i].forEach((code, j) => view.setUint16(size + offset + j * 2, code));
    offset += strings[i].length * 2;
  });
  return out;
}

function buildFont(flavor, parts) {
  parts.sort((a, b) => (a.name < b.name ? -1 : 1));
  const header = 12 + parts.length * 16;
  const size = parts.reduce((sum, part) => sum + Math.ceil(part.data.length / 4) * 4, header);
  const out = new Uint8Array(size);
  const write = new DataView(out.buffer);
  write.setUint32(0, flavor);
  write.setUint16(4, parts.length);
  const power = 2 ** Math.floor(Math.log2(parts.length));
  write.setUint16(6, power * 16);
  write.setUint16(8, Math.log2(power));
  write.setUint16(10, parts.length * 16 - power * 16);
  let offset = header;
  let headOffset = 0;
  parts.forEach((part, i) => {
    const record = 12 + i * 16;
    for (let j = 0; j < 4; j++) write.setUint8(record + j, part.name.charCodeAt(j));
    out.set(part.data, offset);
    write.setUint32(record + 4, checksum(out.subarray(offset, offset + Math.ceil(part.data.length / 4) * 4)));
    write.setUint32(record + 8, offset);
    write.setUint32(record + 12, part.data.length);
    if (part.name === "head") headOffset = offset;
    offset += Math.ceil(part.data.length / 4) * 4;
  });
  if (headOffset) write.setUint32(headOffset + 8, (0xb1b0afba - checksum(out)) >>> 0);
  return out;
}

const faceParts = (bytes, index) => {
  const { view, tables } = designFontTables(bytes, index);
  const start = tag(view, 0) === "ttcf" ? view.getUint32(12 + index * 4) : 0;
  return { flavor: view.getUint32(start), parts: [...tables].map(([name, { offset, length }]) => ({ name, data: bytes.slice(offset, offset + length) })) };
};

/** One face of a collection as a stand-alone font; a plain font comes back as it is. */
export function designFontFace(bytes, index = 0) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (tag(view, 0) !== "ttcf") return bytes;
  const { flavor, parts } = faceParts(bytes, index);
  return buildFont(flavor, parts);
}

/**
 * The face renamed to `family` with OS/2 weight `weight`, so renderers that match fonts by their own names (resvg) find a
 * system face under the name a design uses. Hidden system names (".SF NS") are never matched by a design.
 */
export function renameDesignFont(bytes, family, weight) {
  const { flavor, parts } = faceParts(bytes, 0);
  for (const part of parts) {
    if (part.name === "name") part.data = nameTable(family, weight === 400 ? "Regular" : `W${weight}`);
    if (part.name === "OS/2" && part.data.length > 6) new DataView(part.data.buffer).setUint16(4, Math.round(weight));
    if (part.name === "head") new DataView(part.data.buffer).setUint32(8, 0);
  }
  if (!parts.some((part) => part.name === "name")) parts.push({ name: "name", data: nameTable(family, "Regular") });
  return buildFont(flavor, parts);
}
