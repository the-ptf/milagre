import type { Token } from "markdown-it";

export type MarkdownNode = { token: Token; children: MarkdownNode[] };

/** Collect a table's rows without letting a nested block contribute columns to its parent. */
export function markdownTableRows(nodes: MarkdownNode[]): MarkdownNode[][] {
  return nodes.flatMap(({ token, children }) =>
    token.type === "tr_open" ? [children] : token.type === "thead_open" || token.type === "tbody_open" ? markdownTableRows(children) : [],
  );
}

/** Visible labels only: a short link must not size its column for an invisible URL. */
export function markdownCellText(nodes: MarkdownNode[]): string {
  return nodes
    .map(({ token, children }) => {
      if (token.type === "inline")
        return (token.children ?? [])
          .map((part) =>
            part.type === "text" || part.type === "code_inline" || part.type === "image"
              ? part.content
              : part.type === "softbreak" || part.type === "hardbreak"
                ? "\n"
                : "",
          )
          .join("");
      return children.length ? markdownCellText(children) : token.content;
    })
    .join("");
}

/** Clamp natural widths, then share unused room. Stretching can exceed the natural 260pt cap. */
export function markdownColumnWidths(rows: string[][], available = 0, textPx = 15): number[] {
  const count = Math.max(0, ...rows.map((row) => row.length));
  const widths = Array.from({ length: count }, (_, column) => {
    const longest = Math.max(0, ...rows.flatMap((row) => (row[column] ?? "").split("\n").map((line) => Array.from(line).length)));
    return Math.min(260, Math.max(96, longest * 7.5 * (textPx / 15) + 24));
  });
  const extra = Math.max(0, available - widths.reduce((sum, width) => sum + width, 0));
  return widths.map((width) => width + extra / count);
}
