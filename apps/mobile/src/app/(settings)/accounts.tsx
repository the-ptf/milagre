import { useState } from "react";
import { Stack } from "expo-router";
import { Text, View } from "react-native";
import { Findable, SettingsScroll } from "../../settings-find";
import { AccountsSection } from "../../accounts-section";
import { LimitAutoSwitchSection } from "../../limit-switch-section";
import { ProjectAccountsSection } from "../../project-accounts-section";
import { allComputers, useComputerViews } from "../../all-computers";
import { useSession } from "../../session";
import { PullDown, SectionLabel, useStyles } from "../../ui";

export default function AccountsScreen() {
  const styles = useStyles();
  const session = useSession();
  const views = useComputerViews();
  const currentId = session.client?.url ?? "";
  const [chosen, setChosen] = useState<string | null>(null);
  const picked = views.find((view) => view.hostId === chosen && view.hostId !== currentId) ?? null;
  const client = picked ? allComputers.clientFor(picked.hostId) : null;
  const options = [
    { id: currentId, title: session.hostName || "This computer" },
    ...views
      .filter((view) => view.hostId !== currentId)
      .map((view) => ({ id: view.hostId, title: view.state === "offline" ? `${view.name} · Offline` : view.name })),
  ];
  const selectedId = picked && client ? picked.hostId : currentId;
  const current = options.find((option) => option.id === selectedId)?.title ?? "";
  return (
    <>
      <Stack.Screen options={{ title: "Accounts" }} />
      <SettingsScroll>
        {session.client && options.length > 1 ? (
          <Findable title="Computer">
            <View style={[styles.card, { flexDirection: "row", alignItems: "center", gap: 12 }]}>
              <Text style={[styles.text, { flex: 1 }]}>Computer</Text>
              <PullDown
                label="Computer"
                title="Computer"
                sections={[{ items: options.map((option) => ({ id: option.id, title: option.title, checked: option.id === selectedId })) }]}
                nativeTrigger={{ title: current, systemImage: "chevron.up.chevron.down", showIcon: false, maxWidth: 200 }}
                onSelect={(id) => setChosen(id === currentId ? null : id)}
              >
                <Text style={styles.text}>{current}</Text>
              </PullDown>
            </View>
          </Findable>
        ) : null}
        <AccountsSection client={picked && client ? client : undefined} hostName={picked?.name} />
        <LimitAutoSwitchSection key={selectedId} client={picked && client ? client : undefined} />
        <View style={{ gap: 8 }}>
          <SectionLabel>Per Project</SectionLabel>
          <ProjectAccountsSection onAccountsPage />
        </View>
      </SettingsScroll>
    </>
  );
}
