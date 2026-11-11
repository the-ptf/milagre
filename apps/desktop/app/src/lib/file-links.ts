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

const WINDOWS_PATH = /^[a-z]:[\\/]/i;

/**
 * The files a Chat's steps worked on (absolute, as the tools named them) that a relative path may mean, the latest first.
 * An agent working in a subfolder names files relative to it: `casos/a.md` for `C:\proj\.routines\r\casos\a.md`, which
 * misses under the Chat's folder. A Windows path matches with either slash and in any case, as Windows does.
 */
export function touchedFileMatches(relative: string, files: readonly string[]): string[] {
  const tail = relative.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
  if (!tail || tail.startsWith("/") || WINDOWS_PATH.test(tail) || tail.split("/").includes("..")) return [];
  const matches: string[] = [];
  for (let index = files.length - 1; index >= 0; index--) {
    const file = files[index]!;
    const windows = WINDOWS_PATH.test(file);
    if (!windows && !file.startsWith("/")) continue;
    const found = windows ? file.replace(/\\/g, "/").toLowerCase().endsWith(`/${tail.toLowerCase()}`) : file.endsWith(`/${tail}`);
    if (found && !matches.includes(file)) matches.push(file);
  }
  return matches;
}

type OpenResult = { ok: true } | { ok: false; error: { message: string } };

/**
 * Opens `path`, then each of `fallbacks` while opening fails. Resolves to null once one opens, or to the first failure's
 * message, the one about the path the reply named.
 */
export async function openFirstFound(open: (path: string) => Promise<OpenResult>, path: string, fallbacks: readonly string[]): Promise<string | null> {
  const first = await open(path);
  if (first.ok) return null;
  for (const fallback of fallbacks) if ((await open(fallback)).ok) return null;
  return first.error.message;
}
