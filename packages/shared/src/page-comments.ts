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
}

const RESOLVE = "Once you have addressed a comment, resolve it with browser_resolve_comment and its comment id.";
const SCREENSHOTS = "Each comment's screenshot is attached, in order.";
const HEADING = /^(A comment|\d+ comments) on the page "(.*)" \((https?:\/\/\S+)\):$/;
const ITEM = /^(\d+)\. \(comment ([a-f0-9]{8})\) (.+)$/;
const CONTINUED = "     ";

/** The id of a comment the app sends, made before it is sent so the message can name it. */
export const pageCommentId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8);

const oneLine = (text: string, max: number) => text.replace(/\s+/g, " ").trim().slice(0, max) || "";

/** The comment's text, its lines after the first indented so the message reads them as one comment. */
const commentText = (text: string) =>
  text
    .trim()
    .split(/\r?\n/)
    .map((line, index) => (index ? `${CONTINUED}${line.trimEnd()}` : line.trimEnd()))
    .join("\n");

/**
 * The message the agent reads for comments on Browser panel pages: one block per page, each comment with its id, the
 * element (label, component source, selector, box, styles, HTML) and the user's text. parsePageComments reads it back.
 */
export function pageCommentsMessage(comments: (PageComment & { id: string })[], { screenshots = true }: { screenshots?: boolean } = {}): string {
  const pages = new Map<string, (PageComment & { id: string })[]>();
  for (const comment of comments) pages.set(comment.url, [...(pages.get(comment.url) ?? []), comment]);
  let number = 0;
  const blocks = [...pages].map(([url, list]) => {
    const title = oneLine(list[0]!.title, 120) || url;
    const lines = list.map(({ id, element, text }) => {
      number += 1;
      const detail = [
        `   Comment: ${commentText(text)}`,
        `   Selector: ${oneLine(element.selector, 300)}`,
        `   Box: ${Math.round(element.box.width)}×${Math.round(element.box.height)} at ${Math.round(element.box.x)},${Math.round(element.box.y)} in a ${Math.round(element.viewport.width)}×${Math.round(element.viewport.height)} viewport`,
      ];
      const styles = Object.entries(element.styles ?? {})
        .map(([name, value]) => `${name}: ${value}`)
        .join("; ");
      if (styles) detail.push(`   Styles: ${oneLine(styles, 600)}`);
      if (element.html) detail.push(`   HTML: ${oneLine(element.html, 1500)}`);
      const source = element.source ? ` (${oneLine(element.source, 200)})` : "";
      return [`${number}. (comment ${id}) ${oneLine(element.label, 200)}${source}`, ...detail].join("\n");
    });
    return `${list.length === 1 ? "A comment" : `${list.length} comments`} on the page "${title.replace(/"/g, "'")}" (${url}):\n\n${lines.join("\n\n")}`;
  });
  return [...blocks, `${screenshots ? `${SCREENSHOTS} ` : ""}${RESOLVE}`].join("\n\n");
}

export type ParsedPageComment = { id: string; number: number; url: string; title: string; label: string; text: string };

/** The comments a message pageCommentsMessage wrote carries, to show it as a card; null for any other message. */
export function parsePageComments(body: string): ParsedPageComment[] | null {
  const lines = body.split("\n");
  if (!lines.at(-1)?.endsWith(RESOLVE)) return null;
  const comments: ParsedPageComment[] = [];
  let page: { url: string; title: string } | null = null;
  let current: ParsedPageComment | null = null;
  let inText = false;
  for (const line of lines.slice(0, -1)) {
    const heading = HEADING.exec(line);
    if (heading) {
      page = { title: heading[2]!, url: heading[3]! };
      current = null;
      continue;
    }
    const item = ITEM.exec(line);
    if (item && page) {
      current = { id: item[2]!, number: Number(item[1]), url: page.url, title: page.title, label: item[3]!.replace(/ \([^()]*:\d+\)$/, ""), text: "" };
      comments.push(current);
      inText = false;
      continue;
    }
    if (current && line.startsWith("   Comment: ")) {
      current.text = line.slice("   Comment: ".length);
      inText = true;
    } else if (current && inText && line.startsWith(CONTINUED)) current.text += `\n${line.slice(CONTINUED.length)}`;
    else if (line.startsWith("   ")) inText = false;
    else if (line.trim()) return null;
  }
  return comments.length ? comments : null;
}

/** A comment's address without its query and hash: pins show on every version of the same page. */
export const pageKey = (url: string) => {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
};
