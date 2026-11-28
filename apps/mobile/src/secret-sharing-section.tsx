import { Text, View } from "react-native";
import { SECRETS_COPY } from "@milagre/shared/secrets";
import { CheckRow, ErrorNotice, Group, useStyles } from "./ui";
import { useSecretSharing } from "./use-secrets";

/** Settings › Secrets › Share with: one checkbox per computer paired with the connected one (docs/secrets.md). */
export function SecretSharingSection() {
  const styles = useStyles();
  const { list, error, busy, share } = useSecretSharing();
  if (!list) return error ? <ErrorNotice message={error} /> : null;
  return (
    <View style={{ gap: 8 }}>
      {list.length ? (
        <Group title={SECRETS_COPY.sharing.title} footer={SECRETS_COPY.sharing.intro} inset={32}>
          {list.map((computer) => (
            <CheckRow
              key={computer.id}
              kind="checkbox"
              title={computer.name}
              subtitle={
                computer.pendingRemoval
                  ? SECRETS_COPY.sharing.removing(computer.name)
                  : computer.online
                    ? SECRETS_COPY.sharing.online
                    : SECRETS_COPY.sharing.offline
              }
              checked={computer.shared}
              disabled={busy !== null}
              onPress={() => void share(computer.id, !computer.shared)}
            />
          ))}
        </Group>
      ) : (
        <Group title={SECRETS_COPY.sharing.title} inset={0}>
          <Text style={[styles.muted, { paddingVertical: 12 }]}>{SECRETS_COPY.sharing.empty}</Text>
        </Group>
      )}
      {error ? <ErrorNotice message={error} /> : null}
    </View>
  );
}
