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

// Extensions that make a bit of inline code read as a file. A list rather than any ".word", so
// `console.log`, `Math.max` and `example.com` stay code.
const EXTENSIONS = new Set(
  (
    "ts tsx js jsx mjs cjs mts cts json jsonc md mdx css scss sass less html htm yml yaml toml ini cfg conf " +
    "py rb go rs java kt kts swift c h cc cpp hpp cs php sh bash zsh fish sql graphql gql proto lock txt xml svg png jpg jpeg gif webp ico " +
    "plist gradle vue svelte astro dart lua ex exs hs scala clj tf env csv tsv ipynb"
  ).split(" "),
);
const DOTFILES = new Set(["gitignore", "gitattributes", "env", "npmrc", "nvmrc", "prettierrc", "eslintrc", "editorconfig", "dockerignore"]);
const PATH_CHARS = /^[\w.@+()[\]-]+(\/[\w.@+()[\]-]+)*$/;

/**
 * The file a bit of inline code names, or null when it reads as something else: a relative path with a known
 * extension, optionally ending in `:line`, `:line:column` or `:line-line`. Commands, words, versions, URLs and
 * absolute or parent-relative paths are not files. The renderer can't tell whether the file exists; the computer does.
 */
export function fileLinkTarget(code) {
  const match = /^(.+?)(?::(\d+)(?::(\d+)|-\d+)?)?$/.exec(code);
  if (!match?.[1]) return null;
  const path = match[1];
  if (!PATH_CHARS.test(path) || path.startsWith("-") || path.endsWith("/")) return null;
  const segments = path.split("/");
  if (segments.some((segment, index) => segment === ".." || (segment === "." && index > 0))) return null;
  const name = segments[segments.length - 1];
  if (!name) return null;
  const dot = name.lastIndexOf(".");
  if (dot === -1 || dot === name.length - 1) return null;
  const extension = name.slice(dot + 1).toLowerCase();
  const known = dot === 0 ? DOTFILES.has(extension) : EXTENSIONS.has(extension);
  if (!known) return null;
  const line = match[2] === undefined ? undefined : Number(match[2]);
  if (line === 0) return null;
  return { path, ...(line === undefined ? {} : { line }), ...(match[3] === undefined ? {} : { column: Number(match[3]) }) };
}

/** A Windows absolute path: from a drive (`C:\`, `C:/`) or a network share (`\\server\share`). */
const WINDOWS_ABSOLUTE = /^(?:[a-z]:[\\/]|\\\\[^\\/])/i;

/**
 * The files steps worked on that a relative path may mean, the latest first: each step's `file`, and every file of a
 * change that touched several. An agent working in a subfolder names files relative to it (`casos/a.md` for
 * `C:\proj\.routines\r\casos\a.md`), which misses under the Chat's folder. Windows paths match with either slash and in
 * any case, as Windows does. Absolute and parent-relative paths have none.
 */
export function touchedFileMatches(relative, steps) {
  const tail = relative.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
  if (!tail || tail.startsWith("/") || WINDOWS_ABSOLUTE.test(tail) || tail.split("/").includes("..")) return [];
  const touched = [];
  for (const { file, files } of steps) touched.push(...(Array.isArray(files) ? files : []), ...(file ? [file] : []));
  const matches = [];
  for (let index = touched.length - 1; index >= 0; index--) {
    const candidate = touched[index];
    if (typeof candidate !== "string" || matches.includes(candidate)) continue;
    const windows = WINDOWS_ABSOLUTE.test(candidate);
    if (!windows && !candidate.startsWith("/")) continue;
    const found = windows ? candidate.replace(/\\/g, "/").toLowerCase().endsWith(`/${tail.toLowerCase()}`) : candidate.endsWith(`/${tail}`);
    if (found) matches.push(candidate);
  }
  return matches;
}
