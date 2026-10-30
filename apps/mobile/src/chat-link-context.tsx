import { createContext, type ReactNode } from "react";
import { ReachableHostContext, type ReachableHost } from "./reachable-host";

/** Opens a link associated with the containing Chat. False keeps the usual external link behavior. */
export const ChatLinkContext = createContext<((url: string) => boolean) | null>(null);

/** The containing Chat supplies both its computer's reachable address and its internal link destinations. */
export function ChatLinkProvider({ reachable, openLink, children }: { reachable: ReachableHost; openLink: (url: string) => boolean; children: ReactNode }) {
  return (
    <ChatLinkContext value={openLink}>
      <ReachableHostContext value={reachable}>{children}</ReachableHostContext>
    </ChatLinkContext>
  );
}
