import assert from "node:assert/strict";
import test from "node:test";
import { designFontFamily, designHtml, designSvg, validateDesignDocument } from "./design.mjs";

const screen = (fontFamily) => ({
  schemaVersion: 1,
  width: 390,
  height: 844,
  nodes: [
    {
      id: "label",
      type: "text",
      width: 300,
      height: 40,
      text: "Font test",
      fontFamily,
    },
  ],
});

test("custom font names are quoted consistently while generic families stay generic", () => {
  assert.equal(designFontFamily(), '"Arial", sans-serif');
  assert.equal(designFontFamily("Font 3, SF.Pro, 3D Font, UI-SANS-SERIF"), '"Font 3", "SF.Pro", "3D Font", ui-sans-serif');
  const document = validateDesignDocument(screen("Font 3, SF.Pro, sans-serif"));
  assert.match(designHtml(document), /font-family:&quot;Font 3&quot;, &quot;SF.Pro&quot;, sans-serif/);
  assert.match(designSvg(document), /font-family="&quot;Font 3&quot;, &quot;SF.Pro&quot;, sans-serif"/);
});

test("font lists reject empty families, CSS syntax and line controls before rendering", () => {
  for (const fontFamily of ["", " ", "Inter,,serif", ",Arial", "Arial, ", "Arial\nserif", "Arial; color:red", '"Arial"', "Arial\\serif"]) {
    assert.throws(() => validateDesignDocument(screen(fontFamily)), /font family/);
  }
});
