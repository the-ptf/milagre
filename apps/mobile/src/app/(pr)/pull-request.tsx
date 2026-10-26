import { View } from "react-native";
import { router } from "expo-router";
import { PrOverview } from "../../pr-overview";
import { openPrPage, useCloseSheet, usePrRoute } from "../../pr-nav";
import { PrPending } from "../../pr-pending";
import { chatPullRequestChoices, showChatChanges } from "../../pr-chat";
import { useStyles } from "../../ui";

/** The PR sheet's first page: the PR the Chat's branch opened, and its other PRs in the number's menu. */
export default function PullRequestSheet() {
  const styles = useStyles();
  const { route, cwd, number, client, valid, provider, waiting } = usePrRoute();
  const close = useCloseSheet();
  if (!valid || !client || !cwd) return <PrPending number={number} waiting={waiting} onClose={close} />;
  return (
    // Not collapsable: a form sheet lays out a ScrollView with at most one view beside it; a flattened root hands it every
    // row, and a PR already read (the Chat reads it for its Review pill) opened to a blank sheet.
    <View collapsable={false} style={[styles.screen, { paddingTop: 16 }]}>
      <PrOverview
        key={number}
        client={client}
        cwd={cwd}
        number={number}
        chatKey={route.chat}
        provider={provider}
        onClose={close}
        choices={chatPullRequestChoices(route.chat)}
        onPick={(next) => router.setParams({ number: String(next) })}
        onChanges={(mode) => {
          close();
          // The Chat's Changes slide in once the sheet is down.
          setTimeout(() => showChatChanges(route.chat, mode), 350);
        }}
        onChat={close}
        onOpen={(page, extra) => openPrPage(page, route, extra)}
      />
    </View>
  );
}
