import { radius, space } from "./design-tokens";
import { ChatSwipeRow } from "./chat-swipe-row";
import { type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { GitBranchIcon, Link04Icon, MoreHorizontalIcon, PinIcon } from "@hugeicons/core-free-icons";
import { chatMarkTone } from "@milagre/shared/chats";
import type { PullRequest } from "@milagre/shared/model";
import { CHATS_GROUP_LABEL, NO_PROJECT_LABEL } from "@milagre/shared/chats-home";
import { chatsRowDetail } from "./chats-group";
import { linkMenuSection, linkedAccessibilityLabel } from "./chat-links";
import { type ChatMark } from "./indicators";
import { backgroundLabel } from "@milagre/shared/chat-activity";
import { ChatMarkIcon } from "./status-indicators";
import { Icon, SpinnerRing } from "./icons";
import { tap } from "./primitives/tap";
import { DISABLED_OPACITY, PullDown } from "./ui";
import { HoverView } from "./primitives/hover";
import { ChatsHomeIcon, ProjectIcon } from "./project-icon";
import { chatMenu } from "./chat-actions";
import { canOpenBeside } from "./split-chats";
import { ArchivingOverlay } from "./archive-progress";
import { ChatPullRequestChips, InlinePullRequestLinks } from "./chat-pull-request-chips";
import { requestPullRequest } from "./pr-chat";
import { inkFor, useTheme, type Palette } from "./theme";
import { activityAgo } from "@milagre/shared/chat-row";
import { WaitingLabel } from "./offline-tray";
import { useS } from "./navigation-styles";
import { ComputerTag } from "./navigation-chrome";
import type { RowActions, RowProps, RowView } from "./navigation-row";

/** How far each level of a subchat family indents its row. */
const SUBCHAT_INDENT = 16;
const labels: Record<ChatMark, string> = {
  idle: "",
  running: "Running",
  background: "In the background",
  question: "Needs reply",
  waiting: "Needs approval",
  interrupted: "Interrupted",
  failed: "Failed",
  unread: "Unread",
};

type ChatRowContext = RowProps<"chat"> & { s: ReturnType<typeof useS>; colors: Palette };
type ChatRowBase = ChatRowContext & RowView & RowActions;

/** Whether the row is the open Chat, its menu, and whether it is archiving. */
function chatRowSelection(ctx: ChatRowBase) {
  const {
    item,
    copy,
    currentHostId,
    currentPath,
    activeChatId,
    openRoot,
    wide,
    beside,
    links,
    archivingChats,
    archiveRequests,
    worktreeForLinks,
    doneHours,
    snoozeMinutes,
  } = ctx;
  const offline = item.reach === "offline";
  const title = item.title;
  const besideRow = {
    hostId: item.hostId,
    projectPath: item.path,
    chatId: item.chat.id,
    archived: item.chat.archived,
    offline,
  };
  const offerBeside = canOpenBeside(
    besideRow,
    {
      wide,
      hostId: currentHostId,
      projectPath: currentPath,
      chatId: activeChatId,
    },
    beside,
  );
  // The Chat open beside the open one is selected too.
  const isBeside = wide && activeChatId !== undefined && beside?.hostId === item.hostId && beside.projectPath === item.path && beside.chatId === item.chat.id;
  // A family folded by hand while one of its subchats is open: its parent's row draws as the open one, as on desktop.
  const standIn = !!item.family?.folded && currentHostId === item.hostId && openRoot === `${item.path}#${item.chat.id}`;
  const selected = (currentHostId === item.hostId && currentPath === item.path && activeChatId === item.chat.id) || isBeside || standIn;
  const linked = item.linked ?? [];
  // A Mac that keeps Done answers its retention (done-retention.ts); an older one ignores Done, so its rows archive instead.
  const doneable = doneHours[item.hostId] !== undefined;
  const menu = chatMenu(
    item.chat,
    copy?.project.link ? { path: copy.project.state.worktrees[item.chat.worktree_id]?.path } : copy?.project.state.worktrees[item.chat.worktree_id],
    item.hostId === currentHostId && !item.home
      ? linkMenuSection({
          available: links.available,
          worktreePath: worktreeForLinks(item.path, item.prPath)?.worktree_path,
          linked: linked.length,
        })
      : null,
    offerBeside,
    !item.home,
    doneable,
    snoozeMinutes,
  );
  // While it archives, the row stays put under the progress and takes no taps.
  const archiving =
    archivingChats.has(`${copy?.project.path ?? item.path}#${item.chat.id}`) &&
    (item.hostId === currentHostId || archiveRequests.has(`${item.hostId}|${item.path}#${item.chat.id}`));
  return {
    offline,
    title,
    besideRow,
    offerBeside,
    isBeside,
    standIn,
    selected,
    linked,
    doneable,
    menu,
    archiving,
  };
}

/** What the row says: its chips, diff, time, branch, mark, family and label. */
function chatRowLook(ctx: ChatRowBase & ReturnType<typeof chatRowSelection>) {
  const { item, copy, colors, rowShow, chatList, offline, title, linked } = ctx;
  const tone = chatMarkTone(item.mark);
  const pullRequests = rowShow.pullRequests ? item.pullRequests || [] : [];
  const linearIssue = rowShow.linearIssue ? item.linearIssue : undefined;
  const hasChips = pullRequests.length > 0 || !!linearIssue;
  const worktreeDiff = rowShow.diff && !copy?.project.link && !item.home ? copy?.project.state.worktrees[item.chat.worktree_id]?.diff : undefined;
  const diff = worktreeDiff && (worktreeDiff.added > 0 || worktreeDiff.removed > 0) ? worktreeDiff : undefined;
  const lastAt = rowShow.lastActivity ? item.chat.summary?.lastAt : undefined;
  const branchLine = copy?.project.link ? `Shared Chat · ${copy.project.link.projects.length} Projects` : rowShow.branch ? item.worktree : "";
  const markLabel = item.mark === "background" && item.background ? backgroundLabel(item.background) : labels[item.mark];
  // A working Chat says so with its spinner alone, as on desktop; its words stay for VoiceOver.
  const markWord = item.mark === "running" || item.mark === "background" ? "" : markLabel;
  const markColor = inkFor(colors, tone);
  const family = item.family;
  const familyLabel = family
    ? `${family.folded ? "Show" : "Hide"} ${family.count} subchat${family.count === 1 ? "" : "s"}${family.asking ? ", one needs you" : ""}`
    : "";
  // A subchat sits indented under its parent, with a line down to it.
  // One indent deeper per level, two at most (subchat-rows.ts).
  const depth = item.depth ?? 1;
  const subchatIndent = item.subchat || item.indent ? { paddingLeft: (item.subchat ? SUBCHAT_INDENT * depth : 0) + (item.indent ?? 0) } : null;
  const grouped = chatList !== "list";
  const label = `${title}${item.chat.pinned ? ", pinned" : ""}, ${grouped ? item.worktree : `${item.project}, ${item.worktree}`}${markLabel ? `, ${markLabel}` : ""}${item.many ? `, ${item.hostName}${offline ? ", offline" : ""}` : ""}${linked.length ? `, ${linkedAccessibilityLabel(linked)}` : ""}`;
  return {
    tone,
    pullRequests,
    linearIssue,
    hasChips,
    worktreeDiff,
    diff,
    lastAt,
    branchLine,
    markLabel,
    markWord,
    markColor,
    family,
    familyLabel,
    depth,
    subchatIndent,
    grouped,
    label,
  };
}

/** The parts every layout draws: facts, the Link glyph, the family badge and the Project icon, with their taps. */
function chatRowPieces(ctx: ChatRowBase & ReturnType<typeof chatRowSelection> & ReturnType<typeof chatRowLook>) {
  const {
    item,
    copy,
    s,
    colors,
    currentHostId,
    now,
    chatList,
    selectedFill,
    clientOf,
    enter,
    foldSubchats,
    offline,
    selected,
    linked,
    archiving,
    diff,
    lastAt,
    branchLine,
    markWord,
    family,
    familyLabel,
    depth,
    grouped,
  } = ctx;
  // The diff and the last activity sit after the branch, or after the chips.
  const facts = (
    <>
      {diff && (
        <Text style={[s.detail, { fontVariant: ["tabular-nums"] }]}>
          <Text style={{ color: colors.add }}>+{diff.added}</Text> <Text style={{ color: colors.remove }}>−{diff.removed}</Text>
        </Text>
      )}
      {lastAt !== undefined && chatList !== "list" && <Text style={[s.detail, { fontVariant: ["tabular-nums"] }]}>{activityAgo(lastAt, now)}</Text>}
    </>
  );
  // A linked Chat shows the Link glyph beside its pin, as desktop's sidebar does.
  const linkedIcon = linked.length ? (
    <View accessible accessibilityLabel={linkedAccessibilityLabel(linked)}>
      <Icon icon={Link04Icon} tone="ink3" size={12} />
    </View>
  ) : null;
  // A PR link opens the Chat and then its PR there, for a Chat of this computer with a Worktree of its own.
  const openPullRequest =
    item.hostId === currentHostId && !copy?.project.link && !item.pending
      ? (pr: PullRequest) => {
          requestPullRequest(`${item.path}#${item.chat.id}`, pr.number);
          void enter(item.hostId, item.path, item.chat.id);
        }
      : undefined;
  // A subchat is a Chat like any other: it opens alone, with its family unfolded around it.
  const openRow = () => {
    if (archiving) return;
    void enter(item.hostId, item.path, item.chat.id, item.pending);
  };
  const foldFamily = () => {
    tap();
    foldSubchats(item.key);
  };
  // Every layout uses the same count on the Project icon to fold its family.
  const familyBadge = family ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={familyLabel}
      accessibilityState={{ expanded: !family.folded }}
      hitSlop={12}
      onPress={foldFamily}
      style={[
        s.subchatBadge,
        {
          borderColor: selected ? selectedFill : colors.panel,
          backgroundColor: colors.panel,
        },
      ]}
    >
      <View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          {
            borderRadius: radius.full,
            backgroundColor: family.asking ? colors.orangeInk : family.folded ? colors.lineStrong : colors.accentTint,
          },
        ]}
      />
      <Text
        style={[
          s.subchatBadgeText,
          {
            color: family.asking ? colors.onOrange : family.folded ? colors.ink : colors.accentInk,
          },
        ]}
      >
        {family.count}
      </Text>
    </Pressable>
  ) : null;
  const subchatGuide = item.subchat ? (
    <View pointerEvents="none" style={[s.subchatGuide, { left: 8 + SUBCHAT_INDENT * depth, backgroundColor: colors.line }]} />
  ) : null;
  const rowProjectIcon = (
    <View pointerEvents="box-none">
      <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {item.home ? <ChatsHomeIcon size={32} /> : <ProjectIcon client={clientOf(item.hostId)} path={item.members?.[0]?.path ?? item.path} size={32} />}
      </View>
      {!archiving && familyBadge}
    </View>
  );
  // Under a Project several computers share, each row names its own computer first.
  const computerTag = grouped && item.shared ? <ComputerTag name={item.hostName} offline={offline} /> : null;
  const secondLine = !!computerTag || !!branchLine || !!diff || lastAt !== undefined || !!item.chat.pinned || !!linkedIcon || !!markWord;
  return {
    facts,
    linkedIcon,
    openPullRequest,
    openRow,
    foldFamily,
    familyBadge,
    subchatGuide,
    rowProjectIcon,
    computerTag,
    secondLine,
  };
}

/** What every layout of a Chat row reads and draws, from its item, the list's view and its Project's copy. */
function chatRowParts(ctx: ChatRowContext) {
  const base: ChatRowBase = { ...ctx, ...ctx.view, ...ctx.view.actions };
  const selection = { ...base, ...chatRowSelection(base) };
  const look = { ...selection, ...chatRowLook(selection) };
  return { ...look, ...chatRowPieces(look) };
}
type ChatRowParts = ReturnType<typeof chatRowParts>;

/** A Chat's row: in the Chats group, as an inbox row in the One list, or grouped under its Project. */
export function NavigationChatRow(props: RowProps<"chat">) {
  const s = useS();
  const { colors } = useTheme();
  const parts = chatRowParts({ ...props, s, colors });
  if (props.item.home && parts.chatList !== "list") return homeChatRow(parts);
  if (!parts.grouped) return inboxChatRow(parts);
  return groupedChatRow(parts);
}

// A Chat without a Project, in the Chats group or a grouped list's search: its title, then its computer and age, never a
// branch or PR. The One list draws it as an inbox row like the others, with the Chats bubble for its icon.
function homeChatRow(p: ChatRowParts) {
  const {
    item,
    copy,
    s,
    colors,
    offline,
    now,
    selectedFill,
    background,
    enter,
    act,
    title,
    selected,
    markLabel,
    markWord,
    markColor,
    doneable,
    menu,
    archiving,
  } = p;
  const detail = chatsRowDetail(item.hostName + (offline ? ", offline" : ""), item.chat.summary?.lastAt, now);
  return (
    <ChatSwipeRow
      unread={!!item.chat.unread}
      disabled={offline || !!item.pending || archiving || !!item.chat.archived || !copy}
      doneable={doneable}
      background={background}
      onAction={(action) => act(item, action)}
    >
      <View pointerEvents={archiving ? "none" : "auto"} style={{ opacity: offline ? DISABLED_OPACITY.row : 1 }}>
        <HoverView
          style={[
            s.chat,
            s.grouped,
            {
              backgroundColor: selected && !archiving ? selectedFill : "transparent",
            },
          ]}
          hoverStyle={!selected && !archiving ? { backgroundColor: colors.hover } : undefined}
        >
          <View
            style={{ flex: 1, opacity: archiving ? DISABLED_OPACITY.row : 1 }}
            accessibilityElementsHidden={archiving}
            importantForAccessibility={archiving ? "no-hide-descendants" : "auto"}
          >
            <PullDown
              label={`${title}${item.chat.pinned ? ", pinned" : ""}, ${NO_PROJECT_LABEL}, ${detail}${markLabel ? `, ${markLabel}` : ""}`}
              title={title}
              sections={item.pending || archiving ? [] : menu}
              onSelect={(action) => {
                if (!item.pending && !archiving) void act(item, action);
              }}
              onPress={() => {
                if (!archiving) void enter(item.hostId, item.path, item.chat.id, item.pending);
              }}
              style={{ flex: 1 }}
            >
              <View style={s.chatBody}>
                <ChatMarkIcon mark={item.mark} background={item.background} />
                <View style={{ flex: 1, gap: space.xs }}>
                  <Text
                    numberOfLines={2}
                    style={[
                      s.chatTitle,
                      {
                        color: item.chat.unread || selected ? colors.ink : colors.ink2,
                        fontWeight: item.chat.unread ? "600" : "500",
                      },
                    ]}
                  >
                    {title}
                  </Text>
                  <View
                    style={{
                      flexDirection: "row",
                      gap: space.xs,
                      alignItems: "center",
                    }}
                  >
                    {item.chat.pinned && <Icon icon={PinIcon} tone="ink3" size={12} />}
                    <Text numberOfLines={1} style={[s.detail, { flexShrink: 1, fontVariant: ["tabular-nums"] }]}>
                      {detail}
                    </Text>
                    {!!markWord && <Text style={[s.detail, { color: markColor }]}>{markWord}</Text>}
                    <WaitingLabel computerId={item.hostId} owner={item.path} sessionId={item.chat.id} style={s.detail} />
                  </View>
                </View>
              </View>
            </PullDown>
          </View>
          {!item.pending && !archiving && (
            <PullDown label={`Actions for ${title}`} title={title} sections={menu} onSelect={(action) => void act(item, action)}>
              <View style={s.rowMore}>
                <Icon icon={MoreHorizontalIcon} tone="ink3" size={18} />
              </View>
            </PullDown>
          )}
          {archiving && <ArchivingOverlay title={title} />}
        </HoverView>
      </View>
    </ChatSwipeRow>
  );
}

function inboxChatRow(p: ChatRowParts) {
  const {
    item,
    copy,
    s,
    colors,
    offline,
    now,
    selectedFill,
    background,
    act,
    title,
    selected,
    pullRequests,
    linearIssue,
    hasChips,
    diff,
    lastAt,
    linked,
    linkedIcon,
    markLabel,
    markWord,
    markColor,
    openPullRequest,
    doneable,
    openRow,
    subchatGuide,
    subchatIndent,
    menu,
    archiving,
    rowProjectIcon,
  } = p;
  // One list: inbox rows. The Project's icon, then the title with its time (a spinner while it runs, a dot when unread),
  // then one line naming the Project, its pull requests and Linear issue, what the Chat waits on, the diff, and the
  // computer when it isn't the open one. A tap opens the Chat and a long press opens its menu: the menu covers the row,
  // under the pull request links, which keep their own taps.
  const running = item.mark === "running" || item.mark === "background";
  const word = item.mark === "unread" ? "" : markLabel;
  const unreadColor = colors[chatMarkTone("unread")];
  const otherComputer = item.many;
  const separator = <Text style={s.inboxSeparator}>·</Text>;
  // What VoiceOver reads for the row: what it shows, without the branch.
  const inboxLabel = [
    title,
    item.chat.pinned ? "pinned" : "",
    item.chat.unread ? "unread" : "",
    copy?.project.link ? `${copy.project.link.projects.length} Projects` : item.home ? CHATS_GROUP_LABEL : item.project,
    word,
    otherComputer ? `${item.hostName}${offline ? ", offline" : ""}` : "",
    linked.length ? linkedAccessibilityLabel(linked) : "",
  ]
    .filter(Boolean)
    .join(", ");
  // The second line's parts, " · " between them; the pull request links keep their own taps.
  const parts: { key: string; node: ReactNode; links?: boolean }[] = [
    {
      key: "project",
      node: copy?.project.link ? (
        <>
          <Icon icon={Link04Icon} tone="ink3" size={12} />
          <Text numberOfLines={1} style={s.inboxText}>
            {copy.project.link.projects.length} Projects
          </Text>
        </>
      ) : (
        <Text numberOfLines={1} style={[s.inboxText, { flexShrink: 1 }]}>
          {item.home ? CHATS_GROUP_LABEL : item.project}
        </Text>
      ),
    },
    ...(hasChips
      ? [
          {
            key: "links",
            links: true,
            node: <InlinePullRequestLinks pullRequests={pullRequests} linearIssue={linearIssue} separator={separator} onOpenPullRequest={openPullRequest} />,
          },
        ]
      : []),
    ...(word && markWord
      ? [
          {
            key: "mark",
            node: (
              <Text numberOfLines={1} style={[s.inboxText, { color: markColor, flexShrink: 1 }]}>
                {word}
              </Text>
            ),
          },
        ]
      : []),
    ...(diff
      ? [
          {
            key: "diff",
            node: (
              <Text style={[s.inboxText, { fontVariant: ["tabular-nums"] }]}>
                <Text style={{ color: colors.add }}>+{diff.added}</Text> <Text style={{ color: colors.remove }}>−{diff.removed}</Text>
              </Text>
            ),
          },
        ]
      : []),
    ...(otherComputer
      ? [
          {
            key: "computer",
            node: <ComputerTag name={item.hostName} offline={offline} large />,
          },
        ]
      : []),
  ];
  return (
    <ChatSwipeRow
      unread={!!item.chat.unread}
      disabled={offline || !!item.pending || archiving || !!item.chat.archived || !copy}
      doneable={doneable}
      background={background}
      onAction={(action) => act(item, action)}
    >
      <View
        pointerEvents={archiving ? "none" : "auto"}
        style={{
          opacity: offline ? DISABLED_OPACITY.row : 1,
          ...subchatIndent,
        }}
      >
        {subchatGuide}
        <HoverView
          style={[
            s.inbox,
            {
              backgroundColor: selected && !archiving ? selectedFill : "transparent",
            },
          ]}
          hoverStyle={!selected && !archiving ? { backgroundColor: colors.hover } : undefined}
        >
          <PullDown
            label={inboxLabel}
            title={title}
            sections={item.pending || archiving ? [] : menu}
            onSelect={(action) => {
              if (!item.pending && !archiving) void act(item, action);
            }}
            onPress={openRow}
            style={StyleSheet.absoluteFill}
            fill
          >
            <View style={{ flex: 1 }} />
          </PullDown>
          <View
            pointerEvents="box-none"
            style={[s.inboxContent, { opacity: archiving ? DISABLED_OPACITY.row : 1 }]}
            accessibilityElementsHidden={archiving}
            importantForAccessibility={archiving ? "no-hide-descendants" : "auto"}
          >
            {rowProjectIcon}
            <View pointerEvents="box-none" style={{ flex: 1, gap: space.xs }}>
              <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={s.inboxLine}>
                {item.chat.pinned && <Icon icon={PinIcon} tone="ink3" size={12} />}
                {linkedIcon}
                <Text
                  numberOfLines={1}
                  style={[
                    s.inboxTitle,
                    {
                      color: colors.ink,
                      fontWeight: item.chat.unread ? "600" : "500",
                    },
                  ]}
                >
                  {title}
                </Text>
                {running ? (
                  <SpinnerRing size={12} tone="accent" />
                ) : (
                  <>
                    {lastAt !== undefined && (
                      <Text
                        style={[
                          s.inboxTime,
                          // Unread: the time brighter, not coloured; the dot after it is the one accent mark.
                          item.chat.unread && {
                            color: colors.ink,
                            fontWeight: "500",
                          },
                        ]}
                      >
                        {activityAgo(lastAt, now)}
                      </Text>
                    )}
                    {item.chat.unread && <View style={[s.unread, { backgroundColor: unreadColor }]} />}
                  </>
                )}
              </View>
              <View pointerEvents="box-none" style={s.inboxLine}>
                {parts.map((part, at) => (
                  <View
                    key={part.key}
                    pointerEvents={part.links ? "box-none" : "none"}
                    accessibilityElementsHidden={!part.links}
                    importantForAccessibility={part.links ? "auto" : "no-hide-descendants"}
                    style={[s.inboxPart, !part.links && { flexShrink: 1 }]}
                  >
                    {at > 0 && <View pointerEvents="none">{separator}</View>}
                    {part.node}
                  </View>
                ))}
              </View>
            </View>
          </View>
          {archiving && <ArchivingOverlay title={title} />}
        </HoverView>
      </View>
    </ChatSwipeRow>
  );
}

function groupedChatRow(p: ChatRowParts) {
  const {
    item,
    copy,
    s,
    colors,
    offline,
    selectedFill,
    background,
    act,
    title,
    selected,
    pullRequests,
    linearIssue,
    hasChips,
    facts,
    branchLine,
    linkedIcon,
    markWord,
    markColor,
    openPullRequest,
    doneable,
    openRow,
    family,
    subchatGuide,
    subchatIndent,
    menu,
    archiving,
    rowProjectIcon,
    label,
    computerTag,
    secondLine,
  } = p;
  // A tap opens the Chat and a long press opens its ⋯ menu, as on desktop's sidebar.
  return (
    <ChatSwipeRow
      unread={!!item.chat.unread}
      disabled={offline || !!item.pending || archiving || !!item.chat.archived || !copy}
      doneable={doneable}
      background={background}
      onAction={(action) => act(item, action)}
    >
      <View
        pointerEvents={archiving ? "none" : "auto"}
        style={{
          opacity: offline ? DISABLED_OPACITY.row : 1,
          ...subchatIndent,
        }}
      >
        {subchatGuide}
        <HoverView
          style={[
            s.chat,
            s.grouped,
            {
              backgroundColor: selected && !archiving ? selectedFill : "transparent",
            },
          ]}
          hoverStyle={!selected && !archiving ? { backgroundColor: colors.hover } : undefined}
        >
          {family && <View style={{ marginLeft: 12, opacity: archiving ? DISABLED_OPACITY.row : 1 }}>{rowProjectIcon}</View>}
          <View
            style={{ flex: 1, opacity: archiving ? DISABLED_OPACITY.row : 1 }}
            accessibilityElementsHidden={archiving}
            importantForAccessibility={archiving ? "no-hide-descendants" : "auto"}
          >
            <PullDown
              label={label}
              title={title}
              sections={item.pending || archiving ? [] : menu}
              onSelect={(action) => {
                if (!item.pending && !archiving) void act(item, action);
              }}
              onPress={openRow}
              style={{ flex: 1 }}
            >
              <View
                style={[
                  s.chatBody,
                  hasChips && {
                    minHeight: 28,
                    paddingTop: 6,
                    paddingBottom: 0,
                  },
                ]}
              >
                <ChatMarkIcon mark={item.mark} background={item.background} />
                <View style={{ flex: 1, gap: space.xs }}>
                  <Text
                    numberOfLines={hasChips ? 1 : 2}
                    style={[
                      s.chatTitle,
                      {
                        color: item.chat.unread || selected ? colors.ink : colors.ink2,
                        fontWeight: item.chat.unread ? "600" : "500",
                      },
                    ]}
                  >
                    {title}
                  </Text>
                  {!hasChips && secondLine && (
                    <View
                      style={{
                        flexDirection: "row",
                        gap: space.xs,
                        alignItems: "center",
                      }}
                    >
                      {item.chat.pinned && <Icon icon={PinIcon} tone="ink3" size={12} />}
                      {linkedIcon}
                      {computerTag}
                      {!copy?.project.link && !!branchLine && <Icon icon={GitBranchIcon} tone="ink3" size={12} />}
                      {!!branchLine && (
                        <Text numberOfLines={1} style={[s.detail, { flexShrink: 1 }]}>
                          {branchLine}
                        </Text>
                      )}
                      {facts}
                      {!!markWord && <Text style={[s.detail, { color: markColor }]}>{markWord}</Text>}
                      <WaitingLabel computerId={item.hostId} owner={item.path} sessionId={item.chat.id} style={s.detail} />
                    </View>
                  )}
                </View>
              </View>
            </PullDown>
            {hasChips && (
              <View>
                <ChatPullRequestChips pullRequests={pullRequests} linearIssue={linearIssue} onOpenPullRequest={openPullRequest}>
                  {item.chat.pinned && <Icon icon={PinIcon} tone="ink3" size={12} />}
                  {linkedIcon}
                  {computerTag}
                  {facts}
                  {!!markWord && (
                    <Text numberOfLines={1} style={[s.detail, { flexShrink: 1, color: markColor }]}>
                      {markWord}
                    </Text>
                  )}
                  <WaitingLabel computerId={item.hostId} owner={item.path} sessionId={item.chat.id} style={s.detail} />
                </ChatPullRequestChips>
              </View>
            )}
          </View>
          {!item.pending && !archiving && (
            <PullDown label={`Actions for ${title}`} title={title} sections={menu} onSelect={(action) => void act(item, action)}>
              <View style={s.rowMore}>
                <Icon icon={MoreHorizontalIcon} tone="ink3" size={18} />
              </View>
            </PullDown>
          )}
          {archiving && <ArchivingOverlay title={title} />}
        </HoverView>
      </View>
    </ChatSwipeRow>
  );
}
