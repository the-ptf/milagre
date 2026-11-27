import { formatImageMention, promptParts } from "./prompt-parts.mjs";
import { chatTitle, isListedChat } from "./chats.mjs";
import { prosePrompt } from "./prompt-skills.mjs";

export const PROMPT_PLACEHOLDER = "Type @ for files, Chats and computers, / for skills";

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

export function isMentionOfFile(files, root) {
  return (path) => mentionedFile(path, files, root) !== undefined;
}

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

function changedRange(previous, next, selection) {
  let start = 0;
  while (start < previous.length && start < next.length && previous[start] === next[start]) start++;
  let end = previous.length;
  let nextEnd = next.length;
  while (end > start && nextEnd > start && previous[end - 1] === next[nextEnd - 1]) {
    end--;
    nextEnd--;
  }
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
  return { start, end, inserted: next.slice(start, nextEnd) };
}

export function editImageMentions(previous, next, images, selection) {
  const { start, end, inserted } = changedRange(previous, next, selection);
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

export function chatMentionChoices(state) {
  return Object.values(state.sessions).map((session) => ({
    id: session.id,
    title: session.archived || session.routine?.hidden ? "Chat" : chatTitle(session),
    branch: state.worktrees[session.worktree_id]?.name ?? "",
    at: session.summary?.lastAt ?? session.summary?.lastId ?? session.id,
    lastAt: session.summary?.lastAt,
    available: !session.archived && !session.routine?.hidden && isListedChat(session, session.summary?.count ?? 1),
  }));
}

/** Files precede this separately labelled group; newest matching Chats come first. */
export function matchingMentionChats(chats, query, currentId) {
  const needle = query.toLowerCase();
  return (
    chats
      .filter((chat) => chat.available && chat.id !== currentId && chat.title.toLowerCase().includes(needle))
      // Hermes has no toSorted.
      .sort((a, b) => b.at - a.at || b.id - a.id)
      .slice(0, 5)
  );
}

/**
 * The computers an `@` menu offers: this one first, then the paired ones, online before offline, by name. A query
 * matches a name case-insensitively; one name shows once.
 */
export function matchingMentionComputers(computers, query) {
  const needle = query.toLowerCase();
  const seen = new Set();
  return (
    computers
      .filter((computer) => {
        const key = computer.name.toLowerCase();
        if (!computer.name || seen.has(key) || !key.includes(needle)) return false;
        seen.add(key);
        return true;
      })
      // Hermes has no toSorted.
      .sort((a, b) => Number(Boolean(b.self)) - Number(Boolean(a.self)) || Number(b.online) - Number(a.online) || a.name.localeCompare(b.name))
      .slice(0, 5)
  );
}

/**
 * What a plain text field shows for a draft: a chat mention reads `@<title>` in place of `@chat:<id>`. `spans` pair
 * each mention's place in the draft with its place in the shown text.
 */
export function shownPrompt(parts, title) {
  let text = "";
  let offset = 0;
  const spans = [];
  for (const part of parts) {
    if (part.kind === "chat") {
      const label = `@${
        String(title(part.id) ?? "")
          .replace(/\s+/g, " ")
          .trim() || "Chat"
      }`;
      spans.push({ start: offset, end: offset + part.text.length, shownStart: text.length, shownEnd: text.length + label.length });
      text += label;
    } else text += part.text;
    offset += part.text.length;
  }
  return { text, spans };
}

/** A draft offset in shown text; inside a chat mention it lands after it. */
export function shownOffset(spans, offset) {
  let delta = 0;
  for (const span of spans) {
    if (offset <= span.start) break;
    if (offset < span.end) return span.shownEnd;
    delta = span.shownEnd - span.end;
  }
  return offset + delta;
}

/** A shown offset in the draft; inside a chat mention it lands on the `edge` of it. */
export function draftOffset(spans, offset, edge = "end") {
  let delta = 0;
  for (const span of spans) {
    if (offset <= span.shownStart) break;
    if (offset < span.shownEnd) return edge === "start" ? span.start : span.end;
    delta = span.end - span.shownEnd;
  }
  return offset + delta;
}

export function shownSelection(spans, selection) {
  return { start: shownOffset(spans, selection.start), end: shownOffset(spans, selection.end) };
}

export function draftSelection(spans, selection) {
  if (selection.start === selection.end) {
    const caret = draftOffset(spans, selection.start);
    return { start: caret, end: caret };
  }
  return { start: draftOffset(spans, selection.start, "start"), end: draftOffset(spans, selection.end) };
}

const MENTION_AFTER = /^[\s.,!?;:)\]}]/;

/**
 * Apply an edit made to the shown text to the draft. A chat mention stays whole: an edit that touches it removes all
 * of it, typing inside it lands after it, and text typed against either side of it gets a space so it stays a
 * mention. `caret` is null when the field's own caret is already right.
 */
export function editShownPrompt(draft, shown, next, selection) {
  if (!shown.spans.length) return { value: next, caret: null };
  const range = changedRange(shown.text, next, selection);
  let { start, end, inserted } = range;
  for (const span of shown.spans) {
    if (start === end) {
      if (start > span.shownStart && start < span.shownEnd) start = end = span.shownEnd;
    } else if (start < span.shownEnd && end > span.shownStart) {
      start = Math.min(start, span.shownStart);
      end = Math.max(end, span.shownEnd);
    }
  }
  const from = draftOffset(shown.spans, start, "start");
  const to = draftOffset(shown.spans, end);
  if (inserted) {
    if (shown.spans.some((span) => span.shownEnd === start) && !MENTION_AFTER.test(inserted)) inserted = ` ${inserted}`;
    if (shown.spans.some((span) => span.shownStart === end) && !/\s$/.test(inserted)) inserted = `${inserted} `;
  }
  const value = draft.slice(0, from) + inserted + draft.slice(to);
  const moved = start !== range.start || end !== range.end || inserted !== range.inserted;
  return { value, caret: moved ? from + inserted.length : null };
}
