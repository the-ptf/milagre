import { Button as IOSButton, Label as IOSLabel, Picker as IOSPicker, Section as IOSSection, Toggle as IOSToggle } from "@expo/ui/swift-ui";
import { disabled as nativeDisabled, pickerStyle, tag } from "@expo/ui/swift-ui/modifiers";
import { NativePickerIcon } from "../native-picker-icon";
import type { MenuSection } from "./menu";

/** Custom native choice labels need a Picker so UIKit retains its selected checkmark. */
export function NativeMenuSection({ section, onSelect }: { section: MenuSection; onSelect: (id: string) => void }) {
  const customChoices = section.items.length > 0 && section.items.every((item) => item.icon && item.checked !== undefined);
  if (customChoices)
    return (
      <IOSPicker label="" selection={section.items.find((item) => item.checked)?.id} onSelectionChange={onSelect} modifiers={[pickerStyle("inline")]}>
        <IOSSection title={section.title}>
          {section.items.map((item) => (
            <IOSLabel
              key={item.id}
              title={item.title}
              icon={<NativePickerIcon name={item.icon!} />}
              modifiers={[tag(item.id), nativeDisabled(!!item.disabled)]}
            />
          ))}
        </IOSSection>
      </IOSPicker>
    );
  return (
    <IOSSection title={section.title}>
      {section.items.map((item) =>
        item.checked !== undefined ? (
          <IOSToggle
            key={item.id}
            label={item.title}
            systemImage={item.systemImage as never}
            isOn={item.checked}
            onIsOnChange={() => onSelect(item.id)}
            modifiers={[nativeDisabled(!!item.disabled)]}
          />
        ) : (
          <IOSButton
            key={item.id}
            label={item.title}
            systemImage={item.systemImage as never}
            role={item.destructive ? "destructive" : undefined}
            onPress={() => onSelect(item.id)}
            modifiers={[nativeDisabled(!!item.disabled)]}
          />
        ),
      )}
    </IOSSection>
  );
}
