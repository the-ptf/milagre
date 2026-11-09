import { createContext } from "react";

/**
 * Where the phone reaches the Chat's computer: `host` is the LAN or tailnet IP its route dialed (null over the relay or a
 * tunnel), `loopbackOnly` the Chat's ports that listen on loopback alone (loopbackOnlyPorts). A localhost link the agent
 * wrote is that computer's, never the phone's: Markdown points it at `host`, except to a loopback-only server.
 */
export type ReachableHost = { host: string | null; loopbackOnly: ReadonlySet<number> };
export const ReachableHostContext = createContext<ReachableHost | null>(null);
