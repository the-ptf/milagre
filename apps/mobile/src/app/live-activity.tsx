import { useEffect, useState } from "react";
import { Stack, router, useLocalSearchParams } from "expo-router";
import type { QuestionAnswers } from "@milagre/shared/model";
import { createClient } from "../client";
import { savedHosts } from "../hosts-native";
import { useSession } from "../session";
import { relayRuntime } from "../relay-native";
import { pushStore } from "../push-native";
import { holdActivityDraft } from "../activity-drafts";
import { ErrorNotice, PageScroll, PillButton } from "../ui";

export default function ActivityTargetScreen() {
  const params = useLocalSearchParams<{ hostId?: string; target?: string }>();
  const session = useSession();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!session.booted) return;
    let stopped = false;
    void (async () => {
      const host = (await savedHosts.list()).find((item) => item.id === params.hostId);
      const prefs = await pushStore.read();
      if (!host || prefs.pending.some((item) => item.id === host.id && item.forgotten)) throw new Error("This computer is no longer paired.");
      if (!params.target) {
        if (stopped || !(await session.connect(host, false))) return;
        if (!stopped) router.replace({ pathname: "/projects", params: { hostId: host.id } });
        return;
      }
      const target = await createClient(host, fetch, 15000, relayRuntime).call<{
        projectPath: string;
        sessionId: number;
        requestId: string;
        answers: QuestionAnswers;
      }>("live-activity:open", [{ deviceId: prefs.deviceId, target: params.target }]);
      if (stopped) return;
      const opened = await session.openNotificationTarget(host, target.projectPath, target.sessionId);
      if (!opened || stopped) return;
      holdActivityDraft(host.id, target.projectPath, target.sessionId, target.requestId, target.answers);
      router.replace({ pathname: "/chat", params: { id: String(target.sessionId), projectPath: target.projectPath, hostId: host.id } });
    })().catch((e) => {
      if (!stopped) setError(e.message);
    });
    return () => {
      stopped = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.booted, params.hostId, params.target]);
  return (
    <>
      <Stack.Screen options={{ title: "Open Chat" }} />
      <PageScroll>
        {error ? <ErrorNotice message={error} /> : null}
        <PillButton title="Open computers" secondary onPress={() => router.replace("/")} />
      </PageScroll>
    </>
  );
}
