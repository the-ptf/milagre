import { associatedPullRequest } from "@milagre/shared/chats";
import type { ChatLinkActions } from "./chat-link-context";

export type ChatLinks = { open: (url: string) => boolean; actions: ChatLinkActions };

/**
 * Where a Chat's reply links go: a PR the Chat knows opens in Code review, then the Browser panel when the internal
 * browser is on. A tap takes the first that opens (false leaves the link to the system); a long press lists both.
 */
export function chatLinks<T extends { url: string }>(
  pullRequests: readonly T[],
  openPr: (pr: T) => boolean,
  browserPanel: { on: boolean; open: (url: string) => boolean },
): ChatLinks {
  const panel = browserPanel.on ? browserPanel.open : null;
  return {
    open: (url) => {
      const pr = associatedPullRequest(url, pullRequests);
      return (pr ? openPr(pr) : false) || (panel?.(url) ?? false);
    },
    actions: (url) => {
      const pr = associatedPullRequest(url, pullRequests);
      return { review: pr ? () => void openPr(pr) : null, panel: panel ? () => void panel(url) : null };
    },
  };
}
