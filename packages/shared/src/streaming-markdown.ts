const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const THEMATIC_BREAK = /^ {0,3}([*_-])( *\1){2,} *$/;

export function closeOpenMarkdown(text: string): string {
  const lines = text.split("\n");
  let fence: string | undefined;
  let paragraphStart = 0;
  lines.forEach((line, index) => {
    const marker = line.match(FENCE)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) {
        fence = undefined;
        paragraphStart = index + 1;
      }
      return;
    }
    if (marker) fence = marker;
    else if (line.trim() === "") paragraphStart = index + 1;
  });
  // An open fence already renders as a code block running to the end of the text.
  if (fence) return text;
  // A lone `*` just streamed in starts emphasis or a bullet; hide it until the next chunk shows which.
  if (/(^|\s)\*$/.test(text)) return closeOpenMarkdown(text.slice(0, -1));

  // Emphasis and code spans never cross a blank line, so only the paragraph being written can hold an open marker.
  const paragraph = lines
    .slice(paragraphStart)
    .filter((line) => !THEMATIC_BREAK.test(line))
    .join("\n");
  const ticks = paragraph.match(/(?<!`)`(?!`)/g)?.length ?? 0;
  if (ticks % 2 === 1) return text.endsWith("`") ? text.slice(0, -1) : `${text}\``;
  const bold = paragraph.replace(/`[^`]*`/g, "").match(/\*\*/g)?.length ?? 0;
  // A closing marker must touch the text it closes, so trailing spaces go first.
  if (bold % 2 === 1) return /\*\*\s*$/.test(text) ? text.replace(/\*\*\s*$/, "") : `${text.trimEnd()}**`;
  return text;
}
