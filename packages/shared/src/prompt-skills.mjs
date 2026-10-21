export function prosePrompt(prompt) {
  return prompt.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|(`+)[^\n]*?(?:\1(?!`)|(?=\n|$))/g, (code) => code.replace(/[^\n]/g, " "));
}

/** Standalone slash tokens in prose. Offsets refer to the original prompt. */
export function promptSkillTokens(prompt) {
  const prose = prosePrompt(prompt);
  return Array.from(prose.matchAll(/(^|\s)\/([a-zA-Z0-9][\w.:-]*)(?=$|\s|[,!?;()[\]{}](?=$|\s))/g), (match) => ({
    name: match[2],
    start: match.index + match[1].length,
    end: match.index + match[0].length,
  }));
}

/** A partial slash command at the caret, including the rest of its word for replacement. */
export function promptSkillQuery(prompt, selection, names = []) {
  const caret = selection.start;
  if (caret !== selection.end || caret < 0 || caret > prompt.length) return null;
  const prose = prosePrompt(prompt);
  const match = /(^|\s)\/([\w.:-]*)$/.exec(prose.slice(0, caret));
  if (!match) return null;
  const start = match.index + match[1].length;
  let end = caret + /^[\w.:-]*/.exec(prose.slice(caret))[0].length;
  const word = prose.slice(start + 1, end);
  if (!names.some((name) => name.toLowerCase().startsWith(word.toLowerCase()))) end -= /[.:]*$/.exec(word)[0].length;
  const suffix = prose.slice(end);
  if (suffix && !/^(?:\s|[.,!?;:()[\]{}](?=$|\s))/.test(suffix)) return null;
  return { start, end, query: prose.slice(start + 1, Math.min(caret, end)).toLowerCase() };
}

/** Complete commands from the catalog, with the prompt kept verbatim. */
export function promptSkillParts(prompt, names) {
  const known = new Set(names.map((name) => name.toLowerCase()));
  const parts = [];
  let end = 0;
  for (const token of promptSkillTokens(prompt)) {
    let name = token.name;
    if (!known.has(name.toLowerCase())) name = name.replace(/[.:]+$/, "");
    if (!known.has(name.toLowerCase())) continue;
    if (token.start > end) parts.push({ text: prompt.slice(end, token.start), skill: false });
    end = token.start + name.length + 1;
    parts.push({ text: prompt.slice(token.start, end), skill: true });
  }
  if (end < prompt.length) parts.push({ text: prompt.slice(end), skill: false });
  return parts;
}

/** A native caret or selected range contained inside a recognized command. */
export function promptSkillAtSelection(parts, selection) {
  let start = 0;
  for (const part of parts) {
    const end = start + part.text.length;
    if (part.skill && selection.start >= start && selection.end <= end) return part.text.slice(1).toLowerCase();
    start = end;
  }
  return null;
}
