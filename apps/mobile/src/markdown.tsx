import { isGenuiFence } from "@milagre/shared/genui";
import { isMermaidFence } from "@milagre/shared/diagram";
import { MermaidBlock } from "./diagram";
import { GenerativeUI, MarkdownStreamingContext } from "./genui/GenerativeUI";
import { memo, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Alert,
  Image,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ImageSourcePropType,
  type TextStyle,
  type ViewInstance,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { router } from "expo-router";
import type { Token } from "markdown-it";
import { fileLinkTarget, localFileLink, touchedFileMatches } from "@milagre/shared/file-link";
import { reachableUrl } from "@milagre/shared/loopback-url";
import { splitStreamingBlocks } from "@milagre/shared/streaming-blocks";
import { ReachableHostContext, type ReachableHost } from "./reachable-host";
import { ChatFilesContext, ChatLinkActionsContext, ChatLinkContext, type ChatLinkActions } from "./chat-link-context";
import { showFileLinkSheet, showWebLinkSheet } from "./link-sheet";
import { cachedMarkdownTokens, markdownChunks, markdownTokens, safeLink } from "./chat-presentation";
import { radius, space } from "./design-tokens";
import { PageScroll, pressStyle, useStyles, type Styles } from "./ui";
import { showImages, type MediaValue, type ThumbRect } from "./viewer-store";

import { resolveMarkdownImage } from "./markdown-image";
import { useTheme, type Palette } from "./theme";
import { messageActionProps } from "./message-actions";
import { Icon } from "./icons";
import { tap } from "./primitives/tap";
import { markdownCellText, markdownColumnWidths, markdownTableRows, type MarkdownNode as Node } from "./markdown-table";
import { orderedListLabels } from "./markdown-list";

type ImageOptions = { media?: (path: string) => MediaValue; basePath?: string; remote?: (url: string) => MediaValue | null };
type MarkdownTheme = {
  colors: Palette;
  styles: Styles;
  basePath?: string;
  textPx: number;
  codeSize: number;
  reachable?: ReachableHost | null;
  openChatLink?: ((url: string) => boolean) | null;
  linkActions?: ChatLinkActions | null;
  steps?: { readonly current: readonly { file?: string; files?: readonly string[] }[] };
  /** False where a long press switches the message to an inline selection view (chat replies on iOS). */
  selectable: boolean;
  onMessageAction?: () => void;
  tableHeader?: boolean;
  tone: TextTone;
};
type TextTone = "ink" | "ink2";

const bodyOf = (colors: Palette, textPx = 15, tone: TextTone = "ink") => ({ color: colors[tone], fontSize: textPx, lineHeight: Math.round(textPx * 1.4667) });

function readImage(target: ReturnType<typeof resolveMarkdownImage>, media: ImageOptions["media"], remote: ImageOptions["remote"], attempt: number) {
  let source: MediaValue | null = null;
  if (target) {
    if ("url" in target) source = remote?.(target.url) ?? { uri: target.url };
    else {
      try {
        source = media?.(target.path) ?? null;
      } catch {}
    }
  }
  return { attempt, source };
}

function MarkdownImage({ src, alt, media, basePath, remote }: { src: string; alt: string } & ImageOptions) {
  const { colors } = useTheme();
  const styles = useStyles();
  const target = useMemo(() => resolveMarkdownImage(src, basePath), [src, basePath]);
  const [attempt, setAttempt] = useState(0);
  const { source } = useMemo(() => readImage(target, media, remote, attempt), [target, media, remote, attempt]);
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
        style={[styles.muted, { color: colors.accentInk, textDecorationLine: "underline" }]}
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
  if (!ready) return <Text style={styles.muted}>Loading {alt}…</Text>;
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
        borderRadius: radius.card,
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
function inlineContent(tokens: Token[], t: MarkdownTheme, style: TextStyle = bodyOf(t.colors, t.textPx, t.tone), heading = false, images: ImageOptions = {}) {
  const parts: React.ReactNode[] = [];
  const open: Token[] = [];
  let text: Token[] = [];
  const flush = () => {
    if (text.some((token) => token.nesting === 0 && token.content.trim()))
      parts.push(
        <Text
          key={`text-${parts.length}`}
          selectable={t.selectable}
          accessibilityRole={heading ? "header" : undefined}
          style={style}
          {...messageActionProps(t.onMessageAction)}
        >
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
const LINK_OPTIONS = [{ name: "linkOptions", label: "Link options" }];

function inlineNodes(nodes: Node[], t: MarkdownTheme, inLink = false): React.ReactNode {
  return nodes.map(({ token, children }, i) => {
    if (token.type === "softbreak" || token.type === "hardbreak") return "\n";
    let text = children.length ? inlineNodes(children, t, inLink || token.type === "link_open") : token.content;
    const style: TextStyle =
      token.type === "strong_open"
        ? { fontWeight: "600" }
        : token.type === "em_open"
          ? { fontStyle: "italic" }
          : token.type === "s_open"
            ? { textDecorationLine: "line-through" }
            : token.type === "code_inline"
              ? { fontFamily: t.styles.code.fontFamily, backgroundColor: t.colors.field, fontSize: Math.round(t.codeSize + 1.5) }
              : {};
    const written = token.type === "link_open" ? String(token.attrGet("href") || "") : "";
    const href = written && reachableUrl(written, t.reachable?.host, t.reachable?.loopbackOnly);
    if (href !== written && children.map((child) => child.token.content).join("") === written) text = href;
    const url = href ? safeLink(href) : null;
    const file = href && !url ? localFileLink(href, t.basePath) : null;
    const named = token.type === "code_inline" && !inLink && t.basePath ? fileLinkTarget(token.content) : null;
    const codeFile = named ? localFileLink(named.path, t.basePath) : null;
    const onPress = url
      ? () => {
          if (!t.openChatLink?.(safeLink(written) ?? url))
            void Linking.openURL(url).catch(() => Alert.alert("Cannot open link", "Try opening this address in your browser."));
        }
      : file
        ? () => router.push({ pathname: "/file-preview", params: { path: file.path } })
        : named && codeFile
          ? () => {
              const fallbacks = touchedFileMatches(named.path, t.steps?.current ?? []);
              router.push({
                pathname: "/file-preview",
                params: { path: codeFile.path, ...(fallbacks.length ? { fallbacks: JSON.stringify(fallbacks) } : {}) },
              });
            }
          : undefined;
    const label = children.map((child) => child.token.content).join("") || href;
    const onLongPress = url
      ? () => showWebLinkSheet({ text: label, url, written: safeLink(written) ?? url, actions: t.linkActions })
      : file
        ? () => showFileLinkSheet({ text: label, path: file.path })
        : undefined;
    return (
      <Text
        key={i}
        style={[style, onPress ? { color: t.colors.accentInk, textDecorationLine: "underline" } : {}]}
        accessibilityRole={onPress ? "link" : undefined}
        onPress={onPress}
        onLongPress={onLongPress}
        accessibilityActions={onLongPress ? LINK_OPTIONS : undefined}
        onAccessibilityAction={onLongPress ? (event) => event.nativeEvent.actionName === "linkOptions" && onLongPress() : undefined}
      >
        {text}
      </Text>
    );
  });
}
const CodeBlock = memo(function CodeBlock({ code, language, t }: { code: string; language: string; t: MarkdownTheme }) {
  const [copied, setCopied] = useState(false);
  const copyState = useRef({ live: true, request: 0, timer: undefined as ReturnType<typeof setTimeout> | undefined });
  useEffect(() => {
    const state = copyState.current;
    state.live = true;
    return () => {
      state.live = false;
      state.request++;
      clearTimeout(state.timer);
    };
  }, []);
  const copy = () => {
    const state = copyState.current;
    const request = ++state.request;
    void Clipboard.setStringAsync(code).then(
      () => {
        if (!state.live || request !== state.request) return false;
        tap();
        AccessibilityInfo.announceForAccessibility("Copied");
        setCopied(true);
        clearTimeout(state.timer);
        state.timer = setTimeout(() => setCopied(false), 1500);
        return true;
      },
      () => {},
    );
  };
  return (
    <View style={{ backgroundColor: t.colors.field, borderRadius: radius.card, borderCurve: "continuous", overflow: "hidden" }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingLeft: 12,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderColor: t.colors.line,
        }}
      >
        <Text numberOfLines={1} style={[t.styles.label, { flex: 1 }]}>
          {language.toLowerCase() || "text"}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copied ? "Copied" : "Copy code"}
          onPress={copy}
          style={({ pressed }) => [{ minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" }, pressStyle({ pressed })]}
        >
          <Icon icon={copied ? Tick02Icon : Copy01Icon} size={16} />
        </Pressable>
      </View>
      <PageScroll horizontal contentContainerStyle={{ padding: 12, paddingBottom: 12 }}>
        <Text
          selectable={t.selectable}
          style={[t.styles.code, { fontSize: t.codeSize + 1, lineHeight: Math.round((t.codeSize + 1) * 1.5) }]}
          {...messageActionProps(t.onMessageAction)}
        >
          {code}
        </Text>
      </PageScroll>
    </View>
  );
});

const MarkdownTable = memo(function MarkdownTable({ nodes, images, t }: { nodes: Node[]; images: ImageOptions; t: MarkdownTheme }) {
  const [available, setAvailable] = useState(0);
  const rows = useMemo(() => markdownTableRows(nodes), [nodes]);
  const text = useMemo(() => rows.map((row) => row.map((cell) => markdownCellText(cell.children))), [rows]);
  const widths = useMemo(() => markdownColumnWidths(text, available, t.textPx), [text, available, t.textPx]);
  const line = StyleSheet.hairlineWidth;
  return (
    <View
      onLayout={({ nativeEvent }) => setAvailable(Math.max(0, nativeEvent.layout.width - line * 2))}
      style={{ borderWidth: line, borderColor: t.colors.line, borderRadius: radius.card, borderCurve: "continuous", overflow: "hidden" }}
    >
      <PageScroll horizontal directionalLockEnabled bounces={false} contentContainerStyle={{ padding: 0, paddingBottom: 0, gap: 0 }}>
        <View>
          {rows.map((row, index) => (
            <View key={index} style={{ flexDirection: "row", borderTopWidth: index ? line : 0, borderColor: t.colors.line }}>
              {widths.map((width, column) => {
                const cell = row[column];
                const header = cell?.token.type === "th_open";
                return (
                  <View
                    key={column}
                    style={{
                      width,
                      padding: 12,
                      borderLeftWidth: column ? line : 0,
                      borderColor: t.colors.line,
                      backgroundColor: header ? t.colors.field : undefined,
                    }}
                  >
                    {cell && blocks(cell.children, images, { ...t, tableHeader: header })}
                  </View>
                );
              })}
            </View>
          ))}
        </View>
      </PageScroll>
    </View>
  );
});

const listMarker: Record<"digits" | "sizer" | "label", TextStyle> = {
  digits: { fontVariant: ["tabular-nums"] },
  sizer: { opacity: 0 },
  label: { position: "absolute", top: 0, right: 0 },
};

function blocks(nodes: Node[], images: ImageOptions, t: MarkdownTheme): React.ReactNode {
  const { colors } = t;
  const body = { ...bodyOf(colors, t.textPx, t.tone), ...(t.tableHeader ? { fontWeight: "600" as const } : {}) };
  return nodes.map(({ token, children }, index) => {
    const key = `${token.type}-${index}`;
    if (token.type === "inline") return <View key={key}>{inlineContent(token.children || [], t, body, false, images)}</View>;
    if (token.type === "fence" || token.type === "code_block") {
      const plain = <CodeBlock code={token.content.replace(/\n$/, "")} language={token.info} t={t} />;
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
              color: colors[t.tone],
              fontWeight: "600",
              lineHeight: Math.round(t.textPx * 1.5),
              fontSize: t.textPx + (token.tag === "h1" ? 2 : token.tag === "h2" ? 1 : 0),
            },
            true,
            images,
          )}
        </View>
      );
    if (token.type === "bullet_list_open" || token.type === "ordered_list_open") {
      const ordered = token.type === "ordered_list_open" ? orderedListLabels(Number(token.attrGet("start") || 1), children.length) : null;
      return (
        <View key={key} style={{ gap: 8 }}>
          {children.map((child, i) => (
            <View key={i} style={{ flexDirection: "row", gap: space.lg }}>
              {ordered ? (
                <View>
                  <Text style={[body, listMarker.digits, listMarker.sizer]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                    {ordered.widest}
                  </Text>
                  <Text style={[body, listMarker.digits, listMarker.label]}>{ordered.labels[i]}</Text>
                </View>
              ) : (
                <Text style={body}>•</Text>
              )}
              <View style={{ flex: 1, gap: 8 }}>{blocks(child.children, images, t)}</View>
            </View>
          ))}
        </View>
      );
    }
    if (token.type === "blockquote_open")
      return (
        <View key={key} style={{ borderLeftWidth: 3, borderColor: colors.line, paddingLeft: space.lg, gap: space.md }}>
          {blocks(children, images, t)}
        </View>
      );
    if (token.type === "hr") return <View key={key} style={{ height: 1, backgroundColor: colors.line }} />;
    if (token.type === "table_open") return <MarkdownTable key={key} nodes={children} images={images} t={t} />;
    return (
      <View key={key} style={{ gap: 8 }}>
        {children.length ? (
          blocks(children, images, t)
        ) : (
          <Text selectable={t.selectable} style={body} {...messageActionProps(t.onMessageAction)}>
            {token.content}
          </Text>
        )}
      </View>
    );
  });
}
const Chunk = memo(function Chunk({ text, streaming, media, basePath, remote, selectable, onMessageAction, tone }: BlockProps) {
  const { colors, textPx, codeSize } = useTheme();
  const styles = useStyles();
  const reachable = useContext(ReachableHostContext);
  const openChatLink = useContext(ChatLinkContext);
  const linkActions = useContext(ChatLinkActionsContext);
  const steps = useContext(ChatFilesContext);
  const nodes = useMemo(() => tree(streaming ? markdownTokens(text, true) : cachedMarkdownTokens(text)), [text, streaming]);
  const images = useMemo(() => ({ media, basePath, remote }), [media, basePath, remote]);
  const theme = useMemo(
    () => ({ colors, styles, basePath, textPx, codeSize, reachable, openChatLink, linkActions, steps, selectable, onMessageAction, tone }),
    [colors, styles, basePath, textPx, codeSize, reachable, openChatLink, linkActions, steps, selectable, onMessageAction, tone],
  );
  return <MarkdownStreamingContext value={streaming}>{blocks(nodes, images, theme)}</MarkdownStreamingContext>;
});
type BlockProps = { text: string; streaming: boolean; selectable: boolean; onMessageAction?: () => void; tone: TextTone } & ImageOptions;
const Block = memo(function Block({ text, streaming, ...props }: BlockProps) {
  const chunks = useMemo(() => markdownChunks(text), [text]);
  return chunks.map((chunk, index) => <Chunk key={index} {...props} text={chunk} streaming={streaming && index === chunks.length - 1} />);
});

const STREAM_RENDER_MS = 50;

function useThrottledText(text: string, streaming: boolean): string {
  const [shown, setShown] = useState(text);
  const shownAt = useRef(0);
  useEffect(() => {
    if (!streaming || shown === text) return;
    const timer = setTimeout(
      () => {
        shownAt.current = Date.now();
        setShown(text);
      },
      Math.max(0, shownAt.current + STREAM_RENDER_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [streaming, text, shown]);
  return streaming && text.startsWith(shown) ? shown : text;
}

export const Markdown = memo(function Markdown({
  text,
  streaming = false,
  media,
  basePath,
  remote,
  selectable = true,
  onMessageAction,
  tone = "ink",
}: { text: string; streaming?: boolean; selectable?: boolean; onMessageAction?: () => void; tone?: TextTone } & ImageOptions) {
  const shown = useThrottledText(text, streaming);
  const parts = useMemo(() => splitStreamingBlocks(shown), [shown]);
  return (
    <View style={{ gap: 12 }}>
      {parts.map((part, index) => (
        <Block
          key={index}
          text={part}
          media={media}
          basePath={basePath}
          remote={remote}
          selectable={selectable}
          onMessageAction={onMessageAction}
          tone={tone}
          streaming={streaming && index === parts.length - 1}
        />
      ))}
    </View>
  );
});
