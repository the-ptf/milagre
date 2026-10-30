import assert from "node:assert/strict";
import { test } from "node:test";
import { assetInline, assetType, mentionsAsset, rewriteAssetUrls } from "./artifact-assets.mjs";

test("a page's files are found by their whole assets/<name> reference, and point where the viewer keeps them", () => {
  const html = `<img src="assets/a.png"><img src='./assets/a.png'><div style="background:url(assets/a.png)"></div><video src=assets/clip.mp4></video>
<p>assets/a.png.bak /x/assets/a.png myassets/a.png assets/a.pngx</p>`;
  assert.equal(mentionsAsset(html, "a.png"), true);
  assert.equal(mentionsAsset("<p>myassets/a.png assets/a.pngx /x/assets/a.png</p>", "a.png"), false);
  assert.equal(mentionsAsset("<p>assets/aXpng</p>", "a.png"), false, "a dot in the name is a dot");
  const out = rewriteAssetUrls(html, [{ name: "a.png" }, { name: "clip.mp4" }], (asset) => `file:///cache/${asset.name}?$&`);
  assert.equal((out.match(/file:\/\/\/cache\/a\.png\?\$&/g) ?? []).length, 3, "replacement text is taken as is");
  assert.match(out, /<video src=file:\/\/\/cache\/clip\.mp4\?\$&>/);
  assert.match(out, /assets\/a\.png\.bak \/x\/assets\/a\.png myassets\/a\.png assets\/a\.pngx/, "longer paths and names stay");
  // A page split into tabs carries each tab as a JSON string.
  assert.equal(
    rewriteAssetUrls(JSON.stringify(['<img src="assets/a.png">']), [{ name: "a.png" }], () => "/s/x/files/h"),
    JSON.stringify(['<img src="/s/x/files/h">']),
  );
});

test("a file's type comes from its extension, and only media shows inline", () => {
  assert.equal(assetType("Clip.MP4"), "video/mp4");
  assert.equal(assetType("notes"), "application/octet-stream");
  assert.equal(assetInline("video/mp4"), true);
  assert.equal(assetInline("image/svg+xml"), false);
  assert.equal(assetInline("application/zip"), false);
});
