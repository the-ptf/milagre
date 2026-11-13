#!/usr/bin/env node
// Execute this checkout's Node image helpers with isolated temporary storage. No provider is started.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const root = path.resolve(__dirname, "../../..");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-image-fixtures-"));
function load(relative) {
  const filename = path.join(root, relative);
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(filename, "utf8"),
    {
      module,
      exports: module.exports,
      Buffer,
      require(id) {
        if (id === "@milagre/shared/limits") return localRequire(path.join(root, "packages/shared/src/limits.mjs"));
        if (id === "../image-input.cjs") return load("packages/core/src/image-input.cjs");
        return localRequire(id);
      },
    },
    { filename },
  );
  return module.exports;
}
try {
  const { saveToolImage } = load("packages/core/src/agents/tool-image.cjs");
  const { promptImageBlocks } = require(path.join(root, "packages/shared/src/prompt-parts.mjs"));
  const source = fs.readFileSync(path.join(root, "packages/core/src/agents/codex-provider.cjs"), "utf8");
  const context = {
    module: { exports: {} },
    promptImageBlocks,
    saveToolImage: (url) => `/images/${path.basename(saveToolImage(url, directory))}`,
  };
  vm.runInNewContext(
    source.slice(source.indexOf("const isInternalRender ="), source.indexOf("// account/read answers")) + "\nmodule.exports = { toolImageEvents, turnInput };",
    context,
  );
  const { toolImageEvents, turnInput } = context.module.exports;
  const paths = ["/input/one.png", "/input/two.jpg", "/input/three.gif"];
  const prompts = [
    "",
    "hello",
    "[Image #1]",
    "[Image #2] then [Image #1] again [Image #2]",
    "a [Image #0] [Image #01] [Image #4] [Image #9007199254740992]",
    "😀é [Image #3] 終",
    "```[Image #1]``` [Image #2]",
    "~~~\n[Image #1]\n~~~[Image #3]",
    "`[Image #1]`\n[Image #2]",
    "``[Image #1]`x``[Image #3]",
    "`unclosed [Image #1]\n[Image #2]",
  ];
  // Deterministic combinations exercise greedy inline runs, unclosed fences and UTF-16 offsets.
  const pieces = ["`", "``", "```", "````", "~~~", "\n", "😀", "[Image #1]", "[Image #2]", "[Image #03]", "text"];
  let seed = 217;
  for (let n = 0; n < 250; n++) {
    let prompt = "";
    for (let k = 0; k < 12; k++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      prompt += pieces[seed % pieces.length];
    }
    prompts.push(prompt);
  }
  const inputs = prompts.flatMap((prompt) =>
    [[], paths].map((imagePaths) => ({ prompt, paths: imagePaths, expected: turnInput(prompt, { paths: imagePaths }) })),
  );
  const media = [
    ["image/png", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])],
    ["image/jpeg", Buffer.from([255, 216, 255, 0])],
    ["image/gif", Buffer.from("GIF89a")],
    ["image/webp", Buffer.from("RIFF0000WEBP")],
  ];
  const blocks = media.map(([mimeType, bytes]) => ({ type: "image", mimeType, data: bytes.toString("base64") }));
  const urls = media.map(([mime, bytes], i) => ({ type: "inputImage", [i % 2 ? "image_url" : "imageUrl"]: `data:${mime};base64,${bytes.toString("base64")}` }));
  const content = [
    { type: "text", text: "kept text" },
    ...blocks,
    ...urls,
    { type: "image", mimeType: "image/png", data: "bad!" },
    { type: "image", imageUrl: "https://example.test/picture.png" },
    { type: "image", mimeType: "image/svg+xml", data: "PHN2Zy8+" },
  ];
  const tools = [];
  for (const type of ["mcpToolCall", "dynamicToolCall"])
    for (const status of ["completed", "failed", "inProgress"])
      for (const fields of [{}, { success: false }, { error: { message: "oops" } }]) {
        const item = { id: "tool", type, status, server: "other", tool: "image", result: { content }, contentItems: content, ...fields };
        tools.push({ item, expected: toolImageEvents(item) });
      }
  for (const tool of ["design_show", "design_apply", "html_preview", "imagegen"])
    for (const server of ["milagre", "other"]) {
      const item = { id: "exec-nested", type: "mcpToolCall", status: "completed", server, tool, result: { content } };
      tools.push({ item, expected: toolImageEvents(item) });
    }
  const { decodeImages } = load("packages/core/src/image-input.cjs");
  const validation = [
    ...blocks.map((b) => `data:${b.mimeType};base64,${b.data}`),
    "",
    "https://example.test/image",
    "data:image/png;base64,",
    "data:image/png;base64,AAAA",
    "data:image/png;base64,iVBORw0KGgo=\n",
    "data:image/png;base64,iVBORw0KGgp=",
    "data:image/jpeg;base64,iVBORw0KGgo=",
    "data:image/png;base64,iVBORw0KGgo",
    "data:image/svg+xml;base64,PHN2Zy8+",
  ].map((url) => {
    let valid = true;
    try {
      decodeImages([{ dataUrl: url }]);
    } catch {
      valid = false;
    }
    return { url, valid };
  });
  const out = path.join(__dirname, "../tests/fixtures/conformance/codex-images.json");
  fs.writeFileSync(
    out,
    JSON.stringify(
      { source: "Node promptImageBlocks, turnInput, toolImageEvents, saveToolImage, decodeImages; paths normalized only", inputs, tools, validation },
      null,
      2,
    ) + "\n",
  );
  console.log(`${inputs.length} input, ${tools.length} tool-output, ${validation.length} validation fixtures`);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
