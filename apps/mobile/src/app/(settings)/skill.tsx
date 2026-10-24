import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { SKILL_SCOPES, shadowedBy, shortenHome, skillBody, skillProviderLabel } from "@milagre/shared/skill-catalog";
import { useSession } from "../../session";
import { useRpc } from "../../use-rpc";
import { Markdown } from "../../markdown";
import { ErrorNotice, PageScroll, PillButton, useStyles } from "../../ui";
import { overrides, useSkillBadge, useSkillCatalog } from "../../use-skills";

const scopeLabel = (scope: string) => SKILL_SCOPES.find((item) => item.scope === scope)?.label ?? scope;

/** One skill: where it lives, the same-named skills it hides and its SKILL.md. Editor and Finder stay on the Mac. */
export default function SkillScreen() {
  const styles = useStyles();
  const skillBadge = useSkillBadge();
  const { name } = useLocalSearchParams<{ name: string }>();
  const { client } = useSession();
  const { projectPath, data, error: listError, refresh: reload } = useSkillCatalog();
  const skill = data?.skills.find((item) => item.name === name);
  const content = useRpc<string>(skill?.path ? client : null, "skills:read", [projectPath, skill?.path]);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const hidden = skill ? shadowedBy(data?.shadowed, skill) : [];
  return (
    <>
      <Stack.Screen options={{ title: `/${name}` }} />
      <PageScroll>
        {listError ? (
          <ErrorNotice message={listError} retry={reload} retryTitle="Reload" />
        ) : !data ? (
          <Text style={styles.muted}>{client ? "Loading skill…" : "Connect to the computer to see this skill."}</Text>
        ) : !skill ? (
          <Text style={styles.muted}>This skill is no longer there.</Text>
        ) : (
          <>
            <View style={styles.card}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text selectable numberOfLines={1} style={[styles.subtitle, { flexShrink: 1 }]}>
                  /{skill.name}
                </Text>
                <Text style={skillBadge}>{skillProviderLabel(skill.provider)}</Text>
                <Text style={skillBadge}>{scopeLabel(skill.scope)}</Text>
              </View>
              <Text selectable style={styles.muted}>
                {skill.description}
              </Text>
              {!!skill.path && (
                <Text selectable style={[styles.caption, { fontFamily: styles.code.fontFamily }]}>
                  {shortenHome(skill.path)}
                </Text>
              )}
              <PillButton
                title={copied ? "Copied" : `Copy /${skill.name}`}
                secondary
                style={{ alignSelf: "flex-start" }}
                onPress={() =>
                  void Clipboard.setStringAsync(`/${skill.name}`).then(
                    () => setCopied(true),
                    () => {},
                  )
                }
              />
            </View>
            {hidden.length > 0 && (
              <View style={{ gap: 8 }}>
                <Text accessibilityRole="header" style={styles.section}>
                  {overrides(hidden.length)}
                </Text>
                <View style={[styles.card, { gap: 10 }]}>
                  {hidden.map((item) => (
                    <View key={item.path} style={{ gap: 3 }}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                        <Text style={skillBadge}>{skillProviderLabel(item.provider)}</Text>
                        <Text style={styles.caption}>{scopeLabel(item.scope)}</Text>
                      </View>
                      <Text selectable style={styles.caption}>
                        {shortenHome(item.path)}
                      </Text>
                    </View>
                  ))}
                </View>
              </View>
            )}
            {!skill.path ? null : content.error ? (
              <ErrorNotice message={`Couldn't read this skill: ${content.error}`} retry={content.refresh} retryTitle="Try again" />
            ) : content.data === null ? (
              <Text style={styles.muted}>Reading SKILL.md…</Text>
            ) : (
              <View style={styles.card}>
                <Markdown text={skillBody(content.data)} />
              </View>
            )}
          </>
        )}
      </PageScroll>
    </>
  );
}
