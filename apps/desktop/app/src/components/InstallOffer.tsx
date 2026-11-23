import { useState } from "react";
import { INSTALL_OFFERS } from "@milagre/shared/providers";
import type { ModelProvider } from "../model";
import { ProviderLogo } from "./ProviderLogo";
import { Button } from "./primitives/Button";

/** Offers an opt-in agent that isn't installed (Pi): what it adds and the command that installs it. */
export function InstallOffer({ provider }: { provider: ModelProvider }) {
  const offer = INSTALL_OFFERS[provider];
  const [copied, setCopied] = useState(false);
  if (!offer) return null;
  return (
    <div data-install-offer={provider} className="flex flex-col gap-2 rounded-control border border-line p-3">
      <div className="flex items-center gap-2 text-13 font-semibold text-ink">
        <ProviderLogo provider={provider} size={16} mono />
        {offer.title}
      </div>
      <p className="text-12 text-ink-2">{offer.detail}</p>
      <div className="flex items-center gap-2 rounded-control bg-inset py-1 pr-1 pl-2">
        <code className="min-w-0 flex-1 font-mono text-11 break-all text-ink">{offer.command}</code>
        <Button
          variant="secondary"
          size={24}
          onClick={() =>
            void navigator.clipboard.writeText(offer.command).then(
              () => setCopied(true),
              () => {},
            )
          }
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="text-11 text-ink-3">{offer.after}</p>
    </div>
  );
}
