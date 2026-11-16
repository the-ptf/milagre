export function fitFolder(path: string, fits: (text: string) => boolean): string | null {
  if (fits(path)) return path;
  const parts = path.split("/");
  if (parts.length < 4) return null;
  const head = parts.slice(0, 2).join("/");
  const middle = parts.slice(2, -1);
  const last = parts.at(-1)!;
  for (let keep = middle.length - 1; keep >= 0; keep--) {
    const text = [head, "…", ...middle.slice(middle.length - keep), last].join("/");
    if (fits(text)) return text;
  }
  return null;
}

export function shortestFolder(path: string) {
  const parts = path.split("/");
  return parts.length < 4 ? path : [...parts.slice(0, 2), "…", parts.at(-1)].join("/");
}
