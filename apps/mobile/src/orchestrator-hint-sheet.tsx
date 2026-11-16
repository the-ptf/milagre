import { useState } from "react";
import { Text, View } from "react-native";
import { router } from "expo-router";
import { space } from "./design-tokens";
import { projectsPatch } from "./orchestrator-projects-section";
import { useSession } from "./session";
import { Field, PillButton, SheetBody, useStyles } from "./ui";
import { useOrchestrator } from "./use-orchestrator";
import { useOrchestratorProjects } from "./use-orchestrator-lists";

/** One Project's routing hints as a bottom sheet: Save keeps the text, and the Project's own files take over when it's cleared. */
export function OrchestratorHintSheet({ path, name }: { path: string; name: string }) {
  const styles = useStyles();
  const session = useSession();
  const { snapshot, store } = useOrchestrator(session.client);
  const listed = useOrchestratorProjects(session.client)?.find((project) => project.path === path);
  const settings = snapshot?.settings;
  const saved = settings?.projects[path]?.hints ?? listed?.hints ?? null;
  const [text, setText] = useState<string | null>(null);
  const value = text ?? saved ?? "";
  const save = (hints: string | null) => {
    if (settings && store) void store.saveSettings(projectsPatch(settings, path, { hints })).catch(() => {});
    router.back();
  };
  return (
    <SheetBody style={{ gap: space.xxl }}>
      <View style={{ gap: space.md }}>
        <Text accessibilityRole="header" numberOfLines={1} style={[styles.sheetTitle, { textAlign: "center" }]}>
          {name}
        </Text>
        <Text style={[styles.muted, { textAlign: "center" }]}>What this Project is, so the router can tell it apart.</Text>
      </View>
      <Field
        label={`Hints for ${name}`}
        hideLabel
        multiline
        autoFocus
        autoCapitalize="sentences"
        maxLength={600}
        placeholder={listed?.defaultHints ?? "What this Project is, so the router can tell it apart"}
        value={value}
        onChangeText={setText}
        style={{ minHeight: 96 }}
      />
      <View style={{ gap: space.lg }}>
        <PillButton size="large" title="Save" variant="primary" disabled={!settings} onPress={() => save(value.trim() || null)} />
        <PillButton size="large" title="Use the Project's own files" variant="plain" disabled={!settings || (!saved && !value)} onPress={() => save(null)} />
        <PillButton size="large" title="Cancel" variant="plain" muted onPress={() => router.back()} />
      </View>
    </SheetBody>
  );
}
