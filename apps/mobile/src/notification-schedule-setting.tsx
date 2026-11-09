import { Text, View } from "react-native";
import {
  NOTIFICATION_DAYS,
  NOTIFICATION_TIMES,
  notificationTimeZones,
  workHoursSchedule,
  type NotificationSchedule,
} from "@milagre/shared/notification-schedule";
import { PillButton, PullDown, Toggle, useStyles } from "./ui";
import { usePush } from "./push";

const zones = notificationTimeZones();
export function NotificationScheduleSetting() {
  const push = usePush();
  const styles = useStyles();
  const schedule = push.state?.schedule;
  const disabled = !push.state || push.busy;
  const save = (next: NotificationSchedule | null) => void push.preferences({ schedule: next });
  const picker = (label: string, value: string, options: { value: string; label: string }[], change: (value: string) => void) => (
    <View style={{ gap: 6, ...(label === "Timezone" ? { flex: 1, minWidth: 0 } : { width: 92 }) }}>
      <Text style={styles.label}>{label}</Text>
      <PullDown
        searchable={label === "Timezone" ? { placeholder: "Search timezones", emptyLabel: "No timezone found" } : undefined}
        label={label}
        title={label}
        sections={[{ items: options.map((option) => ({ id: option.value, title: option.label, checked: option.value === value })) }]}
        nativeTrigger={{ title: options.find((option) => option.value === value)?.label ?? value, systemImage: "clock", showIcon: false, disabled }}
        onSelect={change}
      >
        <Text style={styles.text} numberOfLines={1} ellipsizeMode="middle">
          {options.find((option) => option.value === value)?.label ?? value}
        </Text>
      </PullDown>
    </View>
  );
  return (
    <View style={[styles.card, { gap: 16 }]}>
      <Toggle title="Notification schedule" selected={!!schedule} disabled={disabled} onPress={() => save(schedule ? null : workHoursSchedule())} />
      <Text style={styles.muted}>
        {schedule ? "Quiet outside these hours. Unread Chats stay in your inbox." : "Anytime. Receive Chat alerts whenever they arrive."}
      </Text>
      {schedule && (
        <>
          <PillButton title="Weekdays, 9 AM to 5 PM" secondary disabled={disabled} onPress={() => save(workHoursSchedule(schedule.timeZone))} />
          <View style={{ gap: 4 }}>
            {NOTIFICATION_DAYS.map((day, index) => (
              <Toggle
                key={day}
                title={day}
                selected={schedule.days.includes(index)}
                disabled={disabled || (schedule.days.length === 1 && schedule.days.includes(index))}
                onPress={() =>
                  save({
                    ...schedule,
                    days: schedule.days.includes(index)
                      ? schedule.days.filter((value) => value !== index)
                      : NOTIFICATION_DAYS.map((_, number) => number).filter((number) => number === index || schedule.days.includes(number)),
                  })
                }
              />
            ))}
          </View>
          <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
            {picker("Start time", schedule.start, NOTIFICATION_TIMES, (start) =>
              save({
                ...schedule,
                start,
                end: start === schedule.end ? NOTIFICATION_TIMES[(NOTIFICATION_TIMES.findIndex((time) => time.value === start) + 1) % 48]!.value : schedule.end,
              }),
            )}
            {picker(
              "End time",
              schedule.end,
              NOTIFICATION_TIMES.filter(({ value }) => value !== schedule.start),
              (end) => save({ ...schedule, end }),
            )}
            {picker(
              "Timezone",
              schedule.timeZone,
              zones.map((value) => ({ value, label: value.replaceAll("_", " ") })),
              (timeZone) => save({ ...schedule, timeZone }),
            )}
          </View>
          <Text style={styles.muted}>
            {schedule.start > schedule.end ? "Ends the next day. " : ""}Applies to Chat alerts and sounds on this phone. Quiet-hour alerts are not sent later.
            Changes reach each paired computer when it is online.
          </Text>
        </>
      )}
    </View>
  );
}
