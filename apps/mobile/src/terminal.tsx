import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { Alert, AppState, Pressable, ScrollView, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { DomWebView, type DomWebViewRef } from "@expo/dom-webview";
import { File, Paths } from "expo-file-system";
import { Add01Icon, Cancel01Icon, ComputerTerminal01Icon } from "@hugeicons/core-free-icons";
import type { LinkChatSession } from "@milagre/shared/model";
import type { TerminalInfo, TerminalList } from "@milagre/shared/terminal";
import { followTerminal, type TerminalFollower } from "@milagre/shared/terminal-client";
import type { Client } from "./client";
import { useSession } from "./session";
import { Icon } from "./icons";
import { useTheme } from "./theme";
import { StatusPill } from "./status-pill";
import { CircleButton, PillButton, useStyles } from "./ui";
import { createTerminalHtml, scriptValue, xtermTheme, type TerminalTheme, type TerminalViewMessage } from "./terminal-receiver";

/** A Worktree a new Terminal can start in; a shared Chat has one per member Project. */
export type TerminalPlace = { path: string; label: string };

/** A shared Chat's Worktrees, by the folder name its workspace gives each; none for a Project Chat, which has one. */
export function terminalPlaces(chat: object): TerminalPlace[] | undefined {
  const worktrees = (chat as Partial<LinkChatSession>).worktrees;
  if (!Array.isArray(worktrees)) return undefined;
  return worktrees.map((member) => ({
    path: member.worktreePath,
    label: member.alias ?? member.projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? member.worktreePath,
  }));
}

/** This Chat's Terminals, read again every few seconds while the screen shows. */
function useTerminals(client: Client | null, chatId: string | undefined) {
  const [terminals, setTerminals] = useState<TerminalInfo[] | null>(null);
  const refresh = useRef<() => Promise<void>>(async () => {});
  useFocusEffect(
    useCallback(() => {
      if (!client || !chatId) return;
      let disposed = false,
        busy = false;
      const load = async () => {
        if (AppState.currentState !== "active" || disposed || busy) return;
        busy = true;
        try {
          const { terminals } = await client.call<TerminalList>("terminal:list", [{ chatId }]);
          if (!disposed) setTerminals(terminals);
        } catch {
          // A Mac without Terminals: the pill stays hidden.
          if (!disposed) setTerminals(null);
        } finally {
          busy = false;
        }
      };
      refresh.current = load;
      void load();
      const timer = setInterval(load, 5000);
      const subscription = AppState.addEventListener("change", () => void load());
      return () => {
        disposed = true;
        clearInterval(timer);
        subscription.remove();
      };
    }, [client, chatId]),
  );
  return { terminals, setTerminals, refresh: () => refresh.current() };
}

/** Shown for every sent Chat on a Mac that has Terminals. */
export function TerminalChip({ chatId, places }: { chatId?: string; places?: TerminalPlace[] }) {
  const { client } = useSession();
  const { terminals } = useTerminals(client, chatId);
  if (!client || !chatId || !terminals) return null;
  const count = terminals.length;
  return (
    <StatusPill
      label="Terminal"
      count={count || undefined}
      icon={ComputerTerminal01Icon}
      accessibilityLabel={count ? `Terminal, ${count} open in this Chat` : "Open a Terminal in this Chat"}
      onPress={() =>
        router.push({ pathname: "/terminal-sheet", params: { hostId: client.url, chatId, ...(places?.length ? { places: JSON.stringify(places) } : {}) } })
      }
    />
  );
}

// What the key bar sends: keys a phone keyboard lacks. Ctrl is held for the next key instead.
// The most output one read brings to the phone: about a tenth of a second for xterm in the WebView to parse.
const PHONE_READ_LIMIT = 64 * 1024;
// How long a write waits for the page's word before the next read goes ahead anyway.
const WRITE_ACK_MS = 3000;

const KEYS: { label: string; send: string }[] = [
  { label: "esc", send: "\x1b" },
  { label: "tab", send: "\t" },
  { label: "←", send: "\x1b[D" },
  { label: "↑", send: "\x1b[A" },
  { label: "↓", send: "\x1b[B" },
  { label: "→", send: "\x1b[C" },
  { label: "|", send: "|" },
  { label: "~", send: "~" },
  { label: "/", send: "/" },
  { label: "-", send: "-" },
];

type ViewHandle = { send(data: string): void; holdCtrl(held: boolean): void };

export function TerminalSheet({ hostId, chatId, places }: { hostId?: string; chatId?: string; places?: TerminalPlace[] }) {
  const { colors } = useTheme();
  const styles = useStyles();
  const { client } = useSession();
  const insets = useSafeAreaInsets();
  const source = client && (!hostId || hostId === client.url) ? client : null;
  const { terminals, setTerminals, refresh } = useTerminals(source, chatId);
  const [active, setActive] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [opening, setOpening] = useState(false);
  const [ctrl, setCtrl] = useState(false);
  const [paused, setPaused] = useState(AppState.currentState !== "active");
  const [revision, setRevision] = useState(0);
  const view = useRef<ViewHandle>(null);
  const openedFirst = useRef(false);
  const shown = terminals?.find((terminal) => terminal.id === active) ?? terminals?.at(-1) ?? null;
  const multiple = (places?.length ?? 0) > 1;

  useFocusEffect(
    useCallback(() => {
      const subscription = AppState.addEventListener("change", (state) => {
        if (state !== "active") setPaused(true);
      });
      return () => {
        subscription.remove();
        setPaused(true);
      };
    }, []),
  );

  const open = useCallback(
    async (cwd?: string) => {
      if (!source || !chatId) return;
      setOpening(true);
      setError("");
      try {
        const terminal = await source.call<TerminalInfo>("terminal:open", [{ chatId, ...(cwd ? { cwd } : {}) }]);
        setTerminals((current) => [...(current ?? []).filter((item) => item.id !== terminal.id), terminal]);
        setActive(terminal.id);
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : "Couldn't open a Terminal.");
      } finally {
        setOpening(false);
      }
    },
    [source, chatId, setTerminals],
  );
  const add = useCallback(() => {
    if (!multiple || !places) {
      void open(places?.[0]?.path);
      return;
    }
    Alert.alert("New Terminal in", undefined, [
      ...places.map((place) => ({ text: place.label, onPress: () => void open(place.path) })),
      { text: "Cancel", style: "cancel" as const },
    ]);
  }, [multiple, places, open]);

  // Opening the screen for a Chat with no Terminal starts its first one.
  useEffect(() => {
    if (openedFirst.current || !terminals || terminals.length) return;
    openedFirst.current = true;
    add();
  }, [terminals, add]);

  function close(terminal: TerminalInfo) {
    const end = async () => {
      try {
        await source?.call("terminal:close", [{ terminalId: terminal.id }]);
      } finally {
        await refresh();
      }
    };
    if (!terminal.busy) {
      void end();
      return;
    }
    Alert.alert(`End ${terminal.title}?`, "It is still running in this Terminal.", [
      { text: "Cancel", style: "cancel" },
      { text: `End ${terminal.title}`, style: "destructive", onPress: () => void end() },
    ]);
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.page, paddingTop: insets.top }}>
      <View style={{ flexShrink: 0, flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8, gap: 8 }}>
        <CircleButton label="Close Terminal" icon={Cancel01Icon} onPress={() => router.back()} />
        <View style={{ flex: 1, alignItems: "center" }}>
          <Text accessibilityRole="header" numberOfLines={1} style={{ color: colors.ink, fontSize: 17, fontWeight: "600" }}>
            {shown?.title ?? "Terminal"}
          </Text>
          <Text numberOfLines={1} style={{ color: colors.ink3, fontSize: 11 }}>
            {shown?.cwd ?? "This Chat"}
          </Text>
        </View>
        <CircleButton label="New Terminal" icon={Add01Icon} onPress={opening ? undefined : add} />
      </View>
      {!!terminals?.length && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ flexGrow: 0 }}
          contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 8, gap: 6 }}
        >
          {terminals.map((terminal) => {
            const selected = terminal.id === shown?.id;
            return (
              <View
                key={terminal.id}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  height: 30,
                  borderRadius: 15,
                  paddingLeft: 12,
                  paddingRight: selected ? 4 : 12,
                  gap: 4,
                  backgroundColor: selected ? colors.surface : "transparent",
                  borderWidth: 1,
                  borderColor: selected ? colors.lineStrong : colors.line,
                }}
              >
                <Pressable accessibilityRole="tab" accessibilityState={{ selected }} onPress={() => setActive(terminal.id)} hitSlop={6}>
                  <Text numberOfLines={1} style={{ color: selected ? colors.ink : colors.ink2, fontSize: 13, fontFamily: "Menlo" }}>
                    {terminal.title}
                    {multiple ? <Text style={{ color: colors.ink3, fontSize: 11 }}> {terminal.label}</Text> : null}
                  </Text>
                </Pressable>
                {selected && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Close ${terminal.title}`}
                    onPress={() => close(terminal)}
                    hitSlop={6}
                    style={{ padding: 4 }}
                  >
                    <Icon icon={Cancel01Icon} size={12} tone="ink3" />
                  </Pressable>
                )}
              </View>
            );
          })}
        </ScrollView>
      )}
      <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={0} style={{ flex: 1, minHeight: 0 }}>
        <View collapsable={false} style={{ flex: 1, minHeight: 0 }}>
          {!source || !chatId ? (
            <Text style={[styles.muted, { padding: 20 }]}>Reconnect to this computer to open its Terminals.</Text>
          ) : error ? (
            <View style={{ padding: 20, gap: 16 }}>
              <Text accessibilityRole="alert" style={{ color: colors.red }}>
                {error}
              </Text>
              <PillButton title="Try again" onPress={add} />
            </View>
          ) : paused ? (
            <View style={{ padding: 20, gap: 16 }}>
              <Text style={styles.muted}>Paused while the app was hidden. The Terminal kept running on your computer.</Text>
              <PillButton
                title="Resume"
                onPress={() => {
                  setRevision((value) => value + 1);
                  setPaused(false);
                }}
              />
            </View>
          ) : shown ? (
            <TerminalView
              key={`${shown.id}:${revision}`}
              ref={view}
              client={source}
              terminal={shown}
              onCtrlUsed={() => setCtrl(false)}
              onInfo={(latest) =>
                setTerminals(
                  (current) =>
                    current?.map((item) => (item.id === latest.id && (item.title !== latest.title || item.busy !== latest.busy) ? latest : item)) ?? current,
                )
              }
              onEnded={() => {
                setActive(null);
                void refresh();
              }}
            />
          ) : (
            <Text style={[styles.muted, { padding: 20 }]}>{opening || !terminals ? "Opening a Terminal..." : "No Terminal is open in this Chat."}</Text>
          )}
        </View>
        {shown && !paused && (
          <ScrollView
            horizontal
            keyboardShouldPersistTaps="always"
            showsHorizontalScrollIndicator={false}
            style={{ flexGrow: 0, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.surface }}
            contentContainerStyle={{ paddingHorizontal: 8, paddingTop: 6, paddingBottom: Math.max(insets.bottom, 6), gap: 6 }}
          >
            <KeyButton
              label="ctrl"
              held={ctrl}
              onPress={() => {
                const next = !ctrl;
                setCtrl(next);
                view.current?.holdCtrl(next);
              }}
            />
            {KEYS.map((key) => (
              <KeyButton key={key.label} label={key.label} onPress={() => view.current?.send(key.send)} />
            ))}
          </ScrollView>
        )}
      </KeyboardAvoidingView>
    </View>
  );
}

function KeyButton({ label, onPress, held = false }: { label: string; onPress(): void; held?: boolean }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label === "ctrl" ? "Control, for the next key" : label}
      accessibilityState={held ? { selected: true } : undefined}
      onPress={onPress}
      style={({ pressed }) => ({
        minWidth: 40,
        height: 34,
        paddingHorizontal: 10,
        borderRadius: 8,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: held ? colors.accent : pressed ? colors.hover : colors.inset,
      })}
    >
      <Text style={{ color: held ? colors.onAccent : colors.ink, fontSize: 14, fontFamily: "Menlo" }}>{label}</Text>
    </Pressable>
  );
}

function TerminalView({
  ref,
  client,
  terminal,
  onEnded,
  onCtrlUsed,
  onInfo,
}: {
  ref: Ref<ViewHandle>;
  client: Client;
  terminal: TerminalInfo;
  onEnded(): void;
  onCtrlUsed(): void;
  onInfo(terminal: TerminalInfo): void;
}) {
  const { colors, scheme } = useTheme();
  const styles = useStyles();
  const theme = useMemo<TerminalTheme>(() => {
    return {
      scheme,
      background: colors.page,
      ink: colors.ink,
      ink3: colors.ink3,
      accent: colors.accent,
      ansi: [...colors.ansi],
      cursor: colors.cursor,
      selection: colors.selection,
    };
  }, [colors, scheme]);
  const latestTheme = useRef(theme);
  const view = useRef<DomWebViewRef>(null);
  const follower = useRef<TerminalFollower | null>(null);
  const ready = useRef(false);
  const queued = useRef<string[]>([]);
  // Output the page has not parsed yet, by id: the follower's next read waits for it.
  const unwritten = useRef(new Map<number, () => void>());
  const writeId = useRef(0);
  const [uri, setUri] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const latestEnded = useRef(onEnded);
  const latestInfo = useRef(onInfo);
  useEffect(() => {
    latestEnded.current = onEnded;
    latestInfo.current = onInfo;
  }, [onEnded, onInfo]);

  const run = useCallback((script: string) => {
    if (!ready.current) {
      queued.current.push(script);
      return;
    }
    view.current?.injectJavaScript(`${script};true;`);
  }, []);

  // Settles once the page says xterm parsed it, or after a while without word (a reloaded page never answers).
  const draw = useCallback(
    (call: string, data: string) =>
      new Promise<void>((resolve) => {
        const id = ++writeId.current;
        const done = () => {
          clearTimeout(timer);
          unwritten.current.delete(id);
          resolve();
        };
        const timer = setTimeout(done, WRITE_ACK_MS);
        unwritten.current.set(id, done);
        run(`window.${call}(${scriptValue(data)},${id})`);
      }),
    [run],
  );
  const settleWrites = useCallback(() => {
    for (const done of unwritten.current.values()) done();
  }, []);

  useImperativeHandle(ref, () => ({
    send: (data) => follower.current?.send(data),
    holdCtrl: (held) => run(`window.terminalCtrl(${held})`),
  }));

  useEffect(() => {
    latestTheme.current = theme;
    run(`window.terminalTheme(${scriptValue(xtermTheme(theme))})`);
  }, [theme, run]);

  useEffect(() => {
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const file = new File(Paths.cache, `terminal-${token}.html`);
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      file.write(createTerminalHtml(latestTheme.current));
      setUri(file.uri);
    });
    // Output waits for the page: what arrives before it is ready is written once it is.
    const current = followTerminal({
      terminalId: terminal.id,
      api: {
        read: (request) => client.call("terminal:read", [request]),
        input: (request) => client.call("terminal:input", [request]),
        resize: (request) => client.call("terminal:resize", [request]),
      },
      write: (data) => draw("terminalWrite", data),
      reset: (data) => draw("terminalReset", data),
      // A read the phone parses in a few frames; a flood comes as many of them, or as a reset to its newest part.
      readLimit: PHONE_READ_LIMIT,
      ended: () => latestEnded.current(),
      // Each read carries what runs in front, so the tab's name follows a command as it starts and ends.
      info: (latest) => latestInfo.current(latest),
    });
    follower.current = current;
    return () => {
      cancelled = true;
      current.stop();
      settleWrites();
      follower.current = null;
      ready.current = false;
      queued.current = [];
      try {
        if (file.exists) file.delete();
      } catch {
        /* The OS may purge cache files. */
      }
    };
  }, [client, terminal.id, draw, settleWrites]);

  // The page is gone: what it was sent will never be answered, and what follows waits for the reloaded page.
  function stopped() {
    ready.current = false;
    settleWrites();
    setFailed(true);
  }

  if (failed)
    return (
      <View style={{ padding: 20, gap: 16 }}>
        <Text accessibilityRole="alert" style={{ color: colors.red }}>
          The Terminal view stopped. The Terminal is still running on your computer.
        </Text>
        <PillButton title="Reload" onPress={() => setFailed(false)} />
      </View>
    );
  if (!uri) return <Text style={[styles.muted, { padding: 20 }]}>Preparing Terminal...</Text>;
  return (
    <DomWebView
      key={uri}
      ref={view}
      source={{ uri }}
      style={{ flex: 1 }}
      containerStyle={{ flex: 1 }}
      useExpoModulesBridge={false}
      // The key bar replaces the WebView's own Previous/Next/Done bar above the keyboard.
      hideKeyboardAccessoryView
      scrollEnabled={false}
      bounces={false}
      automaticallyAdjustContentInsets={false}
      contentInsetAdjustmentBehavior="never"
      onMessage={(event) => {
        let message: TerminalViewMessage;
        try {
          message = JSON.parse(event.nativeEvent.data);
        } catch {
          return;
        }
        if (message.channel !== "milagre-terminal") return;
        if (message.event === "ready") {
          ready.current = true;
          for (const script of queued.current.splice(0)) view.current?.injectJavaScript(`${script};true;`);
          follower.current?.resize(message.cols, message.rows);
          view.current?.injectJavaScript("window.terminalFocus();true;");
        } else if (message.event === "input") follower.current?.send(message.data);
        else if (message.event === "resize") follower.current?.resize(message.cols, message.rows);
        else if (message.event === "ctrl-used") onCtrlUsed();
        else if (message.event === "wrote") unwritten.current.get(message.id)?.();
      }}
      onContentProcessDidTerminate={stopped}
      onRenderProcessGone={stopped}
    />
  );
}
