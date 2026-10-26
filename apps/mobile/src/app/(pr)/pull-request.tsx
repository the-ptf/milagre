import { View } from "react-native";
import { router } from "expo-router";
import { PrOverview } from "../../pr-overview";
import { openPrPage, useCloseSheet, usePrRoute } from "../../pr-nav";
import { PrPending } from "../../pr-pending";
import { chatPullRequestChoices, prChoiceKey, showChatChanges } from "../../pr-chat";
import { useStyles } from "../../ui";

/** The PR sheet's first page: the PR the Chat's branch opened, and its other PRs in the number's menu. */
export default function PullRequestSheet() {
  const styles = useStyles();
  const { route, cwd, number, client, valid, provider, waiting } = usePrRoute();
  const close = useCloseSheet();
  const choices = chatPullRequestChoices(route.chat);
  const shown = choices.find((choice) => choice.number === number && choice.cwd === route.cwd);
  const project = shown?.project && shown.projectPath ? { name: shown.project, path: shown.projectPath } : undefined;
  if (!valid || !client || !cwd) return <PrPending number={number} waiting={waiting} onClose={close} />;
  return (
    // Not collapsable: a form sheet lays out a ScrollView with at most one view beside it; a flattened root hands it every
    // row, and a PR already read (the Chat reads it for its Review pill) opened to a blank sheet.
    <View collapsable={false} style={[styles.screen, { paddingTop: 16 }]}>
      <PrOverview
        key={`${cwd}#${number}`}
        client={client}
        cwd={cwd}
        number={number}
        chatKey={route.chat}
        provider={provider}
        onClose={close}
        choices={choices}
        project={project}
        onPick={(key) => {
          const next = choices.find((choice) => prChoiceKey(choice) === key);
          if (next) router.setParams({ number: String(next.number), ...(next.cwd ? { cwd: next.cwd } : {}) });
        }}
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
