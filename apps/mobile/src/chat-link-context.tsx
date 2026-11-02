import { createContext, type ReactNode } from "react";
import { ReachableHostContext, type ReachableHost } from "./reachable-host";
import { MessageAskContext } from "./message-actions";

/** Opens a link associated with the containing Chat. False keeps the usual external link behavior. */
export const ChatLinkContext = createContext<((url: string) => boolean) | null>(null);

/** The containing Chat supplies its computer's reachable address, its internal link destinations and Ask for selected text. */
export function ChatLinkProvider({
  reachable,
  openLink,
  ask,
  children,
}: {
  reachable: ReachableHost;
  openLink: (url: string) => boolean;
  ask?: (passage: string) => void;
  children: ReactNode;
}) {
  return (
    <ChatLinkContext value={openLink}>
      <ReachableHostContext value={reachable}>
        <MessageAskContext value={ask ?? null}>{children}</MessageAskContext>
      </ReachableHostContext>
    </ChatLinkContext>
  );
}
