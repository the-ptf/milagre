import { useState, type ReactNode } from "react";
import { SkyLayerContext } from "../lib/sky-layer";

export function DotBackground({ children }: { children: ReactNode }) {
  const [skyLayer, setSkyLayer] = useState<HTMLElement | null>(null);
  return (
    <div className="relative h-screen overflow-hidden bg-page">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 [background-size:20px_20px] [background-image:radial-gradient(var(--line-strong)_1px,transparent_1px)] dark:[background-image:radial-gradient(var(--line)_1px,transparent_1px)]"
      />
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-page [mask-image:radial-gradient(ellipse_at_center,transparent_20%,black)]" />
      {/* A new Chat's sky (WelcomeSky) renders here, under the sidebar and the panes, so it spans the whole window. */}
      {/* Film grain over the window's background (Settings › Appearance › Film grain); the dock layer sits above it. */}
      <div aria-hidden data-window-grain className="window-grain pointer-events-none absolute inset-0" />
      <div ref={setSkyLayer} aria-hidden data-welcome-sky-layer className="pointer-events-none absolute inset-0" />
      {/* The docked panels render in here (dock-area.ts dockLayer), stacked with the git changes panel beside them. */}
      <div data-dock-layer className="relative z-10 flex h-full min-h-0">
        <SkyLayerContext.Provider value={skyLayer}>{children}</SkyLayerContext.Provider>
      </div>
    </div>
  );
}
