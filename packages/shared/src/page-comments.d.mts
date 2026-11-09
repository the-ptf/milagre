/** An element on a Browser panel page, as the comment picker (page-picker.mjs) reads it. */
export type PageElement = {
  /** A CSS selector that finds it again on the page. */
  selector: string;
  tag: string;
  /** How a person names it: `<PayButton> button "Pay now"`. */
  label: string;
  role?: string;
  name?: string;
  text?: string;
  /** Its outer HTML, cut short, with secret-looking values redacted. */
  html?: string;
  /** The computed styles that matter for layout and look. */
  styles?: Record<string, string>;
  /** Where it sits in the viewport, in CSS pixels, and the viewport's size. */
  box: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number };
  /** Its React components, innermost last, when the page is a React development build. */
  components?: string[];
  /** Its component's source location (`src/Checkout.tsx:88`), when the page exposes it. */
  source?: string;
  /** Where on it the user clicked, as fractions of its box: the comment's pin goes there. */
  point?: { x: number; y: number };
};

/** A comment the user leaves on an element of a page. */
export type PageComment = { id?: string; url: string; title: string; element: PageElement; text: string };

/** A comment as the host keeps it: what the agent needs to find the element again and resolve the comment. */
export type SavedPageComment = {
  id: string;
  url: string;
  title: string;
  label: string;
  selector: string;
  source?: string;
  point?: { x: number; y: number };
  text: string;
  createdAt: number;
  resolved?: { note: string; at: number };
};

export interface PageCommentsApi {
  /** Records the comments the user is sending; returns them with their ids. */
  add(request: { chatId: string; comments: PageComment[] }): Promise<SavedPageComment[]>;
  list(request: { chatId: string }): Promise<SavedPageComment[]>;
  /**
   * A comment on a streamed Browser panel page, at a point given as fractions of the page: the host reads the element
   * there, screenshots it, sends the comment to the Chat's agent as the user's message and records it.
   */
  sendFromPage?(request: { chatId: string; targetId: string; x: number; y: number; text: string }): Promise<{ id: string }>;
}

export function pageCommentId(): string;
/** The message the agent reads for comments on Browser panel pages; parsePageComments reads it back. */
export function pageCommentsMessage(comments: (PageComment & { id: string })[], options?: { screenshots?: boolean }): string;
export type ParsedPageComment = { id: string; number: number; url: string; title: string; label: string; text: string };
/** The comments a message pageCommentsMessage wrote carries, to show it as a card; null for any other message. */
export function parsePageComments(body: string): ParsedPageComment[] | null;
/** A comment's address without its query and hash: pins show on every version of the same page. */
export function pageKey(url: string): string;
