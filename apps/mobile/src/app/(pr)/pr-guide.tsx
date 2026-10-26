import { View } from "react-native";
import { Redirect, Stack, router } from "expo-router";
import { PrGuideStop } from "../../pr-guide";
import { useCloseSheet, usePrRoute } from "../../pr-nav";
import { usePrDetail, usePrGuide } from "../../pr-store";
import { useStyles } from "../../ui";

/** A review guide stop; Next moves to the next one in place, the menu jumps to any stop. */
export default function PullRequestGuide() {
  const styles = useStyles();
  const { params, route, cwd, number, client, valid, provider } = usePrRoute();
  const close = useCloseSheet();
  const { pr } = usePrDetail(client, cwd, number, false);
  const { result } = usePrGuide(client, cwd, pr?.url, false);
  const stop = Math.max(0, Number(params.stop) || 0);
  if (!valid || !client || !cwd) return <Redirect href="/" />;
  const stops = result?.ok ? (result.guide?.stops ?? []) : [];
  return (
    <View style={styles.screen}>
      <Stack.Screen
        options={{
          title: stops.length ? `Stop ${Math.min(stop, stops.length - 1) + 1} of ${stops.length}` : "Review guide",
        }}
      />
      {stops.length > 0 && (
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.Menu icon="list.bullet" accessibilityLabel="Stops">
            {stops.map((entry, index) => (
              <Stack.Toolbar.MenuAction key={`${index}:${entry.title}`} onPress={() => router.setParams({ stop: String(index) })}>
                {`${index + 1}. ${entry.title}`}
              </Stack.Toolbar.MenuAction>
            ))}
          </Stack.Toolbar.Menu>
        </Stack.Toolbar>
      )}
      <PrGuideStop
        client={client}
        cwd={cwd}
        number={number}
        stop={Math.min(stop, Math.max(0, stops.length - 1))}
        chatKey={route.chat}
        provider={provider}
        onChat={close}
        onStop={(next) => router.setParams({ stop: String(next) })}
        onFinish={() => router.back()}
      />
    </View>
  );
}
