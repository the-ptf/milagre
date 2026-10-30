import { Pressable, Text } from "react-native";
import { GitBranchIcon, Link04Icon } from "@hugeicons/core-free-icons";
import type { WorktreeLinkedContext } from "@milagre/shared/model";
import { linkedSummaryText, worktreeLinkLabel, worktreeLinkText } from "@milagre/shared/worktree-link";
import type { Client } from "./client";
import { lineHeight, type } from "./design-tokens";
import { Icon } from "./icons";
import { pressStyle } from "./primitives/press-style";
import { TranscriptDivider } from "./primitives/transcript-divider";
import { ProjectIcon } from "./project-icon";
import { fonts, useTheme } from "./theme";

/** A Link on the canvas that reached this Chat, as on desktop. Tapping it opens the linked summary the Chat's next turn gets. */
export function WorktreeLinkDivider({
  context,
  client,
  onOpen,
}: {
  context: WorktreeLinkedContext;
  client: Client | null;
  onOpen: (title: string, text: string) => void;
}) {
  const { colors } = useTheme();
  const label = worktreeLinkLabel(context);
  const summary = context.summary ? linkedSummaryText(context.summary) : undefined;
  const caption = { fontSize: type.caption1, lineHeight: lineHeight.caption1 };
  return (
    <Pressable
      accessibilityRole={summary ? "button" : undefined}
      accessibilityLabel={worktreeLinkText(context)}
      accessibilityHint={summary ? "Opens the linked summary" : undefined}
      disabled={!summary}
      onPress={() => summary && onOpen("Linked summary", summary)}
      style={({ pressed }) => (summary ? pressStyle({ pressed, kind: "row" }) : undefined)}
    >
      <TranscriptDivider label={worktreeLinkText(context)} icon={Link04Icon}>
        <Text style={[caption, { color: colors.ink3 }]}>Linked to{label.lead ? ` ${label.lead}` : ""}</Text>
        {label.project ? (
          <>
            <ProjectIcon client={client} path={context.project.path} size={12} />
            <Text style={[caption, { color: colors.ink2, fontWeight: "500" }]}>{label.project}</Text>
          </>
        ) : (
          <Icon icon={GitBranchIcon} tone="ink3" size={12} />
        )}
        {label.detail && (
          <Text style={[caption, { color: label.project ? colors.ink3 : colors.ink2, fontFamily: fonts.mono, fontWeight: "500" }]}>{label.detail}</Text>
        )}
        {context.sameProject && <Text style={[caption, { color: colors.ink3 }]}>in this Project</Text>}
      </TranscriptDivider>
    </Pressable>
  );
}
