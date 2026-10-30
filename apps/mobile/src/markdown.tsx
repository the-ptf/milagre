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
import { localFileLink } from "@milagre/shared/file-link";
import { reachableUrl } from "@milagre/shared/loopback-url";
import { splitStreamingBlocks } from "@milagre/shared/streaming-blocks";
import { ReachableHostContext, type ReachableHost } from "./reachable-host";
import { ChatLinkContext } from "./chat-link-context";
import { cachedMarkdownTokens, markdownChunks, markdownTokens, safeLink } from "./chat-presentation";
import { PageScroll, useStyles, type Styles } from "./ui";
import { showImages, type MediaValue, type ThumbRect } from "./viewer-store";

import { resolveMarkdownImage } from "./markdown-image";
import { useTheme, type Palette } from "./theme";
import { messageActionProps } from "./message-actions";
import { Icon } from "./icons";
import { tap } from "./primitives/tap";
import { markdownCellText, markdownColumnWidths, markdownTableRows, type MarkdownNode as Node } from "./markdown-table";

/** `remote` reads a web image the phone can't load itself (a private repository's), or returns null to load it directly. */
type ImageOptions = { media?: (path: string) => MediaValue; basePath?: string; remote?: (url: string) => MediaValue | null };
/** What the plain render helpers need from the theme; components pass it in from their hooks. `basePath` resolves relative file links. */
type MarkdownTheme = {
  colors: Palette;
  styles: Styles;
  basePath?: string;
  textPx: number;
  codeSize: number;
  reachable?: ReachableHost | null;
  openChatLink?: ((url: string) => boolean) | null;
  /** False where a long press on the message offers Select text instead (chat replies on iOS). */
  selectable: boolean;
  /** Opens the message's Copy / Select text actions; set, it is also the VoiceOver action on each text block. */
  onMessageAction?: () => void;
  tableHeader?: boolean;
};

// Chat reading size: desktop uses 13px at 1.55; a phone reads best a little larger. `textPx` follows Settings > Appearance > Text size.
const bodyOf = (colors: Palette, textPx = 15) => ({ color: colors.ink, fontSize: textPx, lineHeight: Math.round(textPx * 1.4667) });

/** Each retry reads the computer again, including when its target and media callback are unchanged. */
function readImage(target: ReturnType<typeof resolveMarkdownImage>, media: ImageOptions["media"], remote: ImageOptions["remote"], attempt: number) {
  let source: MediaValue | null = null;
  if (target) {
    if ("url" in target) source = remote?.(target.url) ?? { uri: target.url };
    else {
      try {
        source = media?.(target.path) ?? null;
      } catch {
        // An unavailable computer image keeps its retry control.
      }
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
function inlineNodes(nodes: Node[], t: MarkdownTheme): React.ReactNode {
  return nodes.map(({ token, children }, i) => {
    if (token.type === "softbreak" || token.type === "hardbreak") return "\n";
    let text = children.length ? inlineNodes(children, t) : token.content;
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
    const written = token.type === "link_open" ? String(token.attrGet("href") || "") : "";
    // A localhost link is the Chat's computer, never the phone: it opens at that computer's IP (unless the Chat's ports
    // show that server on loopback only), and a bare URL says so.
    const href = written && reachableUrl(written, t.reachable?.host, t.reachable?.loopbackOnly);
    if (href !== written && children.map((child) => child.token.content).join("") === written) text = href;
    const url = href ? safeLink(href) : null;
    // A link to a file on the computer opens the file preview; the phone's browser can't reach it.
    const file = href && !url ? localFileLink(href, t.basePath) : null;
    const onPress = url
      ? () => {
          // The internal Browser runs on the computer, so preserve its original localhost address.
          if (!t.openChatLink?.(safeLink(written) ?? url))
            void Linking.openURL(url).catch(() => Alert.alert("Cannot open link", "Try opening this address in your browser."));
        }
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
    <View style={{ backgroundColor: t.colors.field, borderRadius: 12, borderCurve: "continuous", overflow: "hidden" }}>
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
          style={({ pressed }) => ({ minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center", opacity: pressed ? 0.5 : 1 })}
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
      style={{ borderWidth: line, borderColor: t.colors.line, borderRadius: 12, borderCurve: "continuous", overflow: "hidden" }}
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

function blocks(nodes: Node[], images: ImageOptions, t: MarkdownTheme): React.ReactNode {
  const { colors } = t;
  const body = { ...bodyOf(colors, t.textPx), ...(t.tableHeader ? { fontWeight: "600" as const } : {}) };
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
/** One top-level block; unchanged blocks skip parsing and rendering while the reply streams. */
const Chunk = memo(function Chunk({
  text,
  streaming,
  media,
  basePath,
  remote,
  selectable,
  onMessageAction,
}: { text: string; streaming: boolean; selectable: boolean; onMessageAction?: () => void } & ImageOptions) {
  const { colors, textPx, codeSize } = useTheme();
  const styles = useStyles();
  const reachable = useContext(ReachableHostContext);
  const openChatLink = useContext(ChatLinkContext);
  const nodes = useMemo(() => tree(streaming ? markdownTokens(text, true) : cachedMarkdownTokens(text)), [text, streaming]);
  const images = useMemo(() => ({ media, basePath, remote }), [media, basePath, remote]);
  const theme = useMemo(
    () => ({ colors, styles, basePath, textPx, codeSize, reachable, openChatLink, selectable, onMessageAction }),
    [colors, styles, basePath, textPx, codeSize, reachable, openChatLink, selectable, onMessageAction],
  );
  return <MarkdownStreamingContext value={streaming}>{blocks(nodes, images, theme)}</MarkdownStreamingContext>;
});
type BlockProps = { text: string; streaming: boolean; selectable: boolean; onMessageAction?: () => void } & ImageOptions;
/**
 * One block of the shared split, cut where the phone also sets list items apart. A finished block keeps its text from
 * batch to batch, so it never splits or renders again while the reply streams.
 */
const Block = memo(function Block({ text, streaming, ...props }: BlockProps) {
  const chunks = useMemo(() => markdownChunks(text), [text]);
  return chunks.map((chunk, index) => <Chunk key={index} {...props} text={chunk} streaming={streaming && index === chunks.length - 1} />);
});

// A reply can stream dozens of batches a second; parsing the block being written faster than this shows nothing new.
const STREAM_RENDER_MS = 50;

/**
 * While `streaming`, `text` changes on screen at most once per STREAM_RENDER_MS, and the newest text always follows.
 * A text that doesn't continue the one on screen (a different reply) shows at once.
 */
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

/**
 * A reply in top-level blocks (the split desktop uses), each cut again where the phone sets list items apart. While it
 * streams, the finished blocks render from memo and only the block being written parses, at most every STREAM_RENDER_MS.
 */
export const Markdown = memo(function Markdown({
  text,
  streaming = false,
  media,
  basePath,
  remote,
  selectable = true,
  onMessageAction,
}: { text: string; streaming?: boolean; selectable?: boolean; onMessageAction?: () => void } & ImageOptions) {
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
          streaming={streaming && index === parts.length - 1}
        />
      ))}
    </View>
  );
});
