import { promptSkillParts, prosePrompt } from "./prompt-skills.mjs";

/** Appends a selected passage below the existing draft, then a blank line for the question. */
export function quoteIntoDraft(draft, passage) {
  const lines = passage
    .replace(/\r\n?/g, "\n")
    .replace(/^\n+|\s+$/g, "")
    .split("\n");
  if (!lines.some((line) => line.trim())) return draft;
  const quote = lines.map((line) => (line.trim() ? `> ${line}` : ">")).join("\n");
  const before = draft.replace(/\s+$/, "");
  return `${before ? `${before}\n\n` : ""}${quote}\n\n`;
}

const TRAILING_PUNCTUATION = /[.,!?;:)\]}]+$/;
const IMAGE_TOKEN = /\[Image #([1-9]\d*)\]/g;

/** `@path`, or `@"path"` when the path has whitespace or a quote. */
export function formatFileMention(path) {
  return /[\s"]/.test(path) || /^chat:[1-9]\d*[.,!?;:)\]}]*$/.test(path) ? `@"${path}"` : `@${path}`;
}

/** A reference to a Chat in the sending Project. */
export function formatChatMention(id) {
  return `@chat:${id}`;
}

/** Chat references in prose, with complete tokens only (never code or file paths). */
export function chatMentionTokens(prompt) {
  const tokens = [];
  const prose = prosePrompt(prompt);
  const quoted = Array.from(prose.matchAll(/(^|\s)@"[^"\n]+"/g), (match) => ({ start: match.index, end: match.index + match[0].length }));
  for (const match of prose.matchAll(/(^|\s)@chat:([1-9]\d*)(?=$|\s|[.,!?;:)\]}]+(?=$|\s))/g)) {
    if (quoted.some((span) => match.index >= span.start && match.index < span.end)) continue;
    const id = Number(match[2]);
    if (!Number.isSafeInteger(id)) continue;
    const start = match.index + match[1].length;
    tokens.push({ id, start, end: start + formatChatMention(id).length });
  }
  return tokens;
}

/** `[Image #1]` inline token for a 1-based attached image index. */
export function formatImageMention(index) {
  return `[Image #${index}]`;
}

/** True when a sent prompt is only its attached images' tokens (`[Image #1] [Image #2]`): the images show, not a text bubble. */
export function onlyImageMentions(prompt, images) {
  if (!images || !prompt.trim()) return false;
  return !prompt.replace(IMAGE_TOKEN, (token, index) => (hasImage(images, Number(index)) ? "" : token)).trim();
}

/**
 * A Chat's name from the first line of its prompt: the `[Image #N]` tokens of attached images are dropped and the spaces
 * collapsed, and a line that was only tokens reads "Image" or "N images". `images` is the attached count, or a predicate for
 * the valid indexes; omit it when unknown and every token counts. A token with no image behind it stays as text.
 */
export function promptTitle(line, images) {
  const found = new Set();
  const text = line
    .replace(IMAGE_TOKEN, (token, index) => {
      if (images !== undefined && !hasImage(images, Number(index))) return token;
      found.add(Number(index));
      return "";
    })
    .replace(/\s+/g, " ")
    .trim();
  if (text || !found.size) return text;
  return found.size === 1 ? "Image" : `${found.size} images`;
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
    if (/^chat:[1-9]\d*[.,!?;:)\]}]*$/.test(match[3])) continue;
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
export function promptParts(prompt, { skills, files, images = 0, chats = () => false }) {
  const marks = [];
  let offset = 0;
  for (const part of promptSkillParts(prompt, skills)) {
    if (part.skill) marks.push({ kind: "skill", start: offset, end: offset + part.text.length, name: part.text.slice(1) });
    offset += part.text.length;
  }
  for (const token of chatMentionTokens(prompt)) {
    if (chats(token.id) && !marks.some((mark) => token.start < mark.end && token.end > mark.start)) marks.push({ kind: "chat", ...token });
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
          : mark.kind === "chat"
            ? { kind: "chat", text, id: mark.id, start: mark.start }
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
