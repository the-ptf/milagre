import { useState } from "react";
import { Text, View } from "react-native";
import { Stack, router } from "expo-router";
import { SECRETS_COPY, SECRET_LIMITS, secretNameProblem } from "@milagre/shared/secrets";
import { ErrorNotice, Field, InlineError, PageScroll, PillButton, useStyles } from "../../ui";
import { SecretOptInFields, SecretScopeFields, SecretValueField, type SecretOptIns } from "../../secret-fields";
import { useSecrets } from "../../use-secrets";

export default function SecretFormScreen() {
  const styles = useStyles();
  const secrets = useSecrets();
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [projects, setProjects] = useState<"all" | string[]>("all");
  const [optIns, setOptIns] = useState<SecretOptIns>({ delivery: "on-demand", askEachUse: false, unattended: false });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const problem = name ? secretNameProblem(name) : null;
  const replaces = !problem && secrets.loaded?.secrets.some((secret) => secret.name === name);
  const ready = !!name && !problem && !!value && (projects === "all" || projects.length > 0) && !saving && !!secrets.client;
  const save = async () => {
    if (!ready) return;
    setSaving(true);
    setError("");
    try {
      await secrets.set({ name, value, kind: "text", projects, ...optIns, note: note.trim() || null });
      router.back();
    } catch (failure) {
      setError(failure instanceof Error && failure.message ? failure.message : "Could not save the secret.");
      setSaving(false);
    }
  };
  return (
    <>
      <Stack.Screen options={{ title: SECRETS_COPY.add }} />
      <PageScroll>
        <View style={{ gap: 24 }}>
          {secrets.loaded?.locked ? <Text style={styles.muted}>{SECRETS_COPY.locked}</Text> : null}
          <View style={{ gap: 8 }}>
            <Field
              label={SECRETS_COPY.name}
              placeholder="VERCEL_TOKEN"
              value={name}
              onChangeText={(next) => setName(next.toUpperCase())}
              autoCapitalize="characters"
              maxLength={64}
              invalid={!!problem}
              editable={!saving}
            />
            {problem ? <InlineError message={problem} style={{ paddingHorizontal: 4 }} /> : null}
            {replaces ? <InlineError warning message={SECRETS_COPY.saveAs.replaces(name)} style={{ paddingHorizontal: 4 }} /> : null}
          </View>
          <SecretValueField label={SECRETS_COPY.value} value={value} onChangeText={setValue} disabled={saving} />
          <Field label={SECRETS_COPY.note} value={note} onChangeText={setNote} maxLength={SECRET_LIMITS.noteChars} editable={!saving} />
          <SecretScopeFields projects={projects} onChange={setProjects} disabled={saving} />
          <SecretOptInFields kind="text" value={optIns} onChange={(patch) => setOptIns((current) => ({ ...current, ...patch }))} disabled={saving} />
          {error ? <ErrorNotice message={error} /> : null}
          <PillButton title={SECRETS_COPY.add} size="large" disabled={!ready} loading={saving} onPress={() => void save()} />
        </View>
      </PageScroll>
    </>
  );
}
