#!/usr/bin/env node
// Actual decodeImages, promptImageBlocks/prosePrompt and ClaudeSession user payloads.
// Fixed synthetic image data only; no provider process, credentials, profile or network.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Module = require("node:module");
const repo = path.resolve(__dirname, "../../..");
// Resolve the worktree's shared source, not the dependency checkout's workspace links.
// oxlint-disable-next-line no-underscore-dangle
const originalResolve = Module._resolveFilename;
// oxlint-disable-next-line no-underscore-dangle
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@milagre/shared/")) return path.join(repo, "packages/shared/src", `${request.slice("@milagre/shared/".length)}.mjs`);
  return originalResolve.call(this, request, ...rest);
};
const { decodeImages } = require(path.join(repo, "packages/core/src/image-input.cjs"));
const { promptImageBlocks } = require(path.join(repo, "packages/shared/src/prompt-parts.mjs"));
const { prosePrompt } = require(path.join(repo, "packages/shared/src/prompt-skills.mjs"));
const { ClaudeSession } = require(path.join(repo, "packages/core/src/agents/claude-provider.cjs"));
const image = (mime, base64) => ({ dataUrl: `data:${mime};base64,${base64}` });
const png = image("image/png", "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=");
const gif = image("image/gif", "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7");
const signature = (mime, bytes) => image(mime, Buffer.from(bytes).toString("base64"));
const validationCases = [
  { name: "empty", images: [] },
  { name: "png", images: [png] },
  { name: "gif", images: [gif] },
  { name: "jpeg-signature-only", images: [signature("image/jpeg", [255, 216, 255])] },
  { name: "webp-signature-only", images: [signature("image/webp", [...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP")])] },
  { name: "node-no-count-limit", images: Array.from({ length: 11 }, () => png) },
  { name: "not-array", images: {} },
  { name: "null-array", images: null },
  { name: "missing-data", images: [{}] },
  { name: "caller-path-only", images: [{ path: "/never/read/image.png" }] },
  { name: "svg", images: [image("image/svg+xml", "PHN2Zz4=")] },
  { name: "uppercase-mime", images: [image("image/PNG", png.dataUrl.split(",")[1])] },
  { name: "bad-signature", images: [image("image/png", "aGVsbG8=")] },
  { name: "wrong-signature", images: [image("image/jpeg", png.dataUrl.split(",")[1])] },
  { name: "empty-base64", images: [image("image/png", "")] },
  { name: "noncanonical-bits", images: [image("image/jpeg", "/9j/AB==")] },
  { name: "unneeded-padding", images: [image("image/jpeg", "/9j/=")] },
  { name: "base64-space", images: [image("image/jpeg", "/9j/ ")] },
  { name: "base64-url-alphabet", images: [image("image/jpeg", "_9j_")] },
  { name: "metadata-ignored-by-node", images: [{ ...png, path: "/never/read/image.png", name: "synthetic.png" }] },
];
const prompts = [
  ["inline-order", "Before [Image #2] middle [Image #1] after", [png, gif]],
  ["repeated", "[Image #1][Image #1] then [Image #2] again [Image #1]", [png, gif]],
  ["append-unreferenced", "See [Image #2].", [png, gif]],
  ["no-tokens", "Look at these", [png, gif]],
  ["empty-prompt", "", [png]],
  ["no-images", "[Image #1]", []],
  ["invalid-indices", "[Image #0] [Image #01] [Image #3] [Image #9007199254740992] [image #1]", [png, gif]],
  ["inline-code", "`[Image #1]` then [Image #2]", [png, gif]],
  ["backtick-fence", "```x\n[Image #1]\n``` outside [Image #2]", [png, gif]],
  ["tilde-fence", "~~~\n[Image #2]\n~~~ outside [Image #1]", [png, gif]],
  ["unclosed-fence", "before ``` [Image #1]\n[Image #2]", [png, gif]],
  ["unclosed-inline", "`[Image #1]\noutside [Image #2]", [png, gif]],
  ["double-tick", "``[Image #1]` still [Image #2]`` outside [Image #1]", [png, gif]],
  ["long-close-run", "`[Image #1]`` outside [Image #2]", [png, gif]],
  ["four-tick-fence", "````[Image #1]```` outside [Image #2]", [png, gif]],
  ["unicode", "😀é漢字 [Image #2]\n`😀 [Image #1]`\n[Image #1] 🧪", [png, gif]],
  ["line-separators", "`[Image #1]\u2028still [Image #2]`\r\n[Image #1]", [png, gif]],
  ["punctuation", "x[Image #1]y([Image #2])", [png, gif]],
  ["image-only", "[Image #1]", [png]],
  ["queued-image", "Queued [Image #1] then [Image #2]", [gif, png]],
];
function deadline(promise) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(Error("image oracle deadline")), 3000);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
async function nativeContent(prompt, images) {
  let received;
  const payload = new Promise((resolve) => {
    received = resolve;
  });
  let finish;
  const closed = new Promise((resolve) => {
    finish = resolve;
  });
  const session = new ClaudeSession({
    cwd: "/synthetic-image-fixture",
    command: "/fake/claude",
    defaultConfigDir: "/nonexistent-image-oracle",
    env: {},
    emit: () => {},
    loadSdk: async () => ({
      query: ({ prompt: input }) => {
        void input[Symbol.asyncIterator]()
          .next()
          .then((next) => received(next.value.message.content));
        return {
          [Symbol.asyncIterator]() {
            return this;
          },
          async next() {
            await closed;
            return { done: true };
          },
          async return() {
            finish();
            return { done: true };
          },
          async setMaxThinkingTokens() {},
        };
      },
    }),
  });
  try {
    await deadline(session.startTurn({ prompt, images, model: "sonnet", permissionMode: "ask" }));
    return await deadline(payload);
  } finally {
    await deadline(session.close());
  }
}
(async () => {
  const validation = validationCases.map((spec) => {
    try {
      return {
        ...spec,
        decoded: decodeImages(spec.images).map(({ mime, bytes, base64 }) => ({
          mime,
          base64,
          size: bytes.length,
          sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        })),
      };
    } catch (error) {
      return { ...spec, error: error.message };
    }
  });
  const cases = [];
  for (const [name, prompt, images] of prompts) {
    const decoded = decodeImages(images);
    const blocks = promptImageBlocks(prompt, decoded).map((block) =>
      block.type === "text" ? { type: "text", text: block.text } : { type: "image", index: block.index },
    );
    cases.push({ name, prompt, images, prose: prosePrompt(prompt), blocks, content: await nativeContent(prompt, decoded) });
  }
  // JavaScript retains lone UTF-16 units; Rust's existing owner free-text boundary replaces
  // them with U+FFFD. Record both actual Node payloads without putting invalid strings in JSON.
  const utf16 = [];
  const units = (text) => Array.from({ length: text.length }, (_, index) => text.charCodeAt(index));
  for (const [name, prompt] of [
    ["lone-surrogates", "\ud800[Image #2]\udc00 `[Image #1]\ud800` [Image #1]"],
    ["surrogates-around-fence", "\ud800```\udc00[Image #1]```😀[Image #2]\udc00"],
  ]) {
    const images = [png, gif];
    const decoded = decodeImages(images);
    const normalize = (content) => content.map((block) => (block.type === "text" ? { type: "text", units: units(block.text) } : block));
    const rustPrompt = Buffer.from(prompt).toString("utf8");
    utf16.push({
      name,
      promptUnits: units(prompt),
      images,
      nativeUnits: normalize(await nativeContent(prompt, decoded)),
      rustPrompt,
      content: await nativeContent(rustPrompt, decoded),
    });
  }
  const sources = [
    "packages/core/src/image-input.cjs",
    "packages/core/src/agents/claude-provider.cjs",
    "packages/shared/src/prompt-parts.mjs",
    "packages/shared/src/prompt-skills.mjs",
    "packages/shared/src/limits.mjs",
    "experiments/rust-claude/scripts/generate-prompt-images.cjs",
  ];
  const output = {
    schema: 1,
    generatedBy: "scripts/generate-prompt-images.cjs",
    scope: "Actual Node validation and prompt ordering; fixed fake SDK captures real ClaudeSession user content. Signature checks are not image decoding.",
    sources: Object.fromEntries(
      sources.map((file) => [
        file,
        crypto
          .createHash("sha256")
          .update(fs.readFileSync(path.join(repo, file)))
          .digest("hex"),
      ]),
    ),
    validation,
    cases,
    utf16,
  };
  const file = path.join(__dirname, "../tests/fixtures/conformance/claude-prompt-images.json");
  if (process.argv.includes("--check")) {
    if (JSON.stringify(JSON.parse(fs.readFileSync(file, "utf8"))) !== JSON.stringify(output)) throw Error("Claude image oracle drifted");
  } else fs.writeFileSync(file, JSON.stringify(output, null, 1) + "\n");
  console.log(
    `${process.argv.includes("--check") ? "matched" : "wrote"} ${validation.length} image validation and ${cases.length} actual Claude content cases`,
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
