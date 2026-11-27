import { mergePullRequestLists, type PullRequestList, type PullRequestListState, type PullRequestRow } from "@milagre/shared/pull-request-list";

export type PullRequestsClient = { call: <T>(method: string, args: unknown[]) => Promise<T> };
/** A computer to read, in the order the list prefers its copy of a PR: the connected computer first. */
export type PullRequestsHost = { hostId: string; client: PullRequestsClient | null; online: boolean };

type Entry = { list: PullRequestList | null; offline: boolean; older: boolean; failure: string; state: PullRequestListState | null };

export type PullRequestsView = {
  rows: PullRequestRow[];
  reading: boolean;
  loaded: boolean;
  error: string;
  older: boolean;
};

const refused = (failure: unknown) => /not available from mobile|unknown (command|method)|no handler/i.test((failure as Error)?.message ?? "");
const message = (failure: unknown) => (failure instanceof Error && failure.message ? failure.message : "Could not read pull requests.");
const isList = (value: unknown): value is PullRequestList => !!value && typeof value === "object" && Array.isArray((value as PullRequestList).items);

/**
 * Every computer's `pull-requests:list`, kept across visits to the page. A computer that fails keeps its last answer,
 * marked offline; one whose Milagre has no such command is left out.
 */
export function createPullRequestsStore() {
  const entries = new Map<string, Entry>();
  const latest = new Map<string, number>();
  const listeners = new Set<() => void>();
  let reading = 0;
  let serial = 0;
  let version = 0;
  const emit = () => {
    version++;
    for (const listener of listeners) listener();
  };

  async function readHost(host: PullRequestsHost, state: PullRequestListState, force: boolean) {
    const ticket = ++serial;
    latest.set(host.hostId, ticket);
    const before = entries.get(host.hostId);
    if (!host.client || !host.online) {
      if (before && !before.offline) {
        entries.set(host.hostId, { ...before, offline: true });
        emit();
      }
      return;
    }
    let next: Entry;
    try {
      const list = await host.client.call<PullRequestList>("pull-requests:list", [{ state, force }]);
      next = { list: isList(list) ? list : null, offline: false, older: false, failure: "", state };
    } catch (failure) {
      next = refused(failure)
        ? { list: null, offline: false, older: true, failure: "", state }
        : { list: before?.list ?? null, offline: true, older: false, failure: message(failure), state };
    }
    if (latest.get(host.hostId) !== ticket) return;
    entries.set(host.hostId, next);
    emit();
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    version: () => version,
    async read(hosts: readonly PullRequestsHost[], state: PullRequestListState, force = false) {
      reading++;
      emit();
      try {
        await Promise.all(hosts.map((host) => readHost(host, state, force)));
      } finally {
        reading--;
        emit();
      }
    },
    view(hostIds: readonly string[], state: PullRequestListState): PullRequestsView {
      const known = hostIds.map((hostId) => ({ hostId, entry: entries.get(hostId) }));
      const rows = mergePullRequestLists(
        known.map(({ hostId, entry }) => ({ computerId: hostId, list: entry?.state === state ? entry.list : null, offline: entry?.offline })),
      );
      const listError = known.flatMap(({ entry }) => (entry && !entry.offline ? (entry.list?.errors ?? []) : []))[0];
      const failure = rows.length ? "" : (known.find(({ entry }) => entry?.failure)?.entry?.failure ?? "");
      return {
        rows,
        reading: reading > 0,
        loaded: !hostIds.length || known.some(({ entry }) => entry?.state === state),
        error: listError ?? failure,
        older: hostIds.length > 0 && known.every(({ entry }) => entry?.older),
      };
    },
  };
}

export type PullRequestsStore = ReturnType<typeof createPullRequestsStore>;
