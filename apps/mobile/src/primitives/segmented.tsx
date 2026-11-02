import { Platform } from "react-native";
import { Host, Picker } from "@expo/ui";
import { Picker as IOSPicker, Text as IOSText } from "@expo/ui/swift-ui";
import { accessibilityLabel, pickerStyle, tag } from "@expo/ui/swift-ui/modifiers";
import { Findable } from "../settings-find";

/** iOS segmented control (a native SwiftUI Picker); Android falls back to the dropdown Picker. */
export function Segmented({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; title: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <Findable title={label}>
      <Host ignoreSafeArea="all" matchContents={{ vertical: true }} style={{ minHeight: 32, width: "100%" }}>
        {Platform.OS === "ios" ? (
          <IOSPicker
            label={label}
            selection={value}
            onSelectionChange={onChange}
            modifiers={[pickerStyle("segmented"), accessibilityLabel(label)]}
            testID={`segmented-${label}`}
          >
            {options.map((option) => (
              <IOSText key={option.value} modifiers={[tag(option.value)]}>
                {option.title}
              </IOSText>
            ))}
          </IOSPicker>
        ) : (
          <Picker selectedValue={value} onValueChange={onChange} testID={`segmented-${label}`}>
            {options.map((option) => (
              <Picker.Item key={option.value} value={option.value} label={option.title} />
            ))}
          </Picker>
        )}
      </Host>
    </Findable>
  );
}
