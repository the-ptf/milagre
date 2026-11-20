import { useCallback, useState } from "react";
import { Alert, Text, View } from "react-native";
import { router, Stack, useFocusEffect } from "expo-router";
import { ArrowRight01Icon, LibraryIcon, PaintBoardIcon } from "@hugeicons/core-free-icons";
import { designScope, isInteractiveDesign, libraryCardLine, type DesignLibraryEntry, type DesignLibraryPage } from "@milagre/shared/artifact";
import { useSession } from "./session";
import { allComputers } from "./all-computers";
import { useDesignLibrary } from "./design-library";
import { promptText } from "./text-prompt";
import { confirm } from "./confirm-store";
import { Icon } from "./icons";
import { lineHeight, radius, space, type } from "./design-tokens";
import { useTheme } from "./theme";
import { Chip, EmptyState, ErrorNotice, Group, PageScroll, PillButton, PullDown, useStyles, type MenuSection } from "./ui";

const ALL = "all";
const MOVE = "move:";

/** A design row's menu: open it, rename it, move it to another page or a new one, delete it. */
function libraryDesignSections(pages: DesignLibraryPage[], design: DesignLibraryEntry): MenuSection[] {
  return [
    {
      items: [
        { id: "open", title: "Open", systemImage: "eye" },
        { id: "rename", title: "Rename", systemImage: "pencil" },
        {
          id: "move",
          title: "Move to page",
          systemImage: "folder",
          submenu: [
            ...pages.map((page) => ({ id: `${MOVE}${page.id}`, title: page.name, checked: page.id === design.page })),
            { id: MOVE, title: "New page…", systemImage: "plus" },
          ],
        },
      ],
    },
    { items: [{ id: "delete", title: "Delete", systemImage: "trash", destructive: true }] },
  ];
}

type Caller = { call: <T>(method: string, args: unknown[]) => Promise<T> };

const failed = (title: string) => (error: unknown) => Alert.alert(title, error instanceof Error ? error.message : String(error));

/**
 * Does what a design row's menu `action` asks on the library of the Project at `projectPath`: asks for a name or a
 * confirmation first where it needs one. Resolves when the computer has made the change, or nothing was asked for.
 */
async function actOnLibraryDesign(source: Caller, projectPath: string, pages: DesignLibraryPage[], design: DesignLibraryEntry, action: string): Promise<void> {
  const scope = designScope(projectPath);
  if (action === "rename") {
    const title = (await promptText("Rename design", { value: design.title }))?.trim();
    if (title && title !== design.title)
      await source.call("design-library:update", [{ ...scope, id: design.id, title }]).catch(failed("Could not rename the design"));
  } else if (action.startsWith(MOVE)) {
    const id = action.slice(MOVE.length);
    const page = id
      ? pages.find((item) => item.id === id)?.name
      : (await promptText("New library page", { message: "Such as iPhone, Watch or Kit.", action: "Move" }))?.trim();
    if (page && id !== design.page) await source.call("design-library:update", [{ ...scope, id: design.id, page }]).catch(failed("Could not move the design"));
  } else if (action === "delete") {
    if (
      await confirm(
        `Delete ${design.title}?`,
        "It leaves the Project library for every Chat in this Project, with every version. Chats' own designs stay.",
        "Delete",
      )
    )
      await source.call("artifact:delete", [{ ...scope, id: design.id }]).catch(failed("Could not delete the design"));
  }
}

/** Renames the library page `page` after asking for its new name. */
async function renameLibraryPage(source: Caller, projectPath: string, page: DesignLibraryPage) {
  const name = (await promptText("Rename page", { value: page.name }))?.trim();
  if (name && name !== page.name)
    await source.call("design-library:rename-page", [{ ...designScope(projectPath), page: page.id, name }]).catch(failed("Could not rename the page"));
}

/**
 * A Project's Design library on the phone and iPad: its library pages as chips after All, a row per design with its
 * size, page and who saved it when. A row opens the design on the library canvas; holding it renames, moves or deletes it.
 */
export function DesignLibraryScreen({ hostId, path, name }: { hostId?: string; path?: string; name?: string }) {
  const styles = useStyles();
  const { colors } = useTheme();
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
  const [tab, setTab] = useState(ALL);
  const pages = library?.pages ?? [];
  const page = pages.find((item) => item.id === tab);
  const all = pages.flatMap((item) => item.designs.map((design) => ({ design, pageName: item.name })));
  const rows = page ? page.designs.map((design) => ({ design, pageName: undefined as string | undefined })) : all;
  const open = (design: DesignLibraryEntry) =>
    router.push({ pathname: "/artifact-sheet", params: { hostId: hostId ?? source?.url ?? "", projectPath: path ?? "", library: design.page, id: design.id } });
  const act = (design: DesignLibraryEntry, action: string) => {
    if (action === "open") open(design);
    else if (source && path) void actOnLibraryDesign(source, path, pages, design, action).then(reread);
  };
  return (
    <>
      <Stack.Screen options={{ title: "Design library", headerBackTitle: name }} />
      <PageScroll style={{ flex: 1 }} contentContainerStyle={{ gap: 12 }}>
        {name ? <Text style={styles.caption}>{name}</Text> : null}
        {!source || !path ? <ErrorNotice message="Reconnect to your computer to open this Project's Design library." /> : null}
        {pages.length > 0 && (
          <View accessibilityRole="radiogroup" style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {[{ id: ALL, name: "All", count: all.length }, ...pages.map((item) => ({ id: item.id, name: item.name, count: item.designs.length }))].map(
              (item) => (
                <Chip
                  key={item.id}
                  label={`${item.name} ${item.count}`}
                  accessibilityLabel={`${item.name}, ${item.count}`}
                  selected={(page ? page.id : ALL) === item.id}
                  onPress={() => setTab(item.id)}
                />
              ),
            )}
          </View>
        )}
        {library && !pages.length ? (
          <EmptyState icon={LibraryIcon} title="No designs in this Project's library yet">
            {
              "Add one from a design's actions in a Chat's Artifact, choosing Add to Project library, or ask an agent to add it. Every Chat in this Project can then open it."
            }
          </EmptyState>
        ) : null}
        {rows.length > 0 && (
          <Group title={page?.name} inset="full">
            {rows.map(({ design, pageName }) => (
              <PullDown
                key={design.id}
                label={`${design.title}. ${libraryCardLine(design, now)}`}
                title={design.title}
                onPress={() => open(design)}
                sections={libraryDesignSections(pages, design)}
                onSelect={(action) => act(design, action)}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: space.lg, minHeight: 64, paddingVertical: space.md }}>
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
                    <Icon icon={PaintBoardIcon} tone="ink2" size={18} />
                  </View>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text numberOfLines={1} style={[styles.text, { fontSize: type.callout, lineHeight: lineHeight.callout, fontWeight: "500" }]}>
                      {design.title}
                    </Text>
                    <Text numberOfLines={1} style={styles.caption}>
                      {[pageName, `${design.width} × ${design.height}`, isInteractiveDesign(design) ? "Interactive" : ""].filter(Boolean).join(" · ")}
                    </Text>
                    <Text numberOfLines={1} style={styles.caption}>
                      {libraryCardLine(design, now)}
                    </Text>
                  </View>
                  <Icon icon={ArrowRight01Icon} tone="ink3" size={16} />
                </View>
              </PullDown>
            ))}
          </Group>
        )}
        {page && source && path ? (
          <PillButton
            title="Rename page"
            secondary
            size="small"
            accessibilityLabel={`Rename the page ${page.name}`}
            onPress={() => void renameLibraryPage(source, path, page).then(reread)}
            style={{ alignSelf: "flex-start" }}
          />
        ) : null}
      </PageScroll>
    </>
  );
}
