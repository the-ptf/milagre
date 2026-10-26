/**
 * The file a reply's markdown link points at, or null when it is a web link or nothing a file viewer can show.
 * Agents link files as absolute paths (`/Users/me/repo/docs/spec.md`) or paths relative to the chat's folder
 * (`docs/spec.md`), sometimes with `:12`, `#L12` or `#L12-L20` after them. A relative link needs `root`, the chat's
 * worktree; `..` segments are folded so the computer checks the real target. URLs with a scheme, `file:` included,
 * are not files here: the renderers drop `file:` links, and the computer checks whether a file belongs to an open Worktree or was shared in a Chat.
 */
export function localFileLink(href, root) {
  let text = href.trim();
  if (!text || /[\0\r\n]/.test(text) || text.startsWith("//") || text.startsWith("#")) return null;
  let line;
  try {
    if (/^[a-z][a-z\d+.-]*:/i.test(text)) return null;
    const hash = text.indexOf("#");
    if (hash !== -1) {
      const anchor = /^#L(\d+)(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/i.exec(text.slice(hash));
      if (anchor) line = Number(anchor[1]);
      text = text.slice(0, hash);
    }
    text = decodeURIComponent(text.replace(/\?.*$/, ""));
  } catch {
    return null;
  }
  const suffix = /:(\d+)(?::\d+|-\d+)?$/.exec(text);
  if (suffix) {
    line ??= Number(suffix[1]);
    text = text.slice(0, suffix.index);
  }
  if (!text || text.endsWith("/")) return null;
  if (!text.startsWith("/")) {
    if (!root?.startsWith("/")) return null;
    text = `${root}/${text}`;
  }
  const parts = [];
  for (const part of text.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  if (!parts.length) return null;
  return { path: "/" + parts.join("/"), ...(line ? { line } : {}) };
}

/** Markdown files open formatted; the viewer offers the source too. */
export function isMarkdownFile(name) {
  return /\.(md|mdx|markdown)$/i.test(name);
}
