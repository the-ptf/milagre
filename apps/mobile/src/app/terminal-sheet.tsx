import { useLocalSearchParams } from "expo-router";
import { TerminalSheet, type TerminalPlace } from "../terminal";

function parsePlaces(value: string | undefined): TerminalPlace[] | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return undefined;
    return parsed.filter((place): place is TerminalPlace => typeof place?.path === "string" && typeof place?.label === "string");
  } catch {
    return undefined;
  }
}

export default function TerminalScreen() {
  const { hostId, chatId, places } = useLocalSearchParams<{ hostId?: string; chatId?: string; places?: string }>();
  return <TerminalSheet key={`${hostId}:${chatId}`} hostId={hostId} chatId={chatId} places={parsePlaces(places)} />;
}
