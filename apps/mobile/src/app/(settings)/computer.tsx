import { useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import {
  AiBrain01Icon,
  BookOpen01Icon,
  ChartColumnIcon,
  ConnectIcon,
  FolderTreeIcon,
  LaptopIcon,
  Plug01Icon,
  SmartphoneIcon,
  UserCircleIcon,
} from "@hugeicons/core-free-icons";
import { useSession } from "../../session";
import { usePush } from "../../push";
import { savedHosts } from "../../hosts-native";
import { forgetComputer, renameComputer, routeLabel } from "../../computer-actions";
import { useComputerStatus, useRouteChanges } from "../../use-computer-status";
import { Group, Row } from "../../settings-list";
import { ErrorNotice, PageScroll } from "../../ui";
import { ComputerResourcesGroup } from "../../computer-resources-group";
import { RowCheckbox } from "../../ui";
import { useTheme } from "../../theme";
import { radius } from "../../design-tokens";
import { presenceTone } from "@milagre/shared/chat-scopes";

type MacPage = "models" | "accounts" | "usage" | "skills" | "mcp" | "worktrees" | "connections" | "phone-sharing" | "this-mac";

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
  const [pending, setPending] = useState<{ hostId: string; page: MacPage } | null>(null);
  const currentUrl = session.client?.url;
  const handled = useRef<typeof pending>(null);
  useEffect(() => {
    if (!pending || handled.current === pending) return;
    handled.current = pending;
    if (currentUrl === pending.hostId) router.push(`/${pending.page}`);
  }, [pending, currentUrl]);
  if (!host) return <Stack.Screen options={{ title: "" }} />;
  const state = reachability[host.id] ?? "checking";
  const shown = !host.hidden;
  const dot = colors[presenceTone(state)];
  const connected = currentUrl === host.id;
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
            leading={<View style={{ width: 8, height: 8, borderRadius: radius.full, backgroundColor: dot, marginHorizontal: 6 }} />}
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
        <Group title="Settings on this computer" footer={connecting ? "Connecting…" : undefined}>
          <Row title="Models" icon={AiBrain01Icon} disabled={connecting} onPress={() => void open("models")} />
          <Row title="Accounts" icon={UserCircleIcon} disabled={connecting} onPress={() => void open("accounts")} />
          <Row title="Usage" icon={ChartColumnIcon} disabled={connecting} onPress={() => void open("usage")} />
          <Row title="Skills" icon={BookOpen01Icon} disabled={connecting} onPress={() => void open("skills")} />
          <Row title="MCP servers" icon={Plug01Icon} disabled={connecting} onPress={() => void open("mcp")} />
          <Row title="Worktrees" icon={FolderTreeIcon} disabled={connecting} onPress={() => void open("worktrees")} />
          <Row title="Integrations" icon={ConnectIcon} disabled={connecting} onPress={() => void open("connections")} />
          <Row title="Phone & sharing" icon={SmartphoneIcon} disabled={connecting} onPress={() => void open("phone-sharing")} />
          <Row title="This computer" icon={LaptopIcon} disabled={connecting} onPress={() => void open("this-mac")} />
        </Group>
        <Group inset={0}>
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
