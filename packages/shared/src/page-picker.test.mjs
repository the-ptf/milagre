import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { PAGE_PICK_CANCEL, pageDescribeAtScript, pagePickScript, pagePinsHidden, pagePinsScript } from "./page-picker.mjs";

test("the page scripts are valid JavaScript expressions, with their data inert", () => {
  for (const script of [
    pagePickScript(),
    pagePickScript("#3e9afd"),
    PAGE_PICK_CANCEL,
    pagePinsHidden(true),
    pagePinsScript([]),
    pageDescribeAtScript(0.5, 0.25),
  ])
    assert.doesNotThrow(() => new Function(`return ${script}`), script.slice(0, 40));
  const hostile = pagePinsScript([{ n: 1, selector: '"]); alert(1); ("', text: "</script><img onerror=alert(1)>`${x}`", state: "open" }]);
  assert.doesNotThrow(() => new Function(`return ${hostile}`));
  assert.match(hostile, /const pins = \[\{"n":1,"selector":"\\"\]\); alert\(1\); \(\\""/);
});

test("a tapped point can't carry code into the page", () => {
  const script = pageDescribeAtScript("1; alert(1)", Infinity);
  assert.doesNotThrow(() => new Function(`return ${script}`));
  assert.match(script, /const px = 0\.5 \* innerWidth, py = 0\.5 \* innerHeight;/);
});

test("desktop and mobile page scripts remove resolved pins without changing saved comments or pending numbers", () => {
  const comments = [
    { id: "sent", n: 0, selector: "h1", text: "Shorter", state: "open" },
    { id: "done", n: 0, selector: "h1", text: "Bigger", state: "resolved", note: "Done" },
    { id: "draft", n: 1, selector: "h1", text: "Green", state: "pending" },
  ];
  let shown;
  const context = {
    window: {
      __milagrePins: {
        set: (pins) => {
          shown = pins;
        },
      },
    },
  };
  assert.equal(runInNewContext(pagePinsScript(comments), context), 2);
  assert.deepEqual(
    Array.from(shown, ({ id, n }) => [id, n]),
    [
      ["sent", 0],
      ["draft", 1],
    ],
  );
  assert.equal(comments.length, 3, "history is retained");
  assert.equal(runInNewContext(pagePinsScript(comments.map((pin) => ({ ...pin, state: "resolved" }))), context), 0);
  assert.equal(shown.length, 0, "resolving the last comment clears the layer");
});

test("injected scripts work when the native JS engine does not retain function source", (t) => {
  const source = t.mock.method(Function.prototype, "toString", () => "function () { [bytecode] }");
  const scripts = [pagePickScript(), pageDescribeAtScript(0.5, 0.5), pagePinsScript([])];
  source.mock.restore();
  for (const script of scripts) {
    assert.doesNotMatch(script, /\[bytecode\]/);
    assert.doesNotThrow(() => new Function(`return ${script}`));
  }
});

test("blank page space gets an exact pin even below a short body or after scrolling", () => {
  const root = {
    tagName: "HTML",
    nodeType: 1,
    id: "",
    classList: [],
    parentElement: null,
    scrollWidth: 800,
    scrollHeight: 1200,
    innerText: "",
    getAttribute: () => null,
    cloneNode: () => ({ attributes: [], querySelectorAll: () => [], outerHTML: "<html></html>" }),
  };
  const body = { tagName: "BODY" };
  const document = { documentElement: root, body, querySelectorAll: () => [], elementFromPoint: () => body };
  const context = {
    document,
    window: {},
    innerWidth: 800,
    innerHeight: 600,
    scrollX: 0,
    scrollY: 300,
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
  };
  const picked = runInNewContext(pageDescribeAtScript(0.25, 0.75), context);
  assert.equal(picked.selector, "html");
  assert.equal(picked.label, "Page background");
  assert.equal(picked.box.x + picked.point.x * picked.box.width, 200);
  assert.equal(picked.box.y + picked.point.y * picked.box.height, 450);
  root.scrollHeight = 100;
  context.scrollY = 0;
  const blank = runInNewContext(pageDescribeAtScript(0.5, 0.9), context);
  assert.equal(blank.box.height, 600, "blank space below the content is still part of the page");
  assert.equal(blank.point.y, 0.9);
});
