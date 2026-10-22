const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { transformSync } = require("esbuild");

function imageDraft() {
  const slots = [];
  let cursor = 0;
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [
        slots[index],
        (update) => {
          slots[index] = typeof update === "function" ? update(slots[index]) : update;
        },
      ];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect() {},
  };
  const pending = [];
  class FileReader {
    readAsDataURL() {
      pending.push(() => {
        this.result = "data:image/png;base64,AAAA";
        this.onload();
      });
    }
  }
  const source = fs.readFileSync(path.join(__dirname, "../apps/desktop/app/src/components/usePastedImages.ts"), "utf8");
  const { code } = transformSync(source, { loader: "ts", format: "cjs" });
  const context = {
    module: { exports: {} },
    FileReader,
    crypto: globalThis.crypto,
    window: { milagre: { getPathForFile: (file) => file.name } },
    require: (name) => (name === "react" ? react : require(name)),
  };
  vm.runInNewContext(code, context);
  const render = () => {
    cursor = 0;
    return context.module.exports.usePastedImages("review");
  };
  const file = (name) => ({ name, size: 1, type: "image/png" });
  return { render, file, finish: () => pending.shift()() };
}

for (const method of ["addFiles", "attachFiles"]) {
  test(`${method} numbers an image against the attachments remaining when its read finishes`, async () => {
    const { render, file, finish } = imageDraft();
    let read = render()[method]([file("first.png")]);
    finish();
    await read;
    const hook = render();
    read = hook[method]([file("second.png")]);
    hook.remove(hook.images[0].id);
    finish();
    assert.equal(JSON.stringify(await read), "[1]");
    assert.equal(render().images[0].name, "second.png");
    assert.equal(render().images.length, 1);
  });
}

test("failed-send restoration remaps a new draft to its merged image order", async () => {
  const { render, file, finish } = imageDraft();
  let read = render().addFiles([file("sent.png")]);
  finish();
  await read;
  const sent = render().images;
  render().clear();
  read = render().addFiles([file("new.png")]);
  finish();
  await read;
  assert.equal(render().restore(sent, [], "new [Image #1]"), "new [Image #2]");
  assert.equal(
    render()
      .images.map((image) => image.name)
      .join(","),
    "sent.png,new.png",
  );
});
