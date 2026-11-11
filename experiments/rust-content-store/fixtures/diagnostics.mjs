import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateDesignDocument, designDiagnostics, designWarningText, diffDesignDocuments } from "../../../packages/shared/src/design.mjs";
const source = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL("./design.mjs", import.meta.url))], { maxBuffer: 16 * 1024 * 1024 })).cases;
const documents = new Map();
const diffs = [];
for (const item of source) {
  try {
    const before = validateDesignDocument(item.document);
    documents.set(JSON.stringify(before), before);
    if (item.result) {
      documents.set(JSON.stringify(item.result), item.result);
      diffs.push({ name: item.name, before, after: item.result, operations: diffDesignDocuments(before, item.result) });
    }
  } catch {}
}
const frame = { id: "frame", type: "frame", width: 180, height: 100, fill: "#ffffff" };
const text = { id: "text", type: "text", parentId: "frame", x: 5, y: 5, width: 90, height: 15, text: "Long words overlap and get clipped", fill: "#cccccc" };
for (const nodes of [
  [frame, text],
  [
    { ...frame, layout: "vertical", gap: 20 },
    { ...text, width: 240, height: 170 },
  ],
  [frame, { id: "image", type: "image", parentId: "frame", width: 170, height: 99, src: "https://example.invalid/image.png" }, text],
  [{ ...frame, opacity: 0.5 }, text],
  [{ ...frame, fill: "rgba(255,255,255,.5)" }, text],
  [{ ...frame, width: 60 }, text],
  [{ ...text, parentId: undefined, x: 380, y: 840 }],
  [{ ...frame, hidden: true }, text],
  [text, frame],
  Array.from({ length: 25 }, (_, index) => ({ ...text, id: "text" + index, parentId: undefined, y: index * 30 })),
]) {
  const doc = validateDesignDocument({ schemaVersion: 1, width: 390, height: 844, tokens: { ink: "black", paper: "white" }, nodes });
  documents.set(JSON.stringify(doc), doc);
}
const cases = [...documents.values()].map((document) => {
  const diagnostics = designDiagnostics(document);
  return { document, diagnostics, warningText: designWarningText(diagnostics.warnings) };
});
process.stdout.write(JSON.stringify({ cases, diffs }));
