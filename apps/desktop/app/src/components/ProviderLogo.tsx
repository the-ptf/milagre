import { useId } from "react";
import { ANTIGRAVITY_LOGO, CLAUDE_LOGO, CODEX_LOGO, KIRO_LOGO, LINEAR_LOGO, providerLogoPath } from "@milagre/shared/provider-logos";
import type { ModelProvider } from "../model";
import { useSettings } from "../lib/settings";

/** ViewBox padding (in the mark's 24 units) for the solid marks, which read heavier than line-like ones at one size. */
const SOLID_MARK: Partial<Record<ModelProvider, number>> = { codex: 3.4, kiro: 2.4 };

/**
 * Every provider mark follows the device's Appearance choice. `mono` draws the flat one-colour mark in the text colour
 * whatever that choice is: for controls such as the model picker's provider rail, where a soft gradient mark at 16px
 * reads as a blur.
 */
export function ProviderLogo({
  provider,
  size = 16,
  mono = false,
  optical = mono,
  className = "text-ink",
}: {
  provider: ModelProvider;
  size?: number;
  mono?: boolean;
  /** Draw a solid mark smaller in its box, so beside line-like marks (Claude's burst, Antigravity's arch) it reads at one
   * weight. On by default with `mono`, where marks sit side by side. */
  optical?: boolean;
  className?: string;
}) {
  // Gradient, mask and filter ids are per instance: two logos on one page must not share them.
  const id = `logo${useId().replace(/[^\w-]/g, "")}`;
  const { appearance } = useSettings();
  const simplified = mono || appearance.providerIcons === "simplified";
  // A wider viewBox around the 24-unit mark shrinks it in the same box: Codex's filled cloud to about 14px in 18.
  const pad = optical ? (SOLID_MARK[provider] ?? 0) : 0;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`${-pad} ${-pad} ${24 + pad * 2} ${24 + pad * 2}`}
      shapeRendering="geometricPrecision"
      aria-hidden="true"
      data-provider-logo={provider}
      className={`shrink-0 ${className}`}
    >
      {simplified ? (
        <path d={providerLogoPath(provider)} fill="currentColor" fillRule="evenodd" clipRule="evenodd" />
      ) : (
        <>
          {provider === "claude" && <path d={CLAUDE_LOGO.d} fill={CLAUDE_LOGO.fill} />}
          {provider === "kiro" && <path d={KIRO_LOGO.d} fill={KIRO_LOGO.fill} fillRule="evenodd" clipRule="evenodd" />}
          {provider === "codex" && (
            <>
              <defs>
                <linearGradient id={`${id}-codex`} gradientUnits="userSpaceOnUse" x1="12" x2="12" y1="0" y2="24">
                  {CODEX_LOGO.stops.map((stop) => (
                    <stop key={stop.offset} offset={stop.offset} stopColor={stop.color} />
                  ))}
                </linearGradient>
              </defs>
              <path d={CODEX_LOGO.d} fill={`url(#${id}-codex)`} fillRule="evenodd" clipRule="evenodd" />
            </>
          )}
          {provider === "antigravity" && (
            <>
              <defs>
                <mask id={`${id}-arch`} maskUnits="userSpaceOnUse" x="0" y="1" width="24" height="23">
                  <path d={ANTIGRAVITY_LOGO.d} fill="#fff" />
                </mask>
                {ANTIGRAVITY_LOGO.blobs.map((blob) => (
                  <filter
                    key={blob.id}
                    id={`${id}-${blob.id}`}
                    filterUnits="userSpaceOnUse"
                    x={blob.region[0]}
                    y={blob.region[1]}
                    width={blob.region[2]}
                    height={blob.region[3]}
                    colorInterpolationFilters="sRGB"
                  >
                    <feGaussianBlur stdDeviation={blob.blur} />
                  </filter>
                ))}
              </defs>
              <g mask={`url(#${id}-arch)`}>
                {ANTIGRAVITY_LOGO.blobs.map((blob) => (
                  <path key={blob.id} d={blob.d} fill={blob.fill} filter={`url(#${id}-${blob.id})`} />
                ))}
              </g>
            </>
          )}
        </>
      )}
    </svg>
  );
}

/** Linear's mark, on Linear issue chips and pickers, in the color of the text beside it. */
export function LinearLogo({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="shrink-0" data-linear-logo>
      <path d={LINEAR_LOGO.d} fill="currentColor" />
    </svg>
  );
}
