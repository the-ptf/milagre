import { Text, View } from "react-native";
import { Stack, router } from "expo-router";
import { Add01Icon, LockKeyIcon } from "@hugeicons/core-free-icons";
import { SECRETS_COPY } from "@milagre/shared/secrets";
import { SettingsScroll } from "../../settings-find";
import { ErrorNotice, Group, ListRow, useStyles } from "../../ui";
import { Icon } from "../../icons";
import { CodeText, secretRowLine } from "../../secret-fields";
import { SecretSharingSection } from "../../secret-sharing-section";
import { useSecrets, useThisComputerName } from "../../use-secrets";

export default function SecretsScreen() {
  const styles = useStyles();
  const { client, loaded, error, reload } = useSecrets();
  const here = useThisComputerName();
  const add = () => router.push("/secret-form");
  return (
    <>
      <Stack.Screen options={{ title: SECRETS_COPY.title }} />
      <SettingsScroll>
        <View style={{ gap: 24 }}>
          <View style={{ gap: 8, paddingHorizontal: 4 }}>
            <Text style={styles.muted}>{SECRETS_COPY.intro}</Text>
            <CodeText text={SECRETS_COPY.usage} />
          </View>
          {!client ? (
            <Text style={styles.muted}>Connect to a computer to see its secrets.</Text>
          ) : error && !loaded ? (
            <ErrorNotice message={error} retry={reload} retryTitle="Try again" />
          ) : !loaded ? (
            <Text style={styles.muted}>Loading secrets…</Text>
          ) : loaded.locked ? (
            <View accessibilityRole="alert" style={[styles.card, { flexDirection: "row", alignItems: "flex-start", gap: 12 }]}>
              <Icon icon={LockKeyIcon} size={20} tone="ink2" />
              <Text style={[styles.muted, { flex: 1 }]}>{SECRETS_COPY.locked}</Text>
            </View>
          ) : (
            <>
              <Group inset={0}>
                <ListRow title={SECRETS_COPY.add} icon={Add01Icon} onPress={add} />
              </Group>
              {loaded.secrets.length ? (
                <Group inset={0}>
                  {loaded.secrets.map((secret) => (
                    <ListRow
                      key={secret.name}
                      title={secret.name}
                      titleLines={1}
                      subtitle={[secret.note, secretRowLine(secret, loaded.at, here)].filter(Boolean).join("\n")}
                      subtitleLines={3}
                      onPress={() => router.push({ pathname: "/secret", params: { name: secret.name } })}
                    />
                  ))}
                </Group>
              ) : (
                <Text style={[styles.muted, { paddingHorizontal: 4 }]}>{SECRETS_COPY.empty}</Text>
              )}
              {error ? <ErrorNotice message={error} retry={reload} retryTitle="Try again" /> : null}
              <SecretSharingSection />
            </>
          )}
        </View>
      </SettingsScroll>
    </>
  );
}
