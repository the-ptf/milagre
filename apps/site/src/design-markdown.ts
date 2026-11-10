// DESIGN.md's prose as HTML for /design: headings get stable ids for the table of contents, and links to repository
// files point at GitHub, since the page lives on milagre.cloud.
import MarkdownIt from "markdown-it";
import { REPO_URL } from "./links";

interface Heading {
  depth: number;
  text: string;
  id: string;
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[`'’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "");

/** A renderer for one page: ids stay unique across every chunk it renders, and `headings` lists them in order. */
export function createRenderer() {
  const headings: Heading[] = [];
  const used = new Map<string, number>();
  const md = new MarkdownIt({ html: false, linkify: false, typographer: false });

  md.renderer.rules.heading_open = (tokens, index, options, _env, self) => {
    const token = tokens[index];
    const text = tokens[index + 1]?.content ?? "";
    const base = slug(text) || "section";
    const count = used.get(base) ?? 0;
    used.set(base, count + 1);
    const id = count ? `${base}-${count + 1}` : base;
    token.attrSet("id", id);
    headings.push({ depth: Number(token.tag.slice(1)), text, id });
    return self.renderToken(tokens, index, options);
  };

  md.renderer.rules.link_open = (tokens, index, options, _env, self) => {
    const token = tokens[index];
    const href = token.attrGet("href") ?? "";
    if (href === "https://milagre.cloud/design") token.attrSet("href", "/design");
    else if (!/^(?:[a-z]+:|#|\/)/i.test(href)) token.attrSet("href", `${REPO_URL}/blob/main/${href}`);
    return self.renderToken(tokens, index, options);
  };

  return { render: (markdown: string) => md.render(markdown), headings };
}
