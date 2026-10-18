import { useEffect, useReducer, useRef, useState } from "react";
import { projectOfKey, sessionIdFromKey } from "@milagre/shared/agent-runs";
import { hasTranscriptTail, isSubagentSummary, mergeTranscript } from "@milagre/shared/subagent-transcript";
import type { Subagent, SubagentTranscriptEntry } from "../model.ts";
import { bridgeForKey } from "./computer-bridge";

// What the subagent panel shows of a subagent the host sends only part of, read with readSubagent:
// - a subagent with only the end of its transcript (subagent-tails-v1): its whole transcript, read once, then kept
//   current from the tails each update brings;
// - an archived subagent's summary (archived-subagent-summaries-v1): the whole subagent (prompt, latest activity,
//   transcript), read when the panel opens it and again when the summary changes.
// A read that fails (the computer is offline) is not kept: the panel says so, and opening the subagent again reads again.

type Whole = { agent: Subagent; transcript: SubagentTranscriptEntry[] };
/** The summary a read was for, and what it read. */
type Read = { agent: Subagent; details: Subagent };
const KEPT = 16;
// `${chatKey}|${agentId}` -> the agent last merged and its whole transcript, the last ones shown kept.
const wholes = new Map<string, Whole>();
// `${chatKey}|${agentId}` -> an archived subagent's summary and the whole subagent read for it.
const reads = new Map<string, Read>();
// Reads in flight; each settles to whether it succeeded.
const loads = new Map<string, Promise<boolean>>();

function remember<T>(cache: Map<string, T>, key: string, value: T) {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > KEPT) cache.delete(cache.keys().next().value!);
}

/** The whole transcript of `agent` as far as it is known; null when it has to be read. */
function known(key: string, agent: Subagent): SubagentTranscriptEntry[] | null {
  // A transcript that comes whole is the start of the one its later tails extend.
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
            // Kept for the summary it was asked for: a newer summary reads again.
            remember(reads, key, { agent, details: read });
            return true;
          }
          // The update shown may be newer than the read: its tail goes on top when it fits, and the read stands when not.
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
  /** The subagent to show: an archived one's summary filled in with what was read for it. */
  agent: Subagent;
  /** Its whole transcript: the tail until the rest is read. */
  transcript: SubagentTranscriptEntry[];
  /** "loading" while an archived subagent's details are read for the first time, "failed" when that read failed. */
  status: "ready" | "loading" | "failed";
};

/** What the panel shows of subagent `agent` of Chat `chatKey`, reading what the host left out. */
export function useSubagentDetails(chatKey: string | null | undefined, agent: Subagent): SubagentDetails {
  const [reloads, loaded] = useReducer((count: number) => count + 1, 0);
  // The agent whose read failed while this panel was open: not read again until it changes or the panel opens again.
  const [failedFor, setFailedFor] = useState<Subagent | null>(null);
  const latest = useRef(agent);
  latest.current = agent;
  const key = chatKey ? `${chatKey}|${agent.id}` : null;
  const summary = isSubagentSummary(agent);
  const transcript = key && !summary ? known(key, agent) : agent.transcript;
  const read = key && summary ? reads.get(key) : undefined;
  const missing = Boolean(key && (summary ? read?.agent !== agent : !transcript) && failedFor !== agent);
  // Each finished read runs this again: a summary that changed while it was read is read again.
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
  // A newer summary keeps showing what was read for the one before until its own read lands.
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
