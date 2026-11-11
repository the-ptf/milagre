// Build-time data snapshot. Runtime rendering does not invoke JavaScript or Node.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { designFontMetrics } from "../../../packages/shared/src/design-font-metrics.mjs";
import { designInterFonts, DESIGN_INTER_WEIGHTS } from "../../../packages/shared/src/design-font-data.mjs";
import { DESIGN_EXTRA_CHARACTERS } from "../../../packages/shared/src/design-font-characters.mjs";
import { DESIGN_FONT_CATALOG, designCatalogFontLoaders } from "../../../packages/shared/src/design-font-catalog.mjs";
import { designIcons } from "../../../packages/shared/src/design-icons.mjs";
import { DESIGN_CONTROLLER_SCRIPT } from "../../../packages/shared/src/design-controller-script.mjs";
const sources = {};
for (const file of ["design.mjs", "design-layout.mjs", "design-fonts.mjs", "design-render-limits.mjs", "design-controller-script.mjs"]) {
  sources[file] = createHash("sha256")
    .update(await readFile(new URL("../../../packages/shared/src/" + file, import.meta.url)))
    .digest("hex");
}
const catalog = {};
for (const [name, entry] of Object.entries(DESIGN_FONT_CATALOG)) {
  catalog[name] = { ...entry, faces: (await designCatalogFontLoaders[name]()).default };
}
process.stdout.write(
  JSON.stringify({
    sources,
    metrics: designFontMetrics,
    inter: designInterFonts,
    interWeights: DESIGN_INTER_WEIGHTS,
    extra: DESIGN_EXTRA_CHARACTERS,
    catalog,
    icons: designIcons,
    controller: DESIGN_CONTROLLER_SCRIPT,
  }),
);
