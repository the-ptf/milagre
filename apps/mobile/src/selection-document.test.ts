import assert from "node:assert/strict";
import test from "node:test";
import { markdownSelection, plainSelection } from "./selection-document.ts";
import { quoteIntoDraft } from "@milagre/shared/prompt-parts";

const text = (paragraphs: ReturnType<typeof markdownSelection>) => paragraphs.map((p) => p.spans.map((s) => s.text).join(""));

test("paragraphs keep the formatted message's gaps and inline looks", () => {
  const doc = markdownSelection("Eu consigo **não cadastrar** um `MCP` e [abrir](https://a.b).\n\nSegundo.");
  assert.deepEqual(text(doc), ["Eu consigo não cadastrar um MCP e abrir.", "Segundo."]);
  assert.deepEqual(
    doc[0]!.spans.map((s) => [s.text, !!s.bold, !!s.code, !!s.link]),
    [
      ["Eu consigo ", false, false, false],
      ["não cadastrar", true, false, false],
      [" um ", false, false, false],
      ["MCP", false, true, false],
      [" e ", false, false, false],
      ["abrir", false, false, true],
      [".", false, false, false],
    ],
  );
  assert.deepEqual(
    doc.map((p) => p.spaceBefore),
    [0, 12],
  );
});

test("lists carry their markers, nesting and inner gaps", () => {
  const doc = markdownSelection("O processo:\n\n1. Abra\n2. Configure:\n   - **Name:** Nora\n   - URL\n3. Confirme\n\nFim.");
  assert.deepEqual(
    doc.map((p) => [text([p])[0], p.markers.join(" "), p.showMarker, p.spaceBefore]),
    [
      ["O processo:", "", false, 0],
      ["Abra", "1.", true, 12],
      ["Configure:", "2.", true, 8],
      ["Name: Nora", "2. •", true, 8],
      ["URL", "2. •", true, 8],
      ["Confirme", "3.", true, 8],
      ["Fim.", "", false, 12],
    ],
  );
});

test("headings grow, code blocks stay verbatim, diagrams and generated UI are left out", () => {
  const doc = markdownSelection("# Title\n\n## Sub\n\n```sh\nnpm ci\n  npm test\n```\n\n```mermaid\ngraph TD\n```\n\n```openui\nx\n```\n\nDone.");
  assert.deepEqual(
    doc.map((p) => [p.kind, p.grow, text([p])[0]]),
    [
      ["heading", 2, "Title"],
      ["heading", 1, "Sub"],
      ["code", 0, "npm ci\n  npm test"],
      ["body", 0, "Done."],
    ],
  );
  assert.ok(doc[0]!.spans.every((s) => s.bold));
});

test("tables read a row per paragraph with tabs between cells and a bold header", () => {
  const doc = markdownSelection("| A | B |\n| - | - |\n| 1 | 2 |");
  assert.deepEqual(text(doc), ["A\tB", "1\t2"]);
  assert.equal(doc[0]!.spans[0]!.bold, true);
  assert.equal(doc[1]!.spans[0]!.bold, undefined);
});

test("quotes indent and soft breaks stay inside the paragraph", () => {
  const doc = markdownSelection("> one\n> two");
  assert.deepEqual(text(doc), ["one\ntwo"]);
  assert.equal(doc[0]!.quote, 1);
});

test("a plain message is one paragraph with its line breaks", () => {
  assert.deepEqual(text(plainSelection("a\n\nb")), ["a\n\nb"]);
  assert.deepEqual(plainSelection(""), []);
});

test("Ask quotes the passage under what was typed", () => {
  assert.equal(quoteIntoDraft("", "Name: Nora\nURL"), "> Name: Nora\n> URL\n\n");
  assert.equal(quoteIntoDraft("Pergunta  \n", "a\n\nb"), "Pergunta\n\n> a\n>\n> b\n\n");
  assert.equal(quoteIntoDraft("keep", "  \n"), "keep");
});
