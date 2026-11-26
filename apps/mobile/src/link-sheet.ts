import { Alert, Linking, Platform, Share } from "react-native";
import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import { showActions } from "./primitives/show-actions";
import { linkSheetActions } from "./reply-link-actions";
import type { ChatLinkActions } from "./chat-link-context";

/** A long press on a web link in a reply: where to open it, or copy or share its address. */
export function showWebLinkSheet({ text, url, written, actions }: { text: string; url: string; written: string; actions: ChatLinkActions | null | undefined }) {
  const open = actions?.(written) ?? { review: null, panel: null };
  showActions({
    title: text,
    message: text === url ? undefined : url,
    actions: linkSheetActions({ kind: "web", review: Boolean(open.review), panel: Boolean(open.panel) }, Platform.OS),
    onSelect: (id) => {
      if (id === "review") open.review?.();
      else if (id === "panel") open.panel?.();
      else if (id === "browser") void Linking.openURL(url).catch(() => Alert.alert("Cannot open link", "Try opening this address in your browser."));
      else if (id === "copy-link") void Clipboard.setStringAsync(url);
      else if (id === "share") void Share.share(Platform.OS === "ios" ? { url } : { message: url }).catch(() => {});
    },
  });
}

/** A long press on a file link in a reply: preview it or copy its path. */
export function showFileLinkSheet({ text, path }: { text: string; path: string }) {
  showActions({
    title: text,
    message: text === path ? undefined : path,
    actions: linkSheetActions({ kind: "file" }, Platform.OS),
    onSelect: (id) => {
      if (id === "preview") router.push({ pathname: "/file-preview", params: { path } });
      else if (id === "copy-path") void Clipboard.setStringAsync(path);
    },
  });
}
