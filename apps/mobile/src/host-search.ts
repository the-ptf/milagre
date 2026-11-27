import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChatSearchResult } from "@milagre/shared/message-search";
import type { ChatSearchMatch, Client } from "./client";
import type { HostBuild, SearchScope } from "./navigation-build";

/** What one computer answered: its matches, "too old for chats:search" (the phone asks per Project instead), or why it failed. */
type HostSearch = { result: ChatSearchResult } | { legacy: true } | { error: string };
export type HostHits = { query: string; archived: boolean; byHost: Record<string, HostSearch> };

const NO_HOST_HITS: HostHits = { query: "", archived: false, byHost: {} };

/** One request per computer for every Project on it, so a phone with many Projects stays under the host's request cap. */
function useHostSearch({
  needle,
  archived,
  hostIds,
  clientOf,
}: {
  needle: string;
  archived: boolean;
  hostIds: readonly string[];
  clientOf: (hostId: string) => Pick<Client, "searchAllChats"> | null;
}): HostHits {
  const [hits, setHits] = useState<HostHits>(NO_HOST_HITS);
  const key = hostIds.join("\n");
  useEffect(() => {
    if (!needle || !key) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void Promise.all(
        key.split("\n").map(async (hostId): Promise<[string, HostSearch]> => {
          const client = clientOf(hostId);
          if (!client) return [hostId, { error: "Not connected." }];
          try {
            return [hostId, { result: await client.searchAllChats(needle, archived) }];
          } catch (error) {
            if ((error as { code?: string })?.code === "unsupported") return [hostId, { legacy: true }];
            return [hostId, { error: error instanceof Error ? error.message : String(error) }];
          }
        }),
      ).then((found) => !cancelled && setHits({ query: needle, archived, byHost: Object.fromEntries(found) }));
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key names the computers; clientOf changes with every render of the list.
  }, [needle, archived, key]);
  return hits;
}

type LegacyMatches = { query: string; matches: Record<string, ChatSearchMatch[]> };

/**
 * The sidebar search's messages: one chats:search per online computer, with Include archived, and the older per-Project
 * search only for a computer too old to answer it.
 */
export function usePhoneMessageSearch({
  needle,
  builds,
  searchable,
  clientOf,
}: {
  needle: string;
  builds: readonly HostBuild[];
  searchable: readonly SearchScope[];
  clientOf: (hostId: string) => Pick<Client, "searchAllChats" | "searchChats"> | null;
}) {
  const [searchArchived, setSearchArchived] = useState(false);
  const toggleSearchArchived = useCallback(() => setSearchArchived((on) => !on), []);
  const searchHosts = useMemo(
    () => builds.filter((build) => build.reach !== "offline").map(({ hostId, hostName, reach }) => ({ hostId, hostName, reach })),
    [builds],
  );
  const hostHits = useHostSearch({ needle, archived: searchArchived, hostIds: searchHosts.map((host) => host.hostId), clientOf });
  const [hostMatches, setHostMatches] = useState<LegacyMatches>({ query: "", matches: {} });
  const legacyKey = useMemo(
    () =>
      needle && hostHits.query === needle
        ? searchable
            .filter((item) => item.messages === null && "legacy" in (hostHits.byHost[item.hostId] ?? {}))
            .map((item) => `${item.hostId}\t${item.path}`)
            .join("\n")
        : "",
    [needle, searchable, hostHits],
  );
  useEffect(() => {
    if (!needle || !legacyKey) return;
    let cancelled = false;
    void Promise.all(
      legacyKey.split("\n").map(async (key) => {
        const [hostId = "", path = ""] = key.split("\t");
        const client = clientOf(hostId);
        return [key, client ? await client.searchChats(path, needle).catch(() => []) : []] as const;
      }),
    ).then((found) => !cancelled && setHostMatches({ query: needle, matches: Object.fromEntries(found) }));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- legacyKey names the Projects; clientOf changes with every render of the list.
  }, [needle, legacyKey]);
  return { hostMatches, hostHits, searchHosts, searchArchived, toggleSearchArchived };
}
