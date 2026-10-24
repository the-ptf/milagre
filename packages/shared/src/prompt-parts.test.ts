import test from "node:test";
import assert from "node:assert/strict";
import {
  promptParts,
  promptImageBlocks,
  formatFileMention,
  formatImageMention,
  imageLabel,
  onlyImageMentions,
  promptTitle,
  skillLabel,
} from "./prompt-parts.mjs";
import { editImageMentions, mentionedImages, remapImageMentions, shiftImageMentions } from "./prompt-mentions.mjs";

test("splits skills, files and images out of prose and keeps the text verbatim", () => {
  const prompt = "Use /frontend-design to fix @src/surface.test.ts like [Image #1] and [Image #2] now";
  const parts = promptParts(prompt, { skills: ["frontend-design"], files: (path) => path === "src/surface.test.ts", images: 2 });
  assert.deepEqual(
    parts.map((part) => part.kind),
    ["text", "skill", "text", "file", "text", "image", "text", "image", "text"],
  );
  const file = parts[3];
  assert.equal(file.kind === "file" && file.path, "src/surface.test.ts");
  const img1 = parts[5];
  assert.equal(img1.kind === "image" && img1.index, 1);
  const img2 = parts[7];
  assert.equal(img2.kind === "image" && img2.index, 2);
  assert.equal(parts.map((part) => part.text).join(""), prompt);
});

test("out-of-range or code-fenced [Image #N] tokens stay plain text", () => {
  const prompt = "See `[Image #1]` and [Image #3] while [Image #2] is attached";
  const parts = promptParts(prompt, { skills: [], files: () => false, images: 2 });
  assert.deepEqual(
    parts.map((part) => (part.kind === "image" ? `image:${part.index}` : part.text)),
    ["See `[Image #1]` and [Image #3] while ", "image:2", " is attached"],
  );
});

test("promptImageBlocks interleaves text and images in reading order and appends unreferenced images", () => {
  const images = ["img-1", "img-2", "img-3"];
  const prompt = "[Image #1] first, then [Image #3] after";
  const blocks = promptImageBlocks(prompt, images);
  assert.deepEqual(blocks, [
    { type: "image", index: 1, image: "img-1" },
    { type: "text", text: " first, then " },
    { type: "image", index: 3, image: "img-3" },
    { type: "text", text: " after" },
    { type: "image", index: 2, image: "img-2" },
  ]);
});

test("promptImageBlocks falls back to text followed by all images when none are referenced inline", () => {
  const blocks = promptImageBlocks("Compare these two screenshots", ["a", "b"]);
  assert.deepEqual(blocks, [
    { type: "text", text: "Compare these two screenshots" },
    { type: "image", index: 1, image: "a" },
    { type: "image", index: 2, image: "b" },
  ]);
});

test("mentionedImages and shiftImageMentions track and renumber inline image tokens", () => {
  const prompt = "[Image #1] before [Image #2] and `[Image #2]` then [Image #3]";
  assert.deepEqual([...mentionedImages(prompt, 3)], [1, 2, 3]);
  assert.equal(shiftImageMentions(prompt, 2), "[Image #1] before and `[Image #2]` then [Image #2]");
  assert.equal(formatImageMention(1), "[Image #1]");
  assert.equal(imageLabel(1), "Image #1");
});

test("quoted paths keep spaces and trailing punctuation stays text", () => {
  const prompt = 'see @"my app/a b.ts".';
  const parts = promptParts(prompt, { skills: [], files: () => true });
  const file = parts.find((part) => part.kind === "file");
  assert.equal(file?.kind === "file" && file.path, "my app/a b.ts");
  assert.equal(parts.at(-1)?.text, ".");
  assert.equal(parts.map((part) => part.text).join(""), prompt);
});

test("merging drafts remaps image references without changing code or unknown indices", () => {
  assert.equal(remapImageMentions("[Image #1] and [Image #2], `[Image #1]`, [Image #3]", [2, 1]), "[Image #2] and [Image #1], `[Image #1]`, [Image #3]");
});

test("native edits remove whole image chips and preserve the surrounding draft", () => {
  const draft = "see [Image #1] next";
  assert.deepEqual(editImageMentions(draft, "see [Image #1 next", 1), { value: "see  next", caret: 4 });
  assert.deepEqual(editImageMentions(draft, "see Image #1] next", 1), { value: "see  next", caret: 4 });
  assert.deepEqual(editImageMentions(draft, "see [Inew1] next", 1), { value: "see new next", caret: 7 });
  assert.deepEqual(editImageMentions(draft, "see [Image X#1] next", 1), { value: "see [Image #1]X next", caret: 15 });
  assert.deepEqual(editImageMentions(draft, "see [Image #1] next!", 1), { value: "see [Image #1] next!", caret: null });
  assert.deepEqual(editImageMentions("`[Image #1]`", "`[Image #1`", 1), { value: "`[Image #1`", caret: null });
  assert.deepEqual(editImageMentions("[Image #1] [Image #2]", "[Image #2]", 2, { start: 0, end: 11 }), { value: "[Image #2]", caret: null });
});

test("mid-word @ and unknown files never parse", () => {
  assert.ok(promptParts("email me@host.com and @team", { skills: [], files: () => true }).every((part) => part.kind === "text" || part.text === "@team"));
  assert.ok(promptParts("email me@host.com and @team", { skills: [], files: (path) => path !== "team" }).every((part) => part.kind === "text"));
});

test("code spans are text", () => {
  const parts = promptParts("`@src/a.ts`", { skills: [], files: () => true });
  assert.ok(parts.every((part) => part.kind === "text"));
});

test("formatFileMention quotes paths with spaces", () => {
  assert.equal(formatFileMention("a b.ts"), '@"a b.ts"');
  assert.equal(formatFileMention("a.ts"), "@a.ts");
});

test("skillLabel title-cases the slug", () => {
  assert.equal(skillLabel("frontend-design"), "Frontend Design");
  assert.equal(skillLabel("plugin:review-code"), "Review Code");
});

test("onlyImageMentions is true only when the prompt is just its attached images", () => {
  assert.equal(onlyImageMentions("[Image #1]", 1), true);
  assert.equal(onlyImageMentions(" [Image #1]\n[Image #2] ", 2), true);
  assert.equal(onlyImageMentions("[Image #1] look at this", 1), false);
  assert.equal(onlyImageMentions("[Image #2]", 1), false);
  assert.equal(onlyImageMentions("[Image #1]", 0), false);
  assert.equal(onlyImageMentions("", 1), false);
});

test("promptTitle drops attached image tokens and names an image-only line", () => {
  assert.equal(promptTitle("[Image #1]", 1), "Image");
  assert.equal(promptTitle("[Image #1] [Image #2]", 2), "2 images");
  assert.equal(promptTitle("[Image #1] [Image #1]", 2), "Image");
  assert.equal(promptTitle("look at [Image #1]  please", 1), "look at please");
  assert.equal(promptTitle("[Image #2] only", 1), "[Image #2] only");
  assert.equal(promptTitle("[Image #2]", 1), "[Image #2]");
  assert.equal(promptTitle("[Image #4]"), "Image");
  assert.equal(promptTitle("Fix the login", 0), "Fix the login");
  assert.equal(promptTitle("", 1), "");
});
