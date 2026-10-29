import assert from "node:assert/strict";
import test from "node:test";
import { PAGE_PICK_CANCEL, pagePickScript, pagePinsHidden, pagePinsScript } from "./page-picker.mjs";

test("the page scripts are valid JavaScript expressions, with their data inert", () => {
  for (const script of [pagePickScript(), pagePickScript("#3e9afd"), PAGE_PICK_CANCEL, pagePinsHidden(true), pagePinsScript([])])
    assert.doesNotThrow(() => new Function(`return ${script}`), script.slice(0, 40));
  const hostile = pagePinsScript([{ n: 1, selector: '"]); alert(1); ("', text: "</script><img onerror=alert(1)>`${x}`", state: "open" }]);
  assert.doesNotThrow(() => new Function(`return ${hostile}`));
  assert.match(hostile, /const pins = \[\{"n":1,"selector":"\\"\]\); alert\(1\); \(\\""/);
});
