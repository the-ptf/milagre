import { useState } from "react";
import { Text, View } from "react-native";
import {
  activeRoles,
  type OrchestratorMemory,
  type OrchestratorMemoryNote,
  type OrchestratorRole,
  type OrchestratorSettings,
} from "@milagre/shared/orchestrator";
import type { AgentModels, ModelProvider } from "@milagre/shared/model";
import { effortCopy } from "@milagre/shared/model-copy";
import { providerName } from "@milagre/shared/providers";
import { confirm } from "./confirm-store";
import { lineHeight, space, type } from "./design-tokens";
import { MemoryNotes } from "./orchestrator-memory";
import { modelAndEffort } from "./orchestrator-board";
import { MenuRow } from "./orchestrator-section";
import { Group, Row } from "./settings-list";
import { useTheme } from "./theme";
import { modelsFor } from "./turn-options";
import { Field, Segmented, Toggle, useStyles } from "./ui";

type Save = (patch: Partial<OrchestratorSettings>) => void;
const PROVIDERS: ModelProvider[] = ["claude", "codex", "antigravity", "kiro"];

export function MemorySection({
  memory,
  busy,
  onNotes,
  onReadAgain,
  onForget,
}: {
  memory: OrchestratorMemory;
  busy: boolean;
  onNotes: (notes: OrchestratorMemoryNote[]) => void;
  onReadAgain: () => void;
  onForget: () => void;
}) {
  const styles = useStyles();
  const found = memory.sources.filter((source) => source.found).map((source) => source.name);
  return (
    <View style={{ gap: space.md }}>
      <Group title="Memory" inset={0}>
        <View style={{ paddingVertical: space.lg, gap: space.xs }}>
          <Text style={styles.text}>What it knows about you</Text>
          <Text style={styles.caption}>
            {memory.notes.length} {memory.notes.length === 1 ? "note" : "notes"}
            {found.length ? `, read from ${found.join(", ")}` : ""}. Untick a note to stop using it.
          </Text>
        </View>
        <Row title="Read again" value={busy ? "Reading…" : undefined} chevron={false} disabled={busy} onPress={onReadAgain} />
        <Row title="Forget everything" destructive chevron={false} onPress={onForget} />
      </Group>
      {memory.notes.length ? <MemoryNotes notes={memory.notes} onChange={onNotes} deletable /> : null}
    </View>
  );
}

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
        <Text style={styles.caption}>{role.description || (active ? "" : "No model set · role inactive")}</Text>
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
        <>
          <MenuRow
            title={`${role.name} effort`}
            value={role.effort ? effortCopy(role.effort).name : "Default"}
            sections={[{ items: efforts.map((effort) => ({ id: effort, title: effortCopy(effort).name, checked: role.effort === effort })) }]}
            onSelect={(effort) => onChange({ ...role, effort })}
          />
          <Segmented
            label={`${role.name} delegation`}
            value={role.delegation}
            options={[
              { value: "prefer", title: "Prefer" },
              { value: "always", title: "Always" },
            ]}
            onChange={(value) => onChange({ ...role, delegation: value === "always" ? "always" : "prefer" })}
          />
          <Text style={styles.caption}>{role.delegation === "always" ? "Every matching task goes to this role." : "Used when the router is confident."}</Text>
        </>
      ) : (
        <Text style={styles.caption}>Pick a model to turn this role on.</Text>
      )}
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

export async function forgetEverything(onForget: () => void) {
  if (await confirm("Forget everything?", "The Orchestrator drops every note and what it learned from your corrections.", "Forget")) onForget();
}
