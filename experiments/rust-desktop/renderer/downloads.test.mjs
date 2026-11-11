import assert from "node:assert/strict";
import test from "node:test";
import { downloadPayload, installDownloads, MAX_DOWNLOAD_BYTES } from "./downloads.js";

test("download payload preserves binary bytes across encoding chunks", async () => {
  const bytes = Uint8Array.from({ length: 70_003 }, (_, index) => index % 256);
  const result = await downloadPayload(new Blob([bytes]), "design.png");
  assert.equal(result.name, "design.png");
  assert.equal(result.size, bytes.length);
  assert.deepEqual(Buffer.from(result.base64, "base64"), Buffer.from(bytes));
  assert.deepEqual(await downloadPayload(new Blob(), ""), { name: "download", size: 0, base64: "" });
});

test("oversized downloads fail before reading their bytes", async () => {
  const oversized = new Blob();
  Object.defineProperty(oversized, "size", { value: MAX_DOWNLOAD_BYTES + 1 });
  oversized.arrayBuffer = () => assert.fail("Oversized blob was read");
  await assert.rejects(downloadPayload(oversized, "large.bin"), /64 MiB/);
  await assert.rejects(downloadPayload(undefined, "missing.bin"), /no longer available/);
});

test("detached and visible download anchors save their captured Blob without navigation", async () => {
  const originals = {
    Element: globalThis.Element,
    HTMLAnchorElement: globalThis.HTMLAnchorElement,
    document: globalThis.document,
    createObjectURL: URL.createObjectURL,
    revokeObjectURL: URL.revokeObjectURL,
  };
  const calls = [];
  const errors = [];
  let navigations = 0;
  let listener;
  class Element {
    closest() {
      return null;
    }
  }
  class Anchor extends Element {
    constructor(href, download) {
      super();
      this.href = href;
      this.download = download;
    }
    hasAttribute(name) {
      return name === "download" && this.download !== undefined;
    }
    closest() {
      return this.hasAttribute("download") ? this : null;
    }
    click() {
      navigations++;
    }
  }
  Object.assign(globalThis, {
    Element,
    HTMLAnchorElement: Anchor,
    document: {
      addEventListener(type, callback) {
        assert.equal(type, "click");
        listener = callback;
      },
    },
  });
  try {
    installDownloads(
      async (...args) => {
        calls.push(args);
        return null;
      },
      (error) => errors.push(error),
    );
    const detachedUrl = URL.createObjectURL(new Blob(["<svg/>"], { type: "image/svg+xml" }));
    new Anchor(detachedUrl, "design.svg").click();
    URL.revokeObjectURL(detachedUrl);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(calls, [["download:save", { name: "design.svg", size: 6, base64: "PHN2Zy8+" }]]);
    assert.equal(navigations, 0);

    const visibleUrl = URL.createObjectURL(new Blob(["file"]));
    const event = {
      target: new Anchor(visibleUrl, "attached.txt"),
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    listener(event);
    URL.revokeObjectURL(visibleUrl);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(event.defaultPrevented, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[1][1].name, "attached.txt");
    assert.equal(errors.length, 0); // A native cancellation is not a failed download.

    new Anchor("file:///private/data", "untrusted.bin").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls.length, 2);
    assert.match(errors[0].message, /no longer available/);
    new Anchor("https://example.com", undefined).click();
    assert.equal(navigations, 1);
  } finally {
    Object.assign(globalThis, { Element: originals.Element, HTMLAnchorElement: originals.HTMLAnchorElement, document: originals.document });
    URL.createObjectURL = originals.createObjectURL;
    URL.revokeObjectURL = originals.revokeObjectURL;
  }
});
