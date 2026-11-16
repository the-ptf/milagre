import { useState } from "react";
import { Text, View } from "react-native";
import { activeRoles, type OrchestratorRole, type OrchestratorSettings } from "@milagre/shared/orchestrator";
import type { AgentModels, ModelProvider } from "@milagre/shared/model";
import { effortCopy } from "@milagre/shared/model-copy";
import { providerName } from "@milagre/shared/providers";
import { lineHeight, space, type } from "./design-tokens";
import { modelAndEffort } from "./orchestrator-board";
import { MenuRow } from "./orchestrator-section";
import { Group } from "./settings-list";
import { useTheme } from "./theme";
import { modelsFor } from "./turn-options";
import { Field, Toggle, useStyles } from "./ui";

type Save = (patch: Partial<OrchestratorSettings>) => void;
const PROVIDERS: ModelProvider[] = ["claude", "codex", "antigravity", "kiro"];

function RoleRow({ role, models, onChange }: { role: OrchestratorRole; models: AgentModels | null; onChange: (role: OrchestratorRole) => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const [instructions, setInstructions] = useState(role.instructions ?? "");
  const active = !!role.model;
  const pickedModel = role.provider ? modelsFor(role.provider, models).find((model) => model.id === role.model) : undefined;
  const efforts = pickedModel?.efforts?.length ? pickedModel.efforts : ["low", "medium", "high"];
  return (
    <View style={{ gap: space.md, paddingVertical: space.lg }}>
      <View style={{ gap: space.xxs }}>
        <Text style={{ color: colors.ink, fontSize: type.callout, lineHeight: lineHeight.callout, fontWeight: "600" }}>{role.name}</Text>
        {active ? null : <Text style={styles.caption}>No model set · role inactive</Text>}
      </View>
      <MenuRow
        title={`${role.name} model`}
        value={active ? modelAndEffort(role.provider, role.model, null, models) : "Not set"}
        sections={[
          { items: [{ id: "none", title: "No model (role off)", checked: !active }] },
          ...PROVIDERS.map((provider) => ({
            title: providerName(provider),
            items: modelsFor(provider, models).map((model) => ({
              id: `${provider}:${model.id}`,
              title: model.name,
              checked: role.provider === provider && role.model === model.id,
            })),
          })),
        ]}
        onSelect={(id) => {
          if (id === "none") return onChange({ ...role, provider: null, model: null, effort: null });
          const [provider, ...rest] = id.split(":");
          if (PROVIDERS.includes(provider as ModelProvider))
            onChange({ ...role, provider: provider as OrchestratorRole["provider"], model: rest.join(":"), effort: role.effort ?? "high" });
        }}
      />
      {active ? (
        <MenuRow
          title={`${role.name} effort`}
          value={role.effort ? effortCopy(role.effort).name : "Default"}
          sections={[{ items: efforts.map((effort) => ({ id: effort, title: effortCopy(effort).name, checked: role.effort === effort })) }]}
          onSelect={(effort) => onChange({ ...role, effort })}
        />
      ) : null}
      <Field
        label="Instructions"
        multiline
        autoCapitalize="sentences"
        autoCorrect
        placeholder={`Built in: the ${role.name} agent works in the Project the router picked.`}
        value={instructions}
        onChangeText={setInstructions}
        onBlur={() => {
          const next = instructions.trim() || null;
          if (next !== role.instructions) onChange({ ...role, instructions: next });
        }}
        style={{ minHeight: 72 }}
      />
    </View>
  );
}

export function RolesSection({ settings, models, save }: { settings: OrchestratorSettings; models: AgentModels | null; save: Save }) {
  const styles = useStyles();
  const change = (next: OrchestratorRole) => {
    const roles = settings.roles.map((role) => (role.id === next.id ? next : role));
    if (activeRoles(roles).length) save({ roles });
  };
  return (
    <Group title="Roles and models" inset="full">
      {settings.roles.map((role) => (
        <RoleRow key={role.id} role={role} models={models} onChange={change} />
      ))}
      <Text style={[styles.caption, { paddingVertical: space.lg }]}>At least one role keeps a model.</Text>
    </Group>
  );
}

export function BoardSection({ settings, save }: { settings: OrchestratorSettings; save: Save }) {
  const styles = useStyles();
  return (
    <Group title="Board" inset={0}>
      <View style={{ gap: space.xs, paddingVertical: space.md }}>
        <Toggle
          title="Keep Orchestrator Subchats out of the sidebar"
          selected={settings.hideTaskChats}
          onPress={() => save({ hideTaskChats: !settings.hideTaskChats })}
        />
        <Text style={styles.caption}>Move any task to the sidebar from its card or its Subchat.</Text>
      </View>
      <View style={{ gap: space.xs, paddingVertical: space.md }}>
        <Toggle title="Notify me when a task needs me" selected={settings.notify} onPress={() => save({ notify: !settings.notify })} />
        <Text style={styles.caption}>Approvals and questions from any task.</Text>
      </View>
      <View style={{ gap: space.xs, paddingVertical: space.md }}>
        <Toggle title="Show the board" selected={!settings.boardHidden} onPress={() => save({ boardHidden: !settings.boardHidden })} />
        <Text style={styles.caption}>Off: the Orchestrator screen shows only the box and counts.</Text>
      </View>
    </Group>
  );
}
