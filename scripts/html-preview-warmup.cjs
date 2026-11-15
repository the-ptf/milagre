// The HTML preview's headless Chrome has electron-warmup.cjs's problem: on a fresh Linux CI runner its first launch can
// take longer than the preview's 20 s to open a debugging port (test-html-replies failed its first attempt in 18 of 107
// green runs, 2026-11), and the next launch takes about a second. `npm test` runs this once on Linux CI before a shard's
// checks that preview HTML. A failed warm-up is not a failed check.
const { previewHtml } = require("../packages/core/src/html-render.cjs");

const started = Date.now();
const seconds = () => ((Date.now() - started) / 1000).toFixed(1);
previewHtml({ html: "<p>warm-up</p>" }).then(
  () => console.log(`warm-up: HTML preview Chrome rendered in ${seconds()} s`),
  (error) => console.log(`warm-up: HTML preview Chrome failed after ${seconds()} s: ${error.message}`),
);
