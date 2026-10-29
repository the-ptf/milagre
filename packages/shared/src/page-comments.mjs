// Comments on Browser panel pages: the message the agent reads, and reading it back for the transcript card.
// Types in page-comments.d.mts.

const RESOLVE = "Once you have addressed a comment, resolve it with browser_resolve_comment and its comment id.";
const SCREENSHOTS = "Each comment's screenshot is attached, in order.";
const HEADING = /^(A comment|\d+ comments) on the page "(.*)" \((https?:\/\/\S+)\):$/;
const ITEM = /^(\d+)\. \(comment ([a-f0-9]{8})\) (.+)$/;
const CONTINUED = "     ";
// The lines under a comment, as pageCommentsMessage writes them. A card shows only a message made of these.
const DETAIL = /^ {3}(Comment|Selector|Box|Styles|HTML): /;

/** The id of a comment the app sends, made before it is sent so the message can name it. */
export const pageCommentId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8);

const oneLine = (text, max) => text.replace(/\s+/g, " ").trim().slice(0, max) || "";

/** The comment's text, its lines after the first indented so the message reads them as one comment. */
const commentText = (text) =>
  text
    .trim()
    .split(/\r?\n/)
    .map((line, index) => (index ? `${CONTINUED}${line.trimEnd()}` : line.trimEnd()))
    .join("\n");

/**
 * The message the agent reads for comments on Browser panel pages: one block per page, each comment with its id, the
 * element (label, component source, selector, box, styles, HTML) and the user's text. parsePageComments reads it back.
 */
export function pageCommentsMessage(comments, { screenshots = true } = {}) {
  const pages = new Map();
  // A page's address on one line without spaces, as the heading names it.
  for (const comment of comments) {
    const url = comment.url.replace(/\s/g, encodeURIComponent);
    pages.set(url, [...(pages.get(url) ?? []), comment]);
  }
  let number = 0;
  const blocks = [...pages].map(([url, list]) => {
    const title = oneLine(list[0].title, 120) || url;
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
      const label = oneLine(element.label ?? "", 200) || oneLine(element.tag ?? "", 40) || "element";
      return [`${number}. (comment ${id}) ${label}${source}`, ...detail].join("\n");
    });
    return `${list.length === 1 ? "A comment" : `${list.length} comments`} on the page "${title.replace(/"/g, "'")}" (${url}):\n\n${lines.join("\n\n")}`;
  });
  return [...blocks, `${screenshots ? `${SCREENSHOTS} ` : ""}${RESOLVE}`].join("\n\n");
}

/** The comments a message pageCommentsMessage wrote carries, to show it as a card; null for any other message. */
export function parsePageComments(body) {
  const lines = body.split("\n");
  const footer = lines.at(-1);
  if (footer !== RESOLVE && footer !== `${SCREENSHOTS} ${RESOLVE}`) return null;
  const comments = [];
  let page = null;
  let current = null;
  let inText = false;
  for (const line of lines.slice(0, -1)) {
    const heading = HEADING.exec(line);
    if (heading) {
      page = { title: heading[2], url: heading[3] };
      current = null;
      continue;
    }
    const item = ITEM.exec(line);
    if (item && page) {
      current = { id: item[2], number: Number(item[1]), url: page.url, title: page.title, label: item[3].replace(/ \([^()]*:\d+\)$/, ""), text: "" };
      comments.push(current);
      inText = false;
      continue;
    }
    if (current && line.startsWith("   Comment: ")) {
      current.text = line.slice("   Comment: ".length);
      inText = true;
    } else if (current && inText && line.startsWith(CONTINUED)) current.text += `\n${line.slice(CONTINUED.length)}`;
    else if (current && DETAIL.test(line)) inText = false;
    // Anything else (a line the writer never makes, text before the first page) is a message someone typed.
    else if (line.trim()) return null;
    else inText = false;
  }
  return comments.length ? comments : null;
}

/** A comment's address without its query and hash: pins show on every version of the same page. */
export const pageKey = (url) => {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
};
