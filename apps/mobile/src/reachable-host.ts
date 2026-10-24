import { createContext } from "react";

/**
 * The address the phone reaches the Chat's computer on (the LAN or tailnet IP its route dialed), or null over the relay
 * or a tunnel. A localhost link the agent wrote is that computer's, never the phone's: Markdown points it here.
 */
export const ReachableHostContext = createContext<string | null>(null);
