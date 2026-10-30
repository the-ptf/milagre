const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { transformSync } = require("esbuild");

function imageDraft({ owner, deferUploads = false, upload = async () => ({ file: { id: "uploaded", path: "/remote/uploads/note.txt" } }) } = {}) {
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
  const uploads = [];
  const bridge = {
    uploadAttachment: async (request) => {
      uploads.push(request);
      return upload(request);
    },
  };
  class FileReader extends EventTarget {
    emit(type) {
      this.dispatchEvent(new Event(type));
    }
    readAsDataURL() {
      pending.push(() => {
        this.result = "data:image/png;base64,AAAA";
        this.emit("load");
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
    require: (name) =>
      name === "react"
        ? react
        : name === "../lib/attachment-uploads"
          ? {
              uploadFile: async (owner, name, base64, current, onProgress) => {
                const result = await bridge.uploadAttachment({ projectPath: owner, name, base64, onProgress });
                if (result.error) throw new context.Error(result.error.message);
                return result.file;
              },
            }
          : name === "../lib/computer-bridge"
            ? {
                isRemoteKey: (key) => Boolean(key?.includes("|")),
                bridgeForKey: () => bridge,
              }
            : require(name),
  };
  context.Error = Error;
  vm.runInNewContext(code, context);
  const render = () => {
    cursor = 0;
    return context.module.exports.usePastedImages("review", owner, deferUploads);
  };
  const file = (name) => ({ name, size: 1, type: "image/png" });
  return { render, file, uploads, finish: () => pending.shift()() };
}

test("files chosen offline retain their bytes locally without contacting the computer", async () => {
  const { render, uploads } = imageDraft({ owner: "computer|/project", deferUploads: true });
  const file = { name: "note.txt", size: 3, type: "text/plain" };
  await render().attachFiles([file]);
  const hook = render();
  assert.equal(uploads.length, 0);
  assert.match(hook.files[0], /^\/\.milagre-offline-attachments\//);
  assert.equal(hook.localFiles.get(hook.files[0]), file);
  assert.equal(hook.loading, false);
});

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

test("a remote Chat uploads selected file bytes and attaches the receiving computer's path", async () => {
  const { render, finish, uploads } = imageDraft({ owner: "computer|/project" });
  const read = render().attachFiles([{ name: "note.txt", size: 3, type: "text/plain" }]);
  assert.equal(render().loading, true);
  finish();
  await read;
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].projectPath, "computer|/project");
  assert.equal(uploads[0].name, "note.txt");
  assert.equal(uploads[0].base64, "AAAA");
  assert.equal(JSON.stringify(render().files), '["/remote/uploads/note.txt"]');
  assert.equal(render().loading, false);
  render().attachPath("/remote/project/existing.txt");
  assert.equal(render().files[1], "/remote/project/existing.txt");
});

test("failed remote uploads leave no attachment and report the receiving computer's error", async () => {
  const { render, finish } = imageDraft({ owner: "computer|/project", upload: async () => ({ error: { status: 507, message: "Storage full" } }) });
  const read = render().attachFiles([{ name: "note.txt", size: 3, type: "text/plain" }]);
  finish();
  await read;
  assert.equal(render().files.length, 0);
  assert.equal(render().error, "Storage full");
  assert.equal(render().loading, false);
});

test("clearing a Chat during a remote upload keeps its result out of the new draft", async () => {
  let complete;
  const { render, finish } = imageDraft({
    owner: "computer|/project",
    upload: () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  });
  const read = render().attachFiles([{ name: "note.txt", size: 3, type: "text/plain" }]);
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  render().clear();
  complete({ file: { path: "/remote/uploads/note.txt" } });
  await read;
  assert.equal(render().files.length, 0);
  assert.equal(render().localFiles.size, 0);
});

test("remote image files retain their thumbnail and use the uploaded path", async () => {
  const { render, file, finish } = imageDraft({ owner: "computer|/project", upload: async () => ({ file: { path: "/remote/uploads/photo.png" } }) });
  const read = render().attachFiles([file("photo.png")]);
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  finish();
  assert.equal(JSON.stringify(await read), "[1]");
  assert.equal(render().images[0].path, "/remote/uploads/photo.png");
  assert.equal(render().images[0].dataUrl, "data:image/png;base64,AAAA");
});

test("remote files above the upload limit fail before reading or uploading", async () => {
  const { render, uploads } = imageDraft({ owner: "computer|/project" });
  await render().attachFiles([{ name: "large.zip", size: 50 * 1024 * 1024 + 1, type: "application/zip" }]);
  assert.equal(uploads.length, 0);
  assert.equal(render().files.length, 0);
  assert.equal(render().error, "large.zip is larger than 50 MiB.");
});

test("a remote batch shows every file as an upload tile that fills, then attaches them", async () => {
  const complete = [];
  const { render, finish } = imageDraft({
    owner: "computer|/project",
    upload: ({ name, onProgress }) => {
      onProgress(4, 10);
      return new Promise((resolve) => complete.push(() => resolve({ file: { path: `/remote/uploads/${name}` } })));
    },
  });
  const read = render().attachFiles([
    { name: "archive.zip", size: 10, type: "application/zip" },
    { name: "notes.txt", size: 2, type: "text/plain" },
  ]);
  const tiles = () => render().uploads.map(({ name, sentBytes, totalBytes }) => `${name} ${sentBytes}/${totalBytes}`);
  assert.equal(JSON.stringify(tiles()), '["archive.zip 0/10","notes.txt 0/2"]');
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(JSON.stringify(tiles()), '["archive.zip 4/10","notes.txt 0/2"]');
  complete.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  complete.shift()();
  await read;
  assert.equal(render().uploads.length, 0);
  assert.equal(JSON.stringify(render().files), '["/remote/uploads/archive.zip","/remote/uploads/notes.txt"]');
});

test("cancelling one upload tile drops that file and keeps the rest of the batch", async () => {
  const complete = [];
  const { render, finish } = imageDraft({
    owner: "computer|/project",
    upload: ({ name }) => new Promise((resolve) => complete.push(() => resolve({ file: { path: `/remote/uploads/${name}` } }))),
  });
  const read = render().attachFiles([
    { name: "archive.zip", size: 10, type: "application/zip" },
    { name: "notes.txt", size: 2, type: "text/plain" },
  ]);
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  render().cancelUpload(render().uploads[0].id);
  assert.equal(
    render()
      .uploads.map((upload) => upload.name)
      .join(),
    "notes.txt",
  );
  complete.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  complete.shift()();
  await read;
  assert.equal(render().error, "");
  assert.equal(JSON.stringify(render().files), '["/remote/uploads/notes.txt"]');
});
