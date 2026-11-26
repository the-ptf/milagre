import { useEffect, useMemo, useState } from "react";
import { Text, useWindowDimensions, View } from "react-native";
import { SvgXml } from "react-native-svg";
import { router } from "expo-router";
import { BubbleChatIcon, PaintBoardIcon } from "@hugeicons/core-free-icons";
import {
  DESIGNS_COPY,
  designDecisionLine,
  designDecisionSummary,
  designScope,
  libraryPagesBySource,
  type DesignLibrary,
  type DesignLibraryChat,
  type DesignSystemView,
} from "@milagre/shared/artifact";
import { addToLibrary, isLibraryAdd, libraryAddSections } from "./design-library";
import { radius, space } from "./design-tokens";
import { useTheme } from "./theme";
import { EmptyState, ErrorNotice, Group, PullDown, useStyles } from "./ui";

type Caller = { call: <T>(method: string, args: unknown[]) => Promise<T> };
const METHODS = { system: "design-system:read", chats: "design-library:chats" } as const;

/** One read of the Designs page, done again whenever `reads` moves (focus, a library change, Try again). */
function useDesignsRead<T>(source: Caller | null, path: string | undefined, kind: keyof typeof METHODS, reads: number) {
  const [state, setState] = useState<{ value: T | null; error: string }>({ value: null, error: "" });
  useEffect(() => {
    if (!source || !path) return;
    let live = true;
    source
      .call<T>(METHODS[kind], [designScope(path)])
      .then((value) => live && setState({ value, error: "" }))
      .catch((error: unknown) => live && setState((current) => ({ value: current.value, error: error instanceof Error ? error.message : String(error) })));
    return () => {
      live = false;
    };
  }, [source, path, kind, reads]);
  return state;
}

/** The phone's Design system section: the board the host draws, then the decision log, newest first. */
export function DesignSystemSection({
  source,
  path,
  reads,
  now,
  onRetry,
}: {
  source: Caller | null;
  path?: string;
  reads: number;
  now: number;
  onRetry: () => void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const { value, error } = useDesignsRead<DesignSystemView>(source, path, "system", reads);
  if (!value && error) return <EmptyState title={DESIGNS_COPY.failed} action={{ title: "Try again", onPress: onRetry }} />;
  if (!value) return null;
  if (value.state === "frozen")
    return (
      <View accessibilityRole="alert" style={{ padding: space.lg, borderRadius: radius.card, borderCurve: "continuous", backgroundColor: colors.orangeTint }}>
        <Text style={[styles.text, { fontWeight: "600" }]}>{DESIGNS_COPY.frozenTitle}</Text>
        <Text style={styles.caption}>
          {DESIGNS_COPY.frozenBody}
          {` ${DESIGNS_COPY.frozenHint}`}
        </Text>
      </View>
    );
  if (value.state === "none")
    return (
      <EmptyState icon={PaintBoardIcon} title={DESIGNS_COPY.noSystemTitle}>
        {DESIGNS_COPY.noSystemBody}
      </EmptyState>
    );
  const shown = Math.min(width - space.lg * 2, value.width);
  return (
    <View style={{ gap: space.lg }}>
      <View
        accessibilityLabel={`${value.kit.title} design system, version ${value.kit.version}`}
        style={{ borderRadius: radius.card, borderCurve: "continuous", overflow: "hidden", backgroundColor: colors.paper }}
      >
        <SvgXml xml={value.svg} width={shown} height={(shown * value.height) / value.width} />
      </View>
      <Group title={DESIGNS_COPY.decisions} inset="full">
        {value.history.map((entry) => (
          <View key={entry.version} style={{ paddingVertical: space.md, gap: 2 }}>
            <Text style={[styles.text, { fontWeight: "600", color: entry.decision ? colors.ink : colors.ink3 }]}>{designDecisionSummary(entry)}</Text>
            {entry.decision?.reason ? <Text style={styles.caption}>{entry.decision.reason}</Text> : null}
            <Text style={styles.caption}>{designDecisionLine(entry, now)}</Text>
          </View>
        ))}
      </Group>
    </View>
  );
}

/** The phone's Chats section: each Chat's designs, archived Chats last; a design opens in its Chat or goes to the library. */
export function DesignChatsSection({
  source,
  hostId,
  path,
  reads,
  library,
  onChanged,
}: {
  source: Caller | null;
  hostId: string;
  path?: string;
  reads: number;
  library: DesignLibrary | null;
  onChanged: () => void;
}) {
  const styles = useStyles();
  const { value, error } = useDesignsRead<DesignLibraryChat[]>(source, path, "chats", reads);
  const inLibrary = useMemo(() => libraryPagesBySource(library), [library]);
  if (!value && error) return <ErrorNotice message={error} />;
  if (!value) return null;
  if (!value.length)
    return (
      <EmptyState icon={BubbleChatIcon} title={DESIGNS_COPY.noChatsTitle}>
        {DESIGNS_COPY.noChatsBody}
      </EmptyState>
    );
  return (
    <>
      {value.map((chat) => (
        <Group key={chat.chatId} title={chat.archived ? `${DESIGNS_COPY.archived} · ${chat.title}` : chat.title} inset="full">
          {chat.designs.map((design) => {
            const page = inLibrary.get(`${chat.chatId}\n${design.id}`);
            return (
              <PullDown
                key={design.id}
                title={design.title}
                label={`${design.title}, version ${design.version}${page ? `, ${DESIGNS_COPY.inLibrary(page)}` : ""}`}
                onPress={() => router.push({ pathname: "/artifact-sheet", params: { hostId, chatId: chat.chatId, id: design.id } })}
                sections={page ? [] : libraryAddSections(library)}
                onSelect={(action) => {
                  if (!source || !library || !isLibraryAdd(action)) return;
                  void addToLibrary(source, action, library.pages, { chatId: chat.chatId, designId: design.id }).then((entry) => entry && onChanged());
                }}
              >
                <View style={{ minHeight: 48, justifyContent: "center", paddingVertical: space.sm }}>
                  <Text numberOfLines={1} style={styles.text}>
                    {design.title}
                  </Text>
                  <Text numberOfLines={1} style={styles.caption}>
                    {[`v${design.version}`, page ? DESIGNS_COPY.inLibrary(page) : ""].filter(Boolean).join(" · ")}
                  </Text>
                </View>
              </PullDown>
            );
          })}
        </Group>
      ))}
    </>
  );
}
