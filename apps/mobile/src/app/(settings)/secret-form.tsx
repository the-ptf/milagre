import { useState } from "react";
import { Text, View } from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { SECRETS_COPY, SECRET_LIMITS, loginName, loginSite, secretNameProblem } from "@milagre/shared/secrets";
import { ErrorNotice, Field, InlineError, PageScroll, PillButton, Segmented, useStyles } from "../../ui";
import { SecretOptInFields, SecretScopeFields, SecretValueField, type SecretOptIns } from "../../secret-fields";
import { useSecrets } from "../../use-secrets";

export default function SecretFormScreen() {
  const styles = useStyles();
  const secrets = useSecrets();
  const params = useLocalSearchParams<{ kind?: string }>();
  const [kind, setKind] = useState<"secret" | "login">(params.kind === "login" ? "login" : "secret");
  const [site, setSite] = useState("");
  const [username, setUsername] = useState("");
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [projects, setProjects] = useState<"all" | string[]>("all");
  const [optIns, setOptIns] = useState<SecretOptIns>({ delivery: "on-demand", askEachUse: false, unattended: false });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const problem = name ? secretNameProblem(name) : null;
  const replaces = !problem && secrets.loaded?.secrets.some((secret) => secret.name === name);
  const login = kind === "login";
  const address = login ? loginSite(site) : null;
  const scoped = projects === "all" || projects.length > 0;
  const ready = (login ? !!address?.origin : !!name && !problem) && !!value && scoped && !saving && !!secrets.client;
  const save = async () => {
    if (!ready) return;
    setSaving(true);
    setError("");
    try {
      if (login && address?.origin) {
        const entry = { origin: address.origin, username: username.trim() };
        await secrets.set({
          name: loginName(entry.origin, entry.username),
          value,
          kind: "login",
          login: entry,
          projects,
          unattended: optIns.unattended,
          note: note.trim() || null,
        });
      } else await secrets.set({ name, value, kind: "text", projects, ...optIns, note: note.trim() || null });
      router.back();
    } catch (failure) {
      setError(failure instanceof Error && failure.message ? failure.message : "Could not save the secret.");
      setSaving(false);
    }
  };
  return (
    <>
      <Stack.Screen options={{ title: login ? SECRETS_COPY.logins.add : SECRETS_COPY.add }} />
      <PageScroll>
        <View style={{ gap: 24 }}>
          {secrets.loaded?.locked ? <Text style={styles.muted}>{SECRETS_COPY.locked}</Text> : null}
          <Segmented
            label="Kind"
            value={kind}
            options={[
              { value: "secret", title: "Secret" },
              { value: "login", title: SECRETS_COPY.logins.title },
            ]}
            onChange={(next) => setKind(next as "secret" | "login")}
          />
          {login ? (
            <>
              <View style={{ gap: 8 }}>
                <Field
                  label={SECRETS_COPY.logins.site}
                  placeholder={SECRETS_COPY.logins.sitePlaceholder}
                  value={site}
                  onChangeText={setSite}
                  keyboardType="url"
                  invalid={!!address?.error}
                  editable={!saving}
                />
                {address?.error ? <InlineError message={address.error} style={{ paddingHorizontal: 4 }} /> : null}
              </View>
              <Field
                label={SECRETS_COPY.logins.username}
                value={username}
                onChangeText={setUsername}
                autoComplete="off"
                textContentType="none"
                editable={!saving}
              />
              <SecretValueField
                label={SECRETS_COPY.logins.password}
                placeholder={SECRETS_COPY.logins.passwordPlaceholder}
                value={value}
                onChangeText={setValue}
                disabled={saving}
              />
            </>
          ) : (
            <>
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
            </>
          )}
          <Field label={SECRETS_COPY.note} value={note} onChangeText={setNote} maxLength={SECRET_LIMITS.noteChars} editable={!saving} />
          <SecretScopeFields projects={projects} onChange={setProjects} disabled={saving} />
          <SecretOptInFields
            kind={login ? "login" : "text"}
            value={optIns}
            onChange={(patch) => setOptIns((current) => ({ ...current, ...patch }))}
            disabled={saving}
          />
          {error ? <ErrorNotice message={error} /> : null}
          <PillButton title={login ? SECRETS_COPY.logins.add : SECRETS_COPY.add} size="large" disabled={!ready} loading={saving} onPress={() => void save()} />
        </View>
      </PageScroll>
    </>
  );
}
