import { NotificationScheduleSetting } from "../NotificationScheduleSetting";
import { SettingCheckbox } from "../primitives/Checkbox";
import { VolumeHighIcon } from "@hugeicons/core-free-icons";
import { updateSettings, useSettings } from "../../lib/settings";
import { Select } from "../primitives/Select";
import { Group, Row } from "./SettingsGroup";
import { NOTIFICATION_CHIMES, type NotificationChime } from "@milagre/shared/notification-chimes";
import { playNotificationChime } from "../../lib/notification-chime";
import { Icon } from "./settings-parts";

function NotificationChimeSetting() {
  const { notificationChime } = useSettings();
  return (
    <Row label="Notification chime" description="Plays when a Chat finishes or needs you. Picking one plays it.">
      <div className="flex items-center gap-1.5">
        {notificationChime !== "system" && (
          <button
            type="button"
            aria-label="Play notification chime"
            title="Play"
            data-chime-play
            className="relative flex size-7 shrink-0 items-center justify-center rounded-control bg-hover text-ink-2"
            onClick={() => playNotificationChime(notificationChime)}
          >
            <Icon icon={VolumeHighIcon} size={14} />
          </button>
        )}
        <Select<NotificationChime>
          label="Notification chime"
          width={200}
          value={notificationChime}
          onChange={(chime) => {
            updateSettings({ notificationChime: chime });
            playNotificationChime(chime);
          }}
          options={NOTIFICATION_CHIMES.map((chime) => ({
            value: chime.id,
            label: chime.label,
          }))}
        />
      </div>
    </Row>
  );
}

export function NotificationsSettings() {
  const settings = useSettings();
  return (
    <>
      <Group title="Alerts">
        <Row label="Notify when finished" description="When a turn finishes or fails while you are outside the chat">
          <SettingCheckbox
            label="Notify when finished"
            checked={settings.notifyOnCompletion}
            onChange={(notifyOnCompletion) => updateSettings({ notifyOnCompletion })}
          />
        </Row>
        <Row label="Dock badge" description="Count chats with unread replies or waiting for your input">
          <SettingCheckbox label="Dock badge" checked={settings.showDockBadge} onChange={(showDockBadge) => updateSettings({ showDockBadge })} />
        </Row>
        <Row label="Notify when waiting" description="When a chat needs an approval or an answer and Milagre is in the background">
          <SettingCheckbox
            label="Notify when waiting"
            checked={settings.notifyWhenWaiting}
            onChange={(notifyWhenWaiting) => updateSettings({ notifyWhenWaiting })}
          />
        </Row>
      </Group>
      <Group title="Schedule">
        <NotificationScheduleSetting />
      </Group>
      <Group title="Sound">
        <NotificationChimeSetting />
      </Group>
      <RoutineNudgesSetting />
    </>
  );
}

/** Settings › Routines: whether this Mac nudges about unread Runs (the top bar's Routines button and the Routines' rows). */
function RoutineNudgesSetting() {
  const settings = useSettings();
  return (
    <Group title="Routines">
      <Row label="Unread Runs dot" description="On the Routines button and each Routine's row, while a Run's Chat has a result you haven't opened">
        <SettingCheckbox label="Unread Runs dot" checked={settings.routineNudges} onChange={(routineNudges) => updateSettings({ routineNudges })} />
      </Row>
    </Group>
  );
}
