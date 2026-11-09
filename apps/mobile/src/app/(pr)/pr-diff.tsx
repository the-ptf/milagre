import { View } from "react-native";
import { Stack, router } from "expo-router";
import { PrDiff } from "../../pr-diff";
import { fileName } from "../../pr-review";
import { openPrPage, useCloseSheet, usePrRoute } from "../../pr-nav";
import { PrPending } from "../../pr-pending";
import { useStyles } from "../../ui";

/** One file of the PR, inside the sheet; previous and next swap the file in place. On iPad the same page fills the window. */
export default function PullRequestDiff() {
  const styles = useStyles();
  const { params, route, cwd, number, client, valid, waiting } = usePrRoute();
  const close = useCloseSheet();
  const path = typeof params.path === "string" ? params.path : "";
  if (!valid || !client || !cwd || !path) return <PrPending number={number} waiting={waiting} />;
  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: fileName(path) }} />
      <PrDiff
        key={path}
        client={client}
        cwd={cwd}
        number={number}
        path={path}
        chatKey={route.chat}
        onChat={close}
        onNavigate={(next) => router.setParams({ path: next })}
        onReview={() => openPrPage("review", route)}
      />
    </View>
  );
}
