import { useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { BookOpen01Icon, ConnectIcon, Plug01Icon, Settings01Icon, UserCircleIcon } from "@hugeicons/core-free-icons";
import { useSession } from "../../session";
import { usePush } from "../../push";
import { savedHosts } from "../../hosts-native";
import { forgetComputer, renameComputer, routeLabel } from "../../computer-actions";
import { useComputerStatus, useRouteChanges } from "../../use-computer-status";
import { Group, Row } from "../../settings-list";
import { ComputerResourcesGroup } from "../../computer-resources-group";
import { ErrorNotice, PageScroll, RowCheckbox } from "../../ui";
import { useTheme } from "../../theme";

type MacPage = "general" | "accounts" | "connections" | "skills" | "mcp";

/** Settings › Computers › one computer: whether it answers, its Chats in the list, its settings, rename and forget. */
export default function ComputerScreen() {
  const { colors } = useTheme();
  const session = useSession();
  const push = usePush();
  const { id } = useLocalSearchParams<{ id: string }>();
  const host = session.hosts.find((saved) => saved.id === id);
  const list = useMemo(() => (host ? [host] : []), [host]);
  const reachability = useComputerStatus(list);
  useRouteChanges(list);
  const [error, setError] = useState("");
  const [connecting, setConnecting] = useState(false);
  // The page to open once the session shows this computer: the session's client is the one on screen, not the one connect returned.
  const [pending, setPending] = useState<{ hostId: string; page: MacPage } | null>(null);
  const currentUrl = session.client?.url;
  const handled = useRef<typeof pending>(null);
  useEffect(() => {
    if (!pending || handled.current === pending) return;
    handled.current = pending;
    // Another computer became current in the meantime (a second connect won): this tap no longer applies.
    if (currentUrl === pending.hostId) router.push(`/${pending.page}`);
  }, [pending, currentUrl]);
  // A forgotten computer leaves the list while this page is still on screen for a moment.
  if (!host) return <Stack.Screen options={{ title: "" }} />;
  const state = reachability[host.id] ?? "checking";
  const shown = !host.hidden;
  const dot = state === "online" ? colors.green : state === "checking" ? colors.orange : colors.lineStrong;
  const connected = currentUrl === host.id;
  // Its settings are the connected Mac's: connect to this one first when another is current.
  async function open(page: MacPage) {
    if (!host) return;
    setError("");
    setPending(null);
    if (connected) {
      router.push(`/${page}`);
      return;
    }
    setConnecting(true);
    try {
      // False when another connect replaced this one: the page would show some other computer's settings.
      if (await session.connect(host)) setPending({ hostId: host.id, page });
      else setError("Could not connect to this computer. Try again.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setConnecting(false);
    }
  }
  return (
    <>
      <Stack.Screen options={{ title: host.name }} />
      <PageScroll>
        <Group>
          <Row
            title={state === "online" ? "Connected" : state === "checking" ? "Checking…" : "Offline"}
            leading={<View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: dot, marginHorizontal: 6 }} />}
            value={routeLabel(host, state)}
            chevron={false}
          />
          <Row
            title="Show its Chats"
            chevron={false}
            trailing={
              <RowCheckbox
                label={`Show ${host.name} Chats`}
                selected={shown}
                onPress={() =>
                  void savedHosts
                    .setHidden(host.id, shown)
                    .then(() => session.loadHosts())
                    .then(
                      () => setError(""),
                      (e: Error) => setError(e.message),
                    )
                }
              />
            }
          />
        </Group>
        <ComputerResourcesGroup host={host} online={state === "online"} />
        <Group title="Settings on this Mac" footer={connecting ? "Connecting…" : "Changes here apply to this Mac and every device paired with it."}>
          <Row title="General" icon={Settings01Icon} disabled={connecting} onPress={() => void open("general")} />
          <Row title="Accounts" icon={UserCircleIcon} disabled={connecting} onPress={() => void open("accounts")} />
          <Row title="Connections" icon={ConnectIcon} disabled={connecting} onPress={() => void open("connections")} />
          <Row title="Skills" icon={BookOpen01Icon} disabled={connecting} onPress={() => void open("skills")} />
          <Row title="MCP" icon={Plug01Icon} disabled={connecting} onPress={() => void open("mcp")} />
        </Group>
        <Group>
          <Row title="Rename" chevron={false} onPress={() => renameComputer(host, { onRenamed: () => session.loadHosts(), onError: setError })} />
          <Row
            title="Forget this computer"
            destructive
            chevron={false}
            onPress={() =>
              forgetComputer(host, {
                session,
                push,
                onForgotten: () => session.loadHosts().then(() => router.back()),
                onError: setError,
              })
            }
          />
        </Group>
        {error ? <ErrorNotice message={error} /> : null}
      </PageScroll>
    </>
  );
}
