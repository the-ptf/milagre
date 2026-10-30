import { Linking, Pressable, Text, View } from "react-native";
import { GitPullRequestIcon } from "@hugeicons/core-free-icons";
import type { PullRequestActionContext } from "@milagre/shared/model";
import { BLOCKERS } from "@milagre/shared/pr-blockers";
import { Icon } from "./icons";
import { useTheme } from "./theme";
import { useContext } from "react";
import { ChatLinkContext } from "./chat-link-context";

/** A PR-blocker pill the user tapped, shown as what it asked for instead of the skill prompt the agent read. Tapping opens the PR. */
export function PullRequestActionCard({ action }: { action: PullRequestActionContext }) {
  const { colors } = useTheme();
  const openChatLink = useContext(ChatLinkContext);
  const blocker = BLOCKERS[action.action];
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`${blocker.action}, pull request #${action.pr}`}
      onPress={() => {
        if (!openChatLink?.(action.url)) void Linking.openURL(action.url).catch(() => {});
      }}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
    >
      <View
        style={{
          minWidth: 240,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingHorizontal: 14,
          paddingVertical: 10,
          borderRadius: 18,
          borderCurve: "continuous",
          borderWidth: 1,
          borderColor: colors.line,
          backgroundColor: colors.surface,
        }}
      >
        <Icon icon={GitPullRequestIcon} tone={blocker.tone === "red" ? "red" : "orange"} size={16} />
        <Text style={{ flex: 1, color: colors.ink, fontSize: 15, fontWeight: "500" }} numberOfLines={1}>
          {blocker.action}
        </Text>
        <Text style={{ color: colors.ink3, fontSize: 13 }}>#{action.pr}</Text>
      </View>
    </Pressable>
  );
}
