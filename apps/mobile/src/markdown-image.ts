export function resolveMarkdownImage(source: string, basePath?: string): { url: string } | { path: string } | null {
  try {
    const text = source.trim();
    if (/^https?:/i.test(text)) {
      const url = new URL(text);
      return !url.username && !url.password ? { url: text } : null;
    }
    let file = text;
    if (/^file:/i.test(file)) {
      const url = new URL(file);
      if ((url.hostname && url.hostname !== "localhost") || url.search || url.hash) return null;
      file = url.pathname;
    } else if (/^[a-z][a-z\d+.-]*:/i.test(file) || file.startsWith("//")) return null;
    file = decodeURIComponent(file);
    if (!/\.(png|jpe?g|gif|webp|heic|heif)$/i.test(file) || /[\0\r\n]/.test(file)) return null;
    if (!file.startsWith("/")) {
      if (!basePath?.startsWith("/")) return null;
      file = `${basePath}/${file}`;
    }
    const parts: string[] = [];
    for (const part of file.split("/")) {
      if (part === "..") parts.pop();
      else if (part && part !== ".") parts.push(part);
    }
    return { path: "/" + parts.join("/") };
  } catch {
    return null;
  }
}
