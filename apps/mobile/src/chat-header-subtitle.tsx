import { Text, View } from "react-native";
import { GitBranchIcon } from "@hugeicons/core-free-icons";
import type { PullRequest } from "@milagre/shared/model";
import { lineHeight, space, type } from "./design-tokens";
import { Icon } from "./icons";
import { HeaderPullRequestChip } from "./status-indicators";
import { useTheme } from "./theme";

/** The Chat header's second line: the Project (beside another pane), the branch with its diff, and the PR. */
export function ChatHeaderSubtitle({
  paired,
  linked,
  home,
  hasChat,
  place,
  branch,
  worktreeShown,
  diff,
  pr,
  onPr,
}: {
  paired: boolean;
  linked: boolean;
  home: boolean;
  hasChat: boolean;
  place: { label: string; spoken: string };
  branch: string;
  worktreeShown: boolean;
  diff: { added: number; removed: number } | null | undefined;
  pr: PullRequest | null | undefined;
  onPr: (number: number) => void;
}) {
  const { colors } = useTheme();
  if (!(paired || (!linked && !home) || (!!pr && hasChat && !home))) return null;
  const changed = !!diff && (diff.added > 0 || diff.removed > 0);
  const chip = pr && hasChat ? <HeaderPullRequestChip pr={pr} onPress={() => onPr(pr.number)} /> : null;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, maxWidth: "100%" }}>
      {paired && (
        <Text
          numberOfLines={1}
          ellipsizeMode="tail"
          accessibilityLabel={place.spoken}
          style={{ color: colors.ink2, fontSize: type.caption1, lineHeight: lineHeight.caption1, fontWeight: "500", flexShrink: 1 }}
        >
          {place.label}
        </Text>
      )}
      {!linked && !home && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, flexShrink: 1, opacity: worktreeShown ? 1 : 0 }}>
          <Icon icon={GitBranchIcon} tone="ink3" size={12} />
          <Text numberOfLines={1} ellipsizeMode="tail" style={{ color: colors.ink2, fontSize: type.caption1, lineHeight: lineHeight.caption1, flexShrink: 1 }}>
            {branch}
          </Text>
          <Text style={{ fontSize: type.caption1, lineHeight: lineHeight.caption1 }}>
            <Text style={{ color: colors.add }}>{changed ? `+${diff.added}` : ""}</Text>
            {changed ? " " : ""}
            <Text style={{ color: colors.remove }}>{changed ? `−${diff.removed}` : ""}</Text>
          </Text>
          {chip}
        </View>
      )}
      {linked && chip}
    </View>
  );
}
