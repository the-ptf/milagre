import { useLocalSearchParams } from "expo-router";
import { BrowserSheet } from "../browser";

export default function BrowserScreen() {
  const { hostId, chatId, url } = useLocalSearchParams<{ hostId?: string; chatId?: string; url?: string }>();
  return <BrowserSheet hostId={hostId} chatId={chatId} url={url} />;
}
