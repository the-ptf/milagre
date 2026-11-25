import { useLocalSearchParams } from "expo-router";
import { BrowserSheet } from "../browser";
import { useSession } from "../session";
import { useNotePhoneTab } from "../workspace-tabs-store";

export default function BrowserScreen() {
  const { hostId, chatId, url } = useLocalSearchParams<{ hostId?: string; chatId?: string; url?: string }>();
  useNotePhoneTab(useSession(), hostId, chatId, "browser");
  return <BrowserSheet hostId={hostId} chatId={chatId} url={url} />;
}
