import { createContext, useCallback, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { ReachableHostContext, type ReachableHost } from "./reachable-host";
import { MessageAskContext, type QuoteFrom } from "./message-actions";

export { chatLinks } from "./reply-links";

/** Opens a link associated with the containing Chat. False keeps the usual external link behavior. */
export const ChatLinkContext = createContext<((url: string) => boolean) | null>(null);

/** Where a reply link can open besides the browser: Code review for a PR the Chat knows, the Browser panel when it is on. */
export type ChatLinkActions = (url: string) => { review: (() => void) | null; panel: (() => void) | null };
export const ChatLinkActionsContext = createContext<ChatLinkActions | null>(null);

type StepFiles = { file?: string; files?: readonly string[] };
const NO_STEPS: readonly StepFiles[] = [];

/**
 * The containing Chat's steps, read when a file named in a reply is tapped (see touchedFileMatches). A ref: a value that
 * changed with each streamed step would re-render every reply.
 */
export const ChatFilesContext = createContext<{ readonly current: readonly StepFiles[] }>({ current: NO_STEPS });

/**
 * The containing Chat supplies its computer's reachable address, its internal link destinations, Quote for selected text
 * and the steps whose files its replies may name relative to a subfolder. `links` and `ask` reach the contexts through
 * wrappers made once, which call the latest functions: a Chat that hands over a new function on each render must not
 * re-render every reply's markdown (a streamed batch renders the Chat).
 */
export function ChatLinkProvider({
  reachable,
  links,
  ask,
  steps,
  liveSteps,
  children,
}: {
  reachable: ReachableHost;
  links: { open: (url: string) => boolean; actions?: ChatLinkActions };
  ask?: (passage: string, from: QuoteFrom) => void;
  steps?: readonly StepFiles[];
  /** The streaming turn's steps, after `steps`: kept by the live reply itself, so its batches never render the Chat. */
  liveSteps?: { readonly current: readonly StepFiles[] | undefined };
  children: ReactNode;
}) {
  const latest = useRef(steps ?? NO_STEPS);
  const live = useRef(liveSteps);
  const linksRef = useRef(links);
  const askRef = useRef(ask);
  // Before any effect or tap handler of the children can run, as the steps ref.
  useLayoutEffect(() => {
    latest.current = steps ?? NO_STEPS;
    live.current = liveSteps;
    linksRef.current = links;
    askRef.current = ask;
  });
  // Read when a file is tapped, never while rendering: the saved steps, then the streaming turn's.
  const files = useMemo(
    () => ({
      get current() {
        const streaming = live.current?.current;
        return streaming?.length ? [...latest.current, ...streaming] : latest.current;
      },
    }),
    [],
  );
  const stableOpen = useCallback((url: string) => linksRef.current.open(url), []);
  const hasActions = Boolean(links.actions);
  const stableActions = useMemo(() => (hasActions ? (url: string) => linksRef.current.actions?.(url) ?? { review: null, panel: null } : null), [hasActions]);
  // Only whether Quote is offered at all changes the value.
  const hasAsk = Boolean(ask);
  const stableAsk = useMemo(() => (hasAsk ? (passage: string, from: QuoteFrom) => askRef.current?.(passage, from) : null), [hasAsk]);
  return (
    <ChatLinkContext value={stableOpen}>
      <ChatLinkActionsContext value={stableActions}>
        <ReachableHostContext value={reachable}>
          <MessageAskContext value={stableAsk}>
            <ChatFilesContext value={files}>{children}</ChatFilesContext>
          </MessageAskContext>
        </ReachableHostContext>
      </ChatLinkActionsContext>
    </ChatLinkContext>
  );
}
