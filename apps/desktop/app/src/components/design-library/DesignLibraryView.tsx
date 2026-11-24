import { lazy, Suspense, useEffect, useState } from "react";
import { onDesignLibraryOpen, type DesignLibraryTarget } from "../../lib/design-library-page";
import type { AppView } from "../../lib/run-pane";

const DesignLibraryPage = lazy(() => import("./DesignLibraryPage").then((module) => ({ default: module.DesignLibraryPage })));

/**
 * The window's Design library view: `openDesignLibrary` from any entry point shows it (through `onShow`) for that
 * Project, and it draws while `view` is "design-library". Leaving it is like leaving any other view.
 */
export function DesignLibraryView({ view, onShow }: { view: AppView; onShow: (view: AppView) => void }) {
  const [target, setTarget] = useState<DesignLibraryTarget | null>(null);
  useEffect(
    () =>
      onDesignLibraryOpen((next) => {
        setTarget(next);
        onShow("design-library");
      }),
    [onShow],
  );
  if (view !== "design-library" || !target) return null;
  return (
    <Suspense fallback={null}>
      <DesignLibraryPage key={target.projectKey} target={target} />
    </Suspense>
  );
}
