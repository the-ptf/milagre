import { isGenuiFence } from "@milagre/shared/genui";
import { isMermaidFence } from "@milagre/shared/diagram";
import { MermaidBlock } from "./diagram";
import { GenerativeUI, MarkdownStreamingContext } from "./genui/GenerativeUI";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Image, Linking, Pressable, Text, View, type ImageSourcePropType, type TextStyle, type ViewInstance } from "react-native";
import { router } from "expo-router";
import type { Token } from "markdown-it";
import { localFileLink } from "@milagre/shared/file-link";
import { markdownChunks, markdownTokens, safeLink } from "./chat-presentation";
import { PageScroll, useStyles, type Styles } from "./ui";
import { showImages, type MediaValue, type ThumbRect } from "./viewer-store";

import { resolveMarkdownImage } from "./markdown-image";
import { useTheme, type Palette } from "./theme";

type ImageOptions = { media?: (path: string) => MediaValue; basePath?: string };
/** What the plain render helpers need from the theme; components pass it in from their hooks. `basePath` resolves relative file links. */
type MarkdownTheme = { colors: Palette; styles: Styles; basePath?: string; textPx: number; codeSize: number };

// Chat reading size: desktop uses 13px at 1.55; a phone reads best a little larger. `textPx` follows Settings > Appearance > Text size.
const bodyOf = (colors: Palette, textPx = 15) => ({ color: colors.ink, fontSize: textPx, lineHeight: Math.round(textPx * 1.4667) });

function MarkdownImage({ src, alt, media, basePath }: { src: string; alt: string } & ImageOptions) {
  const { colors } = useTheme();
  const styles = useStyles();
  const target = useMemo(() => resolveMarkdownImage(src, basePath), [src, basePath]);
  const [attempt, setAttempt] = useState(0);
  const source = useMemo(() => {
    void attempt;
    if (!target) return null;
    if ("url" in target) return { uri: target.url };
    try {
      return media?.(target.path) ?? null;
    } catch {
      return null;
    }
  }, [target, media, attempt]);
  const pending = source && typeof (source as Promise<ImageSourcePropType>).then === "function" ? (source as Promise<ImageSourcePropType>) : null;
  const [loaded, setLoaded] = useState<{ source: MediaValue; value: ImageSourcePropType | null } | null>(null);
  const [failed, setFailed] = useState<MediaValue | null>(null);
  useEffect(() => {
    if (!pending) return;
    let current = true;
    pending.then(
      (value) => {
        if (current) setLoaded({ source: pending, value });
      },
      () => {
        if (current) setLoaded({ source: pending, value: null });
      },
    );
    return () => {
      current = false;
    };
  }, [pending]);
  const ready = pending ? (loaded?.source === pending ? loaded.value : null) : (source as ImageSourcePropType | null);
  const broken = !source || failed === source || (pending && loaded?.source === pending && !loaded.value);
  const [ratio, setRatio] = useState(1);
  const thumb = useRef<ViewInstance>(null);
  if (!target) return <Text style={styles.muted}>[Image: {alt}]</Text>;
  if (broken)
    return "url" in target ? (
      <Text
        accessibilityRole="link"
        style={[styles.muted, { color: colors.accent, textDecorationLine: "underline" }]}
        onPress={() => void Linking.openURL(target.url).catch(() => Alert.alert("Cannot open image", "Try opening this address in your browser."))}
      >
        Cannot load {alt}. Open image
      </Text>
    ) : (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Retry ${alt}`}
        onPress={() => {
          setFailed(null);
          setAttempt((value) => value + 1);
        }}
      >
        <Text style={styles.muted}>Cannot load {alt} from your computer. Tap to retry.</Text>
      </Pressable>
    );
  if (!ready)
    return (
      <Text accessibilityLiveRegion="polite" style={styles.muted}>
        Loading {alt}...
      </Text>
    );
  const open = () => {
    const show = (from?: ThumbRect) => {
      showImages([{ name: alt, source: ready, from }], 0);
      router.push("/viewer");
    };
    if (thumb.current) thumb.current.measureInWindow((x, y, width, height) => show(width && height ? { x, y, width, height } : undefined));
    else show();
  };
  return (
    <Pressable
      ref={thumb}
      accessibilityRole="imagebutton"
      accessibilityLabel={`${alt}. Open full screen`}
      onPress={open}
      style={{
        width: "100%",
        maxWidth: Math.min(320, 300 * ratio),
        borderRadius: 14,
        borderCurve: "continuous",
        overflow: "hidden",
        borderWidth: 1,
        borderColor: colors.line,
        backgroundColor: colors.field,
      }}
    >
      <Image
        source={ready}
        accessibilityLabel={alt}
        resizeMode="contain"
        onError={() => setFailed(source)}
        onLoad={({ nativeEvent }) => {
          const { width, height } = nativeEvent.source;
          if (width > 0 && height > 0) setRatio(width / height);
        }}
        style={{ width: "100%", aspectRatio: ratio }}
      />
    </Pressable>
  );
}

type Node = { token: Token; children: Node[] };
function tree(tokens: Token[]) {
  const root: Node[] = [],
    stack = [root];
  for (const token of tokens) {
    if (token.nesting === -1) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const node = { token, children: [] as Node[] };
    stack.at(-1)!.push(node);
    if (token.nesting === 1) stack.push(node.children);
  }
  return root;
}
function inline(tokens: Token[], t: MarkdownTheme) {
  return inlineNodes(tree(tokens), t);
}
/** Images need their own native View; split text runs while preserving open emphasis and links. */
function inlineContent(tokens: Token[], t: MarkdownTheme, style: TextStyle = bodyOf(t.colors, t.textPx), heading = false, images: ImageOptions = {}) {
  const parts: React.ReactNode[] = [];
  const open: Token[] = [];
  let text: Token[] = [];
  const flush = () => {
    if (text.some((token) => token.nesting === 0 && token.content.trim()))
      parts.push(
        <Text key={`text-${parts.length}`} selectable accessibilityRole={heading ? "header" : undefined} style={style}>
          {inline(text, t)}
        </Text>,
      );
  };
  for (const token of tokens) {
    if (token.type === "image") {
      flush();
      const src = String(token.attrGet("src") || "");
      parts.push(<MarkdownImage key={`image-${parts.length}-${src}`} src={src} alt={token.content || "Image"} {...images} />);
      text = [...open];
    } else {
      text.push(token);
      if (token.nesting === 1) open.push(token);
      else if (token.nesting === -1) open.pop();
    }
  }
  flush();
  return <View style={{ gap: 8 }}>{parts}</View>;
}
function inlineNodes(nodes: Node[], t: MarkdownTheme): React.ReactNode {
  return nodes.map(({ token, children }, i) => {
    if (token.type === "softbreak" || token.type === "hardbreak") return "\n";
    const text = children.length ? inlineNodes(children, t) : token.content;
    const style: TextStyle =
      token.type === "strong_open"
        ? { fontWeight: "600" }
        : token.type === "em_open"
          ? { fontStyle: "italic" }
          : token.type === "s_open"
            ? { textDecorationLine: "line-through" }
            : token.type === "code_inline"
              ? { fontFamily: t.styles.code.fontFamily, backgroundColor: t.colors.field, fontSize: t.codeSize + 1.5 }
              : {};
    const href = token.type === "link_open" ? String(token.attrGet("href") || "") : "";
    const url = href ? safeLink(href) : null;
    // A link to a file on the computer opens the file preview; the phone's browser can't reach it.
    const file = href && !url ? localFileLink(href, t.basePath) : null;
    const onPress = url
      ? () => void Linking.openURL(url).catch(() => Alert.alert("Cannot open link", "Try opening this address in your browser."))
      : file
        ? () => router.push({ pathname: "/file-preview", params: { path: file.path } })
        : undefined;
    return (
      <Text
        key={i}
        style={[style, onPress ? { color: t.colors.accent, textDecorationLine: "underline" } : {}]}
        accessibilityRole={onPress ? "link" : undefined}
        onPress={onPress}
      >
        {text}
      </Text>
    );
  });
}
function blocks(nodes: Node[], images: ImageOptions, t: MarkdownTheme): React.ReactNode {
  const { colors, styles } = t;
  const body = bodyOf(colors, t.textPx);
  return nodes.map(({ token, children }, index) => {
    const key = `${token.type}-${index}`;
    if (token.type === "inline") return <View key={key}>{inlineContent(token.children || [], t, body, false, images)}</View>;
    if (token.type === "fence" || token.type === "code_block") {
      const plain = (
        <View style={{ backgroundColor: colors.field, borderRadius: 12, borderCurve: "continuous", overflow: "hidden" }}>
          {token.info && <Text style={[styles.label, { paddingHorizontal: 12, paddingTop: 10 }]}>{token.info}</Text>}
          <PageScroll horizontal contentContainerStyle={{ padding: 12, paddingBottom: 12 }}>
            <Text selectable style={[styles.code, { fontSize: t.codeSize + 1, lineHeight: Math.round((t.codeSize + 1) * 1.5) }]}>
              {token.content.replace(/\n$/, "")}
            </Text>
          </PageScroll>
        </View>
      );
      return (
        <View key={key}>
          {token.type === "fence" && isGenuiFence(token.info) ? (
            <GenerativeUI code={token.content.replace(/\n$/, "")} fallback={plain} />
          ) : token.type === "fence" && isMermaidFence(token.info) ? (
            <MermaidBlock code={token.content.replace(/\n$/, "")} plain={plain} />
          ) : (
            plain
          )}
        </View>
      );
    }
    if (token.type === "heading_open")
      return (
        <View key={key}>
          {inlineContent(
            children.flatMap((n) => n.token.children || []),
            t,
            {
              color: colors.ink,
              fontWeight: "600",
              lineHeight: Math.round(t.textPx * 1.5),
              fontSize: t.textPx + (token.tag === "h1" ? 2 : token.tag === "h2" ? 1 : 0),
            },
            true,
            images,
          )}
        </View>
      );
    if (token.type === "bullet_list_open" || token.type === "ordered_list_open")
      return (
        <View key={key} style={{ gap: 8 }}>
          {children.map((child, i) => (
            <View key={i} style={{ flexDirection: "row", gap: 10 }}>
              <Text style={body}>{token.type === "ordered_list_open" ? `${Number(token.attrGet("start") || 1) + i}.` : "•"}</Text>
              <View style={{ flex: 1, gap: 8 }}>{blocks(child.children, images, t)}</View>
            </View>
          ))}
        </View>
      );
    if (token.type === "blockquote_open")
      return (
        <View key={key} style={{ borderLeftWidth: 3, borderColor: colors.line, paddingLeft: 14, gap: 8 }}>
          {blocks(children, images, t)}
        </View>
      );
    if (token.type === "hr") return <View key={key} style={{ height: 1, backgroundColor: colors.line }} />;
    if (token.type === "tr_open")
      return (
        <View key={key} style={{ flexDirection: "row", gap: 12, paddingVertical: 8, borderBottomWidth: 0.5, borderColor: colors.line }}>
          {children.map((child, i) => (
            <View key={i} style={{ flex: 1 }}>
              {blocks(child.children, images, t)}
            </View>
          ))}
        </View>
      );
    return (
      <View key={key} style={{ gap: 8 }}>
        {children.length ? (
          blocks(children, images, t)
        ) : (
          <Text selectable style={body}>
            {token.content}
          </Text>
        )}
      </View>
    );
  });
}
/** One top-level block; unchanged blocks skip parsing and rendering while the reply streams. */
const Chunk = memo(function Chunk({ text, streaming, media, basePath }: { text: string; streaming: boolean } & ImageOptions) {
  const { colors, textPx, codeSize } = useTheme();
  const styles = useStyles();
  const nodes = useMemo(() => tree(markdownTokens(text, streaming)), [text, streaming]);
  return (
    <MarkdownStreamingContext value={streaming}>{blocks(nodes, { media, basePath }, { colors, styles, basePath, textPx, codeSize })}</MarkdownStreamingContext>
  );
});
export const Markdown = memo(function Markdown({ text, streaming = false, media, basePath }: { text: string; streaming?: boolean } & ImageOptions) {
  const chunks = useMemo(() => markdownChunks(text), [text]);
  return (
    <View style={{ gap: 12 }}>
      {chunks.map((chunk, index) => (
        <Chunk key={index} text={chunk} media={media} basePath={basePath} streaming={streaming && index === chunks.length - 1} />
      ))}
    </View>
  );
});
