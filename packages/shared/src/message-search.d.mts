export interface SearchableMessage {
  id: number;
  session_id: number;
  body: string;
}

export interface MessageMatch<M extends SearchableMessage = SearchableMessage> {
  message: M;
  score: number;
  snippet: string;
  highlight: [start: number, end: number];
  term: string;
}

/** Damerau-Levenshtein distance between `a` and the closest prefix of `b`, or Infinity once it exceeds `max`. */
export function editDistance(a: string, b: string, max: number, prefix?: boolean): number;

/**
 * Messages matching every word of `query`, best first. A word matches by prefix, inside a longer word, or within one
 * typo (two for words of 8+ letters); the whole query appearing as typed ranks highest. Ties go to the newest message.
 */
export function searchMessages<M extends SearchableMessage>(messages: readonly M[], query: string, limit?: number): MessageMatch<M>[];
