import MarkdownIt from "markdown-it";
import { closeOpenMarkdown } from "@milagre/shared/streaming-markdown";
import { isMarkdownFence } from "@milagre/shared/markdown-fence";

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true });
markdown.linkify.set({ fuzzyLink: true });
const validateLink = markdown.validateLink.bind(markdown);
markdown.validateLink = (url) => /^file:/i.test(url) || validateLink(url);
export function markdownTokens(text: string, streaming = false): ReturnType<typeof markdown.parse> {
  return markdown
    .parse(streaming ? closeOpenMarkdown(text) : text, {})
    .flatMap((token) => (token.type === "fence" && isMarkdownFence(token.info) ? markdownTokens(token.content, streaming) : [token]));
}
export function textCache<T>(compute: (text: string) => T, { entries, chars, maxText }: { entries: number; chars: number; maxText: number }) {
  const values = new Map<string, T>();
  let total = 0;
  return (text: string): T => {
    if (values.has(text)) {
      const hit = values.get(text) as T;
      values.delete(text);
      values.set(text, hit);
      return hit;
    }
    const value = compute(text);
    if (text.length > maxText) return value;
    values.set(text, value);
    total += text.length;
    for (const key of values.keys()) {
      if (values.size <= entries && total <= chars) break;
      values.delete(key);
      total -= key.length;
    }
    return value;
  };
}
export const cachedMarkdownTokens = textCache((text) => markdownTokens(text), { entries: 500, chars: 2_000_000, maxText: 200_000 });
export function markdownChunks(text: string): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let fence = "";
  let blank = false;
  for (const line of text.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (!fence && blank && current.length && /^\S/.test(line)) {
      chunks.push(current.join("\n"));
      current = [];
    }
    current.push(line);
    if (marker && !fence) fence = marker.charAt(0);
    else if (marker && marker[0] === fence) fence = "";
    blank = !fence && line.trim() === "";
  }
  if (current.length) chunks.push(current.join("\n"));
  return chunks;
}
export function safeLink(href: string): string | null {
  try {
    return ["https:", "http:", "mailto:"].includes(new URL(href).protocol) ? href : null;
  } catch {
    return null;
  }
}
