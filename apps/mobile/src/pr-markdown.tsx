import { memo, useMemo } from "react";
import { githubHtmlToMarkdown, isGitHubAttachment } from "@milagre/shared/github-markdown";
import type { Client } from "./client";
import { Markdown } from "./markdown";
import type { MediaValue } from "./viewer-store";

// Images dragged into a PR's description or comments live at github.com/user-attachments, which answers a private
// repository's only to a signed-in viewer: the Mac reads them with gh's token (pr:image). Kept while recent so
// reopening the PR or a refresh doesn't read them again; a read that failed is asked again next time.
const MAX_KEPT = 32;
const kept = new Map<string, Promise<{ uri: string }>>();

function attachmentReader(client: Client, cwd: string) {
  return (url: string): MediaValue | null => {
    if (!isGitHubAttachment(url)) return null;
    const key = `${cwd}\0${url}`;
    const hit = kept.get(key);
    if (hit) {
      kept.delete(key);
      kept.set(key, hit);
      return hit;
    }
    const read = client.call<{ ok: true; dataUrl: string } | { ok: false; message: string }>("pr:image", [{ cwd, url }]).then((result) => {
      if (!result.ok) throw new Error(result.message);
      return { uri: result.dataUrl };
    });
    read.catch(() => kept.get(key) === read && kept.delete(key));
    kept.set(key, read);
    for (const oldest of kept.keys()) {
      if (kept.size <= MAX_KEPT) break;
      kept.delete(oldest);
    }
    return read;
  };
}

/** A PR's description or comment: GitHub's image tags show as images, read through the Mac. */
export const PrMarkdown = memo(function PrMarkdown({ text, client, cwd }: { text: string; client: Client; cwd: string }) {
  const remote = useMemo(() => attachmentReader(client, cwd), [client, cwd]);
  return <Markdown text={useMemo(() => githubHtmlToMarkdown(text), [text])} remote={remote} />;
});
