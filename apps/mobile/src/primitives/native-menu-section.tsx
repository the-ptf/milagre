import { Button as IOSButton, Label as IOSLabel, Menu as IOSMenu, Picker as IOSPicker, Section as IOSSection, Toggle as IOSToggle } from "@expo/ui/swift-ui";
import { disabled as nativeDisabled, pickerStyle, tag } from "@expo/ui/swift-ui/modifiers";
import { NativePickerIcon } from "../native-picker-icon";
import type { MenuSection } from "./menu";

// A native menu row has one label: the subtitle takes its second line, as the Android menu does (pull-down.tsx).
const rowLabel = (item: MenuSection["items"][number]) => (item.subtitle ? `${item.title}\n${item.subtitle}` : item.title);

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
        item.submenu ? (
          // A nested Menu is SwiftUI's submenu: the item opens its own list of choices.
          <IOSMenu key={item.id} label={item.title} systemImage={item.systemImage as never} modifiers={[nativeDisabled(!!item.disabled)]}>
            {item.submenu.map((choice) => (
              <IOSButton
                key={choice.id}
                label={rowLabel(choice)}
                systemImage={choice.systemImage as never}
                role={choice.destructive ? "destructive" : undefined}
                onPress={() => onSelect(choice.id)}
                modifiers={[nativeDisabled(!!choice.disabled)]}
              />
            ))}
          </IOSMenu>
        ) : item.checked !== undefined ? (
          <IOSToggle
            key={item.id}
            label={rowLabel(item)}
            systemImage={item.systemImage as never}
            isOn={item.checked}
            onIsOnChange={() => onSelect(item.id)}
            modifiers={[nativeDisabled(!!item.disabled)]}
          />
        ) : (
          <IOSButton
            key={item.id}
            label={rowLabel(item)}
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
