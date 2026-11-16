import { createContext } from "react";

export type ReachableHost = { host: string | null; loopbackOnly: ReadonlySet<number> };
export const ReachableHostContext = createContext<ReachableHost | null>(null);
