import { useContextSettings } from "../../lib/context-settings";
import { FOLLOW_UP_OPTIONS, type FollowUps } from "@milagre/shared/queued-messages";
import { updateSettings, useSettings } from "../../lib/settings";
import { Select } from "../primitives/Select";
import { Group, Row } from "./SettingsGroup";
import { useDoneSettings } from "../../lib/done-settings";
import { DONE_RETENTION_OPTIONS, retentionLabel } from "@milagre/shared/done";
import { normalizeSnoozeMinutes, SNOOZE_DURATION_OPTIONS, snoozeDurationLabel } from "@milagre/shared/snooze";
import { ReasoningChoice, ToolCallChoice } from "./ChatDisplayChoices";
import { ChoiceGroup } from "./settings-parts";

/** How long a Chat waits in the sidebar's Done list before this Mac archives it. */
export function DoneRetentionSetting() {
  const { settings, save } = useDoneSettings();
  return (
    <Group title="Done">
      <Row label="Archive Done Chats after">
        <Select
          label="Archive Done Chats after"
          width={140}
          value={String(settings.retentionHours)}
          options={DONE_RETENTION_OPTIONS.map((hours) => ({
            value: String(hours),
            label: retentionLabel(hours),
          }))}
          onChange={(value) => void save({ retentionHours: Number(value) }).catch(() => {})}
        />
      </Row>
    </Group>
  );
}

/** How long a Chat row's hover Snooze button puts it away; the row menu's Snooze offers set times too. Kept per device. */
export function SnoozeSetting() {
  const { snoozeMinutes } = useSettings();
  return (
    <Group title="Snooze">
      <Row label="Snooze for" description="How long a Chat's Snooze button puts it away">
        <Select
          label="Snooze for"
          width={140}
          value={String(snoozeMinutes)}
          options={SNOOZE_DURATION_OPTIONS.map((minutes) => ({ value: String(minutes), label: snoozeDurationLabel(minutes) }))}
          onChange={(value) => updateSettings({ snoozeMinutes: normalizeSnoozeMinutes(Number(value)) })}
        />
      </Row>
    </Group>
  );
}

/** Host-kept: what a message sent while a turn runs does, on this computer's Chats from desktop and phone. */
function FollowUpSetting() {
  const host = useContextSettings();
  const current = FOLLOW_UP_OPTIONS.find((option) => option.value === host.settings.followUps) ?? FOLLOW_UP_OPTIONS[0];
  return (
    <Group title="Messages during a turn">
      <Row label="While the agent works" description={current.description}>
        <Select<FollowUps>
          label="Messages during a turn"
          value={current.value}
          disabled={!host.ready || host.saving}
          onChange={(followUps) => void host.save({ followUps })}
          options={FOLLOW_UP_OPTIONS.map(({ value, label }) => ({ value, label }))}
        />
      </Row>
      {host.error && (
        <p role="alert" className="px-4 pb-4 text-12 text-red-ink">
          {host.error}
        </p>
      )}
    </Group>
  );
}

export function ChatSettings() {
  const settings = useSettings();
  return (
    <>
      <FollowUpSetting />
      <ChoiceGroup title="Reasoning">
        <ReasoningChoice expanded={settings.expandReasoning} onChange={(expandReasoning) => updateSettings({ expandReasoning })} />
      </ChoiceGroup>
      <ChoiceGroup title="Tool calls">
        <ToolCallChoice value={settings.toolCallDisplay} onChange={(toolCallDisplay) => updateSettings({ toolCallDisplay })} />
      </ChoiceGroup>
    </>
  );
}
