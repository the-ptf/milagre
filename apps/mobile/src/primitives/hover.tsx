import { useState } from "react";
import { View, type StyleProp, type ViewProps, type ViewStyle } from "react-native";

/** Whether an iPad pointer (trackpad or mouse) is over a view. Touch never hovers, so phones never see it. */
export function useHover() {
  const [hovered, setHovered] = useState(false);
  return { hovered, onPointerEnter: () => setHovered(true), onPointerLeave: () => setHovered(false) };
}

/** A view that takes `hoverStyle` while the pointer is over it, as desktop rows highlight under the mouse. */
export function HoverView({ style, hoverStyle, ...props }: ViewProps & { hoverStyle?: StyleProp<ViewStyle> }) {
  const { hovered, ...pointer } = useHover();
  return <View {...props} {...pointer} style={[style, hovered && hoverStyle]} />;
}
