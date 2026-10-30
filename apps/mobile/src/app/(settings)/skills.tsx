import { useState } from "react";
import { Pressable, RefreshControl, Text, View } from "react-native";
import { Stack, router } from "expo-router";
import type { SkillOption } from "@milagre/shared/model";
import { SKILL_PROVIDERS, SKILL_SCOPES, filterSkills, groupSkills, shadowedBy, shortenHome, skillProviderLabel } from "@milagre/shared/skill-catalog";
import type { SkillScope } from "@milagre/shared/skill-catalog";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { overrides, useSkillCatalog } from "../../use-skills";
import { EmptyState, ErrorNotice, Field, Group, PageScroll, PullDown, SectionLabel, Tag, pressStyle, useStyles } from "../../ui";
import { Icon } from "../../icons";
import { useTheme } from "../../theme";
import { useHover } from "../../primitives/hover";
import { rowHover, rowMetrics } from "../../primitives/row-metrics";

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
      <PageScroll refreshControl={connected ? <RefreshControl refreshing={loading && !!data} onRefresh={refresh} /> : undefined}>
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
            <Group inset={0}>
              <FilterMenu
                label="Scope"
                value={scope}
                onChange={(value) => setScope(value as SkillScope | "all")}
                options={[{ value: "all", title: "All scopes" }, ...SKILL_SCOPES.map((item) => ({ value: item.scope, title: item.label }))]}
              />
              <FilterMenu
                label="Source"
                value={provider}
                onChange={setProvider}
                options={[{ value: "all", title: "All sources" }, ...SKILL_PROVIDERS.map((item) => ({ value: item.provider, title: item.label }))]}
              />
            </Group>
            {groups.map((group) => (
              <Group key={group.scope} title={`${group.label} · ${group.skills.length}`} inset={0}>
                {group.skills.map((skill) => (
                  <SkillRow
                    key={skill.path || skill.name}
                    skill={skill}
                    hidden={shadowedBy(data.shadowed, skill).length}
                    onPress={() => router.push({ pathname: "/skill", params: { name: skill.name } })}
                  />
                ))}
              </Group>
            ))}
            {!groups.length && <EmptyState title="No skills found">Create one in .claude/skills/&lt;name&gt;/SKILL.md.</EmptyState>}
            {data.warnings.length > 0 && (
              <View style={{ gap: 8 }}>
                <SectionLabel>{`Warnings · ${data.warnings.length}`}</SectionLabel>
                <View style={[styles.card, { gap: 12 }]}>
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
      </PageScroll>
    </>
  );
}

/** A skill on ListRow's two-line metrics, with its source as a Tag and its file path under the description. */
function SkillRow({ skill, hidden, onPress }: { skill: SkillOption; hidden: number; onPress: () => void }) {
  const { colors } = useTheme();
  const styles = useStyles();
  const { hovered, ...pointer } = useHover();
  const metrics = rowMetrics({ subtitle: true });
  return (
    <Pressable
      {...pointer}
      accessibilityRole="button"
      accessibilityLabel={`/${skill.name}. ${skill.description}`}
      onPress={onPress}
      style={({ pressed }) => [metrics.box, hovered && rowHover(colors.hover), pressStyle({ pressed, kind: "row" })]}
    >
      <View style={{ flex: 1, gap: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <Text numberOfLines={1} style={[styles.text, metrics.title, { flexShrink: 1 }]}>
            /{skill.name}
          </Text>
          <Tag label={skillProviderLabel(skill.provider)} />
          {hidden > 0 && <Tag tone="orange" label={overrides(hidden)} />}
        </View>
        <Text numberOfLines={2} style={styles.caption}>
          {skill.description}
        </Text>
        {!!skill.path && (
          <Text numberOfLines={1} ellipsizeMode="middle" style={styles.caption}>
            {shortenHome(skill.path)}
          </Text>
        )}
      </View>
      <Icon icon={ArrowRight01Icon} tone="ink3" size={16} />
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
  const { colors } = useTheme();
  return (
    <PullDown
      label={label}
      title={label}
      sections={[{ items: options.map((option) => ({ id: option.value, title: option.title, checked: option.value === value })) }]}
      onSelect={onChange}
    >
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, minHeight: 52 }}>
        <Text style={styles.text}>{label}</Text>
        <Text style={[styles.text, { color: colors.ink3 }]}>{options.find((option) => option.value === value)?.title}</Text>
      </View>
    </PullDown>
  );
}
