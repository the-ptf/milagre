import { useEffect, useReducer, useRef, useState } from "react";
import { projectOfKey, sessionIdFromKey } from "@milagre/shared/agent-runs";
import { hasTranscriptTail, isSubagentSummary, mergeTranscript } from "@milagre/shared/subagent-transcript";
import type { Subagent, SubagentTranscriptEntry } from "../model.ts";
import { bridgeForKey } from "./computer-bridge";

type Whole = { agent: Subagent; transcript: SubagentTranscriptEntry[] };
type Read = { agent: Subagent; details: Subagent };
const KEPT = 16;
const wholes = new Map<string, Whole>();
const reads = new Map<string, Read>();
const loads = new Map<string, Promise<boolean>>();

function remember<T>(cache: Map<string, T>, key: string, value: T) {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > KEPT) cache.delete(cache.keys().next().value!);
}

function known(key: string, agent: Subagent): SubagentTranscriptEntry[] | null {
  if (!hasTranscriptTail(agent)) {
    if (wholes.get(key)?.agent !== agent) remember(wholes, key, { agent, transcript: agent.transcript });
    return agent.transcript;
  }
  const whole = wholes.get(key);
  if (!whole) return null;
  if (whole.agent === agent) return whole.transcript;
  const merged = mergeTranscript(whole.transcript, agent);
  if (merged) remember(wholes, key, { agent, transcript: merged });
  return merged;
}

function load(key: string, chatKey: string, latest: () => Subagent): Promise<boolean> {
  let loading = loads.get(key);
  if (!loading) {
    const agent = latest();
    loading = bridgeForKey(chatKey)
      .readSubagent(projectOfKey(chatKey), sessionIdFromKey(chatKey), agent.id)
      .then(
        (read) => {
          if (isSubagentSummary(agent)) {
            remember(reads, key, { agent, details: read });
            return true;
          }
          const shown = latest();
          remember(wholes, key, { agent: shown, transcript: mergeTranscript(read.transcript, shown) ?? read.transcript });
          return true;
        },
        () => false,
      )
      .finally(() => loads.delete(key));
    loads.set(key, loading);
  }
  return loading;
}

export type SubagentDetails = {
  agent: Subagent;
  transcript: SubagentTranscriptEntry[];
  status: "ready" | "loading" | "failed";
};

export function useSubagentDetails(chatKey: string | null | undefined, agent: Subagent): SubagentDetails {
  const [reloads, loaded] = useReducer((count: number) => count + 1, 0);
  const [failedFor, setFailedFor] = useState<Subagent | null>(null);
  const latest = useRef(agent);
  latest.current = agent;
  const key = chatKey ? `${chatKey}|${agent.id}` : null;
  const summary = isSubagentSummary(agent);
  const transcript = key && !summary ? known(key, agent) : agent.transcript;
  const read = key && summary ? reads.get(key) : undefined;
  const missing = Boolean(key && (summary ? read?.agent !== agent : !transcript) && failedFor !== agent);
  useEffect(() => {
    if (!key || !missing) return;
    let current = true;
    const asked = agent;
    void load(key, chatKey!, () => latest.current).then((ok) => {
      if (!current) return;
      if (!ok) setFailedFor(asked);
      loaded();
    });
    return () => {
      current = false;
    };
  }, [key, chatKey, missing, agent, reloads]);
  if (!summary) return { agent, transcript: transcript ?? agent.transcript, status: "ready" };
  const details = read?.details;
  if (!details) return { agent, transcript: [], status: key && failedFor !== agent ? "loading" : "failed" };
  const { transcript: _transcript, detailsOnDemand: _summary, ...shown } = agent;
  return {
    agent: {
      ...details,
      ...shown,
      prompt: details.prompt,
      latestActivity: details.latestActivity,
      transcript: details.transcript,
    },
    transcript: details.transcript,
    status: "ready",
  };
}
