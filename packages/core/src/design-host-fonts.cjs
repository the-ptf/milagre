const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const NEEDED = new Set(["head", "hhea", "name", "OS/2", "fvar"]);
const FONT_FILE = /\.(?:ttf|otf|ttc)$/i;
const APPLE_FILES = {
  "sfns.ttf": "SF Pro",
  "sfnsitalic.ttf": "SF Pro",
  "sfnsrounded.ttf": "SF Pro Rounded",
  "sfcompact.ttf": "SF Compact",
  "sfcompactitalic.ttf": "SF Compact",
  "sfcompactrounded.ttf": "SF Compact Rounded",
  "sfnsmono.ttf": "SF Mono",
  "sfnsmonoitalic.ttf": "SF Mono",
  "newyork.ttf": "New York",
  "newyorkitalic.ttf": "New York",
};
const ALIASES = {
  "sf pro text": { family: "SF Pro", opsz: 17 },
  "sf pro display": { family: "SF Pro", opsz: 28 },
  "sf compact text": { family: "SF Compact", opsz: 19 },
  "sf compact display": { family: "SF Compact", opsz: 20 },
};
const FALLBACK_ADVANCE = 0.6;
const MAX_CACHED_FILES = 4;

const shared = () => import("@milagre/shared/design-font-file");
const characters = () => import("@milagre/shared/design-font-characters");

function fontDirectories(platform = process.platform, home = os.homedir()) {
  if (platform === "darwin") return ["/System/Library/Fonts", "/System/Library/Fonts/Supplemental", "/Library/Fonts", path.join(home, "Library/Fonts")];
  if (platform === "win32") return [path.join(process.env.WINDIR ?? "C:\\Windows", "Fonts"), path.join(home, "AppData/Local/Microsoft/Windows/Fonts")];
  return ["/usr/share/fonts", "/usr/local/share/fonts", path.join(home, ".local/share/fonts"), path.join(home, ".fonts")];
}

async function fontFiles(directory, depth = 0) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory() && depth < 3 && !directory.endsWith("/Fonts")) files.push(...(await fontFiles(full, depth + 1)));
    else if (entry.isFile() && FONT_FILE.test(entry.name)) files.push(full);
  }
  return files;
}

async function readAt(handle, position, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

/** Each face's naming and metric tables as a small stand-alone font, without reading the glyphs. */
async function faceHeaders(file) {
  const handle = await fs.open(file, "r");
  try {
    const head = await readAt(handle, 0, 12);
    const starts = head.toString("latin1", 0, 4) === "ttcf" ? [] : [0];
    if (head.toString("latin1", 0, 4) === "ttcf") {
      const offsets = await readAt(handle, 12, head.readUInt32BE(8) * 4);
      for (let i = 0; i + 4 <= offsets.length; i += 4) starts.push(offsets.readUInt32BE(i));
    }
    const faces = [];
    for (const start of starts.slice(0, 64)) {
      const header = await readAt(handle, start, 12);
      const count = header.readUInt16BE(4);
      const directory = await readAt(handle, start + 12, count * 16);
      const tables = [];
      for (let i = 0; i < count; i++) {
        const name = directory.toString("latin1", i * 16, i * 16 + 4);
        if (!NEEDED.has(name)) continue;
        const length = directory.readUInt32BE(i * 16 + 12);
        if (length > 4 * 1024 * 1024) continue;
        tables.push({ name, data: await readAt(handle, directory.readUInt32BE(i * 16 + 8), length) });
      }
      const size = tables.reduce((sum, table) => sum + Math.ceil(table.data.length / 4) * 4, 12 + tables.length * 16);
      const out = Buffer.alloc(size);
      header.copy(out, 0, 0, 4);
      out.writeUInt16BE(tables.length, 4);
      let offset = 12 + tables.length * 16;
      tables.forEach((table, i) => {
        out.write(table.name, 12 + i * 16, "latin1");
        out.writeUInt32BE(offset, 12 + i * 16 + 8);
        out.writeUInt32BE(table.data.length, 12 + i * 16 + 12);
        table.data.copy(out, offset);
        offset += Math.ceil(table.data.length / 4) * 4;
      });
      faces.push(new Uint8Array(out));
    }
    return faces;
  } finally {
    await handle.close();
  }
}

const upright = (faces) => faces.filter((face) => !face.italic);
const near = (a, b) => Math.abs(a - b) < 0.5;
const same = (a, b) => Math.abs(a - b) < 0.001;

function describe(family, faces, alias) {
  const shown = upright(faces).length ? upright(faces) : faces;
  const variable = shown.find((face) => face.axes.some((axis) => axis.tag === "wght"));
  const axis = (tag) => variable?.axes.find((item) => item.tag === tag);
  const wght = axis("wght");
  const opsz = axis("opsz");
  const plain = (instance) =>
    variable.axes.every(
      (item) => ["wght", "opsz"].includes(item.tag) || !["wdth", "GRAD"].includes(item.tag) || same(instance.coordinates[item.tag], item.default),
    );
  const named = variable
    ? variable.instances.filter(plain).map((instance) => ({ name: instance.name, weight: Math.round(instance.coordinates.wght * 100) / 100 }))
    : shown.map((face) => ({ name: face.subfamily, weight: face.weightClass }));
  const unique = [...new Map(named.map((item) => [item.name, item])).values()].toSorted((a, b) => a.weight - b.weight);
  return {
    family: alias?.name ?? family,
    apple: faces.some((face) => face.apple),
    ...(wght ? { wght: { min: wght.min, max: wght.max } } : {}),
    ...(opsz ? { opsz: { min: opsz.min, max: opsz.max, ...(alias?.opsz ? { fixed: alias.opsz } : {}) } } : {}),
    weights: variable
      ? [...new Set(unique.map((item) => Math.round(item.weight)))]
      : [...new Set(shown.map((face) => face.weightClass))].toSorted((a, b) => a - b),
    named: unique,
    styles: [...new Set(faces.map((face) => (face.italic ? "italic" : "normal")))],
    faces: shown,
  };
}

function createDesignHostFonts({ directories = fontDirectories(), subset = (...args) => require("subset-font")(...args), readFile = fs.readFile } = {}) {
  let index;
  const files = new Map();
  const loaded = new Map();
  const build = async () => {
    const { designFontFileInfo } = await shared();
    const families = new Map();
    for (const directory of directories) {
      for (const file of await fontFiles(directory)) {
        const headers = await faceHeaders(file).catch(() => []);
        headers.forEach((bytes, faceIndex) => {
          let info;
          try {
            info = designFontFileInfo(bytes);
          } catch {
            return;
          }
          const apple = APPLE_FILES[path.basename(file).toLowerCase()];
          const family = apple ?? info.family;
          if (!family || family.startsWith(".")) return;
          const key = family.toLowerCase();
          if (apple && families.get(key)?.some((known) => !known.apple)) families.delete(key);
          if (!apple && families.get(key)?.some((known) => known.apple)) return;
          const list = families.get(key) ?? [];
          list.push({ ...info, family, file, index: faceIndex, apple: !!apple });
          families.set(key, list);
        });
      }
    }
    const described = new Map([...families].map(([key, faces]) => [key, describe(faces[0].family, faces)]));
    for (const [key, alias] of Object.entries(ALIASES)) {
      const faces = families.get(alias.family.toLowerCase());
      if (faces && !described.has(key))
        described.set(key, describe(alias.family, faces, { name: key.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/^Sf/, "SF"), opsz: alias.opsz }));
    }
    return described;
  };
  const ready = () => (index ??= build().catch(() => new Map()));
  let snapshot = null;
  const fileBytes = async (file) => {
    if (!files.has(file)) {
      files.set(file, readFile(file));
      if (files.size > MAX_CACHED_FILES) files.delete(files.keys().next().value);
    }
    return files.get(file);
  };
  async function face(request) {
    const entry = snapshot?.get(request.family.toLowerCase());
    if (!entry) return null;
    const variable = entry.wght ? entry.faces.find((item) => item.axes.some((axis) => axis.tag === "wght")) : null;
    const chosen = variable ?? entry.faces.find((item) => item.weightClass === request.weight) ?? entry.faces[0];
    const pins = {};
    if (variable) {
      const instance = variable.instances.find((item) => near(item.coordinates.wght, request.weight) && entry.named.some((named) => named.name === item.name));
      for (const axis of variable.axes) pins[axis.tag] = instance?.coordinates[axis.tag] ?? axis.default;
      pins.wght = request.weight;
      if (request.opsz !== null && pins.opsz !== undefined) pins.opsz = request.opsz;
    }
    const [{ renameDesignFont, designFontAdvances, designFontFace }, { DESIGN_ASCII_CHARACTERS, DESIGN_EXTRA_CHARACTERS }] = await Promise.all([
      shared(),
      characters(),
    ]);
    const text = DESIGN_ASCII_CHARACTERS + DESIGN_EXTRA_CHARACTERS;
    const bytes = await fileBytes(chosen.file);
    const source = Buffer.from(designFontFace(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), chosen.index));
    const instance = await subset(source, text, { targetFormat: "truetype", keepFeatures: [], ...(variable ? { variationAxes: pins } : {}) });
    const renamed = renameDesignFont(new Uint8Array(instance), request.cssFamily, request.weight);
    const advances = designFontAdvances(
      renamed,
      Array.from(text, (character) => character.codePointAt(0)),
    ).map((value) => value ?? FALLBACK_ADVANCE);
    return { key: request.key, data: Buffer.from(renamed).toString("base64"), advances };
  }
  return {
    ready: async () => {
      snapshot = await ready();
    },
    family: (name) => {
      const entry = snapshot?.get(name.toLowerCase());
      if (!entry) return null;
      const { faces: _faces, named: _named, styles: _styles, ...descriptor } = entry;
      return descriptor;
    },
    load: async (requests) => {
      snapshot = await ready();
      return Promise.all(
        requests.map((request) => {
          if (!loaded.has(request.key))
            loaded.set(
              request.key,
              face(request).catch(() => null),
            );
          return loaded.get(request.key);
        }),
      );
    },
    info: async (name) => {
      snapshot = await ready();
      return snapshot.get(name.toLowerCase()) ?? null;
    },
    families: async () => {
      snapshot = await ready();
      return [...new Set([...snapshot.values()].map((entry) => entry.family))].toSorted((a, b) => a.localeCompare(b));
    },
  };
}

let hostFonts;
/** The process's installed-font source, shared by the design tools, the saved-design renderer and the agent's previews. */
function designHostFonts() {
  return (hostFonts ??= createDesignHostFonts());
}

const installed = new WeakSet();
/** Hands this process's installed fonts to the shared design renderer once; returns the module for chaining. */
function withDesignHostFonts(design) {
  if (!installed.has(design) && process.env.MILAGRE_DESIGN_SYSTEM_FONTS !== "0") {
    design.setDesignLocalFonts(designHostFonts());
    installed.add(design);
  }
  return design;
}

module.exports = { createDesignHostFonts, designHostFonts, withDesignHostFonts, fontDirectories, faceHeaders };
