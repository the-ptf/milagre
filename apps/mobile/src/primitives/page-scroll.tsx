import React from "react";
import RNCMaskedView from "@react-native-masked-view/masked-view";
import { LinearGradient } from "expo-linear-gradient";
import { Platform, ScrollView, type ScrollViewInstance, type ScrollViewProps, type ViewProps } from "react-native";
import { useStyles } from "./styles";

// The library still extends NativeMethods, which RN 0.88 removed; its native view props are unchanged.
const MaskedView = RNCMaskedView as unknown as React.ComponentType<ViewProps & { maskElement: React.ReactElement }>;

// Native scrolling and choice controls have one shared entry point.
export const PageScroll = React.forwardRef<ScrollViewInstance, ScrollViewProps & { fadeEdges?: boolean }>(function PageScroll(
  { children, contentContainerStyle, fadeEdges = false, style, onLayout, onContentSizeChange, onScroll, ...props },
  ref,
) {
  const styles = useStyles();
  const metrics = React.useRef({ offset: props.contentOffset?.y ?? 0, height: 0, content: 0 });
  const current = React.useRef({ top: false, bottom: false, height: 0 });
  const [edges, setEdges] = React.useState({ top: false, bottom: false, height: 0 });
  const fading = fadeEdges && !props.horizontal;
  const update = () => {
    const { offset, height, content } = metrics.current;
    const next = { top: content > height && offset > 1, bottom: height > 0 && offset + height < content - 1, height };
    // Scrolling only renders when an edge is crossed, never for every scroll frame.
    if (next.top === current.current.top && next.bottom === current.current.bottom && next.height === current.current.height) return;
    current.current = next;
    setEdges(next);
  };
  const scroll = (
    <ScrollView
      ref={ref}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
      contentContainerStyle={[styles.content, contentContainerStyle]}
      style={fading ? { flex: 1 } : style}
      scrollEventThrottle={fading ? 16 : undefined}
      onLayout={
        fading
          ? (event) => {
              metrics.current.height = event.nativeEvent.layout.height;
              update();
              onLayout?.(event);
            }
          : onLayout
      }
      onContentSizeChange={
        fading
          ? (width, height) => {
              metrics.current.content = height;
              update();
              onContentSizeChange?.(width, height);
            }
          : onContentSizeChange
      }
      onScroll={
        fading
          ? (event) => {
              metrics.current.offset = event.nativeEvent.contentOffset.y;
              update();
              onScroll?.(event);
            }
          : onScroll
      }
      {...props}
    >
      {children}
    </ScrollView>
  );
  if (!fading) return scroll;
  const edge = Math.min(28 / (edges.height || 1), 0.5);
  return (
    <MaskedView
      style={[style, { overflow: "hidden" }]}
      maskElement={
        <LinearGradient
          colors={[edges.top ? "transparent" : "black", "black", "black", edges.bottom ? "transparent" : "black"]}
          locations={[0, edge, 1 - edge, 1]}
          style={{ flex: 1 }}
        />
      }
    >
      {scroll}
    </MaskedView>
  );
});
