import type { ColorValue } from "react-native";
import { Checkbox } from "./checkbox";

/** An independent on/off preference, displayed as a labeled checkbox. */
export function Toggle({
  title,
  selected,
  onPress,
  disabled = false,
  tint,
}: {
  title: string;
  selected: boolean;
  onPress: () => void;
  disabled?: boolean;
  tint?: ColorValue;
}) {
  return <Checkbox label={title} selected={selected} onPress={onPress} disabled={disabled} tint={tint} />;
}
