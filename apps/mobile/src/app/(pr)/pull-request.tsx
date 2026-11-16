import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { PrOverview } from "../../pr-overview";
import { openPrPage, useCloseSheet, usePrRoute } from "../../pr-nav";
import { PrPending } from "../../pr-pending";
import { chatPullRequestChoices, prChoiceKey, showChatChanges } from "../../pr-chat";
import { space } from "../../design-tokens";
import { useStyles } from "../../ui";

export default function PullRequestSheet() {
  const styles = useStyles();
  const { route, cwd, number, client, valid, waiting } = usePrRoute();
  const close = useCloseSheet();
  // Android: the sheet reaches under the status bar (fullStackSheet in app/_layout.tsx), and this page has no native header to clear it.
  const insets = useSafeAreaInsets();
  const top = Platform.OS === "android" ? insets.top : 0;
  const choices = chatPullRequestChoices(route.chat);
  const shown = choices.find((choice) => choice.number === number && choice.cwd === route.cwd);
  const project = shown?.project && shown.projectPath ? { name: shown.project, path: shown.projectPath } : undefined;
  if (!valid || !client || !cwd)
    return (
      <View style={[styles.screen, { paddingTop: top }]}>
        <PrPending number={number} waiting={waiting} onClose={close} />
      </View>
    );
  return (
    <View collapsable={false} style={[styles.screen, { paddingTop: top + space.xxl }]}>
      <PrOverview
        key={`${cwd}#${number}`}
        client={client}
        cwd={cwd}
        number={number}
        chatKey={route.chat}
        onClose={close}
        choices={choices}
        project={project}
        onPick={(key) => {
          const next = choices.find((choice) => prChoiceKey(choice) === key);
          if (next) router.setParams({ number: String(next.number), ...(next.cwd ? { cwd: next.cwd } : {}) });
        }}
        onChanges={() => {
          close();
          setTimeout(() => showChatChanges(route.chat), 350);
        }}
        onChat={close}
        onOpen={(page, extra) => openPrPage(page, route, extra)}
      />
    </View>
  );
}
