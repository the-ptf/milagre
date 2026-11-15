import { createContext, useCallback, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { ReachableHostContext, type ReachableHost } from "./reachable-host";
import { MessageAskContext, type QuoteFrom } from "./message-actions";

/** Opens a link associated with the containing Chat. False keeps the usual external link behavior. */
export const ChatLinkContext = createContext<((url: string) => boolean) | null>(null);

type StepFiles = { file?: string; files?: readonly string[] };
const NO_STEPS: readonly StepFiles[] = [];

/**
 * The containing Chat's steps, read when a file named in a reply is tapped (see touchedFileMatches). A ref: a value that
 * changed with each streamed step would re-render every reply.
 */
export const ChatFilesContext = createContext<{ readonly current: readonly StepFiles[] }>({ current: NO_STEPS });

/**
 * The containing Chat supplies its computer's reachable address, its internal link destinations, Quote for selected text
 * and the steps whose files its replies may name relative to a subfolder. `openLink` and `ask` reach the contexts through
 * wrappers made once, which call the latest functions: a Chat that hands over a new function on each render must not
 * re-render every reply's markdown (a streamed batch renders the Chat).
 */
export function ChatLinkProvider({
  reachable,
  openLink,
  ask,
  steps,
  children,
}: {
  reachable: ReachableHost;
  openLink: (url: string) => boolean;
  ask?: (passage: string, from: QuoteFrom) => void;
  steps?: readonly StepFiles[];
  children: ReactNode;
}) {
  const latest = useRef(steps ?? NO_STEPS);
  const openRef = useRef(openLink);
  const askRef = useRef(ask);
  // Before any effect or tap handler of the children can run, as the steps ref.
  useLayoutEffect(() => {
    latest.current = steps ?? NO_STEPS;
    openRef.current = openLink;
    askRef.current = ask;
  });
  const stableOpen = useCallback((url: string) => openRef.current(url), []);
  // Only whether Quote is offered at all changes the value.
  const hasAsk = Boolean(ask);
  const stableAsk = useMemo(() => (hasAsk ? (passage: string, from: QuoteFrom) => askRef.current?.(passage, from) : null), [hasAsk]);
  return (
    <ChatLinkContext value={stableOpen}>
      <ReachableHostContext value={reachable}>
        <MessageAskContext value={stableAsk}>
          <ChatFilesContext value={latest}>{children}</ChatFilesContext>
        </MessageAskContext>
      </ReachableHostContext>
    </ChatLinkContext>
  );
}
