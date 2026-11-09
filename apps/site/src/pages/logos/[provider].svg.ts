// The coding agents' logos as static SVG files, from the same shapes the app draws (packages/shared/src/provider-logos).
// Files rather than inline markup: the landing page's HTML stays small enough to arrive in one round trip.
import type { APIRoute, GetStaticPaths } from "astro";
import { ANTIGRAVITY_LOGO, CLAUDE_LOGO, CODEX_LOGO, KIRO_LOGO } from "../../../../../packages/shared/src/provider-logos";

const LOGOS: Record<string, string> = {
  claude: `<path d="${CLAUDE_LOGO.d}" fill="${CLAUDE_LOGO.fill}"/>`,
  codex: `<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="12" x2="12" y1="0" y2="24">${CODEX_LOGO.stops
    .map((stop) => `<stop offset="${stop.offset}" stop-color="${stop.color}"/>`)
    .join("")}</linearGradient></defs><path d="${CODEX_LOGO.d}" fill="url(#g)" fill-rule="evenodd" clip-rule="evenodd"/>`,
  antigravity: `<defs><mask id="arch" maskUnits="userSpaceOnUse" x="0" y="1" width="24" height="23"><path d="${ANTIGRAVITY_LOGO.d}" fill="#fff"/></mask>${ANTIGRAVITY_LOGO.blobs
    .map(
      (blob) =>
        `<filter id="${blob.id}" filterUnits="userSpaceOnUse" x="${blob.region[0]}" y="${blob.region[1]}" width="${blob.region[2]}" height="${blob.region[3]}" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="${blob.blur}"/></filter>`,
    )
    .join(
      "",
    )}</defs><g mask="url(#arch)">${ANTIGRAVITY_LOGO.blobs.map((blob) => `<path d="${blob.d}" fill="${blob.fill}" filter="url(#${blob.id})"/>`).join("")}</g>`,
  kiro: `<path d="${KIRO_LOGO.d}" fill="${KIRO_LOGO.fill}" fill-rule="evenodd"/>`,
};

export const getStaticPaths: GetStaticPaths = () => Object.keys(LOGOS).map((provider) => ({ params: { provider } }));

export const GET: APIRoute = ({ params }) =>
  new Response(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${LOGOS[params.provider!]}</svg>`, {
    headers: { "Content-Type": "image/svg+xml" },
  });
