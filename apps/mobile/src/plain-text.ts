import { markdownTokens } from "./chat-presentation.ts";

type Token = ReturnType<typeof markdownTokens>[number];

export function markdownPlainText(text: string): string {
  const blocks: string[] = [];
  const lists: { ordered: boolean; next: number }[] = [];
  let current = "";
  const flush = () => {
    const block = current.replace(/^\n+|\n+$/g, "");
    if (block) blocks.push(block);
    current = "";
  };
  let cell = 0;
  for (const token of markdownTokens(text)) {
    switch (token.type) {
      case "bullet_list_open":
      case "ordered_list_open":
        if (!lists.length) flush();
        lists.push({ ordered: token.type === "ordered_list_open", next: Number(token.attrGet("start") || 1) });
        break;
      case "bullet_list_close":
      case "ordered_list_close":
        lists.pop();
        if (!lists.length) flush();
        break;
      case "list_item_open": {
        const list = lists.at(-1);
        if (current && !current.endsWith("\n")) current += "\n";
        current += "  ".repeat(Math.max(0, lists.length - 1)) + (list?.ordered ? `${list.next++}. ` : "• ");
        break;
      }
      case "inline":
        current += inlineText(token.children ?? []);
        break;
      case "paragraph_close":
        if (!lists.length) flush();
        break;
      case "heading_close":
        flush();
        break;
      case "fence":
      case "code_block":
        flush();
        blocks.push(token.content.replace(/\n$/, ""));
        break;
      case "tr_open":
        cell = 0;
        break;
      case "th_open":
      case "td_open":
        if (cell++) current += "\t";
        break;
      case "tr_close":
        current += "\n";
        break;
      case "table_close":
        flush();
        break;
    }
  }
  flush();
  return blocks.join("\n\n");
}

function inlineText(tokens: Token[]): string {
  let out = "";
  let link: { href: string; start: number } | null = null;
  for (const token of tokens) {
    if (token.type === "text" || token.type === "code_inline") out += token.content;
    else if (token.type === "softbreak" || token.type === "hardbreak") out += "\n";
    else if (token.type === "image") out += token.content;
    else if (token.type === "link_open") link = { href: String(token.attrGet("href") || ""), start: out.length };
    else if (token.type === "link_close" && link) {
      const label = out.slice(link.start);
      const bare = label === link.href || `mailto:${label}` === link.href || `http://${label}` === link.href;
      if (link.href && !bare) out += ` (${link.href})`;
      link = null;
    }
  }
  return out;
}
