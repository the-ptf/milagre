// Regenerate the Inter subsets embedded in design previews, SVG exports and the agent's PNG.
// Run: node scripts/generate-design-fonts.cjs
const fs = require("node:fs");
const path = require("node:path");
const subsetFont = require("subset-font");

const WEIGHTS = { 400: "Regular", 500: "Medium", 600: "SemiBold", 700: "Bold" };

async function main() {
  const { DESIGN_ASCII_CHARACTERS, DESIGN_EXTRA_CHARACTERS } = await import("../packages/shared/src/design-font-characters.mjs");
  const CHARACTERS = DESIGN_ASCII_CHARACTERS + DESIGN_EXTRA_CHARACTERS;
  const source = path.dirname(require.resolve("inter-font/package.json"));
  const out = path.resolve(__dirname, "../packages/shared/src");
  const fonts = {};
  for (const [weight, style] of Object.entries(WEIGHTS)) {
    const font = await subsetFont(fs.readFileSync(path.join(source, "ttf", `Inter-${style}.ttf`)), CHARACTERS, { targetFormat: "truetype" });
    fonts[weight] = font.toString("base64");
  }
  fs.writeFileSync(
    path.join(out, "design-font-data.mjs"),
    `// Inter 3.19 (SIL OFL 1.1, see design-font-data.LICENSE.txt), Latin subsets as TrueType. Regenerate: node scripts/generate-design-fonts.cjs\n` +
      `export const DESIGN_INTER_WEIGHTS = [400, 500, 600, 700];\n` +
      `export const designInterFonts = ${JSON.stringify(fonts)};\n`,
  );
  fs.copyFileSync(path.join(source, "OFL.txt"), path.join(out, "design-font-data.LICENSE.txt"));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
