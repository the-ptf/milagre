import { Checkbox } from "./checkbox";

/** A trailing checkbox for a row that already supplies its visible label. */
export function RowCheckbox({ selected, onPress, disabled = false, label }: { selected: boolean; onPress: () => void; disabled?: boolean; label: string }) {
  return <Checkbox label={label} selected={selected} onPress={onPress} disabled={disabled} showLabel={false} />;
}
