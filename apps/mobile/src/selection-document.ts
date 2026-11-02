import { isGenuiFence } from "@milagre/shared/genui";
import { isMermaidFence } from "@milagre/shared/diagram";
import { markdownTokens } from "./chat-presentation.ts";

type Token = ReturnType<typeof markdownTokens>[number];

/** A run of text with one look. Links only change color: the selection view selects them, it never opens them. */
export type SelectionSpan = { text: string; bold?: boolean; italic?: boolean; strike?: boolean; code?: boolean; link?: boolean };

/**
 * One paragraph of the native selection view, laid out like the formatted message it replaces: `markers` are the
 * enclosing list items' markers (outermost first), the last drawn when `showMarker`; `quote` is the blockquote depth;
 * `spaceBefore` the gap above it, in points. A `\n` inside a span breaks the line without that gap.
 */
export type SelectionParagraph = {
  kind: "body" | "heading" | "code";
  /** Points a heading adds to the body size. */
  grow: number;
  markers: string[];
  showMarker: boolean;
  quote: number;
  spaceBefore: number;
  spans: SelectionSpan[];
};

/** Gaps of the formatted message: 12 between top-level blocks, 8 inside lists and quotes. */
const BLOCK_GAP = 12;
const INNER_GAP = 8;

/** A plain message (the user's own) as one paragraph; its line breaks stay. */
export function plainSelection(text: string): SelectionParagraph[] {
  return text ? [{ kind: "body", grow: 0, markers: [], showMarker: false, quote: 0, spaceBefore: 0, spans: [{ text }] }] : [];
}

/**
 * A reply as the phone draws it, for selecting in place: the marks go, bold, italics, code and links keep their look,
 * lists keep their markers and indents. Diagrams, generated UI and images are not text and are left out.
 */
export function markdownSelection(text: string): SelectionParagraph[] {
  const paragraphs: SelectionParagraph[] = [];
  const lists: { ordered: boolean; next: number }[] = [];
  const markers: string[] = [];
  let quote = 0;
  let pendingMarker = false;
  let gap = BLOCK_GAP;
  // The size step of the heading being read (h1 +2, h2 +1, others 0), or null outside a heading.
  let heading: number | null = null;
  let row: SelectionSpan[] | null = null;
  let header = false;
  let cell = 0;
  const inside = () => lists.length > 0 || quote > 0;
  const emit = (kind: SelectionParagraph["kind"], spans: SelectionSpan[], grow = 0) => {
    if (!spans.some((span) => span.text.trim())) return;
    paragraphs.push({ kind, grow, markers: [...markers], showMarker: pendingMarker, quote, spaceBefore: paragraphs.length ? gap : 0, spans });
    pendingMarker = false;
    gap = inside() ? INNER_GAP : BLOCK_GAP;
  };
  for (const token of markdownTokens(text)) {
    switch (token.type) {
      case "bullet_list_open":
      case "ordered_list_open":
        lists.push({ ordered: token.type === "ordered_list_open", next: Number(token.attrGet("start") || 1) });
        break;
      case "bullet_list_close":
      case "ordered_list_close":
        lists.pop();
        if (!inside()) gap = BLOCK_GAP;
        break;
      case "list_item_open": {
        const list = lists.at(-1);
        markers.push(list?.ordered ? `${list.next++}.` : "•");
        pendingMarker = true;
        break;
      }
      case "list_item_close":
        markers.pop();
        pendingMarker = false;
        break;
      case "blockquote_open":
        quote++;
        break;
      case "blockquote_close":
        quote--;
        if (!inside()) gap = BLOCK_GAP;
        break;
      case "heading_open":
        heading = token.tag === "h1" ? 2 : token.tag === "h2" ? 1 : 0;
        break;
      case "heading_close":
        heading = null;
        break;
      case "tr_open":
        row = [];
        cell = 0;
        break;
      case "th_open":
      case "td_open":
        header = token.type === "th_open";
        if (row && cell++) row.push({ text: "\t" });
        break;
      case "tr_close":
        if (row) emit("body", row);
        row = null;
        break;
      case "inline": {
        const spans = inlineSpans(token.children ?? []);
        if (row) row.push(...spans.map((span) => (header ? { ...span, bold: true } : span)));
        else if (heading !== null)
          emit(
            "heading",
            spans.map((span) => ({ ...span, bold: true })),
            heading,
          );
        else emit("body", spans);
        break;
      }
      case "fence":
      case "code_block":
        if (token.type === "fence" && (isGenuiFence(token.info) || isMermaidFence(token.info))) break;
        emit("code", [{ text: token.content.replace(/\n$/, ""), code: true }]);
        break;
    }
  }
  return paragraphs;
}

function inlineSpans(tokens: Token[]): SelectionSpan[] {
  const spans: SelectionSpan[] = [];
  let bold = 0,
    italic = 0,
    strike = 0,
    link = 0;
  const push = (text: string, code = false) => {
    if (!text) return;
    const span: SelectionSpan = { text };
    if (bold) span.bold = true;
    if (italic) span.italic = true;
    if (strike) span.strike = true;
    if (link) span.link = true;
    if (code) span.code = true;
    const last = spans.at(-1);
    // Neighbouring runs with the same look join, so the native view builds fewer attribute ranges.
    if (last && !code && !last.code && sameLook(last, span)) last.text += text;
    else spans.push(span);
  };
  for (const token of tokens) {
    if (token.type === "text" || token.type === "html_inline") push(token.content);
    else if (token.type === "code_inline") push(token.content, true);
    else if (token.type === "softbreak" || token.type === "hardbreak") push("\n");
    else if (token.type === "strong_open") bold++;
    else if (token.type === "strong_close") bold--;
    else if (token.type === "em_open") italic++;
    else if (token.type === "em_close") italic--;
    else if (token.type === "s_open") strike++;
    else if (token.type === "s_close") strike--;
    else if (token.type === "link_open") link++;
    else if (token.type === "link_close") link--;
  }
  return spans;
}

function sameLook(a: SelectionSpan, b: SelectionSpan) {
  return !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.strike === !!b.strike && !!a.link === !!b.link;
}
