// UIKit toolbar images need raster assets. Keep the same PR drawing as desktop and Android.
// Run: node scripts/generate-pr-toolbar-icon.cjs
const fs = require("node:fs");
const path = require("node:path");
const { initWasm, Resvg } = require("@resvg/resvg-wasm");
const { GitPullRequestIcon } = require("@hugeicons/core-free-icons");

async function main() {
  await initWasm(fs.readFileSync(require.resolve("@resvg/resvg-wasm/index_bg.wasm")));
  const drawing = GitPullRequestIcon.map(([tag, attributes]) => {
    const pairs = Object.entries({ ...attributes, strokeWidth: 1.8 }).filter(([key]) => key !== "key");
    return `<${tag} ${pairs.map(([key, value]) => `${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}="${value}"`).join(" ")}/>`;
  }).join("");
  for (const scale of [1, 2, 3]) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${28 * scale}" height="${28 * scale}" viewBox="0 0 24 24" fill="none" color="black">${drawing}</svg>`;
    const suffix = scale === 1 ? "" : `@${scale}x`;
    fs.writeFileSync(path.join(__dirname, `../apps/mobile/assets/pr-toolbar${suffix}.png`), new Resvg(svg).render().asPng());
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
