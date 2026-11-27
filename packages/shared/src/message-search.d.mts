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

/** What `chats:search` looks through: one scope, or every Project on the computer; archived Chats only when asked. */
export interface ChatSearchOptions {
  /** A Project path or Link key; every Project on the computer when left out. */
  scope?: string;
  archived?: boolean;
  limit?: number;
  perChat?: number;
}

/** One message `chats:search` found, with the Project and Chat it belongs to. */
export interface ChatSearchHit {
  projectPath: string;
  projectName: string;
  chat: { id: number; title: string; archived: boolean; lastAt?: number; branch?: string };
  message: { id: number; session_id: number };
  score: number;
  snippet: string;
  highlight: [start: number, end: number];
  term: string;
}

/** `failed` names each Project that couldn't be read, so a client tells "no matches" from "couldn't search". */
export interface ChatSearchResult {
  matches: ChatSearchHit[];
  failed: { projectPath: string; projectName: string; error: string }[];
  searched: number;
}
