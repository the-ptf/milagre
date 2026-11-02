import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Linking, Pressable, Text, View } from "react-native";
import { File, Paths } from "expo-file-system";
import { DomWebView, type DomWebViewRef } from "@expo/dom-webview";
import {
  HTML_RENDER_MESSAGE,
  HTML_RENDER_LOAD_TIMEOUT,
  htmlRenderHeight,
  htmlRenderShell,
  readHtmlRenderMessage,
  type HtmlRenderTheme,
} from "@milagre/shared/html-render";
import type { Artifact } from "@milagre/shared/artifact";
import type { ArtifactRef } from "@milagre/shared/model";
import { useSession } from "./session";
import { fonts, useTheme } from "./theme";
import { SpinnerRing } from "./icons";

function PageLoading() {
  const { colors, textPx } = useTheme();
  return (
    <View
      pointerEvents="none"
      accessibilityRole="progressbar"
      accessibilityLabel="Loading page"
      style={{ position: "absolute", inset: 0, alignItems: "center", justifyContent: "center", gap: 8 }}
    >
      <SpinnerRing size={18} />
      <Text style={{ color: colors.ink3, fontSize: textPx }}>Loading page...</Text>
    </View>
  );
}

function HtmlWebView({ html, onHeight, onEscape }: { html: string; onHeight?: (height: number) => void; onEscape?: () => void }) {
  const { colors, scheme, textPx } = useTheme();
  const view = useRef<DomWebViewRef>(null);
  const ready = useRef(false);
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // The page reads like the reply around it: the phone's text size and the theme's colors. It is transparent, so the
  // transcript's own background (and its dot grid) shows through.
  const theme = useMemo<HtmlRenderTheme>(
    () => ({
      scheme,
      background: "transparent",
      surface: colors.surface,
      field: colors.field,
      ink: colors.ink,
      ink2: colors.ink2,
      muted: colors.ink3,
      line: colors.line,
      lineStrong: colors.lineStrong,
      accent: colors.accent,
      accentInk: colors.accentInk,
      accentTint: colors.accentTint,
      onAccent: colors.onAccent,
      green: colors.green,
      orange: colors.orange,
      red: colors.red,
      purple: colors.purple,
      font: '-apple-system, system-ui, "Helvetica Neue", sans-serif',
      mono: fonts.mono,
      size: textPx,
      leading: 1.47,
    }),
    [colors, scheme, textPx],
  );
  // The file starts in the current theme; later changes are sent to the running page instead of reloading it.
  const latestTheme = useRef(theme);
  useEffect(() => {
    latestTheme.current = theme;
  }, [theme]);
  const [prepared, setPrepared] = useState<{ html: string; attempt: number; file: File }>();
  const file = prepared?.html === html && prepared.attempt === attempt ? prepared.file : null;
  const [laidOutFile, setLaidOutFile] = useState<string>();
  const loaded = file !== null && laidOutFile === file.uri;
  useEffect(() => {
    if (loaded || failed) return;
    const timeout = setTimeout(() => setFailed(true), HTML_RENDER_LOAD_TIMEOUT);
    return () => clearTimeout(timeout);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Each new document gets its own startup deadline.
  }, [file, loaded, failed]);
  useEffect(() => {
    let live = true;
    ready.current = false;
    // Each effect owns a different file: refresh/Strict Mode cleanup must not delete its replacement.
    const next = new File(Paths.cache, `html-reply-${id}-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
    void Promise.resolve().then(() => {
      if (!live) return null;
      try {
        next.writeSync(htmlRenderShell(html, latestTheme.current));
        setPrepared({ html, attempt, file: next });
      } catch {
        setFailed(true);
      }
      return null;
    });
    return () => {
      live = false;
      try {
        if (next.exists) next.delete();
      } catch {
        /* Cache may already be gone. */
      }
    };
  }, [html, id, attempt]);
  const sendTheme = () => {
    if (!ready.current) return;
    void Promise.resolve(
      view.current?.injectJavaScript(
        `window.postMessage(${JSON.stringify({ channel: HTML_RENDER_MESSAGE, type: "theme", theme }).replace(/</g, "\\u003c")}, '*');true;`,
      ),
    ).catch(() => {});
  };
  useEffect(() => {
    if (!ready.current) return;
    void Promise.resolve(
      view.current?.injectJavaScript(
        `window.postMessage(${JSON.stringify({ channel: HTML_RENDER_MESSAGE, type: "theme", theme }).replace(/</g, "\\u003c")}, '*');true;`,
      ),
    ).catch(() => {});
  }, [theme]);
  if (failed)
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Retry HTML page"
        onPress={() => {
          ready.current = false;
          setFailed(false);
          setAttempt((n) => n + 1);
        }}
        style={{ paddingVertical: 4 }}
      >
        <Text style={{ color: colors.ink3, fontSize: textPx }}>
          Could not load this page. <Text style={{ color: colors.accentInk }}>Retry</Text>
        </Text>
      </Pressable>
    );
  if (!file) return <PageLoading />;
  return (
    <View style={{ flex: 1 }}>
      <DomWebView
        key={attempt}
        ref={view}
        source={{ uri: file.uri }}
        style={{ flex: 1, backgroundColor: "transparent" }}
        containerStyle={{ flex: 1 }}
        useExpoModulesBridge={false}
        automaticallyAdjustContentInsets={false}
        contentInsetAdjustmentBehavior="never"
        // The reply is as tall as its page: the transcript scrolls, the page never does.
        scrollEnabled={false}
        bounces={false}
        showsVerticalScrollIndicator={false}
        onMessage={(event) => {
          const message = readHtmlRenderMessage(event.nativeEvent.data);
          if (message?.type === "ready") {
            ready.current = true;
            sendTheme();
          }
          // The initial layout proves the page's scripts ran. `load` can wait longer for remote images or fonts.
          if (message?.type === "size") {
            setLaidOutFile(file.uri);
            onHeight?.(message.height);
          }
          if (message?.type === "escape") onEscape?.();
          if (message?.type === "link") void Linking.openURL(message.url).catch(() => {});
        }}
        onContentProcessDidTerminate={() => setFailed(true)}
        onRenderProcessGone={() => setFailed(true)}
      />
      {!loaded && <PageLoading />}
    </View>
  );
}

export function HtmlReply({ chatId, page }: { chatId?: string; page: ArtifactRef }) {
  const { client } = useSession();
  const { colors, textPx } = useTheme();
  const [loaded, setLoaded] = useState<{ key?: string; page?: Artifact; error?: string }>({});
  const [attempt, setAttempt] = useState(0);
  const [height, setHeight] = useState(() => htmlRenderHeight(page.height));
  const key = `${chatId}:${page.id}:${page.version}:${attempt}`;
  const state = loaded.key === key ? loaded : {};
  useEffect(() => {
    let live = true;
    if (client && chatId)
      client.call<Artifact>("artifact:get", [{ chatId, id: page.id, version: page.version }]).then(
        (value) => live && setLoaded({ key, page: value }),
        () => live && setLoaded({ key, error: "Could not load this page." }),
      );
    return () => {
      live = false;
    };
  }, [client, chatId, page.id, page.version, key]);
  // No frame, title or toolbar: the page sits in the reply like its text. Loading keeps the measured height so the
  // transcript doesn't jump; only a failure shows words.
  return (
    <View accessibilityLabel={page.title} style={{ marginBottom: 8 }}>
      {state.page ? (
        <View style={{ height }}>
          <HtmlWebView html={state.page.html} onHeight={setHeight} />
        </View>
      ) : state.error || !client || !chatId ? (
        <Text accessibilityRole="text" style={{ paddingVertical: 4, color: colors.ink3, fontSize: textPx }}>
          {state.error || "Connect to your computer to see the page."}
          {state.error && (
            <Text accessibilityRole="button" onPress={() => setAttempt((n) => n + 1)} style={{ color: colors.accentInk }}>
              {" "}
              Retry
            </Text>
          )}
        </Text>
      ) : (
        <View style={{ height }}>
          <PageLoading />
        </View>
      )}
    </View>
  );
}
