import assert from "node:assert/strict";
import test from "node:test";
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
