import { Platform, Pressable, Text, View } from "react-native";
import { Host } from "@expo/ui";
import { Picker as IOSPicker, Text as IOSText } from "@expo/ui/swift-ui";
import { accessibilityLabel, pickerStyle, tag } from "@expo/ui/swift-ui/modifiers";
import { Findable } from "../settings-find";
import { lineHeight, radius, space, type } from "../design-tokens";
import { useTheme } from "../theme";
import { pressStyle } from "./press-style";
import { tap } from "./tap";

/**
 * A segmented control: the native SwiftUI segmented Picker on iOS. Android has no theme-following equivalent (Material's
 * dropdown read as a text field), so there the same track and raised segment are drawn from the theme.
 */
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
  if (Platform.OS !== "ios")
    return (
      <Findable title={label}>
        <AndroidSegmented label={label} value={value} options={options} onChange={onChange} />
      </Findable>
    );
  return (
    <Findable title={label}>
      <Host ignoreSafeArea="all" matchContents={{ vertical: true }} style={{ minHeight: 32, width: "100%" }}>
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
      </Host>
    </Findable>
  );
}

function AndroidSegmented({
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
  const { colors } = useTheme();
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      testID={`segmented-${label}`}
      style={{ flexDirection: "row", padding: space.xxs, gap: space.xxs, borderRadius: radius.control, backgroundColor: colors.hover }}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityState={{ selected, checked: selected }}
            accessibilityLabel={option.title}
            onPress={() => {
              if (selected) return;
              tap();
              onChange(option.value);
            }}
            style={({ pressed }) => [
              {
                flex: 1,
                minHeight: 32,
                alignItems: "center",
                justifyContent: "center",
                paddingHorizontal: space.md,
                borderRadius: radius.control,
              },
              selected && { backgroundColor: colors.surface, boxShadow: colors.shadowCard },
              pressStyle({ pressed: pressed && !selected }),
            ]}
          >
            <Text
              numberOfLines={1}
              style={{
                color: selected ? colors.ink : colors.ink2,
                fontSize: type.subheadline,
                lineHeight: lineHeight.subheadline,
                fontWeight: selected ? "600" : "500",
              }}
            >
              {option.title}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
