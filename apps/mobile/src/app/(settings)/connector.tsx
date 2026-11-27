import { Stack, useLocalSearchParams } from "expo-router";
import { ConnectorDetail } from "../../connector-detail";
import { SettingsScroll } from "../../settings-find";

export default function ConnectorScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <>
      <Stack.Screen options={{ title: "" }} />
      <SettingsScroll>
        <ConnectorDetail id={String(id ?? "")} />
      </SettingsScroll>
    </>
  );
}
