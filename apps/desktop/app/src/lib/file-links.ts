import { titleSpans } from "./reply-parts.ts";

export interface FileLinkTarget {
  /** Relative to the chat's folder. */
  path: string;
  line?: number;
  column?: number;
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
 * absolute or parent-relative paths are not files. The renderer can't tell whether the file exists; main does.
 */
export function fileLinkTarget(code: string): FileLinkTarget | null {
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

/** Which of a step title's spans (see titleSpans) is its file, or -1. Only a read or edit with a known file has one. */
export function fileSpanIndex(title: string, file: string | undefined): number {
  if (!file || !/^(Read|Edited|Created|Wrote|Deleted) /.test(title)) return -1;
  return titleSpans(title).findIndex((span) => span.code);
}
