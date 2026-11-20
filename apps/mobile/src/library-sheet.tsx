import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Text, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { DomWebViewRef } from "@expo/dom-webview";
import { Cancel01Icon, DashboardSquare01Icon, MoreHorizontalIcon, PlayIcon } from "@hugeicons/core-free-icons";
import {
  artifactDocument,
  designGroups,
  designScope,
  isInteractiveDesign,
  libraryEditLabel,
  type Artifact,
  type ArtifactSummary,
  type DesignLibraryEntry,
  type DesignLibraryPage,
} from "@milagre/shared/artifact";
import { ArtifactPageTitle, artifactPageMenu, useChatDesigns, usePageTabs } from "./artifact-page-menu";
import { artifactPageSections, readPageChoice, versionSections } from "./artifact-pages";
import { allComputers } from "./all-computers";
import { confirmSheet } from "./confirm-store";
import { loadCanvasDesign } from "./design-font-cache";
import { editLibraryDesign, libraryEditSections, useDesignLibrary } from "./design-library";
import { DesignsCanvas } from "./designs-sheet";
import { designHtmlIn, designModeLabel, designModeMenu, shownDesignMode } from "./design-modes-menu";
import type { DesignMode } from "@milagre/shared/design-modes";
import type { DesignsTab } from "./panel-tabs";
import { useSession } from "./session";
import { useTheme } from "./theme";
import { CircleButton, ErrorNotice, PullDown, SheetHeader, useStyles, type MenuSection } from "./ui";

type CanvasCommand = Record<string, unknown> & { t: string };

/**
 * A page of the Project library on the phone's Artifact sheet (or the iPad's panel tab): its designs on the same canvas
 * as the Chat's, always the latest library version unless a version is picked. Library designs take no comments or
 * choices yet; the actions pick a color mode, step through versions, rename a design, move it to another page and remove
 * it from the library for every Chat.
 * Opened from the Project's Design library page it has `projectPath` instead of a Chat, and reads any paired computer.
 */
export function LibrarySheet({
  hostId,
  chatId,
  projectPath,
  page: pageId,
  id,
  onClose,
  onPage,
}: {
  hostId?: string;
  chatId?: string;
  projectPath?: string;
  page?: string;
  id?: string;
  onClose?: () => void;
  onPage?: (target: DesignsTab) => void;
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  const { client, designs: feature, reconnects } = useSession();
  const insets = useSafeAreaInsets();
  const close = useCallback(() => (onClose ? onClose() : router.back()), [onClose]);
  const scopeKey = chatId ?? projectPath;
  const own = client && (!hostId || hostId === client.url) ? client : null;
  const matching = chatId ? own : projectPath ? (own ?? (hostId ? allComputers.clientFor(hostId) : null)) : null;
  const source = feature.enabled === true ? matching : null;
  const library = useDesignLibrary(source, scopeKey, reconnects);
  const page = library?.pages.find((item) => item.id === pageId);
  const rows = useMemo(() => designGroups(page?.designs ?? []), [page]);
  const ordered = useMemo(() => rows.flatMap((row) => row.designs), [rows]);
  const chatDesigns = useChatDesigns(source, chatId, reconnects, feature.enabled === true);
  const [htmlPage, setHtmlPage] = useState<ArtifactSummary | null>(null);
  useEffect(() => {
    if (!source || !chatId) return;
    let live = true;
    source
      .call<ArtifactSummary[]>("artifact:list", [{ chatId, format: "html" }])
      .then((list) => live && setHtmlPage((Array.isArray(list) && list.find((item) => item.format === "html")) || null))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [source, chatId, reconnects]);
  const pageTabs = usePageTabs(source, chatId, htmlPage);

  const [versions, setVersions] = useState<Record<string, number | null>>({});
  const [modes, setModes] = useState<Record<string, DesignMode>>({});
  const loaded = useLoadedDesigns(source, scopeKey, ordered, versions, reconnects);

  const canvas = useRef<DomWebViewRef>(null);
  const ready = useRef(false);
  const [epoch, setEpoch] = useState(0);
  const [view, setView] = useState<{ mode: "design" | "canvas"; id: string | null }>({ mode: "design", id: id ?? null });
  const [playing, setPlaying] = useState<string | null>(null);
  const overviewed = useRef(Boolean(id));
  const command = useCallback((message: CanvasCommand) => {
    if (!ready.current || !canvas.current) return;
    canvas.current.injectJavaScript(`window.milagreCanvas&&window.milagreCanvas.run(${JSON.stringify(message)});true;`);
  }, []);
  const layoutKey = JSON.stringify(
    rows.map((row) => ({ group: row.group ?? "", designs: row.designs.map((item) => ({ id: item.id, w: item.width, h: item.height })) })),
  );
  useEffect(() => {
    if (!ordered.length) return;
    command({ t: "set", rows: JSON.parse(layoutKey), focus: view.id ?? id, pad: { top: 0, bottom: insets.bottom }, ink: colors.ink3, accent: colors.accent });
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- a new focus moves the canvas through "focus", not a new layout.
  }, [layoutKey, insets.bottom, colors.ink3, colors.accent, command, epoch]);
  const sent = useRef(new Map<string, string>());
  const fonts = useRef(new Set<string>());
  useEffect(() => {
    if (!ready.current) return;
    for (const artifact of Object.values(loaded)) {
      if (artifact.format !== "design") continue;
      if (artifact.fontKey && artifact.fontCss && !fonts.current.has(artifact.fontKey)) {
        command({ t: "fonts", key: artifact.fontKey, css: artifact.fontCss });
        fonts.current.add(artifact.fontKey);
      }
      const key = `${artifact.version}:${artifact.html.length}:${artifact.fontKey ?? ""}:${shownDesignMode(artifact, modes[artifact.id])}`;
      if (sent.current.get(artifact.id) === key) continue;
      sent.current.set(artifact.id, key);
      const code = isInteractiveDesign(artifact);
      const font = artifact.fontKey;
      const doc = artifactDocument(designHtmlIn(artifact, modes[artifact.id]), { code });
      command({ t: "html", id: artifact.id, doc, ...(code ? { run: true } : {}), ...(font ? { font } : {}) });
    }
  }, [loaded, modes, command, epoch, layoutKey]);
  const onMessage = useCallback(
    (data: string) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }
      if (message?.t === "ready") {
        ready.current = true;
        sent.current.clear();
        fonts.current.clear();
        setPlaying(null);
        setEpoch((value) => value + 1);
      } else if (message?.t === "play") setPlaying(typeof message.id === "string" ? message.id : null);
      else if (message?.t === "view" && (message.mode === "design" || message.mode === "canvas") && typeof message.id === "string") {
        setView({ mode: message.mode, id: message.id });
        if (!overviewed.current) command({ t: "overview" });
        overviewed.current = true;
      }
    },
    [command],
  );

  const shownId = view.id ?? id ?? null;
  const shown = shownId ? loaded[shownId] : undefined;
  const summary = ordered.find((design) => design.id === shownId);
  const canvasMode = view.mode === "canvas";
  const latest = summary?.version ?? shown?.version ?? 1;
  const remove = (design: Artifact) =>
    confirmSheet(`Remove ${design.title} from the Project library?`, "It leaves the library for every Chat in this Project. Chats' own designs stay.", [
      {
        text: "Remove",
        style: "destructive",
        onPress: () => {
          if (!source || !scopeKey) return;
          const index = ordered.findIndex((item) => item.id === design.id);
          const next = ordered[index + 1] ?? ordered[index - 1];
          source
            .call("artifact:delete", [{ ...designScope(scopeKey), id: design.id }])
            .then(() => (next ? command({ t: "focus", id: next.id }) : close()))
            .catch((error: unknown) => Alert.alert("Could not remove the design", error instanceof Error ? error.message : String(error)));
        },
      },
      { text: "Cancel", style: "cancel" },
    ]);
  const menu: MenuSection[] = shown
    ? [
        ...designModeMenu(shown, modes[shown.id]),
        ...versionSections(latest, shown.version),
        ...libraryEditSections(library, summary),
        { items: [{ id: "remove", title: "Remove from Project library", systemImage: "trash", destructive: true }] },
      ]
    : [];
  const edit = (action: string) => {
    if (source && scopeKey && library && summary) void editLibraryDesign(source, scopeKey, library.pages, summary, action);
  };
  const act = (action: string) => {
    if (!shown) return;
    if (action === "remove") remove(shown);
    else if (action.startsWith("mode:")) setModes((current) => ({ ...current, [shown.id]: action.slice("mode:".length) as DesignMode }));
    else if (action.startsWith("version:")) {
      const number = Number(action.slice("version:".length));
      setVersions((current) => ({ ...current, [shown.id]: number >= latest ? null : number }));
    } else edit(action);
  };
  const pages = chatId
    ? artifactPageMenu({
        hostId,
        chatId,
        designs: chatDesigns,
        page: htmlPage && { id: htmlPage.id, title: htmlPage.title, tabs: pageTabs },
        library,
        current: { kind: "library", page: pageId ?? "" },
        onPage,
      })
    : projectPageMenu(library, pageId);
  const { title, subtitle } = libraryTitles({ page, count: ordered.length, summary, shown, canvasMode, chatId, mode: modes[shownId ?? ""] });
  const tryable = !canvasMode && shown && isInteractiveDesign(shown);

  return (
    <View style={{ flex: 1, paddingTop: insets.top, backgroundColor: colors.surface }}>
      <SheetHeader
        title={title}
        subtitle={subtitle}
        center={<ArtifactPageTitle title={title} subtitle={subtitle} sections={pages.sections} onSelect={pages.choose} />}
        leading={[
          !onClose && <CircleButton key="close" label="Close artifact" icon={Cancel01Icon} onPress={close} />,
          ordered.length > 0 && (
            <CircleButton
              key="overview"
              label={canvasMode ? "Open the design" : "All designs on this page"}
              icon={DashboardSquare01Icon}
              selected={canvasMode}
              onPress={() => command(canvasMode && shownId ? { t: "focus", id: shownId } : { t: "overview" })}
            />
          ),
        ].filter(Boolean)}
        trailing={[
          tryable && (
            <CircleButton
              key="try"
              label={playing === shown.id ? "Stop trying the design" : "Try the design"}
              icon={PlayIcon}
              selected={playing === shown.id}
              onPress={() => command({ t: "play", id: playing === shown.id ? null : shown.id })}
            />
          ),
          source && shown && !canvasMode && (
            <PullDown key="actions" label="Design actions" sections={menu} onSelect={act}>
              <CircleButton label="Design actions" icon={MoreHorizontalIcon} asTrigger />
            </PullDown>
          ),
        ].filter(Boolean)}
      />
      <View style={{ flex: 1 }}>
        {!matching ? (
          <Text style={[styles.muted, { padding: 16 }]}>Reconnect to your computer to open this page.</Text>
        ) : feature.enabled !== true ? (
          <View style={{ padding: 16 }}>
            {feature.error ? <ErrorNotice message={feature.error} retry={() => void feature.refresh()} retryTitle="Retry" /> : null}
          </View>
        ) : library && !page ? (
          <Text style={[styles.muted, { padding: 16 }]}>This library page has no designs now.</Text>
        ) : (
          <DesignsCanvas ref={canvas} onMessage={onMessage} />
        )}
      </View>
    </View>
  );
}

/** The Design library page's sheet: its title menu moves between the library's pages in place. */
function projectPageMenu(library: { pages: DesignLibraryPage[] } | null, pageId: string | undefined) {
  const pages = library?.pages ?? [];
  return {
    sections: artifactPageSections({ canvas: false, page: null, library: pages, current: { kind: "library", page: pageId ?? "" } }),
    choose: (id: string) => {
      const picked = readPageChoice(id);
      const shown = picked?.kind === "library" ? pages.find((item) => item.id === picked.page) : undefined;
      if (shown?.designs[0] && shown.id !== pageId) router.setParams({ library: shown.id, id: shown.designs[0].id });
    },
  };
}

type Source = Parameters<typeof loadCanvasDesign>[0];

/** The library designs on the page as the canvas draws them: each one's picked version, else its latest. */
function useLoadedDesigns(
  source: Source | null,
  scopeKey: string | undefined,
  ordered: DesignLibraryEntry[],
  versions: Record<string, number | null>,
  reconnects: number,
): Record<string, Artifact> {
  const [loaded, setLoaded] = useState<Record<string, Artifact>>({});
  const inFlight = useRef(new Set<string>());
  useEffect(() => {
    if (!source || !scopeKey) return;
    for (const design of ordered) {
      const target = versions[design.id] ?? design.version;
      const key = `${design.id}@${target}`;
      if (loaded[design.id]?.version === target || inFlight.current.has(key)) continue;
      inFlight.current.add(key);
      loadCanvasDesign(source, { ...designScope(scopeKey), id: design.id, version: target }, reconnects)
        .then((artifact) => setLoaded((current) => ({ ...current, [design.id]: artifact })))
        .catch(() => {})
        .finally(() => inFlight.current.delete(key));
    }
  }, [source, scopeKey, ordered, versions, loaded, reconnects]);
  return loaded;
}

function libraryTitles({
  page,
  count,
  summary,
  shown,
  canvasMode,
  chatId,
  mode,
}: {
  page: DesignLibraryPage | undefined;
  count: number;
  summary: DesignLibraryEntry | undefined;
  shown: Artifact | undefined;
  canvasMode: boolean;
  chatId: string | undefined;
  mode: DesignMode | undefined;
}) {
  if (canvasMode) return { title: page?.name ?? "Project library", subtitle: `Project library · ${count} ${count === 1 ? "design" : "designs"}` };
  return {
    title: summary?.title ?? shown?.title ?? "Project library",
    subtitle: [
      "Project library",
      shown ? `v${shown.version}` : "",
      isInteractiveDesign(shown) ? "Interactive" : "",
      designModeLabel(shown, mode),
      libraryEditLabel(shown, shown?.version, chatId),
    ]
      .filter(Boolean)
      .join(" · "),
  };
}
