import { createHash } from "node:crypto";
import { SIMULATOR_RECEIVER_SCRIPT } from "@milagre/shared/simulator-receiver";
import { BROWSER_RECEIVER_SCRIPT } from "@milagre/shared/browser-receiver";
import { DESIGN_CONTROLLER_SCRIPT } from "@milagre/shared/design";
import { DESIGN_LIVE_RECEIVER_SCRIPT } from "@milagre/shared/design-draft";
import { ARTIFACT_ESCAPE_SCRIPT } from "@milagre/shared/artifact";

/**
 * The inline scripts the renderer's srcdoc iframes run. Opaque srcdoc iframes inherit the renderer's policy, so a script
 * missing here is blocked in packaged builds only: dev has no policy. scripts/test-design-live.cjs runs under it.
 */
export const RENDERER_INLINE_SCRIPTS = [
  SIMULATOR_RECEIVER_SCRIPT,
  BROWSER_RECEIVER_SCRIPT,
  DESIGN_CONTROLLER_SCRIPT,
  DESIGN_LIVE_RECEIVER_SCRIPT,
  ARTIFACT_ESCAPE_SCRIPT,
];

const hash = (script) => `'sha256-${createHash("sha256").update(script).digest("base64")}'`;

/**
 * The packaged renderer shows agent output, so no script may run unless it ships with the app. Images also come from
 * the media protocol and GitHub avatars. `pageScripts` are inline scripts of the page itself (a check's dev page).
 */
export function rendererCsp(pageScripts = []) {
  return [
    "default-src 'self'",
    // Only exact bundled scripts run; their data stays inert.
    `script-src 'self' ${[...RENDERER_INLINE_SCRIPTS, ...pageScripts].map(hash).join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: milagre-media: https:",
    "media-src 'self' blob: milagre-media:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'self' milagre-artifact:",
  ].join("; ");
}
