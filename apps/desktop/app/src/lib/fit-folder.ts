/**
 * A folder path shortened by whole segments from the middle, to the longest form that `fits`: the whole path, then
 * the first two segments, "…" and as many of the last segments as fit ("apps/desktop/…/src/lib", "apps/desktop/…/lib").
 * Words are never cut, and the first two segments (which part of the repo) and the last (the file's own folder) stay.
 * Null when not even the shortest form fits; the caller cuts that one at its end.
 */
export function fitFolder(path: string, fits: (text: string) => boolean): string | null {
  if (fits(path)) return path;
  const parts = path.split("/");
  if (parts.length < 4) return null;
  const head = parts.slice(0, 2).join("/");
  const middle = parts.slice(2, -1);
  const last = parts.at(-1)!;
  // Keep the middle segments nearest the file longest: they say more about it than the ones under the top two.
  for (let keep = middle.length - 1; keep >= 0; keep--) {
    const text = [head, "…", ...middle.slice(middle.length - keep), last].join("/");
    if (fits(text)) return text;
  }
  return null;
}

/** The shortest form fitFolder tries, for a cell too narrow for any of them. */
export function shortestFolder(path: string) {
  const parts = path.split("/");
  return parts.length < 4 ? path : [...parts.slice(0, 2), "…", parts.at(-1)].join("/");
}
