import { Text, View } from "react-native";
import { Cancel01Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import {
  nextSnoozePreset,
  normalizeSnoozePresets,
  sameSnoozePresets,
  snoozeChoices,
  snoozePresetEditor,
  SNOOZE_DURATION_OPTIONS,
  SNOOZE_PRESET_DEFAULTS,
  SNOOZE_PRESETS_MAX,
  snoozeDurationLabel,
  withSnoozePresetDay,
  type SnoozePresetDay,
} from "@milagre/shared/snooze";
import { useSnoozeMinutes, useSnoozePresets } from "./snooze-setting";
import { Findable } from "./settings-find";
import { IconButton, PillButton, PullDown, useStyles } from "./ui";
import { space } from "./design-tokens";
import { useDisplayNow } from "./display-clock";

function Picker({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const styles = useStyles();
  const current = options.find((option) => option.value === value)?.label ?? value;
  return (
    <PullDown
      label={label}
      title={label}
      sections={[{ items: options.map((option) => ({ id: option.value, title: option.label, checked: option.value === value })) }]}
      nativeTrigger={{ title: current, systemImage: "chevron.up.chevron.down", showIcon: false, maxWidth: 160 }}
      onSelect={(id) => {
        if (id !== value && options.some((option) => option.value === id)) onChange(id);
      }}
    >
      <Text style={styles.text}>{current}</Text>
    </PullDown>
  );
}

/** Snooze for (a Chat menu's Snooze for) and the Snooze options its Snooze until lists, kept on this phone. */
export function SnoozeSection() {
  const styles = useStyles();
  const [minutes, setMinutes] = useSnoozeMinutes();
  const [presets, setPresets] = useSnoozePresets();
  const now = useDisplayNow(60_000);
  const editor = snoozePresetEditor(presets, now);
  const menu = snoozeChoices(now, presets);
  const change = (index: number, next: (typeof presets)[number]) => setPresets(presets.map((each, at) => (at === index ? next : each)));
  return (
    <>
      <Text style={[styles.section, { marginTop: space.xl }]}>Snooze</Text>
      <Findable title="Snooze for">
        <View style={[styles.card, { flexDirection: "row", alignItems: "center", gap: 12 }]}>
          <Text style={[styles.text, { flex: 1 }]}>Snooze for</Text>
          <Picker
            label="Snooze for"
            value={String(minutes)}
            options={SNOOZE_DURATION_OPTIONS.map((option) => ({ value: String(option), label: snoozeDurationLabel(option) }))}
            onChange={(value) => setMinutes(Number(value))}
          />
        </View>
      </Findable>
      <Text style={styles.muted}>Snooze for, in a Chat&apos;s menu, snoozes it this long. A question, an approval or a failed turn wakes it sooner.</Text>
      <Findable title="Snooze options">
        <View style={[styles.card, { paddingVertical: 0, gap: 0 }]}>
          {presets.map((preset, index) => {
            const row = editor.rows[index]!;
            return (
              <View key={index} accessibilityLabel={`Snooze option ${index + 1}`}>
                {index > 0 && <View style={styles.separator} />}
                <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: space.lg }}>
                  <View style={{ flex: 1, gap: 4 }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                      <Picker
                        label="When"
                        value={preset.kind === "after" ? "after" : preset.day}
                        options={editor.days}
                        onChange={(day) => change(index, withSnoozePresetDay(preset, day as SnoozePresetDay | "after"))}
                      />
                      {preset.kind === "after" ? (
                        <Picker
                          label="Duration"
                          value={String(preset.minutes)}
                          options={editor.durations}
                          onChange={(value) => change(index, { kind: "after", minutes: Number(value) })}
                        />
                      ) : (
                        <Picker label="Time" value={preset.time} options={editor.times} onChange={(time) => change(index, { ...preset, time })} />
                      )}
                    </View>
                    <Text style={styles.caption}>{row.label ? `${row.label} · ${row.when}` : row.note}</Text>
                  </View>
                  <IconButton
                    label={`Remove snooze option ${index + 1}`}
                    icon={Cancel01Icon}
                    size={32}
                    tone="ink3"
                    onPress={() => setPresets(presets.filter((_, at) => at !== index))}
                  />
                </View>
              </View>
            );
          })}
          {presets.length > 0 && <View style={styles.separator} />}
          <View style={{ flexDirection: "row", gap: 8, paddingVertical: space.lg }}>
            <PillButton
              title="Add option"
              icon={PlusSignIcon}
              secondary
              size="small"
              disabled={presets.length >= SNOOZE_PRESETS_MAX}
              onPress={() => setPresets([...presets, nextSnoozePreset(presets)])}
            />
            {!sameSnoozePresets(presets, SNOOZE_PRESET_DEFAULTS) && (
              <PillButton title="Reset" variant="plain" size="small" onPress={() => setPresets(normalizeSnoozePresets(undefined))} />
            )}
          </View>
        </View>
      </Findable>
      <Text style={styles.muted}>
        {menu.length
          ? `Snooze until shows: ${menu.map((choice) => choice.label).join(" · ")}. Weekdays mean the next one after today.`
          : "Snooze until is empty. Snooze for still works."}
      </Text>
    </>
  );
}
