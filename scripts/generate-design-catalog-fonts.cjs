// Regenerate the catalog fonts designs can name besides Inter: Google Fonts (SIL OFL 1.1) families at the weights listed
// below. Each is subset like Inter, saved as its own module so viewers load only the families a design names, and measured
// for shared line breaking. Needs network access.
// Run: node scripts/generate-design-catalog-fonts.cjs
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "packages/shared/src");
const FONTS = path.join(OUT, "design-catalog-fonts");
// A legacy user agent makes the Google Fonts CSS API answer with whole static TrueType instances, one per weight.
const LEGACY_AGENT = "Mozilla/4.0";

const slug = (family) => family.toLowerCase().replace(/[^a-z0-9]+/g, "-");

// Grotesks, serifs, slabs and condensed display faces: a working type system for most briefs. A weight a family lacks is
// skipped, and text asking for it renders with the nearest drawn weight.
const FAMILIES = {
  "Albert Sans": [400, 500, 600],
  Anton: [400],
  Archivo: [400, 500, 600, 800],
  Barlow: [400, 500],
  "Barlow Condensed": [400, 700],
  "Bebas Neue": [400],
  Besley: [400, 800],
  "Big Shoulders": [400, 800],
  "Bodoni Moda": [400, 500],
  "Bricolage Grotesque": [400, 500, 600],
  Chivo: [400, 700, 900],
  "EB Garamond": [400, 500],
  Epilogue: [400, 500, 900],
  Figtree: [400, 600],
  "Hanken Grotesk": [400, 500],
  Imbue: [400],
  Jost: [400, 500, 700],
  "League Spartan": [400, 700],
  "Libre Franklin": [400, 600, 700],
  Literata: [400, 500, 600],
  Newsreader: [300, 400, 500],
  Onest: [400, 500],
  "Public Sans": [400, 600],
  "Red Hat Display": [400, 900],
  "Red Hat Text": [400, 500],
  Rokkitt: [400, 800],
  "Schibsted Grotesk": [400, 600, 800],
  "Source Serif 4": [400, 600],
  "Stack Sans Headline": [300, 400],
  "Stack Sans Text": [400, 500],
  "STIX Two Text": [400, 600],
  "TikTok Sans": [400, 500, 800],
  Unbounded: [400, 800],
  "Work Sans": [300, 400, 500, 600],
  "Young Serif": [400],
  "Zilla Slab": [400, 500, 600],
};

function catalogFamilies() {
  return Object.entries(FAMILIES).map(([family, weights]) => ({ family, weights }));
}

async function download(family, weight) {
  const css = await fetch(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}:wght@${weight}`, {
    headers: { "User-Agent": LEGACY_AGENT },
  });
  // A weight the family does not have is a 400 for the whole request; the nearest drawn weight stands in for it.
  if (!css.ok) return null;
  const url = /url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.ttf)\)/.exec(await css.text())?.[1];
  if (!url) throw new Error(`No TrueType source for ${family} ${weight}`);
  const font = await fetch(url);
  if (!font.ok) throw new Error(`${family} ${weight}: ${font.status}`);
  return Buffer.from(await font.arrayBuffer());
}

async function licence(family) {
  for (const directory of [family.toLowerCase().replace(/[^a-z0-9]/g, ""), slug(family)]) {
    const response = await fetch(`https://raw.githubusercontent.com/google/fonts/main/ofl/${directory}/OFL.txt`);
    if (response.ok) return response.text();
  }
  throw new Error(`No OFL.txt for ${family} in google/fonts`);
}

async function measureFonts(faces, characters) {
  const context = document.createElement("canvas").getContext("2d");
  context.fontKerning = "none";
  const result = {};
  for (const { family, weights } of faces) {
    const name = `Milagre Catalog ${family}`;
    result[family] = {};
    for (const [weight, base64] of Object.entries(weights)) {
      const face = new FontFace(
        name,
        Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)),
        { weight },
      );
      document.fonts.add(await face.load());
      // Canvas silently falls back to another font when a face is missing, so prove each weight is really loaded.
      if (!document.fonts.check(`${weight} 16px "${name}"`)) throw new Error(`${family} ${weight} did not load`);
      context.font = `${weight} 1000px "${name}"`;
      result[family][weight] = Array.from(characters, (character) => Math.round(context.measureText(character).width) / 1000);
    }
  }
  return result;
}

async function measure(faces, characters) {
  const { app, BrowserWindow } = require("electron");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-catalog-metrics-"));
  app.setPath("userData", temporary);
  try {
    await app.whenReady();
    const window = new BrowserWindow({ show: false });
    await window.loadURL("about:blank");
    const metrics = await window.webContents.executeJavaScript(`(${measureFonts.toString()})(${JSON.stringify(faces)}, ${JSON.stringify(characters)})`);
    window.destroy();
    return metrics;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

async function main() {
  if (!process.versions.electron) {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = require("node:child_process").spawnSync(require("electron"), [__filename], { env, stdio: "inherit" });
    process.exitCode = child.status ?? 1;
    return;
  }
  const subsetFont = require("subset-font");
  const { DESIGN_ASCII_CHARACTERS, DESIGN_EXTRA_CHARACTERS } = await import("../packages/shared/src/design-font-characters.mjs");
  const characters = DESIGN_ASCII_CHARACTERS + DESIGN_EXTRA_CHARACTERS;
  fs.rmSync(FONTS, { recursive: true, force: true });
  fs.mkdirSync(FONTS, { recursive: true });
  const faces = [];
  const licences = [];
  for (const { family, weights } of catalogFamilies()) {
    const drawn = {};
    for (const weight of weights) {
      const source = await download(family, weight);
      if (!source) continue;
      // Keep the typographic family and subfamily (name IDs 16/17), as for Inter, so resvg tells the weights apart.
      const font = await subsetFont(source, characters, { targetFormat: "truetype", preserveNameIds: [1, 2, 16, 17] });
      drawn[weight] = font.toString("base64");
    }
    if (!Object.keys(drawn).length) throw new Error(`${family} has none of its weights on Google Fonts`);
    fs.writeFileSync(
      path.join(FONTS, `${slug(family)}.mjs`),
      `// ${family} from Google Fonts (SIL OFL 1.1, see LICENSE.txt), Latin subsets as TrueType. Regenerate: node scripts/generate-design-catalog-fonts.cjs\n` +
        `export default ${JSON.stringify(drawn)};\n`,
    );
    faces.push({ family, weights: drawn });
    licences.push(`${family}\n${"=".repeat(family.length)}\n\n${(await licence(family)).trim()}\n`);
    console.log(family, Object.keys(drawn).join(" "));
  }
  fs.writeFileSync(path.join(FONTS, "LICENSE.txt"), licences.join("\n\n"));
  const metrics = await measure(faces, characters);
  const catalog = Object.fromEntries(
    faces.map(({ family, weights }) => [
      family.toLowerCase(),
      {
        family,
        weights: Object.keys(weights).map(Number),
        // Advances at 1000px with kerning off: the 95 printable ASCII characters, then DESIGN_EXTRA_CHARACTERS in order.
        advances: metrics[family],
      },
    ]),
  );
  const loaders = faces.map(({ family }) => `  ${JSON.stringify(family.toLowerCase())}: () => import("./design-catalog-fonts/${slug(family)}.mjs"),`);
  fs.writeFileSync(
    path.join(OUT, "design-font-catalog.mjs"),
    `// Catalog fonts a design can name besides Inter, measured for shared line breaking. Regenerate: node scripts/generate-design-catalog-fonts.cjs\n` +
      `export const DESIGN_FONT_CATALOG = ${JSON.stringify(catalog)};\n\n` +
      `// One module per family, imported only when a design names it.\n` +
      `export const designCatalogFontLoaders = {\n${loaders.join("\n")}\n};\n`,
  );
  require("electron").app.quit();
}

main().catch((error) => {
  console.error(error);
  if (process.versions.electron) require("electron").app.exit(1);
  else process.exitCode = 1;
});
