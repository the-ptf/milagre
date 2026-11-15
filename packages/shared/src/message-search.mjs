const WORD = /[\p{L}\p{N}_]+/gu;
const indexes = new WeakMap();
function indexOf(messages) {
  const cached = indexes.get(messages);
  if (cached) return cached;
  const lowered = [];
  const words = new Map();
  messages.forEach((message, position) => {
    const text = message.body.toLowerCase();
    lowered.push(text);
    for (const word of new Set(text.match(WORD))) {
      const postings = words.get(word);
      if (postings) postings.push(position);
      else words.set(word, [position]);
    }
  });
  const index = { messages: [...messages], lowered, words, terms: new Map() };
  indexes.set(messages, index);
  return index;
}
const typos = (length) => (length >= 8 ? 2 : length >= 4 ? 1 : 0);
/** Damerau-Levenshtein distance between `a` and the closest prefix of `b`, or Infinity once it exceeds `max`. */
export function editDistance(a, b, max, prefix = false) {
  if (prefix) b = b.slice(0, a.length + max);
  if (Math.abs(a.length - b.length) > max && !(prefix && b.length > a.length)) return Infinity;
  let before = Array.from({ length: b.length + 1 }, () => 0);
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, before[j - 2] + 1);
      current.push(value);
      if (value < best) best = value;
    }
    if (best > max) return Infinity;
    before = previous;
    previous = current;
  }
  const distance = prefix ? Math.min(...previous.slice(a.length - max > 0 ? a.length - max : 0)) : previous[b.length];
  return distance > max ? Infinity : distance;
}
function wordMatches(index, term) {
  const cached = index.terms.get(term);
  if (cached) return cached;
  const words = index.words;
  const allowed = typos(term.length);
  const found = new Map();
  for (const word of words.keys()) {
    if (word === term) found.set(word, 4);
    else if (word.startsWith(term)) found.set(word, 3);
    else if (term.length >= 3 && word.includes(term)) found.set(word, 2);
    else if (allowed) {
      const distance = editDistance(term, word, allowed, true);
      if (distance <= allowed) found.set(word, 1.5 - distance / 2);
    }
  }
  if (index.terms.size > 200) index.terms.clear();
  index.terms.set(term, found);
  return found;
}
function snippetAround(text, start, end, width = 90) {
  const lead = Math.max(0, Math.min(start, Math.floor((width - (end - start)) / 3)));
  let from = start - lead;
  let to = Math.min(text.length, from + width);
  if (from > 0) {
    const space = text.lastIndexOf(" ", from);
    from = space >= 0 && start - space < width / 2 ? space + 1 : from;
  }
  if (to < text.length) {
    const space = text.indexOf(" ", to);
    to = space >= 0 && space - to < 12 ? space : to;
  }
  const collapse = (value) => value.replace(/\s+/g, " ");
  const before = (from > 0 ? "…" : "") + collapse(text.slice(from, start)).trimStart();
  const match = collapse(text.slice(start, end));
  const after = collapse(text.slice(end, to)).trimEnd() + (to < text.length ? "…" : "");
  return { snippet: before + match + after, highlight: [before.length, before.length + match.length] };
}
/** Best first; ties go to the newest message. */
export function searchMessages(messages, query, limit = 50) {
  const phrase = query.trim().toLowerCase().replace(/\s+/g, " ");
  const terms = [...new Set(phrase.match(WORD) ?? [])];
  if (!terms.length || phrase.length < 2) return [];
  const index = indexOf(messages);
  let scores = null;
  const firstWord = new Map();
  for (const [position, term] of terms.entries()) {
    const next = new Map();
    for (const [word, score] of wordMatches(index, term)) {
      for (const message of index.words.get(word)) {
        if (scores && !scores.has(message)) continue;
        if ((next.get(message) ?? 0) < score) {
          next.set(message, score);
          if (position === 0) firstWord.set(message, { word, score });
        }
      }
    }
    for (const [message, score] of next) next.set(message, score + (scores?.get(message) ?? 0));
    scores = next;
    if (!scores.size) return [];
  }
  const matches = [];
  for (const [position, score] of scores) {
    const text = index.lowered[position];
    const body = index.messages[position].body;
    const exact = text.indexOf(phrase);
    // Lowercasing can change the length (e.g. "İ"), so fall back to the start of the body for offsets.
    const aligned = text.length === body.length;
    let start = 0;
    let end = 0;
    if (exact >= 0 && aligned) [start, end] = [exact, exact + phrase.length];
    else if (aligned) {
      const word = firstWord.get(position).word;
      const at = text.search(new RegExp(`(?<![\\p{L}\\p{N}_])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "u"));
      [start, end] = at >= 0 ? [at, at + word.length] : [0, 0];
    }
    matches.push({
      message: index.messages[position],
      score: score + (exact >= 0 ? terms.length * 4 : 0),
      term: body.slice(start, end),
      ...snippetAround(body, start, end),
    });
  }
  return matches.sort((a, b) => b.score - a.score || b.message.id - a.message.id).slice(0, limit);
}
