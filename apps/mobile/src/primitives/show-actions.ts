import { Keyboard } from "react-native";
import { confirmSheet } from "../confirm-store";
import { tap } from "./tap";

/** A row's actions or a short list of choices, in the confirmation bottom sheet with Cancel last. */
export function showActions({
  title,
  actions,
  onSelect,
}: {
  title?: string;
  actions: { id: string; title: string; destructive?: boolean; disabled?: boolean }[];
  onSelect: (id: string) => void;
}) {
  const enabled = actions.filter((action) => !action.disabled);
  if (!enabled.length) return;
  Keyboard.dismiss();
  confirmSheet(title || "", undefined, [
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
