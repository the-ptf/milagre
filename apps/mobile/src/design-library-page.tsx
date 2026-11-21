import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { router, Stack, useFocusEffect } from "expo-router";
import { ArrowRight01Icon, DashboardSquare01Icon, LibraryIcon, PaintBoardIcon } from "@hugeicons/core-free-icons";
import { designScope, libraryCardLine, libraryRecent, libraryRecentLine, type DesignLibrary, type DesignLibraryEntry } from "@milagre/shared/artifact";
import { useSession } from "./session";
import { allComputers } from "./all-computers";
import { editLibraryDesign, libraryEditSections, renameLibraryPage, useDesignLibrary } from "./design-library";
import { confirm } from "./confirm-store";
import { Icon } from "./icons";
import { lineHeight, radius, space, type } from "./design-tokens";
import { useTheme } from "./theme";
import { LibrarySheet } from "./library-sheet";
import { useSplitLayout } from "./split-context";
import { EmptyState, ErrorNotice, Group, PageScroll, PullDown, useStyles, type MenuSection } from "./ui";

const RECENT = 6;
const PAGE_SECTIONS: MenuSection[] = [{ items: [{ id: "rename-page", title: "Rename page", systemImage: "pencil" }] }];

/** A recent edit's menu: rename it, move it to another page or a new one, delete it. */
function recentSections(library: DesignLibrary, design: DesignLibraryEntry): MenuSection[] {
  return [...libraryEditSections(library, design), { items: [{ id: "delete", title: "Delete", systemImage: "trash", destructive: true }] }];
}

type Caller = { call: <T>(method: string, args: unknown[]) => Promise<T> };

/** Deletes a library design for every Chat in the Project at `projectPath`, after asking. */
async function deleteLibraryDesign(source: Caller, projectPath: string, design: DesignLibraryEntry) {
  const sure = await confirm(
    `Delete ${design.title}?`,
    "It leaves the Project library for every Chat in this Project, with every version. Chats' own designs stay.",
    "Delete",
  );
  if (sure)
    await source
      .call("artifact:delete", [{ ...designScope(projectPath), id: design.id }])
      .catch((error: unknown) => Alert.alert("Could not delete the design", error instanceof Error ? error.message : String(error)));
}

/**
 * A Project's Design library on the phone and iPad: its library pages, each opening on the library canvas with its
 * designs side by side, and its most recent edits, each opening that design. Holding a page renames it; holding a
 * recent edit renames, moves or deletes it.
 */
export function DesignLibraryScreen({
  hostId,
  path,
  name,
  page: pageParam,
  id: idParam,
}: {
  hostId?: string;
  path?: string;
  name?: string;
  page?: string;
  id?: string;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const wide = useSplitLayout().widthClass !== "compact";
  const sheetInsets = useMemo(() => ({ ...insets, top: 0 }), [insets]);
  const { client } = useSession();
  const source = hostId && client?.url === hostId ? client : hostId ? allComputers.clientFor(hostId) : client;
  const [reads, setReads] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const reread = useCallback(() => {
    setReads((count) => count + 1);
    setNow(Date.now());
  }, []);
  useFocusEffect(reread);
  const library = useDesignLibrary(source, path, reads);
  const pages = library?.pages ?? [];
  const recent = libraryRecent(library, RECENT);
  const sheetHost = hostId ?? source?.url ?? "";
  const shownPage = pages.find((item) => item.id === pageParam) ?? pages[0];
  const shownId = shownPage && shownPage.id === pageParam ? idParam : undefined;
  const open = (page: string, id?: string) =>
    wide
      ? router.setParams({ library: page, id: id ?? "" })
      : router.push({ pathname: "/artifact-sheet", params: { hostId: sheetHost, projectPath: path ?? "", library: page, ...(id ? { id } : {}) } });
  const act = async (design: DesignLibraryEntry, action: string) => {
    if (!source || !path) return;
    if (action === "delete") await deleteLibraryDesign(source, path, design);
    else await editLibraryDesign(source, path, pages, design, action);
    reread();
  };
  const lists = (
    <PageScroll style={{ flex: 1 }} contentContainerStyle={{ gap: 12 }}>
      {name ? <Text style={styles.caption}>{name}</Text> : null}
      {!source || !path ? <ErrorNotice message="Reconnect to your computer to open this Project's Design library." /> : null}
      {library && !pages.length ? (
        <EmptyState icon={LibraryIcon} title="No designs in this Project's library yet">
          {
            "Add one from a design's actions in a Chat's Artifact, choosing Add to Project library, or ask an agent to add it. Every Chat in this Project can then open it."
          }
        </EmptyState>
      ) : null}
      {pages.length > 0 && (
        <Group title="Pages" inset="full">
          {pages.map((page) => (
            <PullDown
              key={page.id}
              label={`${page.name}, ${page.designs.length === 1 ? "1 design" : `${page.designs.length} designs`}`}
              title={page.name}
              onPress={() => open(page.id)}
              sections={PAGE_SECTIONS}
              onSelect={() => source && path && void renameLibraryPage(source, path, page).then(reread)}
            >
              <LibraryRow
                selected={wide && shownPage?.id === page.id && !shownId}
                icon={DashboardSquare01Icon}
                title={page.name}
                caption={page.designs.length === 1 ? "1 design" : `${page.designs.length} designs`}
              />
            </PullDown>
          ))}
        </Group>
      )}
      {recent.length > 0 && (
        <Group title="Recent edits" inset="full">
          {recent.map(({ design, page }) => (
            <PullDown
              key={design.id}
              label={`${design.title}. ${page.name} · ${libraryCardLine(design, now)}`}
              title={design.title}
              onPress={() => open(page.id, design.id)}
              sections={recentSections({ pages }, design)}
              onSelect={(action) => void act(design, action)}
            >
              <LibraryRow
                selected={wide && shownId === design.id}
                icon={PaintBoardIcon}
                title={design.title}
                caption={`${page.name} · ${libraryRecentLine(design, now)}`}
              />
            </PullDown>
          ))}
        </Group>
      )}
    </PageScroll>
  );
  return (
    <>
      <Stack.Screen options={{ title: "Design library", headerBackTitle: name }} />
      {wide && shownPage && path ? (
        <View style={{ flex: 1, flexDirection: "row" }}>
          <View style={{ width: 340, borderRightWidth: StyleSheet.hairlineWidth, borderColor: colors.line }}>{lists}</View>
          <View style={{ flex: 1 }}>
            <SafeAreaInsetsContext.Provider value={sheetInsets}>
              <LibrarySheet
                key={`${shownPage.id}:${shownId ?? ""}`}
                hostId={sheetHost}
                projectPath={path}
                page={shownPage.id}
                id={shownId || undefined}
                onClose={() => {}}
              />
            </SafeAreaInsetsContext.Provider>
          </View>
        </View>
      ) : (
        lists
      )}
    </>
  );
}

function LibraryRow({
  icon,
  title,
  caption,
  selected = false,
}: {
  icon: Parameters<typeof Icon>[0]["icon"];
  title: string;
  caption: ReactNode;
  selected?: boolean;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  return (
    <View
      accessibilityState={{ selected }}
      style={[
        { flexDirection: "row", alignItems: "center", gap: space.lg, minHeight: 56, paddingVertical: space.md },
        selected && { backgroundColor: colors.hover, marginHorizontal: -space.lg, paddingHorizontal: space.lg },
      ]}
    >
      <View
        style={{
          width: 36,
          height: 36,
          borderRadius: radius.control,
          borderCurve: "continuous",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.canvas,
        }}
      >
        <Icon icon={icon} tone="ink2" size={18} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text numberOfLines={1} style={[styles.text, { fontSize: type.callout, lineHeight: lineHeight.callout, fontWeight: "500" }]}>
          {title}
        </Text>
        <Text numberOfLines={1} style={styles.caption}>
          {caption}
        </Text>
      </View>
      <Icon icon={ArrowRight01Icon} tone="ink3" size={16} />
    </View>
  );
}
