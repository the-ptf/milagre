import { formatImageMention, promptParts } from "./prompt-parts.mjs";
import { prosePrompt } from "./prompt-skills.mjs";

/**
 * The attached file an `@path` mention names: the file at that absolute path, else the file at `<root>/<path>`,
 * else the one attached file whose path ends with `/<path>`. A suffix shared by several files names none.
 */
export function mentionedFile(path, files, root) {
  if (!path) return undefined;
  const exact = files.find((file) => file === path) ?? files.find((file) => file === `${root.replace(/\/$/, "")}/${path}`);
  if (exact) return exact;
  const suffixed = files.filter((file) => file.endsWith(`/${path.replace(/^\//, "")}`));
  return suffixed.length === 1 ? suffixed[0] : undefined;
}

/** Whether `@path` in a sent prompt names one of the message's files, for `promptParts`. */
export function isMentionOfFile(files, root) {
  return (path) => mentionedFile(path, files, root) !== undefined;
}

/** The absolute files a prompt renders inline as chips; their attachment tiles are left out. */
export function mentionedFiles(prompt, files, root) {
  const found = new Set();
  if (!files.length) return found;
  for (const part of promptParts(prompt, { skills: [], files: isMentionOfFile(files, root) })) {
    if (part.kind !== "file") continue;
    const file = mentionedFile(part.path, files, root);
    if (file) found.add(file);
  }
  return found;
}

/** The 1-based image indices a prompt renders inline as chips. */
export function mentionedImages(prompt, count) {
  const found = new Set();
  if (!count || count < 1) return found;
  for (const part of promptParts(prompt, { skills: [], files: () => false, images: count })) {
    if (part.kind === "image") found.add(part.index);
  }
  return found;
}

/**
 * Remove `[Image #<removedIndex>]` (1-based) and decrement `[Image #N]` tokens with `N > removedIndex` in prose.
 * Collapses duplicate adjacent spaces left behind when an inline image token is stripped.
 */
export function shiftImageMentions(prompt, removedIndex) {
  if (!prompt || !Number.isSafeInteger(removedIndex) || removedIndex < 1) return prompt;
  const prose = prosePrompt(prompt);
  const matches = Array.from(prose.matchAll(/\[Image #([1-9]\d*)\]/g));
  if (!matches.length) return prompt;
  let result = "";
  let end = 0;
  for (const match of matches) {
    const index = Number(match[1]);
    const start = match.index;
    const tokenEnd = start + match[0].length;
    if (index === removedIndex) {
      let sliceStart = start;
      let sliceEnd = tokenEnd;
      if (sliceStart > end && prompt[sliceStart - 1] === " " && (sliceEnd >= prompt.length || prompt[sliceEnd] === " " || prompt[sliceEnd] === "\n")) {
        sliceStart -= 1;
      } else if (sliceEnd < prompt.length && prompt[sliceEnd] === " " && (sliceStart === end || prompt[sliceStart - 1] === "\n")) {
        sliceEnd += 1;
      }
      result += prompt.slice(end, sliceStart);
      end = sliceEnd;
      continue;
    }
    result += prompt.slice(end, start);
    result += index > removedIndex ? formatImageMention(index - 1) : match[0];
    end = tokenEnd;
  }
  result += prompt.slice(end);
  return result;
}

/** Remap prose references when attachment lists are merged; code and unknown references stay literal. */
export function remapImageMentions(prompt, indices) {
  const prose = prosePrompt(prompt);
  return prompt.replace(/\[Image #([1-9]\d*)\]/g, (token, index, offset) =>
    prose.slice(offset, offset + token.length) === token && indices[Number(index) - 1] ? formatImageMention(indices[Number(index) - 1]) : token,
  );
}

/** Expand a native text edit across any image chip it touches, preserving surrounding text. */
export function editImageMentions(previous, next, images, selection) {
  let start = 0;
  while (start < previous.length && start < next.length && previous[start] === next[start]) start++;
  let end = previous.length;
  let nextEnd = next.length;
  while (end > start && nextEnd > start && previous[end - 1] === next[nextEnd - 1]) {
    end--;
    nextEnd--;
  }
  // Repeated tokens have long matching prefixes. The native selection identifies which one was edited.
  const matches = (from, to) =>
    from >= 0 &&
    to <= previous.length &&
    next.length >= from + previous.length - to &&
    next.startsWith(previous.slice(0, from)) &&
    next.endsWith(previous.slice(to));
  if (selection) {
    let from = selection.start;
    let to = selection.end;
    const delta = next.length - previous.length;
    if (from === to && delta < 0) {
      if (matches(from + delta, to)) from += delta;
      else to -= delta;
    }
    if (matches(from, to)) {
      start = from;
      end = to;
      nextEnd = next.length - (previous.length - end);
    }
  }
  const inserted = next.slice(start, nextEnd);
  let from = start;
  let to = end;
  let offset = 0;
  for (const part of promptParts(previous, { skills: [], files: () => false, images })) {
    const partEnd = offset + part.text.length;
    if (part.kind === "image") {
      if (start === end && start > offset && start < partEnd) from = to = partEnd;
      else if (start < partEnd && end > offset) {
        from = Math.min(from, offset);
        to = Math.max(to, partEnd);
      }
    }
    offset = partEnd;
  }
  if (from === start && to === end) return { value: next, caret: null };
  return { value: previous.slice(0, from) + inserted + previous.slice(to), caret: from + inserted.length };
}
