// What GitHub writes into a PR description or comment beyond Markdown: a drag-dropped image becomes an <img> tag at
// github.com/user-attachments, which a private repository serves only to a signed-in viewer.

const ATTACHMENT = /^https:\/\/github\.com\/(?:user-attachments\/assets|[\w.-]+\/[\w.-]+\/assets\/\d+)\/[0-9a-f-]{36}$/;

/** An image GitHub stores for a PR's text; the PR's computer reads it with gh's token (pr:image). */
export function isGitHubAttachment(url: string): boolean {
  return ATTACHMENT.test(url);
}

const attribute = (tag: string, name: string) =>
  new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i")
    .exec(tag)
    ?.slice(1)
    .find((value) => value !== undefined);
// Layout tags GitHub's renderer drops or that only wrap text; their text stays.
const WRAPPERS = /<\/?(?:p|div|span|center|details|summary|picture|sub|sup|b|i|em|strong)\b[^>]*>/gi;

function convert(text: string) {
  return text
    .replace(/<img\b[^>]*>/gi, (tag) => {
      const src = attribute(tag, "src");
      if (!src) return "";
      const alt = (attribute(tag, "alt") || "Image").replace(/[[\]\\]/g, "");
      return `![${alt}](<${src.replace(/[<>\s]/g, "")}>)`;
    })
    .replace(/<br\s*\/?>/gi, " ")
    .replace(WRAPPERS, "");
}

/**
 * GitHub's HTML in a PR's text as the Markdown a renderer without HTML shows: images become Markdown images and
 * wrapper tags go, outside code. Code spans and fences keep their text as written.
 */
export function githubHtmlToMarkdown(text: string): string {
  if (!text.includes("<")) return text;
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      out.push(line);
    } else if (marker) {
      fence = marker;
      out.push(line);
    } else
      out.push(
        line
          .split(/(`+[^`]*`+)/)
          .map((part, index) => (index % 2 ? part : convert(part)))
          .join(""),
      );
  }
  return out.join("\n");
}
