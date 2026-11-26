import { Keyboard } from "react-native";
import { confirmSheet } from "../confirm-store";
import { tap } from "./tap";

export function showActions({
  title,
  message,
  actions,
  onSelect,
}: {
  title?: string;
  message?: string;
  actions: { id: string; title: string; destructive?: boolean; disabled?: boolean }[];
  onSelect: (id: string) => void;
}) {
  const enabled = actions.filter((action) => !action.disabled);
  if (!enabled.length) return;
  Keyboard.dismiss();
  confirmSheet(title || "", message, [
    ...enabled.map((action) => ({
      text: action.title,
      style: action.destructive ? ("destructive" as const) : ("default" as const),
      onPress: () => {
        tap();
        onSelect(action.id);
      },
    })),
    { text: "Cancel", style: "cancel" as const },
  ]);
}
