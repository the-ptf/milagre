import type { ColorValue } from "react-native";
import { Checkbox } from "./checkbox";
import { Findable } from "../settings-find";

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
  return (
    <Findable title={title}>
      <Checkbox label={title} selected={selected} onPress={onPress} disabled={disabled} tint={tint} />
    </Findable>
  );
}
