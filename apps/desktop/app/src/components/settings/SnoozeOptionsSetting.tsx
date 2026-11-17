import { Cancel01Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import {
  nextSnoozePreset,
  normalizeSnoozePresets,
  sameSnoozePresets,
  snoozeChoices,
  snoozePresetEditor,
  SNOOZE_PRESET_DEFAULTS,
  SNOOZE_PRESETS_MAX,
  withSnoozePresetDay,
  type SnoozePreset,
  type SnoozePresetDay,
} from "@milagre/shared/snooze";
import { updateSettings, useSettings } from "../../lib/settings";
import { Button, IconButton } from "../primitives/Button";
import { Icon } from "../primitives/Icon";
import { Select } from "../primitives/Select";
import { Group } from "./SettingsGroup";
import { useDisplayNow } from "../../lib/display-clock";

const save = (snoozePresets: SnoozePreset[]) => updateSettings({ snoozePresets });

/** The choices in every Chat's Snooze menu. Kept per device, like Snooze for. */
export function SnoozeOptionsSetting() {
  const { snoozePresets: presets } = useSettings();
  const now = useDisplayNow(60_000);
  const editor = snoozePresetEditor(presets, now);
  const menu = snoozeChoices(now, presets);
  return (
    <Group
      title="Snooze options"
      action={
        sameSnoozePresets(presets, SNOOZE_PRESET_DEFAULTS) ? undefined : (
          <Button variant="link" size={24} onClick={() => save(normalizeSnoozePresets(undefined))}>
            Reset
          </Button>
        )
      }
      footer={
        menu.length
          ? `Menu now: ${menu.map((choice) => choice.label).join(" · ")}. Weekdays mean the next one after today.`
          : "The Snooze menu is empty. The Snooze button still works."
      }
    >
      {presets.map((preset, index) => {
        const row = editor.rows[index]!;
        return (
          <div key={index} data-settings-row role="group" aria-label={`Snooze option ${index + 1}`} className="flex min-h-12 items-center gap-2 px-4 py-2">
            <Select<SnoozePresetDay | "after">
              label="When"
              width={130}
              value={preset.kind === "after" ? "after" : preset.day}
              options={editor.days}
              onChange={(day) => save(presets.map((each, at) => (at === index ? withSnoozePresetDay(each, day) : each)))}
            />
            {preset.kind === "after" ? (
              <Select
                label="Duration"
                width={130}
                value={String(preset.minutes)}
                options={editor.durations}
                onChange={(minutes) => save(presets.map((each, at) => (at === index ? { kind: "after", minutes: Number(minutes) } : each)))}
              />
            ) : (
              <>
                <span className="text-12 text-ink-3">at</span>
                <Select
                  label="Time"
                  width={100}
                  value={preset.time}
                  options={editor.times}
                  onChange={(time) => save(presets.map((each, at) => (at === index ? { ...preset, time } : each)))}
                />
              </>
            )}
            <span className="ml-auto flex min-w-0 items-center gap-2 truncate text-12 text-ink-3">
              {row.label ? (
                <>
                  <span className="text-ink-2">{row.label}</span>
                  <span className="tabular-nums">{row.when}</span>
                </>
              ) : (
                row.note
              )}
            </span>
            <IconButton
              label={`Remove snooze option ${index + 1}`}
              icon={Cancel01Icon}
              size={24}
              variant="danger-ghost"
              onClick={() => save(presets.filter((_, at) => at !== index))}
            />
          </div>
        );
      })}
      <div className="px-2 py-1.5">
        <Button variant="quiet" size={28} disabled={presets.length >= SNOOZE_PRESETS_MAX} onClick={() => save([...presets, nextSnoozePreset(presets)])}>
          <Icon icon={PlusSignIcon} size={12} />
          Add option
        </Button>
      </div>
    </Group>
  );
}
