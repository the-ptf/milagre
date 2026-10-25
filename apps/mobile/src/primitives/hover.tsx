import { useState } from "react";
import { View, type PointerEvent, type StyleProp, type ViewProps, type ViewStyle } from "react-native";

/** Pointer events also come from touches (pointerType "touch"); only a trackpad, mouse or pencil hovers. */
export const hovers = (event: { nativeEvent: { pointerType?: string } }) => event.nativeEvent.pointerType !== "touch";

/** Whether an iPad pointer (trackpad, mouse or pencil) is over a view. A finger never hovers, so phones never see it. */
export function useHover() {
  const [hovered, setHovered] = useState(false);
  return {
    hovered,
    onPointerEnter: (event: PointerEvent) => {
      if (hovers(event)) setHovered(true);
    },
    onPointerLeave: () => setHovered(false),
  };
}

/** A view that takes `hoverStyle` while the pointer is over it, as desktop rows highlight under the mouse. */
export function HoverView({ style, hoverStyle, ...props }: ViewProps & { hoverStyle?: StyleProp<ViewStyle> }) {
  const { hovered, ...pointer } = useHover();
  return <View {...props} {...pointer} style={[style, hovered && hoverStyle]} />;
}
