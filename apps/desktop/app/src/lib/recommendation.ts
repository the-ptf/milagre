export interface RecommendationOption {
  id: string;
  label: string;
  recommended: boolean;
}
export interface Recommendation {
  intro: string;
  question: string;
  options: RecommendationOption[];
}

const ITEM = /^\s*(\d+)[.)]\s+(.+)$/;
const MAX_LABEL = 120;

const stripMarkers = (text: string) => text.replace(/\*\*|__|`/g, "").trim();

/** Takes the "recommended" marker off a label; reports whether there was one. */
function takeMarker(label: string): { label: string; recommended: boolean } {
  const trailing = /\s*(?:\(\s*recommended\s*\)|[—–,-]\s*recommended)\s*\.?\s*$/i;
  const leading = /^recommended:\s*/i;
  const cleaned = label.replace(trailing, "").replace(leading, "").trim();
  return { label: cleaned, recommended: cleaned !== label && cleaned.length > 0 };
}

function offersChoices(label: string): boolean {
  return (/\(a\)/i.test(label) && /\(b\)/i.test(label)) || (/\ba\)/i.test(label) && /\bb\)/i.test(label));
}

/**
 * A card only when a finished reply ends with a short question followed by 2-6 short answers.
 * Anything else stays plain Markdown.
 */
export function parseRecommendation(body: string): Recommendation | null {
  const lines = body.split(/\r?\n/);
  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? "").trim() === "") end -= 1;

  let start = end;
  while (start > 0 && ITEM.test(lines[start - 1] ?? "")) start -= 1;
  const items = lines.slice(start, end).flatMap((line) => {
    const match = line.match(ITEM);
    return match ? [match] : [];
  });
  if (items.length < 2 || items.length > 6) return null;
  if (items.some((match, index) => Number(match[1]) !== index + 1)) return null;

  const before = lines.slice(0, start);
  if (before.filter((line) => line.trimStart().startsWith("```")).length % 2 === 1) return null;

  let questionLine = before.length;
  while (questionLine > 0 && (before[questionLine - 1] ?? "").trim() === "") questionLine -= 1;
  if (questionLine === 0) return null;
  const raw = before[questionLine - 1];
  if (raw === undefined) return null;
  const trimmed = raw.replace(/[:\s*_]+$/, "");
  if (!trimmed.endsWith("?")) return null;

  let sentenceStart = 0;
  for (const split of trimmed.matchAll(/(?<=[.!?])\s+/g)) sentenceStart = split.index + split[0].length;
  const question = stripMarkers(trimmed.slice(sentenceStart));
  if (!question.endsWith("?")) return null;

  const options: RecommendationOption[] = [];
  let hasRecommended = false;
  for (const [index, match] of items.entries()) {
    if (match[2] === undefined) return null;
    const label = stripMarkers(match[2]);
    if (label.length > MAX_LABEL || label.endsWith("?") || offersChoices(label)) return null;
    const marked = takeMarker(label);
    if (!marked.label) return null;
    const recommended = marked.recommended && !hasRecommended;
    if (recommended) hasRecommended = true;
    options.push({ id: `recommendation-${index + 1}`, label: marked.label, recommended });
  }

  const intro = [...before.slice(0, questionLine - 1), raw.slice(0, sentenceStart)].join("\n").trimEnd();
  return { intro, question, options };
}
