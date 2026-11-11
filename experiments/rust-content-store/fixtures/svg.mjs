import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { designSvg, loadDesignFonts } from "../../../packages/shared/src/design.mjs";
const sources = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL("./render.mjs", import.meta.url))], { maxBuffer: 64 * 1024 * 1024 }));
sources.push({
  name: "paint-case-opacity-clips",
  document: {
    schemaVersion: 1,
    width: 390,
    height: 844,
    background: "#AbCdEf",
    nodes: [
      { id: "group", type: "frame", width: 120, height: 120, opacity: 0.8, radius: 12, stroke: "#AaBbCc", strokeWidth: 5 },
      { id: "shape", type: "ellipse", parentId: "group", x: 20, y: 10, width: 60, height: 40, fill: "#ABCd", stroke: "rgba(100, 20, 30, .3)" },
      { id: "text", type: "text", parentId: "group", x: 20, y: 40, width: 80, height: 70, text: "A\u0001\ud800B 😀", stroke: "#ffe", strokeWidth: 2 },
      { id: "off", type: "rectangle", x: 400, y: 400, width: 40, height: 40, fill: "transparent" },
    ],
  },
});
const cases = [];
for (const source of sources) {
  await loadDesignFonts(source.document);
  for (const options of [{ embedFonts: false }, { embedFonts: true, onCanvasOnly: true }]) {
    try {
      cases.push({ name: source.name, document: source.document, options, svg: designSvg(source.document, options) });
    } catch (error) {
      cases.push({ name: source.name, document: source.document, options, error: error.message });
    }
  }
}
process.stdout.write(JSON.stringify(cases));
