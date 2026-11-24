import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ArrowDown01Icon, ShieldUserIcon } from "@hugeicons/core-free-icons";
import { MASCOT_COLORS, VETO_SECONDS, type AutopilotMode, type OrchestratorSettings } from "@milagre/shared/orchestrator";
import type { AgentModels } from "@milagre/shared/model";
import { lineHeight, radius, space, type } from "./design-tokens";
import { Icon } from "./icons";
import { Mascot } from "./mascot";
import type { MenuSection } from "./primitives/menu";
import { modelName } from "./orchestrator-board";
import { Findable } from "./settings-find";
import { Group } from "./settings-list";
import { useTheme } from "./theme";
import { modelsFor } from "./turn-options";
import { DISABLED_OPACITY, Field, PullDown, Segmented, Toggle, useStyles } from "./ui";

type Save = (patch: Partial<OrchestratorSettings>) => void;

const AUTOPILOT: { value: AutopilotMode; title: string; hint: string }[] = [
  {
    value: "answer",
    title: "Answer for me",
    hint: "Answers questions and approvals in the tasks it started, and notes why on the card. You can undo any answer.",
  },
  { value: "ask", title: "Ask me first", hint: "Proposes an answer and waits for your OK." },
  { value: "off", title: "Off", hint: "Every question and approval waits for you." },
];
const vetoLabel = (seconds: number) => (seconds === 0 ? "None" : seconds < 60 ? `${seconds} seconds` : `${seconds / 60} minutes`);

export const dimmed = (on: boolean) => (on ? null : { opacity: DISABLED_OPACITY.control });

/** A row whose value opens a native menu of checked choices. */
export function MenuRow({
  title,
  subtitle,
  value,
  sections,
  onSelect,
}: {
  title: string;
  subtitle?: string;
  value: string;
  sections: MenuSection[];
  onSelect: (id: string) => void;
}) {
  const { colors } = useTheme();
  return (
    <Findable title={title}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.lg, minHeight: subtitle ? 56 : 52, paddingVertical: space.md }}>
        <View style={{ flex: 1, gap: space.xs }}>
          <Text style={{ color: colors.ink, fontSize: subtitle ? type.callout : type.body, lineHeight: subtitle ? lineHeight.callout : lineHeight.body }}>
            {title}
          </Text>
          {subtitle ? <Text style={{ color: colors.ink3, fontSize: type.caption1, lineHeight: lineHeight.caption1 }}>{subtitle}</Text> : null}
        </View>
        <PullDown label={title} sections={sections} onSelect={onSelect}>
          <View style={{ minHeight: 44, flexDirection: "row", alignItems: "center", gap: space.xs, maxWidth: 200 }}>
            <Text numberOfLines={1} style={{ color: colors.ink2, fontSize: type.subheadline, lineHeight: lineHeight.subheadline }}>
              {value}
            </Text>
            <Icon icon={ArrowDown01Icon} tone="ink3" size={12} />
          </View>
        </PullDown>
      </View>
    </Findable>
  );
}

function Swatches({ color, onPick }: { color: string; onPick: (color: string) => void }) {
  const { colors } = useTheme();
  return (
    <Findable title="Mascot color">
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.lg, paddingVertical: space.lg }}>
        <Mascot size={44} color={color} />
        <View accessibilityRole="radiogroup" accessibilityLabel="Mascot color" style={{ flex: 1, flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
          {MASCOT_COLORS.map((swatch, index) => (
            <Pressable
              key={swatch}
              accessibilityRole="radio"
              accessibilityLabel={index === 0 ? "White" : `Color ${index + 1}`}
              accessibilityState={{ checked: swatch === color }}
              onPress={() => onPick(swatch)}
              style={{
                width: 36,
                height: 36,
                borderRadius: radius.full,
                alignItems: "center",
                justifyContent: "center",
                borderWidth: 2,
                borderColor: swatch === color ? colors.ink : "transparent",
              }}
            >
              <View style={{ width: 26, height: 26, borderRadius: radius.full, backgroundColor: swatch, borderWidth: 1, borderColor: colors.lineStrong }} />
            </Pressable>
          ))}
        </View>
      </View>
    </Findable>
  );
}

function NameRow({ name, onSave }: { name: string; onSave: (name: string) => void }) {
  const styles = useStyles();
  const [draft, setDraft] = useState(name);
  const commit = () => {
    const next = draft.replace(/\s+/g, " ").trim();
    if (next && next !== name) onSave(next);
    else setDraft(name);
  };
  return (
    <Findable title="Name">
      <View style={{ paddingVertical: space.lg }}>
        <Field
          label="Name"
          value={draft}
          maxLength={40}
          trailing={<Text style={styles.caption}>{`${draft.length}/40`}</Text>}
          autoCapitalize="words"
          returnKeyType="done"
          onChangeText={setDraft}
          onBlur={commit}
          onSubmitEditing={commit}
        />
      </View>
    </Findable>
  );
}

function routerSections(settings: OrchestratorSettings, models: AgentModels | null): MenuSection[] {
  return (["claude", "codex"] as const).map((provider) => ({
    title: provider === "claude" ? "Claude" : "Codex",
    items: modelsFor(provider, models).map((model) => ({
      id: `${provider}:${model.id}`,
      title: model.name,
      checked: settings.router.provider === provider && settings.router.model === model.id,
    })),
  }));
}

export function OrchestratorSection({
  settings,
  models,
  save,
  computers,
  completion,
}: {
  settings: OrchestratorSettings;
  models: AgentModels | null;
  save: Save;
  computers?: React.ReactNode;
  completion?: React.ReactNode;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const on = settings.enabled;
  const autopilot = AUTOPILOT.find((mode) => mode.value === settings.autopilot) ?? AUTOPILOT[0];
  return (
    <View style={{ gap: space.section }}>
      <View style={[styles.card, { gap: space.xs }]}>
        <Toggle title="Turn on the Orchestrator" selected={on} onPress={() => save({ enabled: !on })} />
        <Text style={styles.caption}>
          One box for every Project. It picks the Project, the role, the model and the account, then runs the work as a Subchat. Turning it off keeps your
          tasks.
        </Text>
        {on ? null : <Text style={styles.caption}>Turn it on to change the settings below.</Text>}
      </View>
      <View pointerEvents={on ? "auto" : "none"} style={[{ gap: space.section }, dimmed(on)]}>
        {completion}
        <Group title="Name" inset={0}>
          <NameRow key={settings.name} name={settings.name} onSave={(name) => save({ name })} />
        </Group>
        <Group title="Mascot" inset={0}>
          <Swatches color={settings.mascotColor} onPick={(mascotColor) => save({ mascotColor })} />
        </Group>
        <Group title="Routing" inset={0}>
          <MenuRow
            title="Router model"
            subtitle="Sends your prompt, your kept notes and the Project hints to this model's provider, on your account"
            value={modelName(settings.router.provider, settings.router.model, models)}
            sections={routerSections(settings, models)}
            onSelect={(id) => {
              const [provider, ...rest] = id.split(":");
              if (provider === "claude" || provider === "codex") save({ router: { provider, model: rest.join(":") } });
            }}
          />
          <MenuRow
            title="When no Project fits"
            subtitle={settings.whenUnsure === "ask" ? "The task waits in Needs you until you pick" : "Runs in the closest match; you can re-route it"}
            value={settings.whenUnsure === "ask" ? "Ask me" : "Best guess"}
            sections={[
              {
                items: [
                  { id: "ask", title: "Ask me", checked: settings.whenUnsure === "ask" },
                  { id: "guess", title: "Best guess", checked: settings.whenUnsure === "guess" },
                ],
              },
            ]}
            onSelect={(id) => save({ whenUnsure: id === "guess" ? "guess" : "ask" })}
          />
          <MenuRow
            title="Account"
            subtitle={settings.account === "least-used" ? "Spreads work and skips an account at its limit" : "Uses the account each Project already picked"}
            value={settings.account === "least-used" ? "Least used today" : "Project's account"}
            sections={[
              {
                items: [
                  { id: "least-used", title: "Least used today", checked: settings.account === "least-used" },
                  { id: "project", title: "Project's account", checked: settings.account === "project" },
                ],
              },
            ]}
            onSelect={(id) => save({ account: id === "project" ? "project" : "least-used" })}
          />
        </Group>
        {computers ? (
          <Group title="Computers" inset={0}>
            <View style={{ gap: space.xs, paddingVertical: space.md }}>
              <Toggle
                title="Use other computers"
                selected={settings.useOtherComputers}
                onPress={() => save({ useOtherComputers: !settings.useOtherComputers })}
              />
              <Text style={styles.caption}>
                When a Project is on more than one computer, a task runs on the one with the most room: free CPU and memory, agents already running.
              </Text>
            </View>
            {computers}
          </Group>
        ) : null}
        <Group title="Autopilot" inset={0}>
          <View style={{ gap: space.md, paddingVertical: space.lg }}>
            <Text style={{ color: colors.ink, fontSize: type.body, lineHeight: lineHeight.body }}>Answer threads for me</Text>
            <Segmented
              label="Answer threads for me"
              value={settings.autopilot}
              options={AUTOPILOT.map(({ value, title }) => ({ value, title }))}
              onChange={(value) => save({ autopilot: AUTOPILOT.find((mode) => mode.value === value)?.value ?? "answer" })}
            />
            <Text style={styles.caption}>{autopilot?.hint}</Text>
          </View>
          {settings.autopilot !== "off" ? (
            <>
              <View>
                <MenuRow
                  title="Time to veto"
                  subtitle="When it isn't sure, it waits this long before answering so you can step in"
                  value={vetoLabel(settings.vetoSeconds)}
                  sections={[
                    { items: VETO_SECONDS.map((seconds) => ({ id: String(seconds), title: vetoLabel(seconds), checked: settings.vetoSeconds === seconds })) },
                  ]}
                  onSelect={(id) => save({ vetoSeconds: Number(id) })}
                />
              </View>
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.lg }}>
                <Icon icon={ShieldUserIcon} tone="orange" size={16} />
                <Text style={[styles.caption, { flex: 1, color: colors.ink2 }]}>
                  Always asks you before merging, pushing to main, deleting, deploying, paying or messaging someone.
                </Text>
              </View>
            </>
          ) : null}
        </Group>
      </View>
    </View>
  );
}
