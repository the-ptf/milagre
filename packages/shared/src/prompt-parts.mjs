import { promptSkillParts, prosePrompt } from "./prompt-skills.mjs";

const TRAILING_PUNCTUATION = /[.,!?;:)\]}]+$/;
const IMAGE_TOKEN = /\[Image #([1-9]\d*)\]/g;

/** `@path`, or `@"path"` when the path has whitespace or a quote. */
export function formatFileMention(path) {
  return /[\s"]/.test(path) ? `@"${path}"` : `@${path}`;
}

/** `[Image #1]` inline token for a 1-based attached image index. */
export function formatImageMention(index) {
  return `[Image #${index}]`;
}

/** `"Image #1"` display label for a 1-based attached image index. */
export function imageLabel(index) {
  return `Image #${index}`;
}

/** "frontend-design" -> "Frontend Design"; a plugin prefix ("plugin:name") is dropped. */
export function skillLabel(name) {
  const slug = name.slice(name.lastIndexOf(":") + 1);
  return slug
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

function fileTokens(prompt, files) {
  const prose = prosePrompt(prompt);
  const tokens = [];
  for (const match of prose.matchAll(/(^|\s)@(?:"([^"\n]+)"|([^\s"]\S*))/g)) {
    const start = match.index + match[1].length;
    if (match[2] !== undefined) {
      if (files(match[2])) tokens.push({ path: match[2], start, end: match.index + match[0].length });
      continue;
    }
    let path = match[3];
    if (!files(path)) path = path.replace(TRAILING_PUNCTUATION, "");
    if (path && files(path)) tokens.push({ path, start, end: start + 1 + path.length });
  }
  return tokens;
}

function hasImage(images, index) {
  if (typeof images === "function") return images(index);
  if (typeof images === "number") return index >= 1 && index <= images;
  return false;
}

function imageTokens(prompt, images) {
  if (!images) return [];
  const prose = prosePrompt(prompt);
  const tokens = [];
  for (const match of prose.matchAll(IMAGE_TOKEN)) {
    const index = Number(match[1]);
    if (!Number.isSafeInteger(index) || !hasImage(images, index)) continue;
    tokens.push({ index, start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

/** Split a prompt into text, skill, file and image parts. The parts' text joins back into the prompt. */
export function promptParts(prompt, { skills, files, images = 0 }) {
  const marks = [];
  let offset = 0;
  for (const part of promptSkillParts(prompt, skills)) {
    if (part.skill) marks.push({ kind: "skill", start: offset, end: offset + part.text.length, name: part.text.slice(1) });
    offset += part.text.length;
  }
  for (const token of fileTokens(prompt, files)) {
    if (marks.some((mark) => token.start < mark.end && token.end > mark.start)) continue;
    marks.push({ kind: "file", ...token });
  }
  for (const token of imageTokens(prompt, images)) {
    if (marks.some((mark) => token.start < mark.end && token.end > mark.start)) continue;
    marks.push({ kind: "image", ...token });
  }
  marks.sort((a, b) => a.start - b.start);
  const parts = [];
  let end = 0;
  for (const mark of marks) {
    if (mark.start > end) parts.push({ kind: "text", text: prompt.slice(end, mark.start) });
    const text = prompt.slice(mark.start, mark.end);
    parts.push(
      mark.kind === "skill"
        ? { kind: "skill", text, name: mark.name }
        : mark.kind === "file"
          ? { kind: "file", text, path: mark.path }
          : { kind: "image", text, index: mark.index },
    );
    end = mark.end;
  }
  if (end < prompt.length) parts.push({ kind: "text", text: prompt.slice(end) });
  return parts;
}

/**
 * Interleave a prompt's text and attached images in reading order. Each `[Image #N]` token in prose
 * places `images[N - 1]` at that position in the block list; any attached images not referenced inline
 * are appended at the end so nothing is dropped.
 */
export function promptImageBlocks(prompt, images = []) {
  if (!images.length) return [{ type: "text", text: prompt }];
  const tokens = imageTokens(prompt, images.length);
  if (!tokens.length) {
    return [{ type: "text", text: prompt }, ...images.map((image, i) => ({ type: "image", index: i + 1, image }))];
  }
  const blocks = [];
  const referenced = new Set();
  let end = 0;
  for (const token of tokens) {
    if (token.start > end) blocks.push({ type: "text", text: prompt.slice(end, token.start) });
    blocks.push({ type: "image", index: token.index, image: images[token.index - 1] });
    referenced.add(token.index);
    end = token.end;
  }
  if (end < prompt.length) blocks.push({ type: "text", text: prompt.slice(end) });
  for (const [i, image] of images.entries()) {
    const index = i + 1;
    if (!referenced.has(index)) blocks.push({ type: "image", index, image });
  }
  return blocks;
}
