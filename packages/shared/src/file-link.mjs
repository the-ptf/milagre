/** A Windows path from its drive: `C:\repo`, `C:/repo`, or `C:%5Crepo` as markdown writes a backslash in a link. */
export function isWindowsPath(path) {
  return /^[a-z]:(?:[\\/]|%5c)/i.test(path);
}

const separator = (path) => (isWindowsPath(path) ? /[\\/]/ : "/");

/** The file name at the end of a path from `localFileLink`. */
export function fileLinkName(path) {
  return path.split(separator(path)).pop() || path;
}

/** The folder holding a path from `localFileLink`, to resolve the links inside that file. */
export function fileLinkFolder(path) {
  const name = fileLinkName(path);
  const folder = path.slice(0, -name.length - 1);
  return folder.endsWith(":") ? `${folder}\\` : folder || "/";
}

/**
 * The file a reply's markdown link points at, or null when it is a web link or nothing a file viewer can show.
 * Agents link files as absolute paths (`/Users/me/repo/docs/spec.md`, `C:\repo\docs\spec.md`) or paths relative to the chat's folder
 * (`docs/spec.md`), sometimes with `:12`, `#L12` or `#L12-L20` after them. A relative link needs `root`, the chat's
 * worktree; `..` segments are folded so the computer checks the real target. URLs with a scheme, `file:` included,
 * are not files here: the renderers drop `file:` links, and the computer checks whether a file belongs to an open Worktree or was shared in a Chat.
 */
export function localFileLink(href, root) {
  let text = href.trim();
  if (!text || /[\0\r\n]/.test(text) || text.startsWith("//") || text.startsWith("#")) return null;
  let line;
  try {
    if (/^[a-z][a-z\d+.-]*:/i.test(text) && !isWindowsPath(text)) return null;
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
  const windows = isWindowsPath(text) || (!text.startsWith("/") && isWindowsPath(root ?? ""));
  if (windows && text.endsWith("\\")) return null;
  if (windows && !isWindowsPath(text)) text = `${root}\\${text}`;
  else if (!windows && !text.startsWith("/")) {
    if (!root?.startsWith("/")) return null;
    text = `${root}/${text}`;
  }
  const parts = [];
  for (const part of text.split(windows ? /[\\/]/ : "/")) {
    // A Windows path keeps its drive, however many `..` a link has.
    if (part === "..") {
      if (parts.length > (windows ? 1 : 0)) parts.pop();
    } else if (part && part !== ".") parts.push(part);
  }
  if (parts.length < (windows ? 2 : 1)) return null;
  return { path: windows ? parts.join("\\") : "/" + parts.join("/"), ...(line ? { line } : {}) };
}

/** Markdown files open formatted; the viewer offers the source too. */
export function isMarkdownFile(name) {
  return /\.(md|mdx|markdown)$/i.test(name);
}
