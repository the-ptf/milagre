#!/usr/bin/env node
// Actual Node mapper + image persistence, confined to a fresh temporary directory, removed afterwards.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const originalTmp = os.tmpdir;
const scratch = fs.mkdtempSync(path.join(originalTmp(), "claude-image-conformance-"));
os.tmpdir = () => scratch;
const { mapClaudeMessage } = require("../../../packages/core/src/agents/events.cjs");
const image = (mime, bytes) => ({ type: "image", source: { type: "base64", media_type: mime, data: Buffer.from(bytes).toString("base64") } });
const png = image("image/png", [137, 80, 78, 71, 13, 10, 26, 10]);
const jpeg = image("image/jpeg", [255, 216, 255, 1]);
const gif = image("image/gif", "GIF89a");
const webp = image("image/webp", "RIFFxxxxWEBP");
const call = (id = "r", name = "Read", input = { file_path: "/never/read/source.png" }, parent = null) => ({
  type: "assistant",
  parent_tool_use_id: parent,
  message: { content: [{ type: "tool_use", id, name, input }] },
});
const block = (id, content, is_error = false) => ({ type: "tool_result", tool_use_id: id, content, is_error });
const result = (content, extra = {}, id = "r") => ({ type: "user", parent_tool_use_id: null, message: { content: [block(id, content)] }, ...extra });
const malformed = [
  image("image/svg+xml", "<svg/>"),
  image("image/png", "wrong signature"),
  image("image/jpeg", [137, 80, 78, 71, 13, 10, 26, 10]),
  { type: "image", source: { type: "url", url: "file:///never/read/source.png" } },
  ...["", "%%%", "R0lGODlh\n", "R0lGODlh=", "/9j/AR==", "/9j/AQ", "_9j_AQ=="].map((data) => ({
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data },
  })),
];
const cases = [
  ["four-formats", [call(), result([png, jpeg, gif, webp])]],
  ["bad-siblings", [call(), result([...malformed, png, { type: "text", text: "caption" }, jpeg])]],
  ["replayed-result", [call(), result([png], { isReplay: true })]],
  ["failed-result", [call(), { type: "user", message: { content: [block("r", [png], true)] } }]],
  ["orphan-result", [result([png])]],
  ["duplicate-result-consumed-once", [call(), result([png]), result([png])]],
  ["not-read", [call("r", "Bash", { command: "cat image.png" }), result([png])]],
  ["subagent-read", [call("r", "Read", { file_path: "image.png" }, "agent"), result([png], { parent_tool_use_id: "agent" })]],
  [
    "batched-read-results",
    [
      { type: "assistant", message: { content: [...call("a").message.content, ...call("b").message.content] } },
      { type: "user", message: { content: [block("a", [png]), block("b", [gif])] }, tool_use_result: { type: "image", file: "ignored" } },
    ],
  ],
  ["no-source-path", [call("r", "Read", {}), result([png])]],
  ["unwritable-store", [call(), result([png, jpeg])], true],
];
try {
  const output = cases.map(([name, messages, unwritable = false]) => {
    const directory = path.join(scratch, "milagre-generated-images");
    fs.rmSync(directory, { recursive: true, force: true });
    if (unwritable) fs.writeFileSync(directory, "not a directory");
    const state = { turnId: "turn-1", hasText: false };
    const steps = messages.map((message) => {
      const events = mapClaudeMessage(message, state);
      const files =
        unwritable || !fs.existsSync(directory)
          ? {}
          : Object.fromEntries(
              fs
                .readdirSync(directory)
                .sort()
                .map((fileName) => [fileName, fs.readFileSync(path.join(directory, fileName)).toString("hex")]),
            );
      return {
        message,
        events: JSON.parse(
          JSON.stringify(events, (key, value) =>
            key === "file" && typeof value === "string" && value.startsWith(directory + path.sep) ? path.basename(value) : value,
          ),
        ),
        files,
      };
    });
    return { name, unwritable, steps };
  });
  fs.writeFileSync(
    path.join(__dirname, "../tests/fixtures/conformance/claude-images.json"),
    JSON.stringify({ generatedBy: "scripts/generate-images.cjs", cases: output }, null, 2) + "\n",
  );
  console.log(`wrote ${output.length} image traces`);
} finally {
  os.tmpdir = originalTmp;
  fs.rmSync(scratch, { recursive: true, force: true });
}
