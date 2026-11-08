import { createContext } from "react";

/** The window background's layer a new Chat's sky renders into (DotBackground), under the sidebar and the panes. */
export const SkyLayerContext = createContext<HTMLElement | null>(null);
