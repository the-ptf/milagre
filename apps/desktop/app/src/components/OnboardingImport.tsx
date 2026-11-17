import { useEffect, useState } from "react";
import { foundLine, type ImportScan } from "@milagre/shared/ade-import";
import { Download04Icon } from "@hugeicons/core-free-icons";
import type { OpenProject } from "@milagre/shared/model";
import { Button } from "./primitives/Button";
import { Icon } from "./primitives/Icon";
import { ImportDialog } from "./settings/ImportDialog";

/** Onboarding's offer to import from T3 Code, Paseo or Orca; shown only when one of them left data on this computer. */
export function OnboardingImport({ disabled, onOpened }: { disabled: boolean; onOpened: (project: OpenProject) => void }) {
  const [scan, setScan] = useState<ImportScan | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let live = true;
    window.milagre
      .scanImports()
      .then((found) => live && setScan(found))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  const line = foundLine(scan);
  if (!line) return null;
  return (
    <>
      <div data-onboarding-import className="flex items-center gap-3 rounded-card border border-line bg-surface p-3 pl-4">
        <Icon icon={Download04Icon} size={18} className="shrink-0 text-ink" />
        <span className="grid min-w-0 flex-1">
          <span className="truncate text-13 font-medium text-ink">{line.title}</span>
          <span className="truncate text-12 text-ink-2">{line.detail}</span>
        </span>
        <Button disabled={disabled} onClick={() => setOpen(true)}>
          Import…
        </Button>
      </div>
      {open && (
        <ImportDialog
          bridge={window.milagre}
          onClose={() => setOpen(false)}
          onImported={(projectPath) => {
            if (projectPath) void window.milagre.openProjectAt(projectPath).then(onOpened);
          }}
        />
      )}
    </>
  );
}
