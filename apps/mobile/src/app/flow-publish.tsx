import { useState } from "react";
import { Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Add01Icon, InformationCircleIcon, MinusSignIcon, PencilEdit02Icon } from "@hugeicons/core-free-icons";
import { flowChanges, flowProblems, needsAnswer } from "@milagre/shared/routine-flows";
import { useSession } from "../session";
import { useRoutines } from "../use-routines";
import { useFlowDraft } from "../flow-draft";
import { changeKind, runName, runsInProgress } from "../flow-looks";
import { Icon } from "../icons";
import { lineHeight, radius, space, type } from "../design-tokens";
import { ErrorNotice, PillButton, useStyles } from "../ui";
import { useTheme } from "../theme";

/**
 * The Publish sheet: the revision it makes, what changed since the last one, and (when a Run is in progress) that the Run
 * keeps the revision it started on. The first publish also turns the flow on.
 */
export default function FlowPublishSheet() {
  const params = useLocalSearchParams<{ id: string }>();
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { client } = useSession();
  const routines = useRoutines(client);
  const routine = routines.routines.find((item) => item.id === params.id);
  const draft = useFlowDraft(client, routine, routines.update);
  const [error, setError] = useState("");
  const [publishing, setPublishing] = useState(false);
  const revision = routine?.flow?.revision ?? 0;
  const next = revision + 1;
  const changes = flowChanges(draft.published, draft.steps);
  const problem = routine ? flowProblems(draft.steps, routine.trigger.kind)[0] : undefined;
  const going = routine ? runsInProgress(routine.runs) : [];

  async function publish() {
    if (!routine || publishing) return;
    setError("");
    setPublishing(true);
    try {
      await draft.flush();
      // The first revision turns the flow on: until then it had nothing to run.
      await routines.update(routine.id, revision === 0 ? { publishFlow: true, enabled: true } : { publishFlow: true });
      router.back();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not publish this flow.");
    } finally {
      setPublishing(false);
    }
  }

  const note = (() => {
    if (!going.length || revision === 0) return "";
    if (going.length === 1) {
      const run = going[0]!;
      return `${runName(routine!, run)} keeps revision ${run.flow?.revision ?? revision}${needsAnswer(run) ? " and still waits for you" : ""}. New Runs use revision ${next}.`;
    }
    return `${going.length} Runs in progress keep the revision they started on. New Runs use revision ${next}.`;
  })();

  return (
    <View style={{ paddingTop: 24, paddingHorizontal: 20, paddingBottom: Math.max(insets.bottom, 16) + 4, gap: 16 }}>
      <View style={{ gap: 4 }}>
        <Text accessibilityRole="header" style={{ color: colors.ink, fontSize: type.title2, lineHeight: lineHeight.title2, fontWeight: "600" }}>
          {`Publish revision ${next}`}
        </Text>
        <Text style={styles.muted}>
          {revision === 0
            ? "The first revision. Publishing turns the flow on."
            : `${changes.length} ${changes.length === 1 ? "change" : "changes"} since revision ${revision}`}
        </Text>
      </View>
      {error ? <ErrorNotice message={error} /> : null}
      {changes.length && revision > 0 ? (
        <View style={{ borderRadius: radius.card, borderCurve: "continuous", backgroundColor: colors.field, overflow: "hidden" }}>
          {changes.slice(0, 12).map((line, index) => {
            const kind = changeKind(line);
            return (
              <View key={`${index}:${line}`}>
                {index > 0 ? <View style={styles.separator} /> : null}
                <View
                  style={{ flexDirection: "row", alignItems: "center", gap: space.lg, minHeight: 44, paddingHorizontal: space.xl, paddingVertical: space.lg }}
                >
                  <Icon icon={kind === "added" ? Add01Icon : kind === "removed" ? MinusSignIcon : PencilEdit02Icon} tone="ink2" size={16} />
                  <Text style={{ flex: 1, color: colors.ink, fontSize: type.subheadline, lineHeight: lineHeight.subheadline }}>{line}</Text>
                </View>
              </View>
            );
          })}
          {changes.length > 12 ? (
            <View>
              <View style={styles.separator} />
              <Text style={[styles.footnote, { paddingHorizontal: space.xl, paddingVertical: space.lg }]}>{`${changes.length - 12} more`}</Text>
            </View>
          ) : null}
        </View>
      ) : null}
      {problem ? <ErrorNotice message={problem.message} /> : null}
      {note ? (
        <View style={[styles.error, { flexDirection: "row", backgroundColor: colors.orangeTint }]}>
          <View style={{ paddingTop: space.xxs }}>
            <Icon icon={InformationCircleIcon} tone="orangeInk" size={16} />
          </View>
          <Text style={{ flex: 1, color: colors.orangeInk, fontSize: type.subheadline, lineHeight: lineHeight.subheadline }}>{note}</Text>
        </View>
      ) : null}
      <View style={{ gap: space.sm }}>
        <PillButton
          title={`Publish revision ${next}`}
          size="large"
          loading={publishing}
          disabled={!routine || !!problem || (revision > 0 && changes.length === 0)}
          onPress={() => void publish()}
        />
        <PillButton title="Cancel" variant="plain" muted onPress={() => router.back()} />
      </View>
    </View>
  );
}
