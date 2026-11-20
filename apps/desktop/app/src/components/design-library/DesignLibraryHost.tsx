import { lazy, Suspense, useEffect, useState } from "react";
import { onDesignLibraryOpen, type DesignLibraryTarget } from "../../lib/design-library-page";

const DesignLibraryPage = lazy(() => import("./DesignLibraryPage").then((module) => ({ default: module.DesignLibraryPage })));

/** Shows the Design library page of the Project last asked for with `openDesignLibrary`, until it is closed. */
export function DesignLibraryHost() {
  const [target, setTarget] = useState<DesignLibraryTarget | null>(null);
  useEffect(() => onDesignLibraryOpen(setTarget), []);
  return target ? (
    <Suspense fallback={null}>
      <DesignLibraryPage key={target.projectKey} target={target} onClose={() => setTarget(null)} />
    </Suspense>
  ) : null;
}
