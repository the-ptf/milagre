import { useState } from "react";
import { Text, View } from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { SECRETS_COPY, SECRET_LIMITS, secretFlags, type SecretPatch, type SecretSummary } from "@milagre/shared/secrets";
import { ago } from "@milagre/shared/main-sync";
import { ErrorNotice, Field, Group, PageScroll, PillButton, SectionLabel, Tag, useStyles } from "../../ui";
import { confirm } from "../../confirm-store";
import { SecretOptInFields, SecretScopeFields, SecretValueField, secretRowLine } from "../../secret-fields";
import { useSecretLog, useSecrets } from "../../use-secrets";

const FILE_FROM_COMPUTER = "A file secret's value is replaced on the computer that holds the file.";

const UNATTENDED_FLAG = secretFlags({ delivery: "on-demand", askEachUse: false, unattended: true })[0];
const AMBIENT_FLAG = secretFlags({ delivery: "ambient", askEachUse: false, unattended: false })[0];

const message = (failure: unknown) => (failure instanceof Error && failure.message ? failure.message : "Could not reach your computer.");

export default function SecretScreen() {
  const styles = useStyles();
  const { name } = useLocalSearchParams<{ name: string }>();
  const secrets = useSecrets();
  const secret = secrets.loaded?.secrets.find((item) => item.name === name);
  return (
    <>
      <Stack.Screen options={{ title: name ?? SECRETS_COPY.title }} />
      <PageScroll>
        {secrets.error && !secrets.loaded ? (
          <ErrorNotice message={secrets.error} retry={secrets.reload} retryTitle="Try again" />
        ) : !secrets.loaded ? (
          <Text style={styles.muted}>{secrets.client ? "Loading secret…" : "Connect to the computer to see this secret."}</Text>
        ) : secrets.loaded.locked ? (
          <Text style={styles.muted}>{SECRETS_COPY.locked}</Text>
        ) : !secret ? (
          <Text style={styles.muted}>This secret is no longer there.</Text>
        ) : (
          <SecretDetail key={secret.name} secret={secret} now={secrets.loaded.at} update={secrets.update} set={secrets.set} remove={secrets.remove} />
        )}
      </PageScroll>
    </>
  );
}

function SecretDetail({
  secret,
  now,
  update,
  set,
  remove,
}: {
  secret: SecretSummary;
  now: number;
  update: (name: string, patch: SecretPatch) => Promise<SecretSummary>;
  set: ReturnType<typeof useSecrets>["set"];
  remove: (name: string) => Promise<void>;
}) {
  const styles = useStyles();
  const log = useSecretLog(secret.name);
  const [value, setValue] = useState("");
  const [note, setNote] = useState(secret.note ?? "");
  const [projects, setProjects] = useState(secret.projects);
  const [busy, setBusy] = useState<"value" | "settings" | "delete" | null>(null);
  const [error, setError] = useState("");
  const [replaced, setReplaced] = useState(false);
  const run = async (kind: "value" | "settings" | "delete", work: () => Promise<unknown>) => {
    setBusy(kind);
    setError("");
    try {
      await work();
      return true;
    } catch (failure) {
      setError(message(failure));
      return false;
    } finally {
      setBusy(null);
    }
  };
  const change = (patch: SecretPatch) => void run("settings", () => update(secret.name, patch));
  const changeScope = (next: "all" | string[]) => {
    setProjects(next);
    if (next === "all" || next.length) change({ projects: next });
  };
  const saveNote = () => {
    const next = note.trim() || null;
    if (next !== (secret.note ?? null)) change({ note: next });
  };
  const replace = async () => {
    if (!value) return;
    const done = await run("value", () =>
      set({
        name: secret.name,
        value,
        kind: "text",
        projects: secret.projects,
        delivery: secret.delivery,
        askEachUse: secret.askEachUse,
        unattended: secret.unattended,
        note: secret.note,
      }),
    );
    if (done) {
      setValue("");
      setReplaced(true);
    }
  };
  const deleteSecret = async () => {
    if (!(await confirm(SECRETS_COPY.removeConfirm(secret.name), undefined, SECRETS_COPY.remove))) return;
    if (await run("delete", () => remove(secret.name))) router.back();
  };
  return (
    <View style={{ gap: 24 }}>
      <View style={styles.card}>
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <Text selectable numberOfLines={1} style={[styles.subtitle, { fontFamily: styles.code.fontFamily, flexShrink: 1 }]}>
            {secret.name}
          </Text>
          {secret.kind === "file" ? <Tag label={SECRETS_COPY.file} /> : null}
          {secretFlags(secret).map((flag) => (
            <Tag key={flag} label={flag} tone={flag === UNATTENDED_FLAG ? "orange" : "neutral"} />
          ))}
        </View>
        <Text style={styles.caption}>{secretRowLine(secret, now)}</Text>
      </View>

      <View style={{ gap: 8 }}>
        <SectionLabel>{SECRETS_COPY.value}</SectionLabel>
        {secret.kind === "text" ? (
          <View style={[styles.card, { gap: 12 }]}>
            <SecretValueField
              label={SECRETS_COPY.replace}
              value={value}
              onChangeText={(next) => {
                setValue(next);
                setReplaced(false);
              }}
              disabled={busy !== null}
              onSubmitEditing={() => void replace()}
            />
            <PillButton
              title={replaced ? "Replaced" : SECRETS_COPY.replace}
              secondary
              disabled={!value || busy !== null}
              loading={busy === "value"}
              onPress={() => void replace()}
              style={{ alignSelf: "flex-start" }}
            />
          </View>
        ) : (
          <Text style={[styles.muted, { paddingHorizontal: 4 }]}>{FILE_FROM_COMPUTER}</Text>
        )}
      </View>

      <Field label={SECRETS_COPY.note} value={note} onChangeText={setNote} onBlur={saveNote} maxLength={SECRET_LIMITS.noteChars} editable={busy === null} />

      <SecretScopeFields projects={projects} onChange={changeScope} disabled={busy !== null} />

      <SecretOptInFields
        kind={secret.kind}
        value={{ delivery: secret.delivery, askEachUse: secret.askEachUse, unattended: secret.unattended }}
        onChange={change}
        disabled={busy !== null}
      />

      {error ? <ErrorNotice message={error} /> : null}

      <View style={{ gap: 8 }}>
        <SectionLabel>{SECRETS_COPY.log}</SectionLabel>
        {log.error ? (
          <ErrorNotice message={log.error} />
        ) : !log.uses ? (
          <Text style={[styles.muted, { paddingHorizontal: 4 }]}>Loading…</Text>
        ) : !log.uses.length ? (
          <Text style={[styles.muted, { paddingHorizontal: 4 }]}>{SECRETS_COPY.noUses}</Text>
        ) : (
          <Group inset={0}>
            {log.uses.slice(0, 30).map((use) => (
              <View key={`${use.at}:${use.chatId}:${use.command ?? ""}`} style={{ gap: 2, paddingVertical: 12 }}>
                <Text selectable numberOfLines={2} style={styles.code}>
                  {use.command ?? AMBIENT_FLAG}
                </Text>
                <Text style={styles.caption}>{ago(use.at, now)}</Text>
              </View>
            ))}
          </Group>
        )}
      </View>

      <PillButton
        title={SECRETS_COPY.remove}
        destructive
        secondary
        disabled={busy !== null}
        loading={busy === "delete"}
        onPress={() => void deleteSecret()}
        style={{ alignSelf: "flex-start" }}
      />
    </View>
  );
}
