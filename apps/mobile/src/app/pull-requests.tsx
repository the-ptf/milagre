import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import { Linking, Platform, RefreshControl, Text, View } from "react-native";
import { Stack, router } from "expo-router";
import * as Haptics from "expo-haptics";
import { GitPullRequestIcon, SlidersHorizontalIcon } from "@hugeicons/core-free-icons";
import { filterPullRequests, groupPullRequests, sortPullRequests, type PullRequestRow } from "@milagre/shared/pull-request-list";
import { useSession } from "../session";
import { usePullRequests } from "../use-pull-requests";
import { useOrchestrator } from "../use-orchestrator";
import { useOrchestratorBoard } from "../use-orchestrator-board";
import { useActivityClock } from "../chat-row-store";
import { openPullRequest } from "../pr-nav";
import { PullRequestRowSkeleton, PullRequestRowView } from "../pull-request-row";
import { PullRequestSearch, useSearchBottomInset } from "../pull-request-search";
import { StartedToast } from "../orchestrator-overlays";
import {
  PULL_REQUESTS_DEFAULTS,
  RESET_FILTERS,
  activeFilterCount,
  applyFilterChoice,
  mentionsUrl,
  pullRequestFilterGroups,
  reviewPrompt,
  reviewingUrls,
  type FilterGroup,
  type PullRequestsSettings,
} from "../pull-requests-page";
import { Icon } from "../icons";
import { EmptyState, ErrorNotice, Group, PageScroll, PullDown, useStyles } from "../ui";
import { radius, space, type } from "../design-tokens";
import { useTheme } from "../theme";

let remembered = PULL_REQUESTS_DEFAULTS;
const NO_TASKS: never[] = [];
const EMPTY_TEXT = {
  open: "No open pull requests in your Projects' repositories",
  merged: "No merged pull requests in your Projects' repositories",
  closed: "No closed pull requests in your Projects' repositories",
  all: "No pull requests in your Projects' repositories",
};

function open(row: PullRequestRow) {
  const project = row.projects.find((entry) => entry.computerId === row.computerId) ?? row.projects[0];
  if (!project) {
    void Linking.openURL(row.url).catch(() => {});
    return;
  }
  openPullRequest({ host: project.computerId, cwd: project.cwd, number: String(row.number), projectName: project.name, projectPath: project.path });
}

export default function PullRequestsScreen() {
  const styles = useStyles();
  const session = useSession();
  const [settings, setSettings] = useState<PullRequestsSettings>(remembered);
  const [query, setQuery] = useState("");
  const search = useDeferredValue(query);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [sending, setSending] = useState<ReadonlySet<string>>(() => new Set());
  const [toast, setToast] = useState<{ id: string } | null>(null);
  const data = usePullRequests(settings.filters.state);
  const now = useActivityClock(true);
  const bottomInset = useSearchBottomInset();
  const orchestrator = useOrchestrator(session.client);
  const enabled = !!orchestrator.snapshot?.settings.enabled;
  const color = orchestrator.snapshot?.settings.mascotColor ?? "";
  const allTasks = orchestrator.snapshot?.tasks ?? NO_TASKS;
  const requested = useMemo(() => data.rows.filter((row) => row.reviewRequested).map((row) => row.url), [data.rows]);
  const reviewTasks = useMemo(
    () => (enabled ? allTasks.filter((task) => requested.some((url) => mentionsUrl(task.prompt, url))) : NO_TASKS),
    [enabled, allTasks, requested],
  );
  const board = useOrchestratorBoard(reviewTasks);
  const reviewing = useMemo(() => reviewingUrls(requested, board.items), [requested, board.items]);
  const groups = useMemo(
    () => groupPullRequests(sortPullRequests(filterPullRequests(data.rows, settings.filters, search), settings.sort)),
    [data.rows, settings, search],
  );
  const menu = useMemo(() => pullRequestFilterGroups(settings, data.rows), [settings, data.rows]);
  const count = activeFilterCount(settings);
  const choose = useCallback((id: string) => setSettings((current) => applyFilterChoice(current, id)), []);
  useEffect(() => {
    remembered = settings;
  }, [settings]);
  const hideToast = useCallback(() => setToast(null), []);

  async function reviewForMe(row: PullRequestRow) {
    const store = orchestrator.store;
    if (!store) return;
    setError("");
    setSending((current) => new Set(current).add(row.url));
    try {
      const task = await store.send(reviewPrompt(row));
      if (Platform.OS === "ios") void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      if (task?.id) setToast({ id: task.id });
    } catch (failure) {
      setError(failure instanceof Error && failure.message ? failure.message : "Couldn't send this to the Orchestrator.");
    } finally {
      setSending((current) => {
        const next = new Set(current);
        next.delete(row.url);
        return next;
      });
    }
  }

  const noComputer = !data.computers;
  const filtered = data.rows.length > 0 && !groups.length;
  return (
    <View style={styles.screen}>
      <FiltersButton groups={menu} count={count} onSelect={choose} />
      <PageScroll
        style={{ flex: 1 }}
        contentContainerStyle={{ gap: space.lg, paddingBottom: bottomInset }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void data.refresh().finally(() => setRefreshing(false));
            }}
          />
        }
      >
        {data.error ? <ErrorNotice message={data.error} retry={() => void data.refresh()} retryTitle="Reload" /> : null}
        {error ? <ErrorNotice message={error} /> : null}
        {noComputer ? (
          <EmptyState icon={GitPullRequestIcon} title="Connect to a computer">
            Open a computer from the list to see its Projects&apos; pull requests.
          </EmptyState>
        ) : data.older && !data.rows.length ? (
          <EmptyState icon={GitPullRequestIcon} title="Update Milagre on your computer">
            Its Milagre is older than the Pull requests page.
          </EmptyState>
        ) : !data.loaded && !data.rows.length ? (
          <Group inset="full">
            {[0, 1, 2, 3].map((index) => (
              <PullRequestRowSkeleton key={index} />
            ))}
          </Group>
        ) : !data.rows.length ? (
          <EmptyState icon={GitPullRequestIcon} title={EMPTY_TEXT[settings.filters.state]} />
        ) : filtered ? (
          <EmptyState
            icon={GitPullRequestIcon}
            title="No pull requests match"
            action={
              count || query
                ? {
                    title: count ? "Reset filters" : "Clear search",
                    onPress: () => (count ? choose(RESET_FILTERS) : setQuery("")),
                  }
                : undefined
            }
          />
        ) : (
          groups.map((group) => (
            <Group key={group.id} title={group.label} inset="full">
              {group.items.map((row) => (
                <PullRequestRowView
                  key={row.url}
                  row={row}
                  now={now}
                  computer={data.names.get(row.computerId) ?? "Computer"}
                  review={
                    enabled && row.reviewRequested && row.state === "OPEN"
                      ? {
                          color,
                          reviewing: sending.has(row.url) || reviewing.has(row.url),
                          onPress: () => void reviewForMe(row),
                        }
                      : null
                  }
                  onOpen={() => open(row)}
                />
              ))}
            </Group>
          ))
        )}
      </PageScroll>
      <PullRequestSearch query={query} onQuery={setQuery} />
      {toast ? (
        <StartedToast
          key={toast.id}
          text="Sent to the Orchestrator"
          color={color}
          bottom={bottomInset + space.md}
          onHide={hideToast}
          onUndo={() => {
            setToast(null);
            void orchestrator.store?.act("orchestrator:task:undo", [toast.id], { optimisticDrop: toast.id }).catch(() => {});
          }}
          onOpen={() => {
            setToast(null);
            router.push({ pathname: "/orchestrator-task", params: { id: toast.id } });
          }}
        />
      ) : null}
    </View>
  );
}

function FiltersButton({ groups, count, onSelect }: { groups: FilterGroup[]; count: number; onSelect: (id: string) => void }) {
  const { colors } = useTheme();
  const label = count ? `Filters, ${count} on` : "Filters";
  if (Platform.OS === "ios")
    return (
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu icon="slider.horizontal.3" accessibilityLabel={label} title="Filters">
          {count ? <Stack.Toolbar.Badge>{String(count)}</Stack.Toolbar.Badge> : null}
          {groups.map((group) => (
            <Stack.Toolbar.Menu key={group.id} title={group.title}>
              {group.choices.map((choice) => (
                <Stack.Toolbar.MenuAction key={choice.id} isOn={choice.checked} onPress={() => onSelect(choice.id)}>
                  {choice.title}
                </Stack.Toolbar.MenuAction>
              ))}
            </Stack.Toolbar.Menu>
          ))}
          {count ? (
            <Stack.Toolbar.MenuAction icon="xmark.circle" onPress={() => onSelect(RESET_FILTERS)}>
              Reset filters
            </Stack.Toolbar.MenuAction>
          ) : null}
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
    );
  return (
    <Stack.Toolbar placement="right">
      <Stack.Toolbar.View>
        <PullDown
          label={label}
          title="Filters"
          sections={[
            {
              items: groups.map((group) => ({
                id: group.id,
                title: group.title,
                subtitle: group.value,
                submenu: group.choices.map((choice) => ({ id: choice.id, title: choice.title, checked: choice.checked })),
              })),
            },
            ...(count ? [{ items: [{ id: RESET_FILTERS, title: "Reset filters" }] }] : []),
          ]}
          onSelect={onSelect}
        >
          <View style={{ width: 36, height: 36, alignItems: "center", justifyContent: "center" }}>
            <Icon icon={SlidersHorizontalIcon} tone="ink" size={20} />
            {count ? (
              <View
                style={{
                  position: "absolute",
                  top: 0,
                  right: 0,
                  minWidth: 16,
                  height: 16,
                  paddingHorizontal: space.xs,
                  borderRadius: radius.full,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: colors.ink,
                }}
              >
                <Text style={{ color: colors.onInk, fontSize: type.caption2, fontWeight: "600" }}>{count}</Text>
              </View>
            ) : null}
          </View>
        </PullDown>
      </Stack.Toolbar.View>
    </Stack.Toolbar>
  );
}
