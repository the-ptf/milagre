import assert from "node:assert/strict";
import test from "node:test";
import { githubImageSource } from "./github-image.mjs";

test("repository screenshot URLs resolve to authenticated contents requests on both platforms", () => {
  for (const url of [
    "https://github.com/acme/app/blob/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/.pr-assets/11965/asset1.png?raw=true",
    "https://github.com/acme/app/blob/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/.pr-assets/11965/asset1.png",
    "https://github.com/acme/app/raw/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/.pr-assets/11965/asset1.png",
    "https://raw.githubusercontent.com/acme/app/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/.pr-assets/11965/asset1.png",
  ]) {
    assert.deepEqual(githubImageSource(url), {
      kind: "repository",
      url: "https://api.github.com/repos/acme/app/contents/.pr-assets/11965/asset1.png?ref=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      mime: "image/png",
    });
  }
  assert.equal(
    githubImageSource("https://github.com/acme/app/blob/main/screens/a%20b.JPG")?.url,
    "https://api.github.com/repos/acme/app/contents/screens/a%20b.JPG?ref=main",
  );
});

test("uploads retain their original URL and other hosts or malformed paths stay unsupported", () => {
  const upload = "https://github.com/user-attachments/assets/1a75943a-4133-4d9d-8fa3-99d4a0b689da";
  assert.deepEqual(githubImageSource(upload), { kind: "attachment", url: upload });
  for (const url of [
    "https://example.com/screen.png",
    "http://github.com/o/r/blob/main/a.png",
    "https://github.com.evil/o/r/blob/main/a.png",
    "https://user@github.com/o/r/blob/main/a.png",
    "https://github.com/o/r/tree/main/a.png",
    "https://github.com/o/r/blob/main/a.txt",
    "https://github.com/o/r/blob/main/a.constructor",
    "https://github.com/o/r/blob/main/../a.png",
    "https://github.com/o/r/blob/main/%2e%2e/a.png",
    "https://github.com/o/r/blob/main/a%2fb.png",
    "https://github.com/o/r/blob/main/a%5cb.png",
    "https://github.com/o/r/blob/main/a%00.png",
    "https://github.com/o/r/blob/main/a%.png",
    "https://github.com/o/r/blob/main/a.png?next=https://evil.example",
    upload + "?x=1",
  ])
    assert.equal(githubImageSource(url), null, url);
});

test("qualified refs preserve their namespace and ambiguous paths request ref resolution", () => {
  for (const host of ["https://github.com/acme/app/blob/", "https://github.com/acme/app/raw/", "https://raw.githubusercontent.com/acme/app/"]) {
    for (const namespace of ["refs/heads", "refs/tags"]) {
      const simple = githubImageSource(`${host}${namespace}/release/shot.png`);
      assert.equal(simple.url, `https://api.github.com/repos/acme/app/contents/shot.png?ref=${encodeURIComponent(`${namespace}/release`)}`);
      const nested = githubImageSource(`${host}${namespace}/release/v2/images/shot.png`);
      assert.deepEqual(nested.resolve, {
        endpoint: "https://api.github.com/repos/acme/app",
        namespace,
        parts: ["release", "v2", "images", "shot.png"],
      });
    }
    assert.equal(githubImageSource(`${host}feature/screens/shot.png`).resolve.namespace, null);
    assert.equal(githubImageSource(`${host}dead/beef/shot.png`).resolve.namespace, null);
    for (const path of ["refs/heads/branch/../shot.png", "refs/tags/branch/%2e%2e/shot.png", "refs/heads/branch/a%2fshot.png", "refs/heads/shot.png"]) {
      assert.equal(githubImageSource(host + path), null);
    }
  }
});
