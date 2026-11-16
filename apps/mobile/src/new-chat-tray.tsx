import { Pressable, Text, View } from "react-native";
import { ArrowDown01Icon, BubbleChatIcon, ComputerIcon, GitBranchIcon, GitForkIcon, LaptopIcon } from "@hugeicons/core-free-icons";
import { CHATS_TRAY_LABEL } from "@milagre/shared/chats-home";
import { Icon, LinearLogo } from "./icons";
import { DISABLED_OPACITY, PullDown, pressStyle, useStyles } from "./ui";
import { space } from "./design-tokens";
import type { NewChatProject } from "./new-chat-project";

export function LinearIssueButton({ labelled, disabled, onPress }: { labelled: boolean; disabled: boolean; onPress: () => void }) {
  const styles = useStyles();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Start from a Linear issue"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: space.md,
        paddingVertical: 6,
        ...pressStyle({ pressed, disabled }),
      })}
    >
      <LinearLogo size={13} />
      {labelled && <Text style={styles.label}>Linear issue</Text>}
    </Pressable>
  );
}

export function ChatsTrayLabel() {
  const styles = useStyles();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: space.md, paddingVertical: 6 }}>
      <Icon icon={BubbleChatIcon} tone="ink2" size={12} />
      <Text style={styles.label}>{CHATS_TRAY_LABEL}</Text>
    </View>
  );
}

type Worktree = { id: number; name: string; path?: string };

export function NewChatTray({
  computerName,
  computers,
  isOpenCopy,
  disabled,
  onComputer,
  isolation,
  onIsolation,
  newWorktree,
  branchName,
  branchDisabled,
  branches,
  base,
  worktrees,
  worktreeId,
  onBranch,
  linear,
  onIssue,
  labelIssue,
  onRowWidth,
}: {
  computerName: string | undefined;
  computers: NewChatProject[];
  isOpenCopy: (item: NewChatProject) => boolean;
  disabled: boolean;
  onComputer: (hostId: string, path: string) => void;
  isolation: "local" | "worktree";
  onIsolation: (isolation: "local" | "worktree") => void;
  newWorktree: boolean;
  branchName: string;
  branchDisabled: boolean;
  branches: string[];
  base: string | undefined;
  worktrees: Worktree[];
  worktreeId: number;
  onBranch: (id: string) => void;
  linear: boolean;
  onIssue: () => void;
  labelIssue: boolean;
  onRowWidth: (width: number) => void;
}) {
  const styles = useStyles();
  const local = isolation === "local";
  return (
    <View style={{ flexDirection: "row", alignItems: "center" }} onLayout={(event) => onRowWidth(event.nativeEvent.layout.width)}>
      <PullDown
        label="Choose computer"
        style={{ flexShrink: 1 }}
        nativeTrigger={{ title: computerName, systemImage: "desktopcomputer", icon: "computer", disabled, maxWidth: 140 }}
        sections={[
          {
            title: "Run on",
            items: computers.map((item) => ({
              id: `${item.hostId}\n${item.path}`,
              title: item.hostName,
              subtitle: item.offline ? "Offline" : item.path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~"),
              systemImage: "desktopcomputer",
              icon: "computer",
              checked: isOpenCopy(item),
              disabled: disabled || item.offline,
            })),
          },
        ]}
        onSelect={(id) => {
          const [hostId = "", ...rest] = id.split("\n");
          if (!disabled) onComputer(hostId, rest.join("\n"));
        }}
      >
        <View
          style={{
            maxWidth: 140,
            flexShrink: 1,
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            paddingHorizontal: space.md,
            paddingVertical: 6,
            opacity: disabled ? DISABLED_OPACITY.control : 1,
          }}
        >
          <Icon icon={ComputerIcon} tone="ink2" size={12} />
          <Text numberOfLines={1} style={[styles.label, { flexShrink: 1 }]}>
            {computerName}
          </Text>
          <Icon icon={ArrowDown01Icon} tone="ink3" size={12} />
        </View>
      </PullDown>
      <PullDown
        label="Choose isolation"
        nativeTrigger={{
          title: local ? "Local" : "New Worktree",
          systemImage: local ? "laptopcomputer" : "arrow.triangle.branch",
          icon: local ? "laptop" : "fork",
          disabled,
        }}
        sections={[
          {
            title: "Isolation",
            items: [
              { id: "local", title: "Local", systemImage: "laptopcomputer", icon: "laptop", checked: local, disabled },
              { id: "worktree", title: "New Worktree", systemImage: "arrow.triangle.branch", icon: "fork", checked: !local, disabled },
            ],
          },
        ]}
        onSelect={(id) => {
          if (!disabled) onIsolation(id === "worktree" ? "worktree" : "local");
        }}
      >
        <View
          style={{
            flexShrink: 1,
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            paddingHorizontal: space.md,
            paddingVertical: 6,
            opacity: disabled ? DISABLED_OPACITY.control : 1,
          }}
        >
          <Icon icon={local ? LaptopIcon : GitForkIcon} tone="ink2" size={12} />
          <Text numberOfLines={1} style={[styles.label, { flexShrink: 1 }]}>
            {local ? "Local" : "New Worktree"}
          </Text>
          <Icon icon={ArrowDown01Icon} tone="ink3" size={12} />
        </View>
      </PullDown>
      <PullDown
        label="Choose branch"
        style={{ flexShrink: 1 }}
        searchable={{
          placeholder: newWorktree ? "Search branches" : "Search Worktrees",
          emptyLabel: newWorktree ? "No branches found." : "No worktrees found.",
        }}
        nativeTrigger={{ title: branchName, systemImage: "arrow.triangle.branch", disabled: branchDisabled, maxWidth: 180 }}
        sections={[
          {
            title: newWorktree ? "Branch from" : "Choose a Worktree",
            items: newWorktree
              ? branches.map((item) => ({ id: item, title: item, checked: item === base, systemImage: "arrow.triangle.branch", disabled: branchDisabled }))
              : worktrees.map((item) => ({
                  id: String(item.id),
                  title: item.name,
                  subtitle: item.path?.split("/").findLast(Boolean),
                  checked: item.id === worktreeId,
                  systemImage: "arrow.triangle.branch",
                  disabled,
                })),
          },
        ]}
        onSelect={(id) => {
          if (!branchDisabled) onBranch(id);
        }}
      >
        <View
          style={{
            maxWidth: 180,
            flexShrink: 1,
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            paddingHorizontal: space.md,
            paddingVertical: 6,
            opacity: branchDisabled ? DISABLED_OPACITY.control : 1,
          }}
        >
          <Icon icon={GitBranchIcon} tone="ink2" size={12} />
          <Text numberOfLines={1} style={[styles.label, { flexShrink: 1 }]}>
            {branchName}
          </Text>
          <Icon icon={ArrowDown01Icon} tone="ink3" size={12} />
        </View>
      </PullDown>
      {linear && <LinearIssueButton labelled={labelIssue} disabled={disabled} onPress={onIssue} />}
    </View>
  );
}
