import { Checkbox } from "./checkbox";

export function RowCheckbox({ selected, onPress, disabled = false, label }: { selected: boolean; onPress: () => void; disabled?: boolean; label: string }) {
  return <Checkbox label={label} selected={selected} onPress={onPress} disabled={disabled} showLabel={false} />;
}
