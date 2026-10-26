import { View } from "react-native";
import { Redirect } from "expo-router";
import { PrOverview } from "../../pr-overview";
import { openPrPage, useCloseSheet, usePrRoute } from "../../pr-nav";
import { useStyles } from "../../ui";

/** The PR sheet's first page: the PR the Chat's branch opened. */
export default function PullRequestSheet() {
  const styles = useStyles();
  const { route, cwd, number, client, valid, provider } = usePrRoute();
  const close = useCloseSheet();
  if (!valid || !client || !cwd) return <Redirect href="/" />;
  return (
    <View style={[styles.screen, { paddingTop: 12 }]}>
      <PrOverview
        client={client}
        cwd={cwd}
        number={number}
        chatKey={route.chat}
        provider={provider}
        onChat={close}
        onOpen={(page, extra) => openPrPage(page, route, extra)}
      />
    </View>
  );
}
