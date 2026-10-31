/**
 * Settings search, shared by desktop and phone: each platform keeps its own index of what its Settings show (a page and
 * the rows on it), and this ranks them against what was typed and marks the matched letters for the result list.
 */

/** One thing Settings can find: a page, or a row on one. */
export type SettingsSearchEntry<Page extends string = string> = {
  /** Where it lives: a desktop Settings section, or a phone Settings route. */
  page: Page;
  /** The text the row shows, exactly: the page opens and the row with this text lights up. */
  title: string;
  /** The heading of the card the row sits in, shown under the result. */
  group?: string;
  /** The row's own hint, searched but not shown. */
  description?: string;
  /** Other words someone might type for it. */
  keywords?: string;
};

export type SettingsSearchHit<Entry extends SettingsSearchEntry = SettingsSearchEntry> = {
  entry: Entry;
  /** Where the query's words fall in the title, as [start, end) pairs, for bold letters in the result. */
  ranges: [number, number][];
};

/** Lowercase without accents, so "notificacoes" finds "Notificações". Same length as its input for Latin text. */
export function foldSearchText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

function words(query: string): string[] {
  return foldSearchText(query).split(/\s+/).filter(Boolean);
}

/** The [start, end) spans of `text` that the query's words match, merged and in order. */
export function searchRanges(text: string, query: string): [number, number][] {
  // Folding keeps one character per character only when nothing composed was split off; otherwise mark nothing.
  const folded = foldSearchText(text);
  if (folded.length !== text.length) return [];
  const spans: [number, number][] = [];
  for (const word of words(query)) {
    const at = wordStart(folded, word);
    if (at >= 0) spans.push([at, at + word.length]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([...span]);
  }
  return merged;
}

/** Where `word` starts in `text`, preferring the start of a word over the middle of one; -1 when absent. */
function wordStart(text: string, word: string): number {
  let at = text.indexOf(word);
  const first = at;
  while (at > 0 && /[a-z0-9]/.test(text[at - 1] ?? "")) {
    at = text.indexOf(word, at + 1);
    if (at < 0) return first;
  }
  return at;
}

function scoreWord(word: string, title: string, rest: string): number {
  if (title === word) return 100;
  if (title.startsWith(word)) return 80;
  const at = title.indexOf(word);
  if (at >= 0) return /[a-z0-9]/.test(title[at - 1] ?? "") ? 40 : 60;
  if (rest.includes(word)) return 15;
  return -1;
}

/**
 * The entries every word of the query appears in (title, group, page name, hint or keywords), best first: a title that
 * starts with the query, then one with it at a word's start, then inside a word, then the other fields. Ties keep the
 * index's order, which follows the order Settings show things in.
 */
export function searchSettings<Entry extends SettingsSearchEntry>(
  entries: readonly Entry[],
  query: string,
  pageTitle: (page: Entry["page"]) => string = String,
  limit = 60,
): SettingsSearchHit<Entry>[] {
  const terms = words(query);
  if (!terms.length) return [];
  const whole = terms.join(" ");
  const scored: { entry: Entry; score: number; index: number }[] = [];
  entries.forEach((entry, index) => {
    const title = foldSearchText(entry.title);
    const rest = foldSearchText([entry.group, pageTitle(entry.page), entry.description, entry.keywords].filter(Boolean).join(" "));
    let score = 0;
    for (const term of terms) {
      const one = scoreWord(term, title, rest);
      if (one < 0) return;
      score += one;
    }
    // The whole phrase together in the title beats its words scattered.
    if (terms.length > 1 && title.includes(whole)) score += 50;
    scored.push({ entry, score, index });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  const seen = new Set<string>();
  const hits: SettingsSearchHit<Entry>[] = [];
  for (const { entry } of scored) {
    // A row the index names twice on one page (two cards with the same row) shows once.
    const key = `${entry.page}\u0000${entry.title}\u0000${entry.group ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({ entry, ranges: searchRanges(entry.title, query) });
    if (hits.length >= limit) break;
  }
  return hits;
}

/** The line under a result: the page it opens, then the card it sits in. */
export function searchTrail(entry: SettingsSearchEntry, pageTitle: string): string {
  return entry.group && entry.group !== pageTitle ? `${pageTitle} › ${entry.group}` : pageTitle;
}
