import { useContext, useMemo, useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, useWindowDimensions, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SvgXml } from "react-native-svg";
import { ArrowExpand01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { render } from "pele";
import { diagramLabel, diagramTheme, nativeDiagramSvg } from "@milagre/shared/diagram";
import { MarkdownStreamingContext } from "./genui/GenerativeUI";
import { Icon } from "./icons";
import { hitSlopFor, lineHeight, radius, space, type } from "./design-tokens";
import { useTheme, type Palette } from "./theme";
import { CircleButton, pressStyle, SheetHeader, tap } from "./ui";

let opened: { code: string; title: string } | null = null;

/** Pele's drawing of `code` at most `width` wide, coloured for React Native's SVG; null with the reason when it doesn't draw. */
function draw(code: string, width: number, colors: Palette) {
  try {
    const result = render(code, { maxWidth: width, fontSize: type.footnote });
    const theme = diagramTheme({ background: colors.surface, ink: colors.ink, muted: colors.ink3, line: colors.ink3, accent: colors.accent });
    return { svg: nativeDiagramSvg(result.svg, theme), width: result.width, height: result.height, type: result.type as string, error: "" };
  } catch (error) {
    return { svg: "", width: 0, height: 0, type: "", error: error instanceof Error ? error.message : String(error) };
  }
}

export function MermaidBlock({ code, plain }: { code: string; plain: ReactNode }) {
  const streaming = useContext(MarkdownStreamingContext);
  const { colors } = useTheme();
  const [width, setWidth] = useState(0);
  const drawn = useMemo(() => (streaming || !width ? null : draw(code, width - 32, colors)), [code, width, streaming, colors]);
  if (streaming) return <>{plain}</>;
  if (drawn?.error)
    return (
      <View style={{ gap: space.sm }}>
        <Text style={{ color: colors.redInk, fontSize: type.footnote, lineHeight: lineHeight.footnote }}>{`The diagram didn’t draw: ${drawn.error}`}</Text>
        {plain}
      </View>
    );
  const label = diagramLabel(drawn?.type);
  const shown =
    drawn && drawn.width > 0 ? { width: Math.min(drawn.width, width - 32), height: (drawn.height * Math.min(drawn.width, width - 32)) / drawn.width } : null;
  return (
    <View
      onLayout={(event) => setWidth(Math.round(event.nativeEvent.layout.width))}
      style={{
        borderRadius: radius.card,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: colors.line,
        backgroundColor: colors.surface,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingLeft: space.xl,
          paddingRight: space.sm,
          minHeight: 44,
          borderBottomWidth: 1,
          borderColor: colors.line,
        }}
      >
        <Text style={{ flex: 1, color: colors.ink3, fontSize: type.footnote, lineHeight: lineHeight.footnote }}>{label}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open the ${label.toLowerCase()} full screen`}
          accessibilityState={{ disabled: !drawn }}
          hitSlop={hitSlopFor(32)}
          disabled={!drawn}
          onPress={() => {
            tap();
            opened = { code, title: label };
            router.push("/diagram-sheet");
          }}
          style={({ pressed }) => [{ width: 32, height: 32, alignItems: "center", justifyContent: "center" }, pressStyle({ pressed, disabled: !drawn })]}
        >
          <Icon icon={ArrowExpand01Icon} tone="ink3" size={16} />
        </Pressable>
      </View>
      <View accessible accessibilityRole="image" accessibilityLabel={label} style={{ padding: space.xl, alignItems: "center", minHeight: 80 }}>
        {drawn && shown ? <SvgXml xml={drawn.svg} width={shown.width} height={shown.height} /> : null}
      </View>
    </View>
  );
}

const HEADER = 64;

export function DiagramSheet() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const diagram = opened;
  const code = diagram?.code;
  const room = Math.max(240, width - insets.left - insets.right - 32);
  const drawn = useMemo(() => (code === undefined ? null : draw(code, room, colors)), [code, room, colors]);
  const grow = drawn && drawn.width > 0 ? Math.min(2, room / drawn.width) : 1;
  return (
    <View style={{ flex: 1, paddingTop: insets.top, backgroundColor: colors.surface }}>
      <SheetHeader
        title={diagram?.title ?? "Diagram"}
        leading={<CircleButton label="Close diagram" icon={Cancel01Icon} onPress={() => router.back()} />}
        style={{ minHeight: HEADER }}
      />
      {drawn && !drawn.error ? (
        <ScrollView
          maximumZoomScale={4}
          minimumZoomScale={1}
          bouncesZoom
          centerContent
          contentContainerStyle={{
            minHeight: height - insets.top - HEADER,
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
            paddingBottom: 16 + insets.bottom,
          }}
        >
          <SvgXml xml={drawn.svg} width={drawn.width * grow} height={drawn.height * grow} />
        </ScrollView>
      ) : (
        <Text style={{ color: colors.redInk, fontSize: type.body, lineHeight: lineHeight.body, padding: space.xl }}>
          {drawn?.error || "This diagram is no longer open."}
        </Text>
      )}
    </View>
  );
}
