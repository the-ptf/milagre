import React from "react";
import { Platform } from "react-native";
import { Host } from "@expo/ui";
import { Button as IOSButton, RNHostView } from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  buttonBorderShape,
  buttonStyle,
  labelStyle,
  tint,
  controlSize,
  disabled as nativeDisabled,
  foregroundStyle,
} from "@expo/ui/swift-ui/modifiers";
import { Icon, type IconData } from "../icons";
import { useTheme } from "../theme";
import { tap } from "./tap";
import { CircleButton } from "./circle-button";

/** Native Liquid Glass on iOS 26; SwiftUI supplies the fallback on older iOS. `prominent` is the primary: ink fill, onInk icon. */
export function GlassIconButton({
  label,
  systemImage,
  icon,
  iconSize,
  onPress,
  prominent = false,
  disabled = false,
}: {
  label: string;
  systemImage: React.ComponentProps<typeof IOSButton>["systemImage"];
  icon: IconData;
  /** Use the shared vector drawing at this size instead of the SF Symbol. */
  iconSize?: number;
  onPress: () => void;
  prominent?: boolean;
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  if (Platform.OS !== "ios") return <CircleButton label={label} icon={icon} iconSize={iconSize} onPress={onPress} filled={prominent} disabled={disabled} />;
  return (
    <Host ignoreSafeArea="all" matchContents>
      <IOSButton
        label={iconSize ? undefined : label}
        systemImage={iconSize ? undefined : systemImage}
        onPress={() => {
          tap();
          onPress();
        }}
        modifiers={[
          buttonStyle(prominent ? "glassProminent" : "glass"),
          controlSize("large"),
          labelStyle("iconOnly"),
          buttonBorderShape("circle"),
          tint(prominent ? colors.ink : { type: "hierarchical", style: "primary" }),
          ...(prominent ? [foregroundStyle(colors.onInk)] : []),
          nativeDisabled(disabled),
          accessibilityLabel(label),
        ]}
      >
        {iconSize ? (
          <RNHostView matchContents>
            <Icon icon={icon} size={iconSize} tone={prominent ? "onAccent" : "ink"} />
          </RNHostView>
        ) : undefined}
      </IOSButton>
    </Host>
  );
}
