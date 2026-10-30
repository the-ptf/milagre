import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { router } from "expo-router";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { radius } from "../design-tokens";
import { canLinkProjects, type LinkScope } from "@milagre/shared/chat-links";
import { createLinkTitle, linkSummary, linkWorktree, projectsScopeSubtitle, type LinkChoice } from "../chat-links";
import { currentLinkQuestion } from "../link-chat-store";
import { Button, CheckRow, CircleButton, Field, PageScroll, SheetHeader, Toggle, useStyles } from "../ui";
import { useTheme } from "../theme";

/**
 * The "Create Link" confirmation, desktop's dialog on the phone: which ends to link, whether the source Chat may make
 * Delegations without asking, and what it should ask the other Chat. The choice runs once the sheet has gone, as the
 * confirmation sheet's does, so the notice it shows never fights the sheet's dismissal.
 */
export default function LinkChat() {
  const { colors } = useTheme();
  const styles = useStyles();
  const [entry] = useState(currentLinkQuestion);
  const [scope, setScope] = useState<LinkScope>("worktrees");
  const [grant, setGrant] = useState(false);
  const [text, setText] = useState("");
  const chosen = useRef<LinkChoice | null>(null);
  useEffect(() => {
    if (!entry) {
      router.back();
      return;
    }
    return () => entry.choose(chosen.current);
  }, [entry]);
  if (!entry) return null;
  const { source, target } = entry;
  const projects = canLinkProjects(linkWorktree(source), linkWorktree(target));
  const close = (choice: LinkChoice | null) => {
    chosen.current = choice;
    router.back();
  };
  const scopes: { id: LinkScope; title: string; subtitle?: string }[] = [
    { id: "worktrees", title: "Only these Worktrees" },
    ...(projects ? [{ id: "projects" as const, title: "The whole Projects", subtitle: projectsScopeSubtitle(source, target) }] : []),
  ];
  return (
    <PageScroll style={styles.screen} contentContainerStyle={{ gap: 0, padding: 0 }} automaticallyAdjustKeyboardInsets>
      <SheetHeader title="Create Link" leading={<CircleButton label="Cancel" icon={Cancel01Icon} onPress={() => close(null)} />} />
      <View style={{ gap: 16, padding: 16, paddingTop: 8 }}>
        <Text numberOfLines={2} style={[styles.text, { textAlign: "center", fontWeight: "500" }]}>
          {linkSummary(source, target, projects ? scope : "worktrees")}
        </Text>
        <View
          accessibilityRole="radiogroup"
          style={{ borderRadius: radius.card, borderCurve: "continuous", backgroundColor: colors.surface, paddingHorizontal: 16 }}
        >
          {scopes.map((item, index) => (
            <View key={item.id}>
              {index > 0 && <View style={styles.separator} />}
              <CheckRow title={item.title} subtitle={item.subtitle} checked={scope === item.id} onPress={() => setScope(item.id)} />
            </View>
          ))}
        </View>
        <View style={{ gap: 4 }}>
          <Toggle title={`Always allow Delegations from “${source.title}”`} selected={grant} onPress={() => setGrant((value) => !value)} />
          <Text style={styles.caption}>Same as “Always allow for this Link in this chat” on the approval card.</Text>
        </View>
        <Field
          label={`Ask “${source.title}” (optional)`}
          value={text}
          onChangeText={setText}
          placeholder="What should it ask the other chat to do?"
          multiline
          autoCapitalize="sentences"
          autoCorrect
          style={{ minHeight: 96, textAlignVertical: "top" }}
        />
        <Text style={styles.muted}>Every Chat on either side can read the other side and make Delegations to it.</Text>
        <Button title={createLinkTitle(text)} onPress={() => close({ scope: projects ? scope : "worktrees", grant, text })} />
      </View>
    </PageScroll>
  );
}
