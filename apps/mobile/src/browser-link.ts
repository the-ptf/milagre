import { router } from "expo-router";
import type { ChatTab } from "./panel-tabs";

let requestId = 0;

/** Web links belong to the Chat's computer, including localhost servers. */
export function openBrowserLink(hostId: string, chatId: string, url: string, openTab?: ((tab: ChatTab) => void) | null): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  if (openTab) openTab({ kind: "browser", target: { hostId, chatId, url, requestId: ++requestId } });
  else router.push({ pathname: "/browser-sheet", params: { hostId, chatId, url } });
  return true;
}
