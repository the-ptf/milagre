import { useContext, useMemo, useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, useWindowDimensions, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SvgXml } from "react-native-svg";
import { Cancel01Icon, Maximize01Icon } from "@hugeicons/core-free-icons";
import { render } from "pele";
import { diagramLabel, diagramTheme, nativeDiagramSvg } from "@milagre/shared/diagram";
import { MarkdownStreamingContext } from "./genui/GenerativeUI";
import { Icon } from "./icons";
import { useTheme, type Palette } from "./theme";
import { tap } from "./ui";
import { RoundButton } from "./viewer-chrome";

/** The diagram the full-screen page shows (app/diagram-sheet.tsx): set before it opens. */
let opened: { code: string; title: string } | null = null;

/** Pele's drawing of `code` at most `width` wide, coloured for React Native's SVG; null with the reason when it doesn't draw. */
function draw(code: string, width: number, colors: Palette) {
  try {
    const result = render(code, { maxWidth: width, fontSize: 14 });
    const theme = diagramTheme({ background: colors.surface, ink: colors.ink, muted: colors.ink3, line: colors.ink3, accent: colors.accent });
    return { svg: nativeDiagramSvg(result.svg, theme), width: result.width, height: result.height, type: result.type as string, error: "" };
  } catch (error) {
    return { svg: "", width: 0, height: 0, type: "", error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * A ```mermaid block in a reply, drawn by Pele as wide as the reply: narrower than a wide flowchart, it lays the chart
 * out top-down, and turning the phone lays it out again. The block being written stays code until its fence closes;
 * a diagram that doesn't draw shows its code with the reason. Expand opens it full screen, where it pinches.
 */
export function MermaidBlock({ code, plain }: { code: string; plain: ReactNode }) {
  const streaming = useContext(MarkdownStreamingContext);
  const { colors } = useTheme();
  const [width, setWidth] = useState(0);
  const drawn = useMemo(() => (streaming || !width ? null : draw(code, width - 28, colors)), [code, width, streaming, colors]);
  if (streaming) return <>{plain}</>;
  if (drawn?.error)
    return (
      <View style={{ gap: 6 }}>
        <Text style={{ color: colors.red, fontSize: 13 }}>{`The diagram didn’t draw: ${drawn.error}`}</Text>
        {plain}
      </View>
    );
  const label = diagramLabel(drawn?.type);
  const shown =
    drawn && drawn.width > 0 ? { width: Math.min(drawn.width, width - 28), height: (drawn.height * Math.min(drawn.width, width - 28)) / drawn.width } : null;
  return (
    <View
      onLayout={(event) => setWidth(Math.round(event.nativeEvent.layout.width))}
      style={{ borderRadius: 14, borderCurve: "continuous", borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, overflow: "hidden" }}
    >
      <View
        style={{ flexDirection: "row", alignItems: "center", paddingLeft: 14, paddingRight: 6, height: 40, borderBottomWidth: 1, borderColor: colors.line }}
      >
        <Text style={{ flex: 1, color: colors.ink3, fontSize: 13 }}>{label}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open the ${label.toLowerCase()} full screen`}
          hitSlop={6}
          disabled={!drawn}
          onPress={() => {
            tap();
            opened = { code, title: label };
            router.push("/diagram-sheet");
          }}
          style={({ pressed }) => ({ width: 32, height: 32, alignItems: "center", justifyContent: "center", opacity: pressed ? 0.5 : 1 })}
        >
          <Icon icon={Maximize01Icon} tone="ink3" size={16} />
        </Pressable>
      </View>
      <View accessible accessibilityRole="image" accessibilityLabel={label} style={{ padding: 14, alignItems: "center", minHeight: 80 }}>
        {drawn && shown ? <SvgXml xml={drawn.svg} width={shown.width} height={shown.height} /> : null}
      </View>
    </View>
  );
}

/** The diagram full screen: drawn as wide as the screen (turned sideways, a wide chart lies flat again), pinch to zoom. */
export function DiagramSheet() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const diagram = opened;
  const room = Math.max(240, width - insets.left - insets.right - 32);
  const drawn = useMemo(() => (diagram ? draw(diagram.code, room, colors) : null), [diagram, room, colors]);
  return (
    <View style={{ flex: 1, paddingTop: insets.top, backgroundColor: colors.surface }}>
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, height: 52, gap: 8 }}>
        <RoundButton label="Close diagram" icon={Cancel01Icon} onPress={() => router.back()} />
        <Text
          accessibilityRole="header"
          numberOfLines={1}
          style={{ flex: 1, textAlign: "center", color: colors.ink, fontSize: 14, fontWeight: "600", marginRight: 42 }}
        >
          {diagram?.title ?? "Diagram"}
        </Text>
      </View>
      {drawn && !drawn.error ? (
        <ScrollView
          maximumZoomScale={4}
          minimumZoomScale={1}
          bouncesZoom
          centerContent
          contentContainerStyle={{
            minHeight: height - insets.top - 52,
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
            paddingBottom: 16 + insets.bottom,
          }}
        >
          <SvgXml xml={drawn.svg} width={drawn.width} height={drawn.height} />
        </ScrollView>
      ) : (
        <Text style={{ color: colors.red, padding: 20 }}>{drawn?.error || "This diagram is no longer open."}</Text>
      )}
    </View>
  );
}
