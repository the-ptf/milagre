import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { DESIGNS_CANVAS_SCRIPT, artifactDocument } from "./artifact-document.mjs";

const element = () => ({
  style: {},
  children: [],
  clientWidth: 390,
  clientHeight: 844,
  classList: { add() {}, remove() {} },
  appendChild(child) {
    this.children.push(child);
  },
  setAttribute() {},
  addEventListener() {},
  remove() {},
});

function page() {
  const nodes = { port: element(), world: element(), marks: element() };
  const window = {};
  vm.runInNewContext(DESIGNS_CANVAS_SCRIPT, {
    window,
    document: { getElementById: (id) => nodes[id], createElement: element, addEventListener() {} },
    matchMedia: () => ({ matches: true }),
    ResizeObserver: class {
      observe() {}
    },
  });
  const run = (message) => window.milagreCanvas.run(message);
  run({ t: "set", rows: [{ designs: [{ id: "home", w: 390, h: 844 }] }] });
  return { run, frame: () => nodes.world.children[0].children[0] };
}

test("canvas splices held fonts exactly, keeps full HTML unchanged, and updates font versions", () => {
  const p = page();
  const doc = artifactDocument("<!doctype html><html><head><style>body{color:red}</style></head><body>Hi</body></html>");
  const css = '@font-face{font-family:"Inter";src:url(data:font/ttf;base64,AAAA)}';
  p.run({ t: "fonts", key: "inter", css });
  p.run({ t: "html", id: "home", doc, font: "inter" });
  assert.equal(p.frame().srcdoc, doc.replace("</head>", `<style>${css}</style></head>`));
  p.run({ t: "fonts", key: "catalog", css: css + "/* catalog */" });
  p.run({ t: "html", id: "home", doc, font: "catalog" });
  assert.match(p.frame().srcdoc, /catalog/);
  p.run({ t: "html", id: "home", doc });
  assert.equal(p.frame().srcdoc, doc);
});

test("unknown fonts and malformed heads never replace a painted design or mount an unfonted frame", () => {
  const p = page();
  const doc = artifactDocument("<html><head></head><body>Hello</body></html>");
  p.run({ t: "html", id: "home", doc, font: "missing" });
  assert.equal(p.frame(), undefined);
  p.run({ t: "fonts", key: "held", css: "@font-face{}" });
  p.run({ t: "html", id: "home", doc, font: "held" });
  const painted = p.frame().srcdoc;
  p.run({ t: "html", id: "home", doc, font: "missing" });
  p.run({ t: "html", id: "home", doc: "no head", font: "held" });
  assert.equal(p.frame().srcdoc, painted);
  // A fresh page has no fonts until the native ready handler replays them.
  const fresh = page();
  fresh.run({ t: "html", id: "home", doc, font: "held" });
  assert.equal(fresh.frame(), undefined);
  fresh.run({ t: "fonts", key: "held", css: "@font-face{}" });
  fresh.run({ t: "html", id: "home", doc, font: "held" });
  assert.equal(fresh.frame().srcdoc, painted);
});
