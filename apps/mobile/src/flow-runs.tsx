import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { RoutineRun } from "@milagre/shared/model";
import type { RoutineWithRuns } from "./use-routines";
import { flowRunMatches, flowRunState, flowRunTitle, runStateLook, runSubtitle, type FlowRunFilter } from "./flow-looks";
import { FlowButton } from "./flow-ui";
import { Icon, SpinnerRing } from "./icons";
import { tap, useStyles } from "./ui";
import { useTheme } from "./theme";

const FILTERS: { id: FlowRunFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "you", label: "Needs you" },
  { id: "stopped", label: "Stopped" },
];

/**
 * A flow's Runs, newest first: each with its state's icon, its issue or name, and where it stands ("Run 15, stopped at
 * Implement after 3 tries"), in orange while it waits for you and red once it stopped. A paused Run has Resume beside it.
 * All, Needs you and Stopped filter them; a filter shows once a Run is in it.
 */
export function FlowRunList({
  routine,
  onOpen,
  onResume,
  resuming,
}: {
  routine: RoutineWithRuns;
  onOpen: (run: RoutineRun) => void;
  onResume: (run: RoutineRun) => void;
  /** The Run whose Resume is being sent. */
  resuming: string;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const [filter, setFilter] = useState<FlowRunFilter>("all");
  const runs = [...(routine.runs ?? [])].sort((a, b) => b.startedAt - a.startedAt);
  const counts: Record<FlowRunFilter, number> = {
    all: runs.length,
    you: runs.filter((run) => flowRunMatches(run, "you")).length,
    stopped: runs.filter((run) => flowRunMatches(run, "stopped")).length,
  };
  // A filter whose last Run left it falls back to All.
  const shown = filter !== "all" && counts[filter] === 0 ? "all" : filter;
  const filters = FILTERS.filter((item) => item.id === "all" || counts[item.id] > 0);
  const list = runs.filter((run) => flowRunMatches(run, shown));

  if (!runs.length)
    return (
      <View style={[styles.card, { alignItems: "center", gap: 4, paddingVertical: 24 }]}>
        <Text style={styles.muted}>No Runs yet</Text>
        <Text style={[styles.caption, { textAlign: "center" }]}>
          {routine.flow?.revision ? "Runs start when the trigger fires." : "Publish the flow to start Runs. A Test run tries the draft."}
        </Text>
      </View>
    );

  return (
    <View style={{ gap: 12 }}>
      {filters.length > 1 ? (
        <View accessibilityRole="radiogroup" style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {filters.map((item) => {
            const selected = shown === item.id;
            return (
              <Pressable
                key={item.id}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected }}
                accessibilityLabel={`${item.label}, ${counts[item.id]}`}
                onPress={() => setFilter(item.id)}
                style={({ pressed }) => ({
                  height: 32,
                  paddingHorizontal: 12,
                  borderRadius: 14,
                  borderCurve: "continuous",
                  justifyContent: "center",
                  backgroundColor: selected ? colors.ink : colors.field,
                  opacity: pressed ? 0.7 : 1,
                })}
              >
                <Text style={{ color: selected ? colors.onInk : colors.ink2, fontSize: 13, fontWeight: selected ? "600" : "500" }}>
                  {item.label} {counts[item.id]}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      <View style={[styles.card, { paddingVertical: 0, gap: 0 }]}>
        {list.map((run, index) => {
          const state = flowRunState(run);
          const look = runStateLook(run);
          const title = flowRunTitle(run, routine.name);
          const subtitle = runSubtitle(routine, run);
          const tint = state === "you" ? colors.orangeInk : state === "failed" ? colors.redInk : colors.ink3;
          return (
            <View key={run.id}>
              {index > 0 ? <View style={styles.separator} /> : null}
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${title}. ${subtitle}`}
                  onPress={() => {
                    tap();
                    onOpen(run);
                  }}
                  style={({ pressed }) => ({ flex: 1, flexDirection: "row", gap: 12, paddingVertical: 14, opacity: pressed ? 0.6 : 1 })}
                >
                  <View style={{ width: 22, paddingTop: 1, alignItems: "center" }}>
                    {look.icon ? <Icon icon={look.icon} tone={look.tone} size={20} /> : <SpinnerRing size={17} tone="accent" />}
                  </View>
                  <View style={{ flex: 1, gap: 3 }}>
                    <Text numberOfLines={2} style={{ color: colors.ink, fontSize: 16, lineHeight: 21, fontWeight: "600" }}>
                      {title}
                    </Text>
                    <Text numberOfLines={2} style={{ color: tint, fontSize: 13, lineHeight: 18 }}>
                      {subtitle}
                    </Text>
                  </View>
                </Pressable>
                {state === "paused" ? <FlowButton title="Resume" kind="secondary" compact loading={resuming === run.id} onPress={() => onResume(run)} /> : null}
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}
