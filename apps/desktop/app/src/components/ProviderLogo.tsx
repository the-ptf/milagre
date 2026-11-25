import { useId } from "react";
import { ANTIGRAVITY_LOGO, CLAUDE_LOGO, CODEX_LOGO, GITHUB_LOGO, KIRO_LOGO, LINEAR_LOGO, PI_LOGO, providerLogoPath } from "@milagre/shared/provider-logos";
import type { ModelProvider } from "../model";
import { useSettings } from "../lib/settings";

const SOLID_MARK: Partial<Record<ModelProvider, number>> = { codex: 3.4, kiro: 2.4 };

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
  optical?: boolean;
  className?: string;
}) {
  const id = `logo${useId().replace(/[^\w-]/g, "")}`;
  const { appearance } = useSettings();
  const simplified = mono || appearance.providerIcons === "simplified";
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
          {provider === "pi" && <path d={PI_LOGO.d} fill="currentColor" />}
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

export function LinearLogo({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="shrink-0" data-linear-logo>
      <path d={LINEAR_LOGO.d} fill="currentColor" />
    </svg>
  );
}

export function GithubLogo({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="shrink-0" data-github-logo>
      <path d={GITHUB_LOGO.d} fill="currentColor" />
    </svg>
  );
}
