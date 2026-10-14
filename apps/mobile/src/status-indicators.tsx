import { useCallback, useState } from "react";
import { useFocusEffect } from "expo-router";
import { AppState, View } from "react-native";
import { BubbleChatIcon, GitPullRequestIcon, ShieldAlertIcon, Alert02Icon } from "@hugeicons/core-free-icons";
import type { PullRequest, Subagent, Worktree } from "@milagre/shared/model";
import { BLOCKERS, pullRequestBlockers } from "@milagre/shared/pr-blockers";
import { chatMarkTone } from "@milagre/shared/chats";
import { agentCounts, MARK_LABEL, type ChatMark } from "./indicators";
import { useSession } from "./session";
import { readPullRequest } from "./pr-status";
import { Icon, SpinnerRing } from "./icons";
import { useTheme } from "./theme";
import { StatusPill } from "./status-pill";

/** The open PR for a Worktree. Slow GitHub lookups are pooled and cached, and stop while the screen is hidden. */
export function usePullRequest(worktree?: Worktree) {
  const session = useSession();
  const [pr, setPr] = useState<PullRequest | null>(null);
  useFocusEffect(
    useCallback(() => {
      if (!worktree || !session.client) return;
      const client = session.client;
      let focused = true;
      const active = () => focused && AppState.currentState === "active";
      const refresh = () =>
        void readPullRequest(client, worktree.path, active)
          .then((value) => {
            if (active() && value !== undefined) setPr(value);
          })
          .catch(() => {});
      refresh();
      const timer = setInterval(refresh, 30000);
      const subscription = AppState.addEventListener("change", refresh);
      return () => {
        focused = false;
        clearInterval(timer);
        subscription.remove();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [session.client, worktree?.path]),
  );
  return pr;
}

/** Desktop's chat mark slot: a question bubble, an approval shield, a spinning ring, an unread dot, or a faint idle dot. */
export function ChatMarkIcon({ mark }: { mark: ChatMark }) {
  const { colors } = useTheme();
  const tone = chatMarkTone(mark);
  const body =
    mark === "question" ? (
      <Icon icon={BubbleChatIcon} tone={tone} size={15} strokeWidth={2} />
    ) : mark === "waiting" ? (
      <Icon icon={ShieldAlertIcon} tone={tone} size={15} strokeWidth={2} />
    ) : mark === "interrupted" ? (
      <Icon icon={Alert02Icon} tone={tone} size={15} strokeWidth={2} />
    ) : mark === "running" ? (
      <SpinnerRing size={14} tone={tone} />
    ) : (
      <View
        style={{
          width: mark === "idle" ? 6 : 8,
          height: mark === "idle" ? 6 : 8,
          borderRadius: 4,
          backgroundColor: mark === "idle" ? colors.idleDot : colors[tone],
        }}
      />
    );
  return (
    <View
      accessible={mark !== "idle"}
      accessibilityLabel={MARK_LABEL[mark] || undefined}
      style={{ width: 20, height: 20, alignItems: "center", justifyContent: "center" }}
    >
      {body}
    </View>
  );
}

/** Desktop's pullRequestAction chip: the first blocker's fix, sent to the agent. */
export function PullRequestAction({ pr, onRun, disabled }: { pr: PullRequest; onRun: () => void; disabled?: boolean }) {
  const { colors } = useTheme();
  const blocker = pullRequestBlockers(pr)[0];
  if (!blocker) return null;
  const red = BLOCKERS[blocker].tone === "red";
  return (
    <StatusPill
      label={BLOCKERS[blocker].action}
      icon={GitPullRequestIcon}
      tone={red ? "red" : "orange"}
      tint={red ? colors.redTint : colors.orangeTint}
      disabled={disabled}
      onPress={onRun}
    />
  );
}

/** Desktop's SubagentTrack trigger: a chip with a ring while any agent works. */
export function SubagentChip({ agents, onPress }: { agents: Subagent[]; onPress: () => void }) {
  const count = agentCounts(agents);
  if (!count.total) return null;
  return (
    <StatusPill
      label="Subagents"
      count={count.total}
      leading={count.running > 0 ? <SpinnerRing size={11} /> : undefined}
      tone={count.failed ? "red" : "ink2"}
      accessibilityLabel={`Subagents, ${count.total}${count.running ? `, ${count.running} running` : ""}`}
      onPress={onPress}
    />
  );
}
