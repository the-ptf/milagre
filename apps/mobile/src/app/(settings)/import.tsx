import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { Stack } from "expo-router";
import {
  IMPORT_NONE,
  IMPORT_TITLE,
  defaultSelection,
  foundSources,
  importLabel,
  importIntro,
  importSummary,
  stayedBehind,
  importable,
  projectDetail,
  projectState,
  threadDetail,
  toggleProject,
  toggleThread,
  type ImportRequest,
  type ImportResult,
  type ImportScan,
} from "@milagre/shared/ade-import";
import { rowDate } from "@milagre/shared/storage";
import { useSession } from "../../session";
import { Group, Row } from "../../settings-list";
import { CheckRow } from "../../primitives/check-row";
import { ErrorNotice, PageScroll, PillButton, useStyles } from "../../ui";
import { useTheme } from "../../theme";
import { space, type } from "../../design-tokens";

const olderMilagre = (error: string) => /unknown|not (available|allowed|supported)|no handler/i.test(error);

export default function ImportScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const client = useSession().client;
  const [scan, setScan] = useState<ImportScan | null>(null);
  const [error, setError] = useState("");
  const [selection, setSelection] = useState<ImportRequest>({ projects: [], threads: [] });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const running = useRef(false);
  const [now, setNow] = useState(0);

  const load = () =>
    client?.call<ImportScan>("import:scan", []).then(
      (answer) => {
        setNow(Date.now());
        setScan(answer);
        setSelection(defaultSelection(answer));
        setError("");
      },
      (failure: Error) => setError(failure.message),
    );
  useEffect(() => {
    void load();
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- load reads only the client, which this effect follows
  }, [client]);

  async function run() {
    if (!client || running.current) return;
    running.current = true;
    setBusy(true);
    try {
      setResult(await client.call<ImportResult>("import:run", [selection]));
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  const sources = foundSources(scan);
  const nothing = !selection.projects.length && !selection.threads.length;
  return (
    <>
      <Stack.Screen options={{ title: IMPORT_TITLE }} />
      <PageScroll>
        <View style={{ gap: space.section }}>
          <Text style={{ color: colors.ink2, fontSize: type.subheadline }}>{importIntro(scan)}</Text>
          {result ? (
            <Group title={importSummary(result)} inset={0}>
              {stayedBehind(result, scan).map((item, index) => (
                <Row key={`${item.title}-${index}`} title={item.title} subtitle={item.why} subtitleLines={3} chevron={false} />
              ))}
            </Group>
          ) : null}
          {error ? <ErrorNotice message={olderMilagre(error) ? "This computer's Milagre can't import yet. Update it first." : error} /> : null}
          {scan === null && !error ? (
            <ActivityIndicator color={colors.ink3} style={{ marginTop: 24 }} />
          ) : scan && !sources.length ? (
            <Text style={{ color: colors.ink3, fontSize: type.subheadline, paddingVertical: 16, textAlign: "center" }}>{IMPORT_NONE}</Text>
          ) : (
            <>
              {sources.map((source) =>
                source.projects.map((project) => {
                  const state = projectState(selection, source.id, project);
                  return (
                    <Group key={`${source.id}:${project.path}`} title={`${source.label} · ${project.name}`} inset={0}>
                      <CheckRow
                        kind="checkbox"
                        title={project.name}
                        subtitle={projectDetail(project)}
                        subtitleLines={2}
                        checked={state === true}
                        disabled={busy || !project.exists}
                        onPress={() => setSelection((current) => toggleProject(current, source.id, project, state !== true))}
                      />
                      {project.exists
                        ? project.threads.map((thread) => {
                            const on = selection.threads.includes(thread.id);
                            const when = thread.updatedAt ? ` · ${rowDate(thread.updatedAt, now)}` : "";
                            return (
                              <CheckRow
                                key={thread.id}
                                kind="checkbox"
                                title={thread.title}
                                subtitle={`${threadDetail(thread)}${when}`}
                                subtitleLines={3}
                                checked={on}
                                disabled={busy || !importable(thread)}
                                onPress={() => setSelection((current) => toggleThread(current, source.id, project, thread, !on))}
                              />
                            );
                          })
                        : null}
                    </Group>
                  );
                }),
              )}
              <PillButton title={busy ? "Importing…" : importLabel(selection)} variant="primary" disabled={busy || nothing} onPress={() => void run()} />
              <Text style={styles.caption}>{"Chats on agents Milagre doesn't run, and threads that never started, stay behind."}</Text>
            </>
          )}
        </View>
      </PageScroll>
    </>
  );
}
