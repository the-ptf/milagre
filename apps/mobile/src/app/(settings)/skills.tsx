import { useState } from "react";
import { Pressable, RefreshControl, Text, View } from "react-native";
import { Stack, router } from "expo-router";
import type { SkillOption } from "@milagre/shared/model";
import { SKILL_PROVIDERS, SKILL_SCOPES, filterSkills, groupSkills, shadowedBy, shortenHome, skillProviderLabel } from "@milagre/shared/skill-catalog";
import type { SkillScope } from "@milagre/shared/skill-catalog";
import { overrides, useSkillBadge, useSkillCatalog } from "../../use-skills";
import { ErrorNotice, Field, PullDown, useStyles } from "../../ui";
import { SettingsScroll } from "../../settings-find";
import { useTheme } from "../../theme";

export default function SkillsScreen() {
  const styles = useStyles();
  const { projectPath, data, error, loading, refresh, connected } = useSkillCatalog();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<SkillScope | "all">("all");
  const [provider, setProvider] = useState("all");
  const groups = groupSkills(filterSkills(data?.skills ?? [], { query, scope, provider }));
  return (
    <>
      <Stack.Screen options={{ title: "Skills" }} />
      <SettingsScroll refreshControl={connected ? <RefreshControl refreshing={loading && !!data} onRefresh={refresh} /> : undefined}>
        {!connected ? (
          <Text style={styles.muted}>Connect to a computer to see its skills.</Text>
        ) : error ? (
          <ErrorNotice message={error} retry={refresh} retryTitle="Reload" />
        ) : !data ? (
          <Text accessibilityRole="text" style={styles.muted}>
            Loading skills…
          </Text>
        ) : (
          <>
            <Text style={styles.caption}>
              {projectPath
                ? "Skills from this Project and your Mac's home folder. When two share a name, the first one found wins. Pull down to reload."
                : "Open a Project to see its skills too. Pull down to reload."}
            </Text>
            <Field label="Search skills" hideLabel placeholder="Search skills" value={query} onChangeText={setQuery} clearButtonMode="while-editing" />
            <View style={[styles.card, { paddingVertical: 4, gap: 0 }]}>
              <FilterMenu
                label="Scope"
                value={scope}
                onChange={(value) => setScope(value as SkillScope | "all")}
                options={[{ value: "all", title: "All scopes" }, ...SKILL_SCOPES.map((item) => ({ value: item.scope, title: item.label }))]}
              />
              <View style={styles.separator} />
              <FilterMenu
                label="Source"
                value={provider}
                onChange={setProvider}
                options={[{ value: "all", title: "All sources" }, ...SKILL_PROVIDERS.map((item) => ({ value: item.provider, title: item.label }))]}
              />
            </View>
            {groups.map((group) => (
              <View key={group.scope} style={{ gap: 8 }}>
                <Text accessibilityRole="header" style={styles.section}>
                  {group.label} · {group.skills.length}
                </Text>
                <View style={[styles.card, { paddingVertical: 0, gap: 0 }]}>
                  {group.skills.map((skill, index) => (
                    <View key={skill.path || skill.name}>
                      {index > 0 && <View style={styles.separator} />}
                      <SkillRow
                        skill={skill}
                        hidden={shadowedBy(data.shadowed, skill).length}
                        onPress={() => router.push({ pathname: "/skill", params: { name: skill.name } })}
                      />
                    </View>
                  ))}
                </View>
              </View>
            ))}
            {!groups.length && <Text style={styles.muted}>No skills found. Create one in .claude/skills/&lt;name&gt;/SKILL.md.</Text>}
            {data.warnings.length > 0 && (
              <View style={{ gap: 8 }}>
                <Text accessibilityRole="header" style={styles.section}>
                  Warnings · {data.warnings.length}
                </Text>
                <View style={[styles.card, { gap: 10 }]}>
                  {data.warnings.map((warning) => (
                    <Text key={warning} selectable style={styles.caption}>
                      {shortenHome(warning)}
                    </Text>
                  ))}
                </View>
              </View>
            )}
          </>
        )}
      </SettingsScroll>
    </>
  );
}

function SkillRow({ skill, hidden, onPress }: { skill: SkillOption; hidden: number; onPress: () => void }) {
  const skillBadge = useSkillBadge();
  const { colors } = useTheme();
  const styles = useStyles();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`/${skill.name}. ${skill.description}`}
      onPress={onPress}
      style={({ pressed }) => ({ paddingVertical: 12, gap: 3, opacity: pressed ? 0.5 : 1 })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text numberOfLines={1} style={[styles.text, { fontWeight: "500", flexShrink: 1 }]}>
          /{skill.name}
        </Text>
        <Text style={skillBadge}>{skillProviderLabel(skill.provider)}</Text>
        {hidden > 0 && <Text style={{ color: colors.orangeInk, fontSize: 11 }}>{overrides(hidden)}</Text>}
      </View>
      <Text numberOfLines={1} style={[styles.caption, { color: colors.ink2, fontSize: 13 }]}>
        {skill.description}
      </Text>
      {!!skill.path && (
        <Text numberOfLines={1} ellipsizeMode="middle" style={styles.caption}>
          {shortenHome(skill.path)}
        </Text>
      )}
    </Pressable>
  );
}

/** A filter row; a tap opens the native menu of its choices. */
function FilterMenu({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; title: string }[];
  onChange: (value: string) => void;
}) {
  const styles = useStyles();
  return (
    <PullDown
      label={label}
      title={label}
      sections={[{ items: options.map((option) => ({ id: option.value, title: option.title, checked: option.value === value })) }]}
      onSelect={onChange}
    >
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 44 }}>
        <Text style={styles.text}>{label}</Text>
        <Text style={styles.muted}>{options.find((option) => option.value === value)?.title}</Text>
      </View>
    </PullDown>
  );
}
