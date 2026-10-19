import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, RefreshControl, Text, View } from "react-native";
import { Redirect, Stack, router, type Href } from "expo-router";
import { ArrowRight01Icon, GitBranchIcon, Link04Icon } from "@hugeicons/core-free-icons";
import { linkedEndLabel, type CanvasLink, type LinkEnd } from "@milagre/shared/chat-links";
import {
  canvasAttention,
  canvasFilterCounts,
  canvasStatus,
  canvasWorktrees,
  matchesCanvasFilter,
  type CanvasChat,
  type CanvasFilter,
  type CanvasMark,
  type CanvasTone,
  type CanvasWorktree,
} from "@milagre/shared/canvas";
import { useSession } from "../session";
import { useLinks } from "../use-links";
import { useAttention } from "../attention";
import { endNamer } from "../chat-links";
import { ChatMarkIcon } from "../status-indicators";
import { chatActivity } from "@milagre/shared/chat-activity";
import { Icon, ProviderLogo } from "../icons";
import { ProjectIcon } from "../project-icon";
import { ErrorNotice, PageScroll, useStyles } from "../ui";
import { useTheme, type Palette } from "../theme";

const FILTERS: Array<{ id: CanvasFilter; label: string; dot?: "orange" | "accent" }> = [
  { id: "all", label: "All" },
  { id: "needs-you", label: "Needs you", dot: "orange" },
  { id: "running", label: "Running", dot: "accent" },
];

/** The other end of each Link that `matches`, named the way the sidebar names it. */
function linkLabels(links: readonly CanvasLink[], matches: (end: LinkEnd) => boolean, names: ReturnType<typeof endNamer>) {
  return links.flatMap((link) => {
    if (matches(link.a)) return [linkedEndLabel(link.b, names(link.b))];
    if (matches(link.b)) return [linkedEndLabel(link.a, names(link.a))];
    return [];
  });
}

const toneColor = (colors: Palette, tone: CanvasTone) => (tone === "accent" ? colors.accentInk : tone === "ink3" ? colors.ink2 : colors[tone]);

type Row = CanvasChat & { sharedLinkId?: string };
type Section = { path: string; name: string; worktrees: Array<CanvasWorktree & { rows: Row[]; linked: string[] }>; linked: string[] };

/**
 * The phone's Projects canvas: the chats the sidebar lists, by Project, a card per Worktree, each chat with what it's
 * doing now, and the Links between them written out on the cards (desktop draws them as lines).
 */
export default function CanvasScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const session = useSession();
  const links = useLinks(session.client);
  const attention = useAttention();
  const { cachedProject, previewProject, reloadProjects } = session;
  const [filter, setFilter] = useState<CanvasFilter>("all");
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, []);
  const currentPath = session.snapshot?.project.path;
  const copyOf = useCallback(
    (path: string) => (path === currentPath && session.snapshot ? session.snapshot : cachedProject(path)),
    [currentPath, session.snapshot, cachedProject],
  );
  // The sidebar's Projects, hidden ones out; a named Link's conversation shows on its member Projects' cards.
  const listed = useMemo(() => session.recent.filter((item) => !item.hidden && !item.link), [session.recent]);
  const load = useCallback(
    () =>
      Promise.all(
        listed.map((item) =>
          previewProject(item.path).then(
            () => alive.current && setRevision((value) => value + 1),
            (e: Error) => alive.current && setError(e.message),
          ),
        ),
      ),
    [listed, previewProject],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError("");
    try {
      await Promise.all([reloadProjects(), links.refresh(), load()]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if (alive.current) setRefreshing(false);
    }
  }, [reloadProjects, links, load]);

  const sections = useMemo(() => {
    const waitingKeys = new Set(attention);
    const names = endNamer(
      links.projects,
      (projectPath, worktreePath) => Object.values(copyOf(projectPath)?.project.state.worktrees ?? {}).find((worktree) => worktree.path === worktreePath)?.name,
    );
    const result: Section[] = [];
    for (const item of listed) {
      const copy = copyOf(item.path);
      if (!copy) continue;
      const markOf = (id: number, unread: boolean): CanvasMark => {
        const run = copy.runs.runs[`${item.path}#${id}`];
        if (run?.questions.length) return "question";
        if (run?.approvals.length || waitingKeys.has(`${item.path}#${id}`)) return "waiting";
        if (run) return "running";
        if (chatActivity(copy.project.state.sessions[id], run).activity === "background") return "background";
        return unread ? "unread" : "idle";
      };
      const projectId = links.available ? links.projectIdOf(item.path) : undefined;
      const worktrees = canvasWorktrees(copy.project.state, markOf).map((worktree) => ({
        ...worktree,
        rows: worktree.sharedChat
          ? [
              ...worktree.chats,
              { id: worktree.sharedChat.sessionId, title: "Shared Link Chat", mark: "idle" as const, failed: false, sharedLinkId: worktree.sharedChat.linkId },
            ]
          : worktree.chats,
        linked: projectId ? linkLabels(links.links, (end) => end.project_id === projectId && end.worktree_path === worktree.path, names) : [],
      }));
      const linked = projectId ? linkLabels(links.links, (end) => end.project_id === projectId && !end.worktree_path, names) : [];
      if (!worktrees.length && !linked.length) continue;
      result.push({ path: item.path, name: item.name || item.path.split("/").at(-1) || "Project", worktrees, linked });
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- revision changes when a cached Project does.
  }, [listed, copyOf, links, attention, revision]);
  const counts = useMemo(() => canvasFilterCounts(sections.flatMap((section) => section.worktrees)), [sections]);
  const loading = !sections.length && listed.some((item) => !copyOf(item.path));

  // A chat opens the way the sidebar opens one: as the screen the phone goes back to the sidebar from.
  const open = (projectPath: string, id: number) => {
    if (!session.client) return;
    const href: Href = { pathname: "/chat", params: { projectPath, hostId: session.client.url, id: String(id) } };
    if (router.canDismiss()) router.dismissAll();
    router.replace(href);
  };

  if (!session.client) return <Redirect href="/" />;
  const total = counts.all;
  return (
    <>
      <Stack.Screen options={{ title: "Canvas" }} />
      <PageScroll refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}>
        <View accessibilityRole="radiogroup" accessibilityLabel="Show chats" style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
          {FILTERS.map((item) => {
            const selected = filter === item.id;
            return (
              <Pressable
                key={item.id}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected }}
                accessibilityLabel={`${item.label}, ${counts[item.id]}`}
                onPress={() => setFilter(item.id)}
                style={({ pressed }) => ({
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 6,
                  height: 34,
                  paddingHorizontal: 14,
                  borderRadius: 17,
                  borderCurve: "continuous",
                  backgroundColor: selected ? colors.ink : colors.surface,
                  borderWidth: selected ? 0 : 1,
                  borderColor: colors.line,
                  opacity: pressed ? 0.7 : 1,
                })}
              >
                {item.dot && <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: colors[item.dot] }} />}
                <Text style={{ color: selected ? colors.onInk : colors.ink, fontSize: 14, fontWeight: selected ? "600" : "500" }}>
                  {item.label} {counts[item.id]}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {error ? <ErrorNotice message={error} retry={() => void refresh()} retryTitle="Reload" /> : null}
        {loading ? (
          <Text style={styles.muted}>Loading Projects…</Text>
        ) : !total && !sections.length ? (
          <Text style={styles.muted}>No active chats. Chats the sidebar shows appear here.</Text>
        ) : null}
        {sections.map((section) => {
          const cards = section.worktrees.filter((worktree) => filter === "all" || worktree.chats.some((chat) => matchesCanvasFilter(chat.mark, filter)));
          if (!cards.length && filter !== "all") return null;
          const chatCount = section.worktrees.reduce((count, worktree) => count + worktree.rows.length, 0);
          return (
            <View key={section.path} style={{ gap: 10 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <ProjectIcon client={session.client} path={section.path} size={20} />
                <Text accessibilityRole="header" numberOfLines={1} style={{ color: colors.ink, fontSize: 15, fontWeight: "600", flexShrink: 1 }}>
                  {section.name}
                </Text>
                <Text style={{ color: colors.ink2, fontSize: 13 }}>{chatCount === 1 ? "1 chat" : `${chatCount} chats`}</Text>
                <View style={{ flex: 1 }} />
                {section.linked.map((label) => (
                  <LinkChip key={label} label={label} />
                ))}
              </View>
              {cards.map((worktree) => (
                <Card
                  key={worktree.path}
                  worktree={worktree}
                  now={now}
                  onOpen={(row) => open(row.sharedLinkId ? `milagre-link:${row.sharedLinkId}` : section.path, row.id)}
                />
              ))}
            </View>
          );
        })}
      </PageScroll>
    </>
  );
}

function LinkChip({ label, wide = false }: { label: string; wide?: boolean }) {
  const { colors } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={`Linked to ${label}`}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        height: 24,
        paddingHorizontal: 9,
        borderRadius: 12,
        backgroundColor: colors.hover,
        maxWidth: wide ? "100%" : 200,
      }}
    >
      <Icon icon={Link04Icon} tone="ink2" size={12} />
      <Text numberOfLines={1} style={{ color: colors.ink2, fontSize: 12, fontWeight: "500", flexShrink: 1 }}>
        {label}
      </Text>
    </View>
  );
}

function Diff({ diff }: { diff?: CanvasWorktree["diff"] }) {
  const { colors } = useTheme();
  if (!diff || (!diff.added && !diff.removed)) return null;
  return (
    <Text style={{ fontSize: 12, fontVariant: ["tabular-nums"] }}>
      <Text style={{ color: colors.add }}>+{diff.added}</Text> <Text style={{ color: colors.remove }}>−{diff.removed}</Text>
    </Text>
  );
}

function Card({ worktree, now, onOpen }: { worktree: CanvasWorktree & { rows: Row[]; linked: string[] }; now: number; onOpen: (row: Row) => void }) {
  const { colors } = useTheme();
  const attention = canvasAttention(worktree.rows);
  const single = worktree.rows.length === 1;
  return (
    <View
      style={{
        backgroundColor: colors.surface,
        borderRadius: 16,
        borderCurve: "continuous",
        borderWidth: attention ? 1.5 : 1,
        borderColor: attention === "waiting" ? colors.orange : attention === "question" ? colors.accent : colors.line,
        paddingHorizontal: 14,
        paddingVertical: 4,
      }}
    >
      {worktree.rows.map((row, index) => {
        const status = row.sharedLinkId ? { label: "The Link's shared conversation", tone: "ink3" as const } : canvasStatus(row, now);
        const mark = row.mark === "idle" && row.failed ? "failed" : row.mark === "delegated" ? "running" : row.mark;
        return (
          <View key={`${row.sharedLinkId ? "shared" : "chat"}:${row.id}`}>
            {index > 0 && <View style={{ height: 1, backgroundColor: colors.line }} />}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${row.title}, ${status.label}${single ? `, ${worktree.branch}` : ""}`}
              onPress={() => onOpen(row)}
              style={({ pressed }) => ({ paddingVertical: 10, gap: 4, opacity: pressed ? 0.6 : 1 })}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                <View style={{ width: 16, alignItems: "center" }}>
                  <ChatMarkIcon mark={mark} />
                </View>
                <Text numberOfLines={1} style={{ flex: 1, color: colors.ink, fontSize: 16, fontWeight: "600" }}>
                  {row.title}
                </Text>
                <Icon icon={ArrowRight01Icon} tone="ink3" size={16} />
              </View>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: 26 }}>
                <Text numberOfLines={1} style={{ color: toneColor(colors, status.tone), fontSize: 13, fontWeight: "500", flexShrink: 0 }}>
                  {status.label}
                </Text>
                {single && (
                  <Text numberOfLines={1} style={{ color: colors.ink3, fontSize: 13, flexShrink: 1 }}>
                    · {worktree.branch}
                  </Text>
                )}
                <View style={{ flex: 1 }} />
                {single && <Diff diff={worktree.diff} />}
                {row.provider && <ProviderLogo provider={row.provider} size={13} />}
              </View>
            </Pressable>
          </View>
        );
      })}
      {!single && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: 26, paddingBottom: 10 }}>
          <Icon icon={GitBranchIcon} tone="ink3" size={13} />
          <Text numberOfLines={1} style={{ flex: 1, color: colors.ink2, fontSize: 12 }}>
            {worktree.branch}
          </Text>
          <Diff diff={worktree.diff} />
        </View>
      )}
      {worktree.linked.length > 0 && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, paddingLeft: 26, paddingBottom: 10 }}>
          {worktree.linked.map((label) => (
            <LinkChip key={label} label={label} wide />
          ))}
        </View>
      )}
    </View>
  );
}
