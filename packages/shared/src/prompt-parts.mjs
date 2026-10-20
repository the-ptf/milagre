import { promptSkillParts, prosePrompt } from "./prompt-skills.mjs";

const TRAILING_PUNCTUATION = /[.,!?;:)\]}]+$/;

/** `@path`, or `@"path"` when the path has whitespace or a quote. */
export function formatFileMention(path) {
  return /[\s"]/.test(path) ? `@"${path}"` : `@${path}`;
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

/** Split a prompt into text, skill and file parts. The parts' text joins back into the prompt. */
export function promptParts(prompt, { skills, files }) {
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
  marks.sort((a, b) => a.start - b.start);
  const parts = [];
  let end = 0;
  for (const mark of marks) {
    if (mark.start > end) parts.push({ kind: "text", text: prompt.slice(end, mark.start) });
    const text = prompt.slice(mark.start, mark.end);
    parts.push(mark.kind === "skill" ? { kind: "skill", text, name: mark.name } : { kind: "file", text, path: mark.path });
    end = mark.end;
  }
  if (end < prompt.length) parts.push({ kind: "text", text: prompt.slice(end) });
  return parts;
}
