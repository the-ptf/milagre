import { useEffect, useState } from "react";
import { PaintBoardIcon } from "@hugeicons/core-free-icons";
import { DESIGNS_COPY, designScope } from "@milagre/shared/artifact";
import { bridgeForKey } from "../../lib/computer-bridge";
import { openDesignLibrary } from "../../lib/design-library-page";
import { useDesignLibrary } from "../agents/design-library";
import { Button } from "../primitives/Button";
import { Icon } from "../primitives/Icon";

/** The new Chat screen's way to the Project's Designs page, shown once the Project has a design system or library designs. */
export function DesignsShortcut({ projectKey, name }: { projectKey: string; name: string }) {
  const library = useDesignLibrary(projectKey);
  const [system, setSystem] = useState(false);
  useEffect(() => {
    let live = true;
    const api = bridgeForKey(projectKey).artifacts;
    if (!api?.designSystem) return;
    api
      .designSystem(designScope(projectKey))
      .then((view) => live && setSystem(view?.state === "ready"))
      .catch(() => live && setSystem(false));
    return () => {
      live = false;
    };
  }, [projectKey]);
  const count = (library?.pages ?? []).reduce((sum, page) => sum + page.designs.length, 0);
  if (!system && !count) return null;
  return (
    <Button variant="quiet" size={28} data-new-chat-designs className="gap-1.5" onClick={() => openDesignLibrary(projectKey, name)}>
      <Icon icon={PaintBoardIcon} size={14} />
      {count ? `${DESIGNS_COPY.title} · ${count}` : DESIGNS_COPY.title}
    </Button>
  );
}
