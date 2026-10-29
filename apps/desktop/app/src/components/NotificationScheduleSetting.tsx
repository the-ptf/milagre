import {
  NOTIFICATION_DAYS,
  NOTIFICATION_TIMES,
  notificationTimeZones,
  workHoursSchedule,
  type NotificationSchedule,
} from "@milagre/shared/notification-schedule";
import { useSettings, updateSettings } from "../lib/settings";
import { Select } from "./primitives/Select";
import { thisComputer } from "../lib/shortcut-hints";

const zones = notificationTimeZones().map((value) => ({ value, label: value.replaceAll("_", " ") }));
const save = (value: NotificationSchedule | null) => updateSettings({ notificationSchedule: value });
export function NotificationScheduleSetting() {
  const { notificationSchedule: schedule } = useSettings();
  const mode = !schedule ? "anytime" : schedule.start === "09:00" && schedule.end === "17:00" && schedule.days.join() === "1,2,3,4,5" ? "weekdays" : "custom";
  return (
    <div className="space-y-4 px-4 py-3" data-notification-schedule>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[13px] font-medium text-ink">Notification schedule</p>
          <p className="mt-1 text-[12px] text-ink-3">Quiet outside these hours. Unread Chats stay in your inbox.</p>
        </div>
        <Select
          label="Notification schedule"
          value={mode}
          width={200}
          options={[
            { value: "anytime", label: "Anytime" },
            { value: "weekdays", label: "Weekdays, 9 AM to 5 PM" },
            { value: "custom", label: "Custom hours" },
          ]}
          onChange={(value) =>
            save(
              value === "anytime"
                ? null
                : value === "weekdays"
                  ? workHoursSchedule(schedule?.timeZone)
                  : { ...(schedule ?? workHoursSchedule()), days: [0, 1, 2, 3, 4, 5, 6] },
            )
          }
        />
      </div>
      {schedule && (
        <>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Notification days">
            {NOTIFICATION_DAYS.map((day, index) => (
              <button
                key={day}
                type="button"
                aria-label={day}
                aria-pressed={schedule.days.includes(index)}
                disabled={schedule.days.length === 1 && schedule.days.includes(index)}
                className={`rounded-control border px-3 py-2 text-[12px] disabled:opacity-60 ${schedule.days.includes(index) ? "border-accent bg-accent/15 text-ink" : "border-line text-ink-2 hover:bg-hover"}`}
                onClick={() =>
                  save({
                    ...schedule,
                    days: schedule.days.includes(index)
                      ? schedule.days.filter((value) => value !== index)
                      : NOTIFICATION_DAYS.map((_, number) => number).filter((number) => number === index || schedule.days.includes(number)),
                  })
                }
              >
                {day}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <Select
              label="Notification start time"
              value={schedule.start}
              width={130}
              options={NOTIFICATION_TIMES}
              onChange={(start) =>
                save({
                  ...schedule,
                  start,
                  end:
                    start === schedule.end ? NOTIFICATION_TIMES[(NOTIFICATION_TIMES.findIndex((time) => time.value === start) + 1) % 48]!.value : schedule.end,
                })
              }
            />
            <span className="text-[12px] text-ink-3">to</span>
            <Select
              label="Notification end time"
              value={schedule.end}
              width={130}
              options={NOTIFICATION_TIMES.filter(({ value }) => value !== schedule.start)}
              onChange={(end) => save({ ...schedule, end })}
            />
            <Select
              searchable
              triggerClassName="min-w-0 max-w-[220px]"
              label="Notification timezone"
              value={schedule.timeZone}
              width={280}
              options={zones}
              onChange={(timeZone) => save({ ...schedule, timeZone })}
            />
          </div>
          <p className="text-[12px] text-ink-3">
            {schedule.start > schedule.end ? "Ends the next day. " : ""}Applies to Chat alerts and sounds on {thisComputer}. Quiet-hour alerts are not sent
            later.
          </p>
        </>
      )}
    </div>
  );
}
