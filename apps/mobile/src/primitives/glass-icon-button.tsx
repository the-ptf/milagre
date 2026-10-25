import React from "react";
import { Platform } from "react-native";
import { Host } from "@expo/ui";
import { Button as IOSButton } from "@expo/ui/swift-ui";
import { accessibilityLabel, buttonBorderShape, buttonStyle, labelStyle, tint, controlSize } from "@expo/ui/swift-ui/modifiers";
import { type IconData } from "../icons";
import { useTheme } from "../theme";
import { tap } from "./tap";
import { CircleButton } from "./circle-button";

/** Native Liquid Glass on iOS 26; SwiftUI supplies the fallback on older iOS. `prominent` fills it with the accent. */
export function GlassIconButton({
  label,
  systemImage,
  icon,
  onPress,
  prominent = false,
}: {
  label: string;
  systemImage: React.ComponentProps<typeof IOSButton>["systemImage"];
  icon: IconData;
  onPress: () => void;
  prominent?: boolean;
}) {
  const { colors } = useTheme();
  if (Platform.OS !== "ios") return <CircleButton label={label} icon={icon} onPress={onPress} filled={prominent} />;
  return (
    <Host ignoreSafeArea="all" matchContents>
      <IOSButton
        label={label}
        systemImage={systemImage}
        onPress={() => {
          tap();
          onPress();
        }}
        modifiers={[
          buttonStyle(prominent ? "glassProminent" : "glass"),
          controlSize("large"),
          labelStyle("iconOnly"),
          buttonBorderShape("circle"),
          tint(prominent ? colors.accent : { type: "hierarchical", style: "primary" }),
          accessibilityLabel(label),
        ]}
      />
    </Host>
  );
}
